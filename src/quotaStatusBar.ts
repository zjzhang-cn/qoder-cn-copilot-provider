import * as vscode from "vscode";
import type { DirectAuthManager } from "./direct/authStore";
import { endpointsFor } from "./direct/endpoints";
import { fetchQoderQuota, type QoderQuota } from "./direct/quota";
import { t } from "./l10n";
import type { Logger } from "./logger";

export interface QuotaStatusBarOptions {
  auth: DirectAuthManager;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Persistent status-bar credit balance. Refreshes on sign-in/activation and
 * after each chat; failures degrade to "unavailable" without disturbing chat.
 */
export class QuotaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private inflight: Promise<void> | undefined;
  private last: QoderQuota | undefined;

  constructor(private readonly options: QuotaStatusBarOptions) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.command = "qoderDirect.showQuota";
    this.item.tooltip = t("Qoder Direct: click for credit details");
    this.setIdle();
  }

  show(): void {
    this.item.show();
  }

  /** Refresh the balance; concurrent calls share one request. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const auth = await this.options.auth.getAuth();
    if (!auth) {
      this.item.hide();
      this.last = undefined;
      return;
    }
    this.item.show();
    try {
      const fresh = await this.options.auth.ensureFresh(auth);
      const quota = await fetchQoderQuota(
        endpointsFor(fresh.instance),
        fresh.accessToken,
        { fetchImpl: this.options.fetchImpl },
      );
      this.last = quota;
      this.item.text = `$(credit-card) ${formatCredits(quota.remaining)}`;
      this.item.tooltip = t("Qoder Direct: click for credit details");
    } catch (error) {
      this.last = undefined;
      this.item.text = `$(credit-card) ${t("unavailable")}`;
      this.item.tooltip = t("Qoder Direct: quota unavailable; click to retry");
      this.options.logger.error("Quota refresh failed", error);
    }
  }

  /** Show a detail breakdown (also used as the status-bar click action). */
  async showDetails(): Promise<void> {
    if (!this.last) {
      await this.refresh();
    }
    const quota = this.last;
    if (!quota) {
      void vscode.window.showWarningMessage(
        t("Qoder Direct: quota is unavailable. Sign in and try again."),
      );
      return;
    }
    const lines = [
      t("Qoder Direct: remaining credits: {0}", formatCredits(quota.remaining)),
    ];
    if (quota.base) {
      lines.push(
        t("Base: {0} / {1}", formatCredits(quota.base.remaining), formatCredits(quota.base.total)),
      );
    }
    if (quota.addOn) {
      lines.push(
        t("Add-on: {0} / {1}", formatCredits(quota.addOn.remaining), formatCredits(quota.addOn.total)),
      );
    }
    if (quota.shared) {
      lines.push(
        quota.shared.unlimited
          ? t("Shared pool: unlimited")
          : t("Shared: {0} / {1}", formatCredits(quota.shared.remaining), formatCredits(quota.shared.total)),
      );
    }
    void vscode.window.showInformationMessage(lines.join("  ·  "));
  }

  private setIdle(): void {
    this.item.text = `$(credit-card) ${t("unavailable")}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatCredits(value: number): string {
  if (value < 0) return "∞";
  return Math.round(value).toLocaleString("en-US");
}