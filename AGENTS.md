# AGENTS.md

## Project status

- Standalone VS Code extension **Qoder CN Provider for Copilot** that exposes Qoder CN models as a native language-model chat provider.
- Layout: `src/extension.ts` (activation/commands), `src/provider.ts` (VS Code provider), `src/direct/*` (Qoder OAuth/COSY/catalog/chat), `src/core/*` (VS Code-free model/message/SSE helpers), `assets/baseprompt.json` (MIT attribution in `NOTICE`), `test/*`.
- `npm test` currently runs 27 files / 175 tests; keep this line updated.

## Design decisions

- Single vendor `qoder-direct`, display "Qoder (Direct)", group "Qoder Direct", activation `onLanguageModelChatProvider:qoder-direct`.
- OAuth device flow + PAT import (`pt-` → `jobToken/exchange` → `jt-`/`jrt-`). Tokens/uid/instance/machineId live in `SecretStorage` under `qoder-direct.auth.v1`; pending login under `qoder-direct.login.v1`. Never log tokens, COSY headers, or request bodies.
- PAT sessions store `personalToken` + `source: "pat"` on the same auth record (additive, `version: 1` unchanged). Refresh routes by refreshToken prefix (`drt-` → device, else job); any job-refresh failure falls back to PAT re-exchange; a dead PAT surfaces as 401 "import a new PAT" without auto-clearing credentials. PAT import requires `/userinfo` to succeed (COSY identity derives from uid); an existing sign-in is replaced only after a modal confirmation.
- Credential writes are serialized: `saveAuth`/`clearAuth` take the auth file lock; `refreshWithLock` re-reads storage under the lock and bails (401) if the record is gone or the uid changed (no stale-snapshot resurrection/clobber). The shared single-flight refresh is NOT bound to any caller's abort signal; `forceRefresh` chains a forced refresh after an in-flight non-forced one.
- Errors: `HubError` carries an optional stable `code`; `src/authErrors.ts` (presentation layer) maps codes to localized text, falling back to the English message for unknown/server text. `direct/*` and `core/*` stay VS Code-free. `redactTokens` (`pt-…` → `pt-***`) is applied in `authError`, `formatError`, and the extension `errorMessage` before any log/toast. Network failures map to a coded "cannot reach server" error; transports throw `HubTimeoutError` so timeouts localize.
- Recovery UI (`promptForSetup`) offers Sign In, Import PAT, Create Group, Show Logs via `profile.setup`. `managementCommand` stays `signIn`; PAT import is command-palette / recovery-prompt only (documented in README).
- VPC accepts only a bare instance name (`acme`); derive website/openapi/gateway hosts. No public fallback for VPC.
- Model ids are Qoder `upstream_key`s; display names are UI-only. The model list is a signed **GET with a body** (`node:https`, never global `fetch`).
- Chat uses the outer Qoder SSE envelope, `model_config.max_input_tokens` for Context Size, `reasoning_effort` for Effort Level, and a conversation id derived from workspace + system prompt + first user message.
- Token usage is forwarded to VS Code as a `LanguageModelDataPart` with mime `"usage"` carrying the upstream OpenAI-style usage JSON (the stable-API channel the built-in providers use); malformed usage is ignored, and usage is also logged. **Cached-input tokens cannot be shown**: VS Code's only `"usage"` decoder reads prompt/completion/reasoning tokens and never builds the `modelTotals[].cachedTokens` the cached line needs — that flows exclusively through the built-in Copilot metadata channel (verified against shipped binaries + live test; a `_meta.turnTokenTotals` attempt was ignored).
- Credit quota: `src/direct/quota.ts` GETs `/api/v2/quota/usage` (bearer token, CN UA, no COSY) and aggregates `userQuota` + `addOnQuota` + org shared pool (`cap`, `cap=-1` = unlimited, `available=false` excluded); degenerate/empty responses are rejected rather than reported as 0. `QuotaStatusBar` shows remaining credits in the status bar (click → breakdown), refreshes on activation/sign-in/secret-change and after each chat (provider `onChatFinished` hook), single-flight, and degrades to "unavailable" on failure without disturbing chat. Commands `showQuota` / `refreshQuota`. No daily check-in (deliberately out of scope).
- Models are only served through the provider group; groupless discovery returns `[]`. Deleting the group removes models; sign-out is separate.
- One chat at a time + 300ms gap; `DirectLimiter` coordinates across VS Code windows via a lock file.
- Fixed protocol version constants; log version-gate errors instead of forging a higher client version.
- Images enabled for vision models: `imageInput` follows catalog `is_vl` (per-model override can force on/off). Inline images flow as OpenAI `image_url` parts in user-message `content` (the only field upstream reads); top-level `image_urls`/`chat_context.imageUrls` stay null. Non-vision models get a text placeholder instead of images. No transcode/resize; encoded body capped at 29MB (Aliyun SLB 30MB hard limit) with a local 413. Upstream "Image conversion timeout" is coded + localized (no dedicated retry yet). Remote-URL images unsupported. Reasoning content dropped (stable `LanguageModelResponsePart` has no thinking part).

## Commands (verified)

- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — Vitest, mocked protocol/OAuth/HTTP.
- `npm run build` — esbuild bundle to `dist/extension.js`.
- `npm run package` — local VSIX.
- `npm run watch` — esbuild watch.
- F5 uses `.vscode/launch.json`; no proposed-API flag.
- Live smoke: Qoder Direct: Sign In (or Import PAT with a `pt-` token) in the Extension Development Host; VPC instance `acme` is only an example placeholder.

## Known backlog (P2, deferred from the v0.1.2 functional review)

- `isUnauthorized` matches session-dead markers by substring; a numeric marker like `12153` can false-positive on unrelated error text (bounded: one retry). Anchor to error-code fields / word boundaries.
- Auth lock margins: waiter timeout 30s and TTL 60s vs a worst-case ~60s PAT refresh (30s job + 30s exchange) can time out a waiter or steal a stale lock. Raise margins or renew the lock while held.
- Importing an already-revoked PAT shows the raw upstream marker text (the friendly mapping lives on the refresh path only). Route import exchange errors through the same mapping.
- `personalToken` validator accepts any string (no `pt-` shape check) and `expires_in` ≤ 0 / seconds-valued strings are accepted as ms. Tighten validation.
- Cancelling after `saveAuth` still shows the success toast; `store.refresh` is not wired to the cancel signal.
- `signIn` success toast omits the account name (importPat includes it); align them.
- Default `package.nls.json` description is Chinese text shown to English-locale users.
- `secrets.onDidChange` clears the model cache on every token save (bounded ~1 refetch/window/refresh); skip the clear when only tokens changed.
- Live PAT smoke (jt- acceptance in COSY, server token lifetimes/rotation) remains unverified against a real account.
- Images: optional PNG→JPEG transcode for bandwidth (needs a native codec dependency; skipped to keep the single-file bundle); dedicated one-shot retry for upstream "Image conversion timeout"; remote-URL image support; live vision smoke (upstream acceptance of WebP/GIF and non-vision behavior unverified).
