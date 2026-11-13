import { describe, expect, it } from "vitest";
import type { DirectAuth, DirectAuthManager } from "../src/direct/authStore";
import {
  DirectQoderClient,
  type DirectTransport,
  type DirectTransportOptions,
} from "../src/direct/client";
import { qoderDecode } from "../src/direct/encode";
import type { ToolCallResult } from "../src/backend";

const AUTH: DirectAuth = {
  version: 1,
  realm: "cn",
  uid: "uid-1",
  name: "Tester",
  accessToken: "dt-access",
  refreshToken: "drt-refresh",
  expiresAt: 10_000_000,
  machineId: "machine-1",
};

function authManager(
  auth: DirectAuth = AUTH,
): Pick<DirectAuthManager, "getAuth" | "ensureFresh" | "forceRefresh"> {
  return {
    getAuth: async () => auth,
    ensureFresh: async (value) => value,
    forceRefresh: async () => auth,
  };
}

function outer(inner: unknown): string {
  return `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify(inner),
  })}\n\n`;
}

function transportWith(chunks: string[], onRequest?: (options: DirectTransportOptions) => void): DirectTransport {
  return async (_url, options) => {
    onRequest?.(options);
    return {
      status: 200,
      body: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  };
}

describe("DirectQoderClient", () => {
  it("fetches and maps the model catalog", async () => {
    const client = new DirectQoderClient({
      authManager: authManager(),
      catalogRequest: async () => ({
        status: 200,
        body: JSON.stringify({
          chat: [
            {
              key: "qmodel_38max",
              display_name: "Qwen3.8-Max",
              enable: true,
              context_config: { "200K": { token_count: 200_000, is_default: true } },
            },
          ],
        }),
      }),
    });
    const models = await client.fetchModels();
    expect(models[0]).toMatchObject({
      id: "qmodel_38max",
      name: "Qwen3.8-Max",
      enabled: true,
    });
  });

  it("streams text and sends the Qoder body", async () => {
    let captured: DirectTransportOptions | undefined;
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: transportWith(
        [
          outer({ choices: [{ delta: { content: "Hel" } }] }),
          outer({ choices: [{ delta: { content: "lo" } }] }),
          outer({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ],
        (options) => {
          captured = options;
        },
      ),
    });

    const chunks: string[] = [];
    await client.streamChat(
      {
        model: "qmodel_38max",
        modelName: "Qwen3.8-Max",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 16_000,
        maxInputTokens: 200_000,
        supportsReasoning: true,
        reasoningEffort: "high",
        contextSize: 200_000,
      },
      {
        onText: (text) => chunks.push(text),
        onToolCall: () => undefined,
      },
    );

    expect(chunks.join("")).toBe("Hello");
    expect(captured?.headers["x-model-key"]).toBe("qmodel_38max");
    expect(captured?.headers.authorization).toMatch(/^Bearer COSY\./);
    const decoded = JSON.parse(qoderDecode(captured?.body ?? "")) as Record<
      string,
      unknown
    >;
    expect(decoded.model_config).toMatchObject({ key: "qmodel_38max" });
    expect(decoded.parameters).toMatchObject({
      max_tokens: 16_000,
      reasoning_effort: "high",
    });
  });

  it("uses VPC gateway hosts for chat", async () => {
    let url = "";
    const vpcAuth = { ...AUTH, instance: "acme" };
    const client = new DirectQoderClient({
      authManager: authManager(vpcAuth),
      transport: async (target) => {
        url = target;
        return {
          status: 200,
          body: (async function* () {
            yield outer({ choices: [{ delta: { content: "ok" } }] });
            yield "data: [DONE]\n\n";
          })(),
        };
      },
    });
    await client.streamChat(
      { model: "qmodel_38max", messages: [{ role: "user", content: "hi" }] },
      { onText: () => undefined, onToolCall: () => undefined },
    );
    expect(url.startsWith("https://acme-gateway.vpc.qoder.com.cn/")).toBe(
      true,
    );
  });

  it("streams tool calls", async () => {
    const calls: ToolCallResult[] = [];
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: transportWith([
        outer({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"a.txt"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        outer({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    });
    await client.streamChat(
      {
        model: "qmodel_38max",
        messages: [{ role: "user", content: "read" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        toolChoice: "required",
      },
      {
        onText: () => undefined,
        onToolCall: (call) => calls.push(call),
      },
    );
    expect(calls).toEqual([
      { callId: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("refreshes once and retries a 401 before output", async () => {
    let refreshed = 0;
    let requests = 0;
    const client = new DirectQoderClient({
      authManager: {
        getAuth: async () => AUTH,
        ensureFresh: async (value) => value,
        forceRefresh: async () => {
          refreshed += 1;
          return { ...AUTH, accessToken: "dt-new" };
        },
      },
      transport: async () => {
        requests += 1;
        if (requests === 1) {
          return {
            status: 401,
            body: (async function* () {
              yield "invalid token";
            })(),
          };
        }
        return {
          status: 200,
          body: (async function* () {
            yield outer({ choices: [{ delta: { content: "ok" } }] });
            yield "data: [DONE]\n\n";
          })(),
        };
      },
    });
    const chunks: string[] = [];
    await client.streamChat(
      { model: "qmodel_38max", messages: [{ role: "user", content: "hi" }] },
      { onText: (text) => chunks.push(text), onToolCall: () => undefined },
    );
    expect(refreshed).toBe(1);
    expect(requests).toBe(2);
    expect(chunks.join("")).toBe("ok");
  });

  it("retries a queue response once before output", async () => {
    let requests = 0;
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: async () => {
        requests += 1;
        if (requests === 1) {
          return {
            status: 403,
            body: (async function* () {
              yield JSON.stringify({
                code: "10605",
                isQueued: true,
                retryAfterSeconds: 0,
              });
            })(),
          };
        }
        return {
          status: 200,
          body: (async function* () {
            yield outer({ choices: [{ delta: { content: "ok" } }] });
            yield "data: [DONE]\n\n";
          })(),
        };
      },
    });
    const chunks: string[] = [];
    await client.streamChat(
      { model: "qmodel_38max", messages: [{ role: "user", content: "hi" }] },
      { onText: (text) => chunks.push(text), onToolCall: () => undefined },
    );
    expect(requests).toBe(2);
    expect(chunks.join("")).toBe("ok");
  });

  it("surfaces a mid-stream inner error", async () => {
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: transportWith([
        outer({ choices: [{ delta: { content: "partial" } }] }),
        outer({ error: { message: "boom" } }),
      ]),
    });
    await expect(
      client.streamChat(
        { model: "qmodel_38max", messages: [{ role: "user", content: "hi" }] },
        { onText: () => undefined, onToolCall: () => undefined },
      ),
    ).rejects.toMatchObject({ name: "HubError", message: "boom" });
  });

  it("learns a lower max_tokens limit and clamps the next request", async () => {
    let calls = 0;
    let secondBody = "";
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: async (_url, options) => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 400,
            body: (async function* () {
              yield "Range of max_tokens should be [1, 8000]";
            })(),
          };
        }
        secondBody = options.body;
        return {
          status: 200,
          body: (async function* () {
            yield outer({ choices: [{ delta: { content: "ok" } }] });
            yield "data: [DONE]\n\n";
          })(),
        };
      },
    });
    const handlers = {
      onText: () => undefined,
      onToolCall: () => undefined,
    };
    await expect(
      client.streamChat(
        {
          model: "qmodel_38max",
          messages: [{ role: "user", content: "hi" }],
          maxOutputTokens: 16_000,
        },
        handlers,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await client.streamChat(
      {
        model: "qmodel_38max",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 16_000,
      },
      handlers,
    );
    const decoded = JSON.parse(qoderDecode(secondBody)) as {
      parameters?: { max_tokens?: number };
    };
    expect(decoded.parameters?.max_tokens).toBe(8000);
  });

  it("surfaces a non-200 outer status", async () => {
    const client = new DirectQoderClient({
      authManager: authManager(),
      transport: transportWith([
        `data: ${JSON.stringify({ statusCodeValue: 500, body: "failed" })}\n\n`,
      ]),
    });
    await expect(
      client.streamChat(
        { model: "qmodel_38max", messages: [{ role: "user", content: "hi" }] },
        { onText: () => undefined, onToolCall: () => undefined },
      ),
    ).rejects.toMatchObject({ name: "HubError", status: 500 });
  });
});
