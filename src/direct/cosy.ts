import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  COSY_CLIENT_IP,
  COSY_CLIENT_TYPE,
  COSY_PUBLIC_KEY,
  COSY_USER_AGENT,
  COSY_VERSION,
  DEFAULT_USER_TYPE,
  LOGIN_VERSION,
} from "./constants";
import {
  deriveId,
  deriveMachineToken,
  deriveMachineType,
  machineHostname,
  machineOs,
} from "./fingerprint";
import { isRecord } from "../core/util";

export function sortedCompactJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function aesCbcEncrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export function rsaEncryptPkcs1v15(
  data: Buffer,
  publicKeyPem: string = COSY_PUBLIC_KEY,
): Buffer {
  try {
    return publicEncrypt(
      { key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
      data,
    );
  } catch {
    return rsaEncryptFallback(data, publicKeyPem);
  }
}

/** BigInt fallback for Node/OpenSSL builds that reject 1024-bit RSA. */
export function rsaEncryptFallback(
  data: Buffer,
  publicKeyPem: string = COSY_PUBLIC_KEY,
): Buffer {
  const { modulus, exponent } = parseRsaPublicKey(publicKeyPem);
  const size = Math.ceil(modulus.toString(2).length / 8);
  if (data.length > size - 11) {
    throw new Error(`RSA payload too long: ${data.length} > ${size - 11}`);
  }

  const paddingLength = size - data.length - 3;
  const padding = randomBytes(paddingLength);
  for (let index = 0; index < padding.length; index += 1) {
    if (padding[index] === 0) padding[index] = 1;
  }
  const block = Buffer.concat([
    Buffer.from([0, 2]),
    padding,
    Buffer.from([0]),
    data,
  ]);
  const encrypted = modPow(
    BigInt(`0x${block.toString("hex")}`),
    exponent,
    modulus,
  );
  return Buffer.from(encrypted.toString(16).padStart(size * 2, "0"), "hex");
}

export interface CosyIdentity {
  uid: string;
  name?: string;
  organizationId?: string;
  organizationName?: string;
  userType?: string;
  accessToken: string;
  refreshToken: string;
}

export interface CosyHeaderOptions {
  accept?: string;
  sse?: boolean;
  modelKey?: string;
}

export class CosySession {
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineHostname: string;
  private readonly cosyKey: string;
  private readonly info: string;

  constructor(private readonly identity: CosyIdentity) {
    this.machineId = deriveId(identity.uid, "machine");
    this.machineToken = deriveMachineToken(identity.uid);
    this.machineType = deriveMachineType(identity.uid);
    this.machineHostname = machineHostname(identity.uid);

    const tempKey = randomBytes(8).toString("hex");
    const tempKeyBuffer = Buffer.from(tempKey);
    this.cosyKey = rsaEncryptPkcs1v15(tempKeyBuffer).toString("base64");

    const identityJson = sortedCompactJson({
      name: identity.name ?? "",
      aid: identity.uid,
      uid: identity.uid,
      yx_uid: "",
      organization_id: identity.organizationId ?? "",
      organization_name: identity.organizationName ?? "",
      user_type: identity.userType ?? DEFAULT_USER_TYPE,
      security_oauth_token: identity.accessToken ?? "",
      refresh_token: identity.refreshToken ?? "",
    });
    this.info = aesCbcEncrypt(
      Buffer.from(identityJson, "utf8"),
      tempKeyBuffer,
    ).toString("base64");
  }

  headers(
    body: string,
    rawUrl: string,
    options: CosyHeaderOptions = {},
  ): Record<string, string> {
    const path = stripAlgoPrefix(new URL(rawUrl).pathname);
    const payload = sortedCompactJson({
      cosyVersion: COSY_VERSION,
      ideVersion: "",
      info: this.info,
      requestId: randomUUID(),
      version: "v1",
    });
    const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
    const date = String(Math.floor(Date.now() / 1000));
    const signature = createHash("md5")
      .update(
        [payloadBase64, this.cosyKey, date, body, path].join("\n"),
        "utf8",
      )
      .digest("hex");

    const headers: Record<string, string> = {
      "cosy-data-policy": "agree",
      "content-type": "application/json",
      "cosy-business-product": "cli",
      "cosy-business-type": "agent",
      "cosy-scene": "assistant",
      "cosy-clienttype": COSY_CLIENT_TYPE,
      "cosy-date": date,
      "cosy-user": this.identity.uid,
      "cosy-key": this.cosyKey,
      accept:
        options.accept ??
        (options.sse ? "text/event-stream" : "application/json"),
      authorization: `Bearer COSY.${payloadBase64}.${signature}`,
      "accept-encoding": "identity",
      "cosy-version": COSY_VERSION,
      "cosy-machineid": this.machineId,
      "cosy-machinetoken": this.machineToken,
      "cosy-machinetype": this.machineType,
      "cosy-clientip": COSY_CLIENT_IP,
      "login-version": LOGIN_VERSION,
      "user-agent": COSY_USER_AGENT,
    };

    if (options.sse) {
      headers["cache-control"] = "no-cache";
      headers["cosy-machineos"] = machineOs();
      headers["cosy-machinehostname"] = this.machineHostname;
    }
    if (options.modelKey) {
      headers["x-model-key"] = options.modelKey;
      headers["x-model-source"] = "system";
    }
    return headers;
  }
}

function stripAlgoPrefix(path: string): string {
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

function normalizeJson(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeJson(value[key]);
    }
    return result;
  }
  return value;
}

interface RsaPublicKey {
  modulus: bigint;
  exponent: bigint;
}

function parseRsaPublicKey(pem: string): RsaPublicKey {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(base64, "base64");
  const root = readDerElement(der, 0);
  if (root.tag !== 0x30) throw new Error("Invalid RSA public key: no sequence");

  const algorithm = readDerElement(root.content, 0);
  const bitString = readDerElement(root.content, algorithm.next);
  if (bitString.tag !== 0x03) {
    throw new Error("Invalid RSA public key: no bit string");
  }
  const rsa = readDerElement(bitString.content, 1); // skip unused-bits byte
  if (rsa.tag !== 0x30) throw new Error("Invalid RSA public key: no RSA sequence");

  const modulus = readDerElement(rsa.content, 0);
  const exponent = readDerElement(rsa.content, modulus.next);
  if (modulus.tag !== 0x02 || exponent.tag !== 0x02) {
    throw new Error("Invalid RSA public key: missing integers");
  }
  return {
    modulus: integerToBigInt(modulus.content),
    exponent: integerToBigInt(exponent.content),
  };
}

interface DerElement {
  tag: number;
  content: Buffer;
  next: number;
}

function readDerElement(buffer: Buffer, offset: number): DerElement {
  if (offset + 2 > buffer.length) throw new Error("Invalid DER element");
  const tag = buffer[offset];
  if (tag === undefined) throw new Error("Invalid DER tag");
  let cursor = offset + 1;
  const firstLength = buffer[cursor];
  if (firstLength === undefined) throw new Error("Invalid DER length");
  cursor += 1;

  let length = firstLength;
  if (firstLength & 0x80) {
    const lengthBytes = firstLength & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      const byte = buffer[cursor + index];
      if (byte === undefined) throw new Error("Invalid DER length");
      length = length * 256 + byte;
    }
    cursor += lengthBytes;
  }

  const end = cursor + length;
  if (end > buffer.length) throw new Error("Invalid DER content length");
  return { tag, content: buffer.subarray(cursor, end), next: end };
}

function integerToBigInt(content: Buffer): bigint {
  const hex = content.toString("hex") || "0";
  return BigInt(`0x${hex}`);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}
