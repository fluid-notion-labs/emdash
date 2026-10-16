# AI Edit Demo

A dedicated demo for the `@emdash-cms/plugin-ai-edit` plugin: an in-site editing
agent available to logged-in editors.

## What's included

- **AI Edit plugin** — injects a floating widget on public pages for signed-in
  editors (author and up). The widget accepts text or voice (Whisper STT),
  resolves the entry being viewed, proposes field-level edits as a reviewable
  diff, and applies the confirmed draft (optionally publishing) through the
  stock content API.

## Running locally

```bash
pnpm install
pnpm dev
```

The dev server seeds sample content. Sign in via the dev bypass or the admin UI,
then browse a page and use the widget.

## Workers AI requirement

The agent uses Workers AI through an `AI` binding (`@cf/openai/gpt-oss-20b`
for chat, `@cf/openai/whisper-large-v3-turbo` for speech). Under this Node demo
the widget still runs, but chat and transcription answer with
`AI_BINDING_MISSING` unless the site is served through the Cloudflare runtime
(see `demos/cloudflare` for the full Workers deployment with an `AI` binding).
Deployed to a Worker, the binding config lives in `wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" }
```
