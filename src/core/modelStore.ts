import { toProviderModels } from "./models";
import type { HubModel, ModelOverride, ProviderModel } from "./types";
import { formatError, isRecord } from "./util";

const DEFAULT_CACHE_KEY = "qoder-direct.models.v1";
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void | PromiseLike<void>;
}

export interface ModelStoreOptions {
  client: {
    fetchModels(signal?: AbortSignal): Promise<HubModel[]>;
  };
  memento: MementoLike;
  /** Separate persisted caches for the hub and direct profiles. */
  cacheKey?: string;
  logger?: (message: string) => void;
  getExcludedModels: () => readonly string[];
  getModelOverrides: () => Record<string, ModelOverride>;
  now?: () => number;
}

export interface LoadResult {
  models: ProviderModel[];
  stale: boolean;
  error?: unknown;
}

interface CacheEntry {
  at: number;
  models: HubModel[];
}

export class ModelStore {
  private entry: CacheEntry | undefined;
  private inflight: Promise<HubModel[]> | undefined;
  private generation = 0;
  private readonly now: () => number;
  private readonly cacheKey: string;

  constructor(private readonly options: ModelStoreOptions) {
    this.now = options.now ?? Date.now;
    this.cacheKey = options.cacheKey ?? DEFAULT_CACHE_KEY;
    const cached = options.memento.get<unknown>(this.cacheKey);
    if (isCacheEntry(cached)) this.entry = cached;
  }

  getModels(): ProviderModel[] {
    return toProviderModels(this.entry?.models ?? [], {
      excludedModels: this.options.getExcludedModels(),
      overrides: this.options.getModelOverrides(),
    });
  }

  async load(force = false, signal?: AbortSignal): Promise<LoadResult> {
    const fresh =
      this.entry !== undefined && this.now() - this.entry.at < CACHE_TTL_MS;
    if (fresh && !force) {
      return { models: this.getModels(), stale: false };
    }

    try {
      await this.fetch(signal);
      return { models: this.getModels(), stale: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.log(`Model list load failed: ${formatError(error)}`);
      if (this.entry) {
        return { models: this.getModels(), stale: true, error };
      }
      return { models: [], stale: false, error };
    }
  }

  async refresh(signal?: AbortSignal): Promise<ProviderModel[]> {
    await this.fetch(signal);
    return this.getModels();
  }

  clear(): void {
    this.generation += 1;
    this.entry = undefined;
    this.inflight = undefined;
    void Promise.resolve(
      this.options.memento.update(this.cacheKey, undefined),
    ).catch(() => undefined);
  }

  private async fetch(signal?: AbortSignal): Promise<HubModel[]> {
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const promise = this.options.client.fetchModels(signal);
    this.inflight = promise;
    try {
      const models = await promise;
      if (generation === this.generation) {
        this.entry = { at: this.now(), models };
        try {
          await this.options.memento.update(this.cacheKey, this.entry);
        } catch (error) {
          this.log(`Failed to persist the model cache: ${formatError(error)}`);
        }
      }
      this.log(`Loaded ${models.length} models from the hub.`);
      return models;
    } finally {
      if (this.inflight === promise) this.inflight = undefined;
    }
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    Array.isArray(value.models)
  );
}


