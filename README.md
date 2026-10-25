# Uncensor AI

A private, single-user, mobile-first AI chat workspace built around open-weight models, persistent chats, and a personal semantic knowledge library.

## What v2 already supports

- Streaming chat on iPhone and desktop
- Up to 500 conversations loaded in the sidebar
- Search chats by title
- Pin/unpin chats
- Rename chats
- **Permanent chat deletion** with database-level cascade deletion of every message in that chat
- Export the current chat to Markdown
- Stop a generation while it is streaming
- Persistent conversation history in Supabase
- Long-chat context recovery from the database (up to 80 recent messages / a configurable context budget)
- OpenRouter model selector
- DeepSeek V4.1 Flash 1017 as the balanced default
- Kimi K3.1 Pro as a higher-cost "Best" option
- GLM 5.3 Flash and Qwen3.8 27B alternatives
- Direct / Teacher / Precise / Deep-analysis response modes
- Custom personal instructions
- Personal knowledge ingestion from pasted text and multiple text-based files
- Up to ~5,000,000 characters per knowledge source
- Resumable batched embedding/indexing
- Semantic retrieval using Supabase `gte-small` + pgvector
- Enable/disable individual knowledge sources without deleting them
- Rename or permanently delete knowledge sources
- Retrieval source chips on answers
- OpenRouter is hard-disabled by default
- Rolling 24-hour application spend cap
- PWA metadata for iPhone Home Screen use

## Privacy / access model

The frontend never receives the Supabase service-role key or OpenRouter API key. All privileged calls are performed server-side. The intended deployment is behind Cloudflare Access so only your account can open the site.

**Important:** the GitHub repository itself should be private. A public repo is still safe only if no secrets are committed, but private is the correct setting for this personal project.

## Behavior

The default assistant prompt is intentionally direct and low-friction: it asks the model not to refuse merely because a topic is controversial, sensitive, adult, unconventional, or uncomfortable, and to give the closest useful answer rather than canned boilerplate.

The actual behavior still depends on the selected model and the inference provider. No hosted setup can truthfully guarantee that every model will answer literally every possible request.

## Architecture

```text
iPhone / browser
    ↓
Cloudflare Worker + static assets
    ├─→ OpenRouter (chat completions only)
    └─→ Supabase
         ├─ conversations + messages
         ├─ usage ledger
         ├─ knowledge sources + chunks
         └─ local gte-small embeddings + pgvector retrieval
```

## Setup

1. Make the GitHub repo private.
2. Create a dedicated Supabase project.
3. Run `supabase/schema.sql` in the Supabase SQL editor.
4. Deploy `supabase/functions/private-ai-knowledge/index.ts` as the `private-ai-knowledge` Edge Function.
5. Add a long random `PRIVATE_AI_INTERNAL_TOKEN` to the Edge Function secrets.
6. Deploy the repository as a Cloudflare Worker with static assets.
7. Add the server-side secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `PRIVATE_AI_INTERNAL_TOKEN`.
8. Leave `OPENROUTER_ENABLED=false` until the dedicated OpenRouter key is added.
9. Add `OPENROUTER_API_KEY`, then intentionally set `OPENROUTER_ENABLED=true`.
10. Put the site behind Cloudflare Access and allow only your account.

## Spend protection

Two independent controls prevent surprise usage:

- `OPENROUTER_ENABLED=false` means chat calls cannot reach OpenRouter at all.
- `DAILY_SPEND_LIMIT_USD=1.00` blocks new requests after the rolling 24-hour app ledger reaches the configured cap.

Knowledge ingestion uses Supabase embeddings rather than OpenRouter, so importing notes does not consume OpenRouter chat credits.

## Knowledge ingestion

Text is split into overlapping chunks, stored first, then embedded in resumable batches. This is deliberately designed for long transcripts and course material so one timeout does not discard the whole import.

Current direct file support is text-based: TXT, Markdown, CSV, JSON, HTML, logs, code, SQL, CSS, and other browser-readable text files. PDF/DOCX extraction is the next ingestion upgrade rather than pretending binary documents are plain text.

## Product roadmap

See [ROADMAP.md](./ROADMAP.md) for the 14-step reliability and capability roadmap. AI-generated courses are intentionally not part of the plan.
