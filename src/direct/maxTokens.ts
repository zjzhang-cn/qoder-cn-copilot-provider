/** Parse Qoder's max_tokens range error: "Range of max_tokens should be [1, 131072]". */
export function learnMaxOutputLimit(message: string): number | undefined {
  const match = /Range of max_tokens should be \[1,\s*(\d+)\]/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
