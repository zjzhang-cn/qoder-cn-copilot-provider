import { createHash } from "node:crypto";

/**
 * Stable per-account identity derivation copied from the hub's
 * qoder_fingerprint.py. Never randomize these per request.
 */
export function deriveId(uid: string, salt: string): string {
  let hash = createHash("md5")
    .update(`${salt}:${uid || "anonymous"}`)
    .digest("hex");
  hash = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function deriveMachineType(uid: string): string {
  return deriveId(uid, "machinetype").replace(/-/g, "").slice(0, 18);
}

export function deriveMachineToken(uid: string): string {
  return createHash("sha512")
    .update(`machinetoken:${uid}`)
    .digest("base64url")
    .slice(0, 43);
}

export function machineHostname(uid: string): string {
  const hash = createHash("md5")
    .update(`hostname:${uid}`)
    .digest("hex")
    .slice(0, 7)
    .toUpperCase();
  return `DESKTOP-${hash}`;
}

export function machineOs(platform = process.platform, arch = process.arch): string {
  if (platform === "win32") return "x86_64_win32";
  if (arch === "arm64") return "aarch64_linux";
  return "x86_64_linux";
}
