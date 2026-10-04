# CONTEXT — AI Edit plugin work-in-progress (session handoff)

Goal: in-site AI editing agent for emdash. Logged-in authors/editors get a floating widget on
public pages; they can talk (voice → Whisper STT) or type an edit request; the agent resolves the
page being viewed, proposes field-level edits, and the user applies (draft) or applies-and-publishes.
Model: **Cloudflare Workers AI `@cf/zai-org/glm-5.3-flash`** (exists on the catalog, function
calling + streaming + 1M ctx). STT: `@cf/openai/whisper-large-v3-turbo`.

State: P0 implementation is code-complete and verified working end-to-end at the API level on the
Node demo. Formatting pass (`pnpm format`) had just STARTED and was ABORTED by a crash — repo may
have oxfmt/prettier edits applied to some files. Not committed. Continue from "Next steps".

## Files created

`packages/plugins/ai-edit/` (package `@emdash-cms/plugin-ai-edit`, private, trusted/native format):

- `SCOPE.md` — full plan/experience/guardrails/milestones (P0–P3).
- `package.json` — exports `.`, `./plugin`, `./widget`; peer dep `emdash: workspace:*`;
  devDeps `@cloudflare/workers-types`, vitest.
- `tsconfig.json` — extends `../tsconfig.base.json`, `"types": ["@cloudflare/workers-types"]`
  (needed for `assert`, `Record<string, unknown>`, and the `assert` sieve for `assert`, i.e.
  `cloudflare:workers` module types).
- `src/index.ts` — `definePlugin({id:"ai-edit", …})`:
  - capabilities `["content:read","content:write","schema:read","hooks.page-fragments:register"]`
    (the last capability is what actually registers the page:fragments hook).
  - hook `page:fragments`: injects a single inline script (key `ai-edit-widget`, body:end) on every
    public page not starting `/_emdash`, via `widgetScript()` from `./widget.js` (Vite `?raw`).
  - routes (trusted; URLs `/_emdash/api/plugins/ai-edit/<key>`):
    - `chat` (POST, permission `content:edit_own`): coerces input, resolves target from `urlPath`
      with `resolveEmDashPath` (imported from `emdash`) when no explicit target, runs
      `runAgentTurn`, on error **throws `PluginRouteError(code, message, 400)`** (dispatcher then
      emits `{success:false,error:{code,message}}` — handler returns were nested otherwise).
    - `transcribe` (POST, `content:edit_own`, `request: {body:"bytes", maxBytes:1_200_000,
headers:["content-type"]}`): `transcribeAudio(options, input)`.
- `src/ai.ts` — binding resolution via `await import("cloudflare:workers")` → `env[binding=AI]`;
  `AiBindingError` with the "requires the Cloudflare runtime" message; `runChatTurn` (messages +
  tools, `tool_choice:"auto"`, `max_completion_tokens:1024`, stream:false) with defensive response
  normalization (`choices[0].message`, `{response:{...}}`, `{response:"string"}` shapes);
  `transcribeAudio` runs Whisper with `{audio: bytes}`.
- `src/agent.ts` — 5 tools on `ctx.content`/`ctx.schema` (all reads; NO server-side writes):
  `list_collections`, `get_collection_schema`, `get_entry_data`, `search_entries`, `propose_edits`
  (which validates field slugs against the real schema and returns current entry+`currentData`).
  System prompt: default target = the page's entry; read-before-propose; rules against invention.
  Loop bounds: 6 tool rounds / 30 s deadline; a `propose_edits` always ends the turn. Proposal
  payload: `{collection,id,slug,title,status,edits:[{field,old,value}],note,suggestPublish}`.
  NOTE: do NOT import `ContentItem` from `emdash` for plugin shapes — the root export's
  `ContentItem` requires `primaryBylineId`; the plugin-context ContentItem (from
  `packages/core/src/plugins/types.ts`, no byline id) is what `ctx.content` returns. `pickTitle()`
  therefore takes a structural `{data,slug}` type.
- `src/client.js` — plain-JS widget (imported `?raw` by `widget.ts`). Flow: boot →
  `GET /_emdash/api/auth/me` (role ≥ 30 = AUTHOR) → render pill + panel (style injected).
  Panel: message list, target input ("paste url/slug/id"), textarea, mic button (MediaRecorder,
  ≤30 s, posts webm blob to `transcribe`), Send. Chat response renders `proposal` as field diff
  rows (old→new) plus buttons Apply(draft) / Apply&publish (role≥40 or author-30-own, cosmetic
  server-side anyway) / Discard. Apply does:
  `GET /_emdash/api/content/{c}/{id}` (fresh `_rev`) → `PUT … {data,_rev}` → optional
  `POST …/publish {_rev}`. All stock content routes; ownership/permissions respected server-side.
  CSRF header `X-EmDash-Request: 1` on every mutating call.
- `src/widget.ts` — exports `widgetScript()`; `import clientSource from "./client.js?raw"`
  (`// @ts-ignore - Vite raw import`).

## Files modified

- `demos/simple/astro.config.mjs` — `plugins: [auditLog, mcpSmokePlugin(), aiEditPlugin()]`
  (`aiEditPlugin` descriptor factory, NOT the resolved plugin: the Astro integration needs a
  descriptor with `entrypoint: "@emdash-cms/plugin-ai-edit/plugin"` + `adminEntry`.
  `aiEditPlugin` is exported next to `createPlugin` in src/index.ts; createPlugin must ALSO be a
  named export `createPlugin` because the integration generates
  `import { createPlugin } from entrypoint; createPlugin(options)`).
- `demos/simple/package.json` — added `"@emdash-cms/plugin-ai-edit": "workspace:*"`.
- `pnpm-lock.yaml` — from `pnpm install`.

## Key integration facts discovered (for iteration)

- Trusted plugin route handler signature is **one param**: `handler: async (routeCtx) => …`,
  `routeCtx: RouteContext` (input/request/user/log/content/schema…). Errors: throw
  `PluginRouteError` (exported from `emdash` root), else responses nest under `{success,data}`.
- Trusted route URL mapping: route key → `/_emdash/api/plugins/{pluginId}/{key}`.
- `page:fragments` hook shape: `(event:{page:PublicPageContext}, ctx)` →
  `{kind:"inline-script", key?, placement:"head"|"body:start"|"body:end", code}` |
  `{kind:"html",…}` | `null`. Trusted-only; requires capability `hooks.page-fragments:register`.
  All `</` in code are escaped by the host renderer; no further escaping needed.
- Astro `plugins:[]` in `emdash({...})` config = descriptors (PluginDescriptor with entrypoint),
  not ResolvedPlugin. Marketplaces/sandbox use standard-format default export +
  `adaptSandboxEntry`; trusted plugins use `definePlugin()` + `entrypoint` that exports
  `createPlugin(options)`.
- Editor-only auth check for the widget: `GET /_emdash/api/auth/me` returns
  `{success:true,data:{id,email,name,role}}`; roles: SUBSCRIBER=10, CONTRIBUTOR=20, AUTHOR=30,
  EDITOR=40, ADMIN=50.
- RBAC (packages/auth/src/rbac.ts): `content:edit_own`=AUTHOR, `content:edit_any`=EDITOR,
  `content:publish_own`=AUTHOR, `content:publish_any`=EDITOR.
- `_rev` = base64(`"version:updatedAt"`), stateless; GET content returns `{item,_rev}`;
  mismatch → 409 CONFLICT. Entry edit locks → `ENTRY_LOCKED`.

## Verified so far

1. `pnpm --filter @emdash-cms/plugin-ai-edit typecheck` → clean.
2. Demo dev server (`cd demos/simple && npx astro dev`) runs; `curl /` → 200 and contains
   the injected `emdash-ai-edit` widget script (dev log: `[plugin:ai-edit] [ai-edit] injecting
widget for / …`). Route tested as dev admin:
   `POST /_emdash/api/plugins/ai-edit/chat` with `X-EmDash-Request: 1` + session cookie →
   `{"success":false,"error":{"code":"AI_BINDING_MISSING","message":"The AI Edit widget requires
the Cloudflare Workers runtime…"}}` (expected on Node). Unauthenticated → 401.
   `transcribe` behaves identically.
3. MCP server separately verified earlier: `/_emdash/api/mcp` live with 72 tools and a PAT
   (also registered in opencode config as MCP server "emdash").

## Next steps (continue here)

1. **Re-run checks that were aborted**: `pnpm format` (watch that it doesn't mangle
   `src/client.js` strings; it uses oxfmt+prettier), then `pnpm lint:quick` and
   `pnpm --silent lint:json | jq '.diagnostics | length'` → expect 0. Then `pnpm build` from root
   (workspace packages resolve each other's declarations). Then `pnpm typecheck` /
   `pnpm typecheck:demos`.
2. **Real E2E with the model** needs the Cloudflare runtime: run the demo through the Cloudflare
   Vite plugin or `wrangler dev` (the emdash-demo repo has `demos/cloudflare`), with an
   `AI` binding in wrangler.jsonc. There the chat route should hit
   `@cf/zai-org/glm-5.3-flash` for real; validate tool-calling JSON shapes against the
   normalizer (adjust `normalizeChatResponse` if GLM wraps differently — GLM reasoning models
   may emit `reasoning` field; strip it from reply text).
3. **Widget polish targets already known**:
   - `history` is client-side but the loop only receives raw strings; server expects
     `{role:"user",content}` style — currently coerced. Consider real multi-turn array.
   - Proposals: only one at a time (P0 as scoped); add "propose nothing" affordance /
     `targetEl` is currently unused in chat POST (wire it: send `target:{slug|urlPath}` from the
     target input).
   - After Apply draft: surface "view draft" link to admin editor rather than nothing.
   - Fix author-publish button Enable logic (publish route enforces server-side anyway).
4. **P1**: voice UX already implemented (hold-ish 30 s cap, auto-send transcript); polish codec
   (`recorder.media.mimeType` → `audio/webm;codecs=opus`; Safari uses audio/mp4 — Whisper on CF
   accepts flac/mp3/mp4/webm wav — should be ok; verify).
5. **Hygiene before PR**: comment at bottom of src/index.ts (the "P0 note") — decide keep/drop;
   routes emit English strings (plugin Block Kit i18n not applicable to widget; matches
   webhook-notifier precedent); changeset NOT needed (package is private) unless we publish it —
   when publishing under @emdash-cms scope, add a changeset.
6. Dev admin user for testing: `GET /_emdash/api/setup/dev-bypass` with cookies jar
   (`dev@emdash.local`). Known dev-only.

Env notes: node v26.10.0, pnpm installed globally (npm i -g pnpm). Dev server only reachable
while `astro dev` runs (background process may have died in the crash — restart with
`cd demos/simple && npx astro dev start`).
