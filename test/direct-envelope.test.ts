import { describe, expect, it } from "vitest";
import { parseOuterFrame } from "../src/direct/envelope";

describe("parseOuterFrame", () => {
  it("unwraps a Qoder envelope", () => {
    expect(
      parseOuterFrame(
        JSON.stringify({
          statusCodeValue: 200,
          body: '{"choices":[]}',
        }),
      ),
    ).toEqual({ inner: '{"choices":[]}' });
  });

  it("handles [DONE] inside and outside the envelope", () => {
    expect(parseOuterFrame("[DONE]")).toEqual({ done: true });
    expect(
      parseOuterFrame(JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })),
    ).toEqual({ done: true });
  });

  it("throws on a non-200 envelope status even with HTTP 200", () => {
    expect(() =>
      parseOuterFrame(JSON.stringify({ statusCodeValue: 403, body: "denied" })),
    ).toThrow(/403/);
  });

  it("accepts a raw inner chunk from a proxy", () => {
    expect(parseOuterFrame('{"choices":[{"delta":{}}]}')).toEqual({
      inner: '{"choices":[{"delta":{}}]}',
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseOuterFrame("not-json")).toThrow(/invalid JSON/);
  });
});
