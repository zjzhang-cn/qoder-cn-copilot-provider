import { HubError } from "../backend";
import { isRecord } from "../core/util";

export interface DirectOuterFrame {
  inner?: string;
  done?: boolean;
}

/**
 * Qoder wraps each OpenAI chunk in an outer JSON envelope:
 * `{"headers":{...},"body":"<inner JSON>","statusCodeValue":200}`.
 * A non-200 status is an error even though the HTTP response was 200.
 */
export function parseOuterFrame(data: string): DirectOuterFrame {
  if (data === "[DONE]") return { done: true };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new HubError("Qoder stream contained invalid JSON.");
  }
  if (!isRecord(payload)) return { inner: data };

  const status = payload.statusCodeValue;
  if (typeof status === "number" && status !== 200) {
    throw new HubError(
      `Qoder upstream returned status ${status}.`,
      status,
    );
  }
  if (typeof status === "string" && status !== "200") {
    const numeric = Number(status);
    throw new HubError(
      `Qoder upstream returned status ${status}.`,
      Number.isFinite(numeric) ? numeric : undefined,
    );
  }

  const body = payload.body;
  if (typeof body === "string") {
    if (body === "[DONE]") return { done: true };
    return { inner: body };
  }
  if (isRecord(body)) return { inner: JSON.stringify(body) };

  // Some gateways forward the inner chat chunk without the outer envelope.
  return { inner: data };
}
