import { QODER_ALPHABET } from "./constants";

const STANDARD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Qoder's custom Base64:
 * 1. standard Base64,
 * 2. split into three parts of length floor(n/3) and rotate,
 * 3. translate the standard alphabet to Qoder's alphabet; '=' becomes '$'.
 */
export function qoderEncode(input: string | Uint8Array): string {
  const standard = Buffer.from(input).toString("base64");
  const n = standard.length;
  const a = Math.floor(n / 3);
  const rearranged =
    standard.slice(n - a) + standard.slice(a, n - a) + standard.slice(0, a);
  return rearranged.replace(/[A-Za-z0-9+/=]/g, (character) =>
    character === "="
      ? "$"
      : QODER_ALPHABET[STANDARD_ALPHABET.indexOf(character)] ?? character,
  );
}

/** Inverse of {@link qoderEncode}; useful for tests and diagnostics. */
export function qoderDecode(input: string): string {
  const withPadding = Array.from(input, (character) => {
    if (character === "$") return "=";
    const index = QODER_ALPHABET.indexOf(character);
    return index >= 0 ? (STANDARD_ALPHABET[index] ?? character) : character;
  }).join("");
  const n = withPadding.length;
  const a = Math.floor(n / 3);
  const rearranged =
    withPadding.slice(n - a) +
    withPadding.slice(a, n - a) +
    withPadding.slice(0, a);
  return Buffer.from(rearranged, "base64").toString("utf8");
}
