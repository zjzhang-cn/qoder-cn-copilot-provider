import { describe, expect, it } from "vitest";
import {
  ModelStore,
  type MementoLike,
  type ModelStoreOptions,
} from "../src/core/modelStore";
import type { HubModel } from "../src/core/types";

class FakeMemento implements MementoLike {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

function model(id: string, overrides: Partial<HubModel> = {}): HubModel {
  return { id, enabled: true, ...overrides };
}

function makeStore(
  overrides: Partial<ModelStoreOptions> = {},
): {
  store: ModelStore;
  memento: FakeMemento;
  calls: () => number;
} {
  let calls = 0;
  const memento = new FakeMemento();
  const store = new ModelStore({
    client: {
      fetchModels: async () => {
        calls += 1;
        return [model("a")];
      },
    },
    memento,
    getExcludedModels: () => [],
    getModelOverrides: () => ({}),
    ...overrides,
  });
  return { store, memento, calls: () => calls };
}

describe("ModelStore", () => {
  it("fetches once and serves the cache", async () => {
    const { store, calls } = makeStore();
    const first = await store.load();
    const second = await store.load();
    expect(first.models.map((entry) => entry.id)).toEqual(["a"]);
    expect(second.models.map((entry) => entry.id)).toEqual(["a"]);
    expect(calls()).toBe(1);
  });

  it("honors a fresh cache from the memento", async () => {
    const memento = new FakeMemento();
    memento.values.set("qoder-direct.models.v1", {
      at: 100,
      models: [model("cached")],
    });
    const { store, calls } = makeStore({
      memento,
      now: () => 200,
    });
    const result = await store.load();
    expect(result.models.map((entry) => entry.id)).toEqual(["cached"]);
    expect(calls()).toBe(0);
  });

  it("falls back to stale cache when the hub fails", async () => {
    const memento = new FakeMemento();
    memento.values.set("qoder-direct.models.v1", {
      at: 0,
      models: [model("cached")],
    });
    const { store } = makeStore({
      memento,
      now: () => 2 * 60 * 60 * 1000,
      client: {
        fetchModels: async () => {
          throw new Error("offline");
        },
      },
    });
    const result = await store.load();
    expect(result.stale).toBe(true);
    expect(result.models.map((entry) => entry.id)).toEqual(["cached"]);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("returns an empty list when there is no cache and the hub fails", async () => {
    const { store } = makeStore({
      client: {
        fetchModels: async () => {
          throw new Error("offline");
        },
      },
    });
    const result = await store.load();
    expect(result.models).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("applies excluded models and overrides on every read", async () => {
    const { store } = makeStore({
      getExcludedModels: () => ["b"],
      getModelOverrides: () => ({ a: { maxInputTokens: 1_000 } }),
      client: {
        fetchModels: async () => [model("a"), model("b")],
      },
    });
    await store.load();
    expect(store.getModels().map((entry) => entry.id)).toEqual(["a"]);
    expect(store.getModels()[0]?.maxInputTokens).toBe(1_000);
  });

  it("refresh bypasses the cache", async () => {
    const { store, calls } = makeStore();
    await store.load();
    await store.refresh();
    expect(calls()).toBe(2);
  });

  it("does not cache a fetch that started before clear", async () => {
    let resolveFetch!: (models: HubModel[]) => void;
    const pending = new Promise<HubModel[]>((resolve) => {
      resolveFetch = resolve;
    });
    const { store } = makeStore({
      client: {
        fetchModels: () => pending,
      },
    });
    const loading = store.load();
    store.clear();
    resolveFetch([model("old")]);
    await loading;
    expect(store.getModels()).toEqual([]);
  });

  it("uses a custom cache key", async () => {
    const { store, memento } = makeStore({
      cacheKey: "custom.models.v1",
    });
    await store.load();
    expect(memento.values.has("custom.models.v1")).toBe(true);
    expect(memento.values.has("qoder-direct.models.v1")).toBe(false);
  });

  it("clear removes the persisted cache", async () => {
    const { store, memento, calls } = makeStore();
    await store.load();
    expect(memento.values.has("qoder-direct.models.v1")).toBe(true);
    store.clear();
    await Promise.resolve();
    expect(memento.values.has("qoder-direct.models.v1")).toBe(false);
    await store.load();
    expect(calls()).toBe(2);
  });
});
