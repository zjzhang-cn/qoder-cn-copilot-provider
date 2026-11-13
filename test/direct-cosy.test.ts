import {
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { COSY_PUBLIC_KEY } from "../src/direct/constants";
import { deriveId } from "../src/direct/fingerprint";
import {
  aesCbcEncrypt,
  CosySession,
  rsaEncryptFallback,
  rsaEncryptPkcs1v15,
  sortedCompactJson,
} from "../src/direct/cosy";

describe("sortedCompactJson", () => {
  it("sorts keys recursively and maps nullish values to empty strings", () => {
    expect(
      sortedCompactJson({
        b: 1,
        a: { d: null, c: undefined, e: [2, { z: 1, y: 2 }] },
      }),
    ).toBe('{"a":{"c":"","d":"","e":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe("AES", () => {
  it("round-trips with a 16-byte key used as IV", () => {
    const key = Buffer.from("0123456789abcdef");
    const plain = Buffer.from("hello qoder", "utf8");
    const encrypted = aesCbcEncrypt(plain, key);
    const decipher = createDecipheriv("aes-128-cbc", key, key);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    expect(decrypted.toString("utf8")).toBe("hello qoder");
  });
});

describe("RSA", () => {
  it("encrypts the real COSY key to 128 bytes", () => {
    const encrypted = rsaEncryptPkcs1v15(Buffer.from("0123456789abcdef"));
    expect(encrypted).toHaveLength(128);
  });

  it("BigInt fallback decrypts with a generated key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const data = Buffer.from("fallback payload");
    const encrypted = rsaEncryptFallback(data, pem);
    const decrypted = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_PADDING,
      },
      encrypted,
    );
    expect(decrypted).toEqual(data);
  });

  it("uses a working public key for direct COSY encryption", () => {
    const encrypted = rsaEncryptPkcs1v15(
      Buffer.from("0123456789abcdef"),
      COSY_PUBLIC_KEY,
    );
    expect(encrypted.length).toBeGreaterThan(0);
  });
});

describe("CosySession", () => {
  it("builds protocol headers without leaking raw tokens", () => {
    const accessToken = "dt-secret-access";
    const refreshToken = "drt-secret-refresh";
    const session = new CosySession({
      uid: "uid-1",
      name: "tester",
      accessToken,
      refreshToken,
    });
    const headers = session.headers(
      '{"x":1}',
      "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
      { accept: "application/json" },
    );

    expect(headers["cosy-user"]).toBe("uid-1");
    expect(headers["cosy-version"]).toBe("1.1.75");
    expect(headers["cosy-clienttype"]).toBe("5");
    expect(headers["login-version"]).toBe("v2");
    expect(headers.authorization).toMatch(/^Bearer COSY\./);
    expect(headers["cosy-key"]).toBeTruthy();
    expect(headers["cosy-machineid"]).toBe(deriveId("uid-1", "machine"));
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
  });

  it("adds SSE and model headers", () => {
    const session = new CosySession({
      uid: "uid-1",
      accessToken: "dt-a",
      refreshToken: "drt-b",
    });
    const headers = session.headers(
      "body",
      "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
      { sse: true, modelKey: "qmodel_38max" },
    );
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-model-key"]).toBe("qmodel_38max");
    expect(headers["x-model-source"]).toBe("system");
    expect(headers["cosy-machineos"]).toBeTruthy();
    expect(headers["cosy-machinehostname"]).toMatch(/^DESKTOP-/);
  });
});
