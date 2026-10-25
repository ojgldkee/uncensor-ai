# Next deployment steps

## Before tomorrow

The code is safe to keep deployed with `OPENROUTER_ENABLED=false`; no chat request can spend OpenRouter credits while that switch is false.

## Tomorrow

1. Make `ojgldkee/uncensor-ai` **private** in GitHub.
2. Create a new Supabase project dedicated to Uncensor AI.
3. Run `supabase/schema.sql`.
4. Deploy the `private-ai-knowledge` Edge Function.
5. Create matching `PRIVATE_AI_INTERNAL_TOKEN` secrets in Supabase + Cloudflare.
6. Deploy to Cloudflare.
7. Protect the domain with Cloudflare Access (only your account).
8. Create a dedicated OpenRouter key for this app.
9. Add it only as the Cloudflare secret `OPENROUTER_API_KEY`.
10. Verify `DAILY_SPEND_LIMIT_USD`, then set `OPENROUTER_ENABLED=true`.
11. Test one cheap chat first, then test Kimi only after usage/cost logging is confirmed.

## Next product upgrades after deployment

- PDF and DOCX extraction
- URL / website ingestion
- Web research with citations
- Hybrid keyword + vector retrieval and reranking
- Image input for multimodal models
- Conversation folders/tags
- Automatic knowledge collections
- Optional local/self-hosted model backend so OpenRouter is not required
