export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Includes the wrapped `cause` and `code` that Node's `fetch failed` hides. */
export function formatError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    parts.push(`code=${code}`);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 3) {
    parts.push(`cause=${formatError(cause, depth + 1)}`);
  }
  return parts.join(" | ");
}
