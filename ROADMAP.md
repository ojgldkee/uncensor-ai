# Uncensor AI — 14-step product and reliability roadmap

This roadmap intentionally **does not include AI-generated courses**.

## 1. Bulletproof chat transport
- iPhone/iPad use a Safari/WebKit-safe JSON completion path.
- Desktop keeps streaming responses.
- Preserve Stop/abort.
- Recover saved server answers after client/network interruption.
- Idempotent request handling so retries never create duplicate user/assistant messages.
- Continue/regenerate actions on failed or interrupted responses.

## 2. Hybrid knowledge retrieval
- Combine pgvector semantic search with Postgres full-text/keyword search.
- Merge and deduplicate candidates.
- Add a lightweight reranker.
- Prefer exact passages when a query contains names, numbers, quoted phrases, or technical terms.
- Surface retrieval confidence and source titles.

## 3. Universal file ingestion
- PDF, DOCX, PPTX, TXT, Markdown, CSV, JSON, HTML, and code files.
- Extract text server-side.
- Keep file metadata, page/slide numbers, headings, and source locations.
- Detect unsupported/corrupt files gracefully.
- Durable background processing and retry.

## 4. Web research mode
- Search the public web from a dedicated research action.
- Fetch and compare multiple sources.
- Return citations.
- Let the user save selected research directly into Knowledge.
- Keep research separate from private memory unless explicitly saved.

## 5. URL / website ingestion
- Paste a URL and ingest a page into Knowledge.
- Optional same-domain crawl with limits.
- Canonical URL normalization.
- Duplicate-page detection.
- Re-crawl/update an existing source instead of duplicating it.

## 6. Structured long-term memory
- Separate memory into preferences, goals, projects, decisions, routines, people, background, and standing instructions.
- Per-category importance and confidence.
- Pin, edit, disable, or permanently delete memories.
- Use semantic retrieval so only relevant memories enter a prompt.

## 7. Contradiction and supersession handling
- Detect when a new confirmed fact conflicts with an old memory.
- Mark old memories superseded instead of keeping contradictory active facts.
- Keep a provenance trail to the source chat.
- Never silently infer sensitive traits.

## 8. Projects, folders, and chat organization
- Projects/folders for large numbers of chats.
- Move chats between projects.
- Pin/favorite/archive.
- Bulk delete/archive.
- Per-project custom instructions and knowledge scope.

## 9. Global search
- Search chat titles, message bodies, memories, and knowledge from one interface.
- Exact phrase + semantic search.
- Filters by project, date, source type, and content type.
- Jump directly to the matching message/source.

## 10. Conversation branching and recovery
- Branch from any message into a new chat.
- Preserve the original conversation.
- Regenerate an answer without losing the prior version.
- Restore the latest server-saved response after refresh/network loss.

## 11. Multimodal input
- Image/screenshot upload for supported vision models.
- Image + text in the same message.
- Store image metadata without exposing provider secrets.
- Future audio attachment support.

## 12. Voice mode
- Speech-to-text input on mobile.
- Optional spoken responses.
- Save the transcript as normal chat history.
- Voice can use the same memory/knowledge context as text chat.

## 13. Intelligent model router
- Auto-select model by task: fast chat, long context, coding, deep reasoning, vision.
- User can always override.
- Provider/model health scoring.
- Automatic provider/model fallback.
- Cost-aware routing with a quality floor.

## 14. Reliability, observability, and recovery
- Health dashboard: API, worker, queue, OpenRouter, embeddings, database.
- Error logs with request ID, model, latency, status, fallback count, and operation.
- Automated end-to-end smoke tests after deploys.
- Backup/recovery for chats, memories, and knowledge.
- Queue dead-letter review and retry.
- Spend dashboard and alerts.
- Hard OpenRouter key limit plus app-side rolling cap.
- Versioned database migrations.
- Deployment rollback if health checks fail.

## Current status

Already live:
- Supabase chat API
- OpenRouter chat
- server-side access key
- origin lock
- rolling 24-hour spend cap
- request throttling
- saved chats
- rename/pin/permanent delete
- rolling chat summaries
- cross-chat long-term memory
- memory manager
- semantic knowledge retrieval
- background indexing queue
- retries
- duplicate source detection
- worker heartbeat
- model/provider fallback
- mobile-safe non-stream chat path
- desktop streaming path

Next implementation priority:
1. idempotent chat request IDs
2. hybrid retrieval
3. PDF/DOCX/PPTX ingestion
4. global search
5. contradiction-aware memory
6. health dashboard + automated smoke tests
