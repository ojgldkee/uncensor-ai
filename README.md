# Uncensor AI

A private, single-user, mobile-first AI workspace with persistent chats, long-term memory, a global Knowledge library, current-web research, and multiple OpenRouter models.

## Current capabilities

- Persistent chats with rename, pin, export, search, and permanent deletion
- Mobile-safe iPhone chat transport plus desktop streaming
- Rolling long-chat summaries
- Cross-chat long-term memory
- Global Knowledge library with background indexing
- Large HTML/text ingestion with saved-page cleanup
- Searchable scanned/screenshot PDFs with automatic page-level OCR and extraction quality checks
- Batch video/audio Knowledge uploads with timestamped background analysis
- Exact duplicate-file blocking with SHA-256
- Batched OpenRouter embeddings + pgvector retrieval
- Multiple models including DeepSeek, Venice Uncensored, GLM, Kimi, and multimodal routing
- Current-web research using OpenRouter web search/fetch
- Multiple-source comparison and clickable citations
- Save researched web sources into Knowledge
- Privacy firewall that sanitizes public search queries before external search
- Revocable 30-day device sessions
- Private attachment storage
- Server-side spend limits and request throttling
- Background worker health tracking and automatic retries

## Privacy model

The GitHub Pages frontend contains no Supabase service-role key, OpenRouter key, Vault data key, or private database content.

Private database tables are not granted to anonymous/authenticated client roles. Attachments live in a non-public Supabase Storage bucket.

The master enrollment key is used only to enroll a device. The browser then receives a revocable device session token; only its hash is stored in the database.

High-value stored content is application-encrypted before it rests in the database:

- chat message bodies
- long-term memory content
- rolling conversation summaries
- Knowledge chunk text

The random encryption key is generated inside Supabase and stored in Supabase Vault. Server-only functions/views decrypt content when the AI needs to process it.

Private model requests require OpenRouter Zero Data Retention routing and data_collection: deny. Web research is intentionally separated: the external search stage receives a privacy-firewalled public query, not private Memory or Knowledge. Private context is merged later during synthesis.

This is intentionally stronger than relying only on database disk encryption, but it is not client-only end-to-end encryption. The trusted server must be able to decrypt selected content for background memory, indexing, retrieval, and summarization.

## Web Research

Turn Web on in chat.

Research flow:

private question → privacy firewall/redaction → sanitized public query → OpenRouter web search/fetch → multiple public sources → private Knowledge + relevant Memory → private synthesis model → cited answer

No Gemini API key is required. The existing OpenRouter key powers both model inference and current-web research.

## Knowledge

Knowledge can be global or assigned to individual specialist chats. Direct ingestion supports websites, text/HTML/code, subtitle transcripts (SRT/VTT), and PDFs. HTML saved-page exports are cleaned before indexing so embedded images, scripts, CSS, and base64 payloads do not pollute retrieval.

PDF.js extracts selectable PDF text locally. Pages containing screenshots with too little selectable text are rendered one at a time and passed to Tesseract.js v6 for browser-local English OCR; the result is checked for legible content, given page citations, and uploaded as text for background embedding. OCR itself uses no external AI API credits. Keep the tab open until PDF scanning and upload finish; only subsequent embedding is server-side. Large screenshot PDFs may take time on iPhone.

Knowledge media uploads allow up to 10 files per batch (100 MB per video, 16 MB per audio file). Files up to 16 MB can receive separate audio transcription; Full mode can also analyze visuals. Larger videos receive visual analysis only, which may not capture every spoken word. For complete long-course spoken content, upload the course's TXT/SRT/VTT captions alongside the video. Source media is deleted after processing, and exact-duplicate files are skipped.

Exact duplicate files are blocked by SHA-256 even if renamed.

## Cost protection

The backend enforces a rolling spend ceiling and request-rate limits. Embedding, chat, memory, summary, and research usage are recorded separately so costs can be audited.

## Reliability

The background worker uses leased batched indexing instead of one queue job per chunk. Cron runs every 10 seconds, worker health is recorded, jobs are retried, and the client can restore server-saved responses after network interruption.

## Product roadmap

See ROADMAP.md. AI-generated courses are intentionally excluded.
