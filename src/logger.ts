import type * as vscode from "vscode";
import { formatError } from "./core/util";

export class Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  error(message: string, error?: unknown): void {
    const detail = error === undefined ? "" : formatError(error);
    const stack =
      error instanceof Error && error.stack ? `\n${error.stack}` : "";
    this.channel.appendLine(
      `[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ""}${stack}`,
    );
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
