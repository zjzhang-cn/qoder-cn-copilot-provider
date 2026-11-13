import { describe, expect, it } from "vitest";
import {
  deriveId,
  deriveMachineToken,
  deriveMachineType,
  machineHostname,
  machineOs,
} from "../src/direct/fingerprint";

describe("direct Qoder device identity", () => {
  it("matches the hub test vectors", () => {
    expect(deriveId("test-uid-001", "machine")).toBe(
      "b79a1004-ac8c-4564-aa0d-282f1b12ccc6",
    );
    expect(deriveMachineToken("test-uid-001")).toBe(
      "fEdC3vcf_wHrXzuL_peNGgZHeYT2BYZLoG2LjcyvEpg",
    );
    expect(deriveMachineType("test-uid-001")).toBe("2642a4d377f741a4a6");
  });

  it("is stable and format-correct", () => {
    expect(deriveId("uid", "machine")).toBe(deriveId("uid", "machine"));
    expect(deriveId("uid", "machine")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(machineHostname("uid")).toMatch(/^DESKTOP-[0-9A-F]{7}$/);
  });

  it("maps machine OS values", () => {
    expect(machineOs("win32", "x64")).toBe("x86_64_win32");
    expect(machineOs("linux", "x64")).toBe("x86_64_linux");
    expect(machineOs("linux", "arm64")).toBe("aarch64_linux");
  });
});
