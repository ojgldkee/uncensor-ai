-- Run in the private Uncensor AI Supabase project.
-- Full-library, similarity-ranked retrieval for authenticated server-side diagnosis.
-- Leaves chat-specific and global settings unchanged for normal requests.
create or replace function public.private_ai_match_chunks_library_v1(
  query_embedding vector,
  match_count integer default 80,
  similarity_threshold double precision default 0.19
)
returns table(id bigint,source_id uuid,title text,content text,chunk_index integer,similarity double precision)
language sql stable security invoker set search_path = ''
as $function$
  with nearest as materialized (
    select c.id,c.source_id,
      public.private_ai_decrypt_text(s.title) as title,
      public.private_ai_decrypt_text(c.content) as content,
      c.chunk_index,
      1-(c.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
    from public.private_ai_knowledge_chunks c
    join public.private_ai_knowledge_sources s on s.id=c.source_id
    where s.status='ready' and s.enabled=true and c.embedding is not null
      and 1-(c.embedding OPERATOR(extensions.<=>) query_embedding)>=similarity_threshold
    order by c.embedding OPERATOR(extensions.<=>) query_embedding
    limit 350
  ), diversified as (
    select n.*,row_number() over(partition by n.source_id order by n.similarity desc) as source_rank
    from nearest n
  )
  select d.id,d.source_id,d.title,d.content,d.chunk_index,d.similarity
  from diversified d where d.source_rank<=8
  order by d.similarity desc
  limit greatest(1,least(match_count,100));
$function$;

-- Only the app's authenticated Edge Function (service role) may call this RPC.
revoke all on function public.private_ai_match_chunks_library_v1(vector,integer,double precision)
  from public,anon,authenticated;
grant execute on function public.private_ai_match_chunks_library_v1(vector,integer,double precision)
  to service_role;
