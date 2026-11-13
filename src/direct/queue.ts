import { isRecord } from "../core/util";

/**
 * Qoder queue responses are HTTP 403/429/503 with a business code (10605) and
 * an optional retryAfterSeconds. Return the delay in milliseconds.
 */
export function parseQueueRetryAfter(
  body: string,
  status: number,
): number | undefined {
  if (status !== 403 && status !== 429 && status !== 503) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  const candidates: unknown[] = [parsed];
  if (isRecord(parsed)) candidates.push(parsed.error);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const code = candidate.code;
    const queued = candidate.isQueued === true || candidate.is_queued === true;
    if (!queued && String(code) !== "10605" && code !== 10605) continue;
    const raw =
      candidate.retryAfterSeconds ??
      candidate.retry_after_seconds ??
      candidate.retry_after;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
    return 5_000;
  }
  return undefined;
}
