# AGENTS.md

## Project status

- Standalone VS Code extension **Qoder CN Provider for Copilot** that exposes Qoder CN models as a native language-model chat provider.
- Layout: `src/extension.ts` (activation/commands), `src/provider.ts` (VS Code provider), `src/direct/*` (Qoder OAuth/COSY/catalog/chat), `src/core/*` (VS Code-free model/message/SSE helpers), `assets/baseprompt.json` (MIT attribution in `NOTICE`), `test/*`.
- `npm test` currently runs 23 files / 118 tests; keep this line updated.

## Design decisions

- Single vendor `qoder-direct`, display "Qoder (Direct)", group "Qoder Direct", activation `onLanguageModelChatProvider:qoder-direct`.
- OAuth device flow only. Tokens/uid/instance/machineId live in `SecretStorage` under `qoder-direct.auth.v1`; pending login under `qoder-direct.login.v1`. Never log tokens, COSY headers, or request bodies.
- VPC accepts only a bare instance name (`acme`); derive website/openapi/gateway hosts. No public fallback for VPC.
- Model ids are Qoder `upstream_key`s; display names are UI-only. The model list is a signed **GET with a body** (`node:https`, never global `fetch`).
- Chat uses the outer Qoder SSE envelope, `model_config.max_input_tokens` for Context Size, `reasoning_effort` for Effort Level, and a conversation id derived from workspace + system prompt + first user message.
- Models are only served through the provider group; groupless discovery returns `[]`. Deleting the group removes models; sign-out is separate.
- One chat at a time + 300ms gap; `DirectLimiter` coordinates across VS Code windows via a lock file.
- Fixed protocol version constants; log version-gate errors instead of forging a higher client version.
- Images disabled; reasoning content dropped (stable `LanguageModelResponsePart` has no thinking part).

## Commands (verified)

- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — Vitest, mocked protocol/OAuth/HTTP.
- `npm run build` — esbuild bundle to `dist/extension.js`.
- `npm run package` — local VSIX.
- `npm run watch` — esbuild watch.
- F5 uses `.vscode/launch.json`; no proposed-API flag.
- Live smoke: Qoder Direct: Sign In in the Extension Development Host; VPC instance `acme` is only an example placeholder.
