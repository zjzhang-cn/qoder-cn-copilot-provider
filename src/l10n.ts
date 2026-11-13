import { l10n } from "vscode";

export function t(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  return l10n.t(message, ...args);
}
