import { HubError } from "./backend";
import { t } from "./l10n";

/**
 * Presentation-layer localization for backend errors. The direct/core layers
 * stay VS Code-free and throw English `HubError`s with a stable `code`; this
 * boundary maps known codes to localized text and falls back to the original
 * message for anything unknown (e.g. server-provided error text).
 */
export function localizedAuthMessage(error: HubError): string {
  switch (error.code) {
    case "pat-revoked":
      return t("Qoder PAT is invalid or revoked. Import a new PAT.");
    case "session-changed":
      return t("Qoder session changed. Sign in again.");
    case "session-expired":
      return t("Qoder session expired. Sign in again.");
    case "job-refresh-missing":
      return t("Qoder job refresh token is missing.");
    case "refresh-cancelled":
      return t("Qoder token refresh cancelled.");
    case "signin-required":
      return t("Sign in to Qoder Direct first.");
    case "network-unreachable":
      return t("Cannot reach the Qoder server. Check your network or VPC instance.");
    case "userinfo-failed":
      return t("Failed to read Qoder user info.");
    case "userinfo-no-id":
      return t("Qoder user info did not contain an id.");
    case "token-payload-invalid":
      return t("Qoder returned an invalid token payload.");
    case "token-payload-incomplete":
      return t("Qoder token payload is incomplete.");
    case "pat-exchange-failed":
      return t("Qoder PAT exchange failed.");
    case "job-refresh-failed":
      return t("Qoder job token refresh failed.");
    case "device-refresh-failed":
      return t("Qoder token refresh failed.");
    case "device-auth-failed":
      return t("Device authorization failed.");
    default:
      return error.message;
  }
}

/** Localize a HubError for user-facing surfaces; pass through other errors. */
export function localizedErrorMessage(error: unknown): string {
  if (error instanceof HubError) return localizedAuthMessage(error);
  return error instanceof Error ? error.message : String(error);
}