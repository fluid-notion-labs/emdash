# AI Edit Plugin — Scope

An EmDash plugin that puts an AI editing agent inside the running site. While navigating their
own site, an admin/editor opens a floating widget and requests changes by voice or text; the
agent resolves the page being viewed, proposes field-level edits, and applies (and optionally
publishes) them after explicit confirmation.

Folder lives inside the repo (`emdash-ai-edit-plugin/`) until it is spun out for publication.

## Target experience

- A logged-in user with author-or-higher role gets a floating agent pill injected into every
  public page they can edit. Visitors see nothing — the widget renders client-side only after
  an auth check, so no request/byte is added to the anonymous hot path.
- The widget has one text input plus a record button, served in two modes from the same
  component:
  - **Voice-first**: mic armed by default. Hold-to-talk → up to 30 s of audio → normalized to
    text, which enters the chat loop identically to typed text.
  - **Text-first**: same panel, mic greyed out.
- The page currently being viewed is the default edit target. A small "context" field accepts a
  pasted URL, path, slug, or entry ID to redirect the agent to another entry.
- Proposed changes render as a structured, field-level diff ("title: 'A' → 'B'") with
  **Apply** / **Apply & Publish** / **Discard** buttons. The agent never writes content by
  itself; writes happen only on the explicit Apply click.

## Runtime architecture

```
public page (editor hits it)
  └─ inline script (page:fragments hook, trusted plugin)
       ├─ fetch /_emdash/api/auth/me → render only if role ≥ AUTHOR
       └─ POST /_emdash/api/plugins/ai-edit/chat
            └─ server: resolve target (URL path → collection+entry via resolveEmDashPath)
                 └─ tool loop on Workers AI (@cf/zai-org/glm-5.3-flash; function calling)
                      ├─ get_entry_data / search_entries / list_fields (via ctx.content.*)
                      └─ propose_edits → the ONLY write-shaped tool; returns a proposal
                 └─ SSE-style response { reply, proposal }
  Apply → POST /_emdash/api/plugins/ai-edit/apply
       ├─ revalidate: schema field names, _rev precondition, ownership, role
       └─ ctx.content.update → optional ctx.content.publish (revisions + audit log intact)
```

Key choices:

- **Trusted (native) plugin format** (`definePlugin`, like `plugin-ai-moderation`). Required for
  the `page:fragments` hook (trusted-only) and for the Cloudflare Workers AI binding.
- **Workers AI binding** (default name `AI`), accessed via `cloudflare:workers` at call time. On
  Node.js dev the binding is absent → the widget shows a clear "requires the Cloudflare runtime"
  message instead of failing silently. An options-based REST-API fallback (`accountId` +
  `apiToken`) can be added later.
- **Model**: `@cf/zai-org/glm-5.3-flash` (function calling, streaming, 1M context). STT:
  `@cf/openai/whisper-large-v3-turbo` (≤30 s per request drives the recording cap).
- **In-process tools** over `ctx.content` / schema registry — no HTTP hop, no PAT, session-borne
  authorization via `RouteContext.user`.

## Security / correctness guardrails

1. **Proposal → confirm, always.** The model's writes are limited to `propose_edits`; only the
   human can turn a proposal into a database write.
2. **Apply route revalidates everything** — it does not trust the proposal from the chat step:
   schema field validation, `_rev` optimistic-concurrency check (409 `CONFLICT`), ownership
   (author edits their own; editor edits anyone's), publish tier (`content:publish_own` /
   `content:publish_any`).
3. **Route gating** — `permission: "content:edit_own"` on the ingest route; CSRF
   `X-EmDash-Request: 1` enforced by the host dispatcher; widget sends it via `apiFetch`.
4. **Tool-loop bounds** — max ~6 tool calls and ~30 s per turn; abort is safe (agents never
   mid-write).
5. **Audit + revisions** — every apply is a normal content write: revision history, audit log
   (origin `plugin`), and entry-edit-lock behavior all come for free; `ENTRY_LOCKED` surfaces in
   chat.
6. **Voice starts on-device** — microphone recording stays local until the user sends the
   transcript; disclosed in a first-run tooltip.

## Milestones

| Phase          | Deliverable                                                                                                                                                                | Est.    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **P0**         | Text chat: widget on public pages, current-page resolution, schema-aware `propose_edits`, Apply → draft save, Apply & Publish for permitted roles. Non-stream single POST. | ~2 d    |
| **P1**         | Voice: hold-to-talk capture (30 s cap), Whisper transcription route, transcript enters chat, codec handling for Safari.                                                    | ~1–2 d  |
| **P2**         | Polish: pasted targets (URL/slug/iD), entry diffs vs live in editor, rate limits, unit + e2e tests, changeset, README.                                                     | ~2–3 d  |
| **P3** (later) | Streaming + partial diffs, TTS readback, full-page agent console in admin, per-user multi-turn memory, toolc from other plugins, REST fallback for Node deploys.           | backlog |

Package layout (inside `emdash-ai-edit-plugin/`):

| File            | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `src/index.ts`  | `definePlugin` descriptor: capabilities, hooks (page:fragments), routes |
| `src/ai.ts`     | Workers AI binding access; run chat/whisper                             |
| `src/tools.ts`  | Tool definitions + bounded tool loop                                    |
| `src/widget.ts` | Client widget script + injected bootstrap                               |
| `src/apply.ts`  | Execute proposal with full revalidation (update + optional publish)     |
