import { describe, expect, it } from "vitest";
import { qoderDecode, qoderEncode } from "../src/direct/encode";

describe("qoderEncode", () => {
  it("matches the hub test vectors", () => {
    expect(qoderEncode("{}")).toBe("$kwm");
    expect(qoderEncode('{"x":1}')).toBe("ep$$BMn%mYKI");
  });

  it("round-trips ASCII and Unicode", () => {
    for (const value of ["", "hello", "你好，Qoder", '{"a":[1,2,3]}']) {
      expect(qoderDecode(qoderEncode(value))).toBe(value);
    }
  });
});
