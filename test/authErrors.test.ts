import { describe, expect, it } from "vitest";
import { HubError } from "../src/backend";
import {
  localizedAuthMessage,
  localizedErrorMessage,
} from "../src/authErrors";

describe("localizedAuthMessage", () => {
  it("maps known codes to localized text", () => {
    const error = new HubError("Qoder PAT is invalid or revoked. Import a new PAT.", 401);
    error.code = "pat-revoked";
    // The mock l10n.t is a passthrough, so the localized key is returned;
    // the point is that the code path is taken, not the raw message reused.
    expect(localizedAuthMessage(error)).toBe(
      "Qoder PAT is invalid or revoked. Import a new PAT.",
    );
  });

  it("falls back to the original message for unknown codes", () => {
    const error = new HubError("server said something specific", 500);
    error.code = "not-a-known-code";
    expect(localizedAuthMessage(error)).toBe("server said something specific");
  });

  it("falls back to the original message when no code is set", () => {
    const error = new HubError("upstream text", 403);
    expect(localizedAuthMessage(error)).toBe("upstream text");
  });

  it("passes non-HubError values through localizedErrorMessage", () => {
    expect(localizedErrorMessage(new Error("plain"))).toBe("plain");
    expect(localizedErrorMessage("raw string")).toBe("raw string");
  });
});