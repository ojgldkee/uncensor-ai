-- Uncensor AI v3 backend: rolling summaries, durable memory, duplicate-safe knowledge, background queue.
-- Apply to the dedicated "uncensored ai" Supabase project only.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.private_ai_conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  pinned boolean not null default false,
  rolling_summary text not null default '',
  summary_through_message_count integer not null default 0,
  summary_version integer not null default 0,
  summary_updated_at timestamptz,
  total_message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.private_ai_conversations add column if not exists rolling_summary text not null default '';
alter table public.private_ai_conversations add column if not exists summary_through_message_count integer not null default 0;
alter table public.private_ai_conversations add column if not exists summary_version integer not null default 0;
alter table public.private_ai_conversations add column if not exists summary_updated_at timestamptz;
alter table public.private_ai_conversations add column if not exists total_message_count integer not null default 0;
create index if not exists private_ai_conversations_sort_idx on public.private_ai_conversations(pinned desc, updated_at desc);

create table if not exists public.private_ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.private_ai_conversations(id) on delete cascade,
  sequence_no bigint generated always as identity,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  model text,
  sources jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.private_ai_messages add column if not exists attachments jsonb not null default '[]'::jsonb;
create index if not exists private_ai_messages_conversation_created_idx on public.private_ai_messages(conversation_id, created_at);
create index if not exists private_ai_messages_sequence_idx on public.private_ai_messages(conversation_id, sequence_no);

create table if not exists public.private_ai_memories (
  id uuid primary key default gen_random_uuid(),
  memory_key text not null,
  content text not null,
  category text not null default 'general',
  importance smallint not null default 5 check (importance between 1 and 10),
  confidence numeric(4,3) not null default 0.8 check (confidence between 0 and 1),
  active boolean not null default true,
  pinned boolean not null default false,
  source_conversation_id uuid references public.private_ai_conversations(id) on delete set null,
  source_message_id uuid references public.private_ai_messages(id) on delete set null,
  embedding extensions.vector(384),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(memory_key)
);
create index if not exists private_ai_memories_active_idx on public.private_ai_memories(active, pinned desc, importance desc, updated_at desc);
create index if not exists private_ai_memories_conversation_idx on public.private_ai_memories(source_conversation_id);
create index if not exists private_ai_memories_message_idx on public.private_ai_memories(source_message_id);
create index if not exists private_ai_memories_hnsw_idx on public.private_ai_memories using hnsw (embedding vector_cosine_ops);

create table if not exists public.private_ai_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type text not null default 'paste',
  enabled boolean not null default true,
  content_hash text not null,
  char_count integer not null default 0,
  chunk_count integer not null default 0,
  embedded_chunk_count integer not null default 0,
  status text not null default 'queued',
  failure_count integer not null default 0,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.private_ai_knowledge_sources add column if not exists content_hash text;
alter table public.private_ai_knowledge_sources add column if not exists embedded_chunk_count integer not null default 0;
alter table public.private_ai_knowledge_sources add column if not exists failure_count integer not null default 0;
alter table public.private_ai_knowledge_sources add column if not exists last_error text;
alter table public.private_ai_knowledge_sources add column if not exists completed_at timestamptz;
create unique index if not exists private_ai_knowledge_content_hash_unique on public.private_ai_knowledge_sources(content_hash) where content_hash is not null;
create index if not exists private_ai_knowledge_status_idx on public.private_ai_knowledge_sources(status, updated_at);

create table if not exists public.private_ai_knowledge_chunks (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.private_ai_knowledge_sources(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  content_hash text not null,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  unique(source_id, chunk_index)
);
alter table public.private_ai_knowledge_chunks add column if not exists content_hash text;
create index if not exists private_ai_knowledge_chunks_source_idx on public.private_ai_knowledge_chunks(source_id, chunk_index);
create index if not exists private_ai_knowledge_chunks_hash_idx on public.private_ai_knowledge_chunks(content_hash);
create index if not exists private_ai_knowledge_hnsw_idx on public.private_ai_knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists public.private_ai_usage (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.private_ai_conversations(id) on delete set null,
  model text not null,
  operation text not null default 'chat',
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
alter table public.private_ai_usage add column if not exists operation text not null default 'chat';
create index if not exists private_ai_usage_created_idx on public.private_ai_usage(created_at desc);
create index if not exists private_ai_usage_conversation_idx on public.private_ai_usage(conversation_id);


create table if not exists public.private_ai_request_buckets (
  window_type text not null check (window_type in ('minute','day')),
  bucket_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (window_type, bucket_start)
);
alter table public.private_ai_request_buckets enable row level security;
revoke all on table public.private_ai_request_buckets from anon, authenticated;
grant select, insert, update, delete on table public.private_ai_request_buckets to service_role;

create or replace function public.private_ai_take_rate_limit(
  minute_limit integer default 12,
  day_limit integer default 400
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $
declare
  minute_bucket timestamptz := date_trunc('minute', now());
  day_bucket timestamptz := date_trunc('day', now());
  minute_count integer;
  day_count integer;
begin
  insert into public.private_ai_request_buckets(window_type,bucket_start,request_count,updated_at)
  values ('minute',minute_bucket,1,now())
  on conflict (window_type,bucket_start)
  do update set request_count=public.private_ai_request_buckets.request_count+1, updated_at=now()
  returning request_count into minute_count;

  insert into public.private_ai_request_buckets(window_type,bucket_start,request_count,updated_at)
  values ('day',day_bucket,1,now())
  on conflict (window_type,bucket_start)
  do update set request_count=public.private_ai_request_buckets.request_count+1, updated_at=now()
  returning request_count into day_count;

  return minute_count <= greatest(minute_limit,1)
     and day_count <= greatest(day_limit,1);
end;
$;
revoke all on function public.private_ai_take_rate_limit(integer,integer) from public,anon,authenticated;
grant execute on function public.private_ai_take_rate_limit(integer,integer) to service_role;

create table if not exists public.private_ai_runtime_config (
  id boolean primary key default true check (id),
  project_url text,
  worker_token text,
  access_token_hash text,
  summary_trigger_messages integer not null default 24,
  memory_trigger_messages integer not null default 6,
  last_worker_run_at timestamptz,
  last_worker_success_at timestamptz,
  last_worker_error text,
  backend_version text not null default 'v3',
  updated_at timestamptz not null default now()
);
alter table public.private_ai_runtime_config add column if not exists last_worker_run_at timestamptz;
alter table public.private_ai_runtime_config add column if not exists last_worker_success_at timestamptz;
alter table public.private_ai_runtime_config add column if not exists last_worker_error text;
alter table public.private_ai_runtime_config add column if not exists backend_version text not null default 'v3';
insert into public.private_ai_runtime_config(id) values (true) on conflict (id) do nothing;

alter table public.private_ai_conversations enable row level security;
alter table public.private_ai_messages enable row level security;
alter table public.private_ai_memories enable row level security;
alter table public.private_ai_knowledge_sources enable row level security;
alter table public.private_ai_knowledge_chunks enable row level security;
alter table public.private_ai_usage enable row level security;
alter table public.private_ai_runtime_config enable row level security;

-- These tables are server-side only. No anon/authenticated policies are intentionally created.
revoke all on table public.private_ai_conversations from anon, authenticated;
revoke all on table public.private_ai_messages from anon, authenticated;
revoke all on table public.private_ai_memories from anon, authenticated;
revoke all on table public.private_ai_knowledge_sources from anon, authenticated;
revoke all on table public.private_ai_knowledge_chunks from anon, authenticated;
revoke all on table public.private_ai_usage from anon, authenticated;
revoke all on table public.private_ai_runtime_config from anon, authenticated;

grant select, insert, update, delete on table public.private_ai_conversations to service_role;
grant select, insert, update, delete on table public.private_ai_messages to service_role;
grant select, insert, update, delete on table public.private_ai_memories to service_role;
grant select, insert, update, delete on table public.private_ai_knowledge_sources to service_role;
grant select, insert, update, delete on table public.private_ai_knowledge_chunks to service_role;
grant select, insert, update, delete on table public.private_ai_usage to service_role;
grant select, insert, update, delete on table public.private_ai_runtime_config to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.private_ai_match_chunks(
  query_embedding extensions.vector(384),
  match_count integer default 10,
  similarity_threshold double precision default 0.25
)
returns table (
  id bigint,
  source_id uuid,
  title text,
  content text,
  chunk_index integer,
  similarity double precision
)
language sql stable set search_path = ''
as $$
  select c.id,c.source_id,s.title,c.content,c.chunk_index,
         1 - (c.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.private_ai_knowledge_chunks c
  join public.private_ai_knowledge_sources s on s.id=c.source_id
  where s.status='ready' and s.enabled=true and c.embedding is not null
    and 1 - (c.embedding OPERATOR(extensions.<=>) query_embedding) >= similarity_threshold
  order by c.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(match_count,30));
$$;

create or replace function public.private_ai_match_memories(
  query_embedding extensions.vector(384),
  match_count integer default 12,
  similarity_threshold double precision default 0.24
)
returns table (
  id uuid,
  memory_key text,
  content text,
  category text,
  importance smallint,
  pinned boolean,
  similarity double precision
)
language sql stable set search_path = ''
as $$
  select m.id,m.memory_key,m.content,m.category,m.importance,m.pinned,
         1 - (m.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.private_ai_memories m
  where m.active=true and m.embedding is not null
    and (m.pinned=true or 1 - (m.embedding OPERATOR(extensions.<=>) query_embedding) >= similarity_threshold)
  order by m.pinned desc, m.importance desc, m.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(match_count,30));
$$;

-- Create one durable queue. If it already exists, ignore only the duplicate-object case.
do $$
begin
  perform pgmq.create('uncensor_jobs');
exception
  when duplicate_table then null;
  when duplicate_object then null;
end $$;

create or replace function public.private_ai_enqueue_job(job jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pgmq.send('uncensor_jobs', job);
$$;

create or replace function public.private_ai_read_jobs(qty integer default 8, visibility_seconds integer default 180)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb,
  headers jsonb
)
language sql
security definer
set search_path = ''
as $$
  select * from pgmq.read('uncensor_jobs', visibility_seconds, greatest(1,least(qty,50)), '{}'::jsonb);
$$;

create or replace function public.private_ai_delete_job(job_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pgmq.delete('uncensor_jobs', job_id);
$$;

create or replace function public.private_ai_archive_job(job_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pgmq.archive('uncensor_jobs', job_id);
$$;

create or replace function public.private_ai_validate_access_token(candidate text)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(
    encode(extensions.digest(candidate,'sha256'),'hex') =
      (select access_token_hash from public.private_ai_runtime_config where id=true),
    false
  );
$$;

-- Keep message counts accurate and enqueue background summarization/memory extraction.
create or replace function public.private_ai_after_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.private_ai_runtime_config%rowtype;
  conv public.private_ai_conversations%rowtype;
begin
  update public.private_ai_conversations
     set total_message_count=total_message_count+1,
         updated_at=now()
   where id=new.conversation_id
   returning * into conv;

  select * into cfg from public.private_ai_runtime_config where id=true;

  if conv.total_message_count - conv.summary_through_message_count >= cfg.summary_trigger_messages
     and mod(conv.total_message_count - conv.summary_through_message_count, greatest(cfg.summary_trigger_messages,1)) = 0 then
    perform pgmq.send('uncensor_jobs', jsonb_build_object(
      'type','summarize_conversation',
      'conversation_id',new.conversation_id,
      'target_message_count',conv.total_message_count
    ));
  end if;

  if new.role='assistant' and mod(conv.total_message_count, greatest(cfg.memory_trigger_messages,2)) = 0 then
    perform pgmq.send('uncensor_jobs', jsonb_build_object(
      'type','extract_memories',
      'conversation_id',new.conversation_id,
      'through_message_count',conv.total_message_count
    ));
  end if;

  return new;
end;
$$;

drop trigger if exists private_ai_after_message_trigger on public.private_ai_messages;
create trigger private_ai_after_message_trigger
after insert on public.private_ai_messages
for each row execute function public.private_ai_after_message();

-- Enqueue knowledge chunks automatically; the UI does not need to stay open.
create or replace function public.private_ai_after_knowledge_chunk()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pgmq.send('uncensor_jobs', jsonb_build_object(
    'type','embed_knowledge_chunk',
    'chunk_id',new.id,
    'source_id',new.source_id
  ));
  return new;
end;
$$;

drop trigger if exists private_ai_knowledge_queue_trigger on public.private_ai_knowledge_chunks;
create trigger private_ai_knowledge_queue_trigger
after insert on public.private_ai_knowledge_chunks
for each row execute function public.private_ai_after_knowledge_chunk();

-- Server-only functions.
revoke all on function public.private_ai_match_chunks(extensions.vector,integer,double precision) from public,anon,authenticated;
revoke all on function public.private_ai_match_memories(extensions.vector,integer,double precision) from public,anon,authenticated;
revoke all on function public.private_ai_enqueue_job(jsonb) from public,anon,authenticated;
revoke all on function public.private_ai_read_jobs(integer,integer) from public,anon,authenticated;
revoke all on function public.private_ai_delete_job(bigint) from public,anon,authenticated;
revoke all on function public.private_ai_archive_job(bigint) from public,anon,authenticated;
revoke all on function public.private_ai_validate_access_token(text) from public,anon,authenticated;
revoke all on function public.private_ai_after_message() from public,anon,authenticated;
revoke all on function public.private_ai_after_knowledge_chunk() from public,anon,authenticated;
grant execute on function public.private_ai_match_chunks(extensions.vector,integer,double precision) to service_role;
grant execute on function public.private_ai_match_memories(extensions.vector,integer,double precision) to service_role;
grant execute on function public.private_ai_enqueue_job(jsonb) to service_role;
grant execute on function public.private_ai_read_jobs(integer,integer) to service_role;
grant execute on function public.private_ai_delete_job(bigint) to service_role;
grant execute on function public.private_ai_archive_job(bigint) to service_role;
grant execute on function public.private_ai_validate_access_token(text) to service_role;

-- Worker dispatcher. project_url + worker_token are populated after project connection.
create or replace function public.private_ai_dispatch_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.private_ai_runtime_config%rowtype;
  request_id bigint;
begin
  select * into cfg from public.private_ai_runtime_config where id=true;
  if cfg.project_url is null or cfg.worker_token is null then return null; end if;
  select net.http_post(
    url := rtrim(cfg.project_url,'/') || '/functions/v1/uncensor-worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-worker-token',cfg.worker_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function public.private_ai_dispatch_worker() from public,anon,authenticated;
grant execute on function public.private_ai_dispatch_worker() to service_role;

-- Cron: every 15 seconds, dispatch a worker batch. Re-running this setup replaces the named job.
select cron.schedule(
  'uncensor-ai-background-worker',
  '15 seconds',
  $$ select public.private_ai_dispatch_worker(); $$
);


-- Private attachment storage for chat media. Provisioned by migration so the API never
-- needs to create infrastructure dynamically at request time.
insert into storage.buckets (id,name,public,file_size_limit)
values ('private-ai-attachments','private-ai-attachments',false,104857600)
on conflict (id) do update
set public=false,
    file_size_limit=104857600,
    updated_at=now();


-- v4 batched indexing architecture
-- Knowledge embeddings are claimed directly in batches instead of creating one PGMQ
-- message per chunk. This avoids Edge Function resource exhaustion on large libraries.
alter table public.private_ai_knowledge_chunks
  add column if not exists embedding_claimed_at timestamptz;

create index if not exists private_ai_knowledge_unembedded_idx
  on public.private_ai_knowledge_chunks(id)
  where embedding is null;

drop trigger if exists private_ai_knowledge_queue_trigger on public.private_ai_knowledge_chunks;

create or replace function public.private_ai_claim_knowledge_chunks(
  batch_size integer default 192,
  lease_seconds integer default 180
)
returns table(id bigint, source_id uuid, content text)
language plpgsql
security definer
set search_path=''
as $$
begin
  return query
  with picked as (
    select c.id
    from public.private_ai_knowledge_chunks c
    join public.private_ai_knowledge_sources s on s.id=c.source_id
    where c.embedding is null
      and s.enabled=true
      and s.status in ('queued','processing')
      and (
        c.embedding_claimed_at is null
        or c.embedding_claimed_at < now() - ((greatest(lease_seconds,30)::text || ' seconds')::interval)
      )
    order by c.id
    for update of c skip locked
    limit greatest(1,least(batch_size,512))
  )
  update public.private_ai_knowledge_chunks c
     set embedding_claimed_at=now()
    from picked p
   where c.id=p.id
  returning c.id,c.source_id,c.content;
end;
$$;

create or replace function public.private_ai_set_chunk_embeddings(payload jsonb)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare changed integer;
begin
  with rows as (
    select x.id,x.embedding
    from pg_catalog.jsonb_to_recordset(payload) as x(id bigint,embedding text)
  )
  update public.private_ai_knowledge_chunks c
     set embedding=cast(rows.embedding as extensions.vector),
         embedding_claimed_at=null
    from rows
   where c.id=rows.id;
  get diagnostics changed=row_count;
  return changed;
end;
$$;

create or replace function public.private_ai_set_memory_embeddings(payload jsonb)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare changed integer;
begin
  with rows as (
    select x.id,x.embedding
    from pg_catalog.jsonb_to_recordset(payload) as x(id uuid,embedding text)
  )
  update public.private_ai_memories m
     set embedding=cast(rows.embedding as extensions.vector),
         updated_at=now()
    from rows
   where m.id=rows.id;
  get diagnostics changed=row_count;
  return changed;
end;
$$;

create or replace function public.private_ai_refresh_knowledge_progress(source_ids uuid[])
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare changed integer;
begin
  with counts as (
    select c.source_id,
           count(*)::integer as total,
           count(*) filter (where c.embedding is not null)::integer as embedded
    from public.private_ai_knowledge_chunks c
    where c.source_id=any(source_ids)
    group by c.source_id
  )
  update public.private_ai_knowledge_sources s
     set embedded_chunk_count=counts.embedded,
         status=case when counts.total>0 and counts.embedded>=counts.total then 'ready' else 'processing' end,
         completed_at=case when counts.total>0 and counts.embedded>=counts.total then coalesce(s.completed_at,now()) else null end,
         last_error=null,
         updated_at=now()
    from counts
   where s.id=counts.source_id;
  get diagnostics changed=row_count;
  return changed;
end;
$$;

create or replace function public.private_ai_replace_knowledge_chunks(
  p_source_id uuid,
  p_content_hash text,
  p_char_count integer,
  p_chunks jsonb,
  p_metadata jsonb
)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare inserted integer;
begin
  delete from public.private_ai_knowledge_chunks where source_id=p_source_id;

  insert into public.private_ai_knowledge_chunks(source_id,chunk_index,content,content_hash)
  select p_source_id,x.chunk_index,x.content,x.content_hash
  from pg_catalog.jsonb_to_recordset(p_chunks)
    as x(chunk_index integer,content text,content_hash text);

  get diagnostics inserted=row_count;

  update public.private_ai_knowledge_sources
     set content_hash=p_content_hash,
         char_count=p_char_count,
         chunk_count=inserted,
         embedded_chunk_count=0,
         status=case when inserted>0 then 'processing' else 'failed' end,
         completed_at=null,
         failure_count=0,
         last_error=case when inserted>0 then null else 'No readable text found after HTML cleanup' end,
         metadata=coalesce(p_metadata,'{}'::jsonb),
         updated_at=now()
   where id=p_source_id;

  return inserted;
end;
$$;

revoke all on function public.private_ai_claim_knowledge_chunks(integer,integer) from public,anon,authenticated;
revoke all on function public.private_ai_set_chunk_embeddings(jsonb) from public,anon,authenticated;
revoke all on function public.private_ai_set_memory_embeddings(jsonb) from public,anon,authenticated;
revoke all on function public.private_ai_refresh_knowledge_progress(uuid[]) from public,anon,authenticated;
revoke all on function public.private_ai_replace_knowledge_chunks(uuid,text,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.private_ai_claim_knowledge_chunks(integer,integer) to service_role;
grant execute on function public.private_ai_set_chunk_embeddings(jsonb) to service_role;
grant execute on function public.private_ai_set_memory_embeddings(jsonb) to service_role;
grant execute on function public.private_ai_refresh_knowledge_progress(uuid[]) to service_role;
grant execute on function public.private_ai_replace_knowledge_chunks(uuid,text,integer,jsonb,jsonb) to service_role;

update public.private_ai_runtime_config
set backend_version='v4',updated_at=now()
where id=true;

select cron.unschedule(jobid)
from cron.job
where jobname='uncensor-ai-background-worker';

select cron.schedule(
  'uncensor-ai-background-worker',
  '10 seconds',
  $$ select public.private_ai_dispatch_worker(); $$
);


-- Exact duplicate-file protection.
alter table public.private_ai_knowledge_sources
  add column if not exists file_sha256 text;

create unique index if not exists private_ai_knowledge_file_sha256_uidx
  on public.private_ai_knowledge_sources(file_sha256)
  where source_type='file' and file_sha256 is not null;


-- Revocable private device sessions. The master access key is used only to enroll a
-- browser/device; the browser then stores a revocable 30-day session token instead.
create table if not exists public.private_ai_device_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  device_name text not null default 'Private device',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz
);
alter table public.private_ai_device_sessions enable row level security;
revoke all on table public.private_ai_device_sessions from anon, authenticated;
grant select, insert, update, delete on table public.private_ai_device_sessions to service_role;
create index if not exists private_ai_device_sessions_active_idx
  on public.private_ai_device_sessions(expires_at, revoked_at);

create or replace function public.private_ai_create_device_session(
  candidate text,
  requested_device_name text default 'Private device'
)
returns table(id uuid, session_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path=''
as $$
declare
  token text := encode(extensions.gen_random_bytes(32),'hex');
  new_id uuid := extensions.gen_random_uuid();
  exp timestamptz := now() + interval '30 days';
begin
  if not public.private_ai_validate_access_token(candidate) then return; end if;
  insert into public.private_ai_device_sessions(id,token_hash,device_name,expires_at)
  values (
    new_id,
    encode(extensions.digest(token,'sha256'),'hex'),
    left(coalesce(nullif(trim(requested_device_name),''),'Private device'),120),
    exp
  );
  return query select new_id,token,exp;
end;
$$;

create or replace function public.private_ai_validate_device_session(candidate text)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare hashed text; found_id uuid;
begin
  if candidate is null or length(candidate)<32 then return false; end if;
  hashed:=encode(extensions.digest(candidate,'sha256'),'hex');
  update public.private_ai_device_sessions
     set last_seen_at=now()
   where token_hash=hashed and revoked_at is null and expires_at>now()
  returning id into found_id;
  return found_id is not null;
end;
$$;

revoke all on function public.private_ai_create_device_session(text,text) from public,anon,authenticated;
revoke all on function public.private_ai_validate_device_session(text) from public,anon,authenticated;
grant execute on function public.private_ai_create_device_session(text,text) to service_role;
grant execute on function public.private_ai_validate_device_session(text) to service_role;


-- v5 privacy hardening
-- Core private text is encrypted in Postgres using a random data key stored in
-- Supabase Vault. Vault's root key is kept separately from database data.
do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name='private_ai_data_key') then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(48),'hex'),
      'private_ai_data_key',
      'Uncensor AI content encryption key'
    );
  end if;
end $$;

create or replace function public.private_ai_data_key()
returns text language sql stable security definer set search_path=''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name='private_ai_data_key' limit 1
$$;

create or replace function public.private_ai_encrypt_text(value text)
returns text language plpgsql security definer set search_path=''
as $$
declare k text;
begin
  if value is null then return null; end if;
  if value like 'enc:v1:%' then return value; end if;
  k:=public.private_ai_data_key();
  if k is null then raise exception 'private_ai_data_key missing'; end if;
  return 'enc:v1:' || pg_catalog.encode(
    extensions.pgp_sym_encrypt(value,k,'cipher-algo=aes256,compress-algo=1'),'base64'
  );
end;
$$;

create or replace function public.private_ai_decrypt_text(value text)
returns text language plpgsql stable security definer set search_path=''
as $$
declare k text;
begin
  if value is null then return null; end if;
  if value not like 'enc:v1:%' then return value; end if;
  k:=public.private_ai_data_key();
  if k is null then raise exception 'private_ai_data_key missing'; end if;
  return extensions.pgp_sym_decrypt(pg_catalog.decode(substr(value,8),'base64'),k);
exception when others then
  return '[encrypted content unavailable]';
end;
$$;

revoke all on function public.private_ai_data_key() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_text(text) from public,anon,authenticated;
revoke all on function public.private_ai_decrypt_text(text) from public,anon,authenticated;
grant execute on function public.private_ai_encrypt_text(text) to service_role;
grant execute on function public.private_ai_decrypt_text(text) to service_role;

create or replace function public.private_ai_encrypt_message_content()
returns trigger language plpgsql security definer set search_path=''
as $$ begin new.content:=public.private_ai_encrypt_text(new.content); return new; end $$;
create or replace function public.private_ai_encrypt_memory_content()
returns trigger language plpgsql security definer set search_path=''
as $$ begin new.content:=public.private_ai_encrypt_text(new.content); return new; end $$;
create or replace function public.private_ai_encrypt_conversation_summary()
returns trigger language plpgsql security definer set search_path=''
as $$ begin if new.rolling_summary is not null then new.rolling_summary:=public.private_ai_encrypt_text(new.rolling_summary); end if; return new; end $$;
create or replace function public.private_ai_encrypt_chunk_content()
returns trigger language plpgsql security definer set search_path=''
as $$ begin new.content:=public.private_ai_encrypt_text(new.content); return new; end $$;

drop trigger if exists private_ai_encrypt_message_content_trigger on public.private_ai_messages;
create trigger private_ai_encrypt_message_content_trigger
before insert or update of content on public.private_ai_messages
for each row execute function public.private_ai_encrypt_message_content();

drop trigger if exists private_ai_encrypt_memory_content_trigger on public.private_ai_memories;
create trigger private_ai_encrypt_memory_content_trigger
before insert or update of content on public.private_ai_memories
for each row execute function public.private_ai_encrypt_memory_content();

drop trigger if exists private_ai_encrypt_conversation_summary_trigger on public.private_ai_conversations;
create trigger private_ai_encrypt_conversation_summary_trigger
before insert or update of rolling_summary on public.private_ai_conversations
for each row execute function public.private_ai_encrypt_conversation_summary();

drop trigger if exists private_ai_encrypt_chunk_content_trigger on public.private_ai_knowledge_chunks;
create trigger private_ai_encrypt_chunk_content_trigger
before insert or update of content on public.private_ai_knowledge_chunks
for each row execute function public.private_ai_encrypt_chunk_content();

update public.private_ai_messages set content=public.private_ai_encrypt_text(content)
where content is not null and content not like 'enc:v1:%';
update public.private_ai_memories set content=public.private_ai_encrypt_text(content)
where content is not null and content not like 'enc:v1:%';
update public.private_ai_conversations set rolling_summary=public.private_ai_encrypt_text(rolling_summary)
where rolling_summary is not null and rolling_summary not like 'enc:v1:%';
update public.private_ai_knowledge_chunks set content=public.private_ai_encrypt_text(content)
where content is not null and content not like 'enc:v1:%';

create or replace view public.private_ai_messages_read with (security_invoker=false) as
select id,conversation_id,role,public.private_ai_decrypt_text(content) as content,
       model,sources,attachments,created_at
from public.private_ai_messages;

create or replace view public.private_ai_conversations_read with (security_invoker=false) as
select id,title,pinned,public.private_ai_decrypt_text(rolling_summary) as rolling_summary,
       summary_through_message_count,summary_version,summary_updated_at,
       total_message_count,created_at,updated_at
from public.private_ai_conversations;

create or replace view public.private_ai_memories_read with (security_invoker=false) as
select id,memory_key,public.private_ai_decrypt_text(content) as content,
       category,importance,confidence,active,pinned,source_conversation_id,
       source_message_id,embedding,created_at,updated_at
from public.private_ai_memories;

create or replace view public.private_ai_knowledge_chunks_read with (security_invoker=false) as
select id,source_id,chunk_index,public.private_ai_decrypt_text(content) as content,
       content_hash,embedding,embedding_claimed_at,created_at
from public.private_ai_knowledge_chunks;

revoke all on public.private_ai_messages_read from public,anon,authenticated;
revoke all on public.private_ai_conversations_read from public,anon,authenticated;
revoke all on public.private_ai_memories_read from public,anon,authenticated;
revoke all on public.private_ai_knowledge_chunks_read from public,anon,authenticated;
grant select on public.private_ai_messages_read to service_role;
grant select on public.private_ai_conversations_read to service_role;
grant select on public.private_ai_memories_read to service_role;
grant select on public.private_ai_knowledge_chunks_read to service_role;

create or replace function public.private_ai_claim_knowledge_chunks(
  batch_size integer default 192, lease_seconds integer default 180
)
returns table(id bigint, source_id uuid, content text)
language plpgsql security definer set search_path=''
as $$
begin
  return query
  with picked as (
    select c.id
    from public.private_ai_knowledge_chunks c
    join public.private_ai_knowledge_sources s on s.id=c.source_id
    where c.embedding is null and s.enabled=true and s.status in ('queued','processing')
      and (c.embedding_claimed_at is null
        or c.embedding_claimed_at < now() - ((greatest(lease_seconds,30)::text || ' seconds')::interval))
    order by c.id
    for update of c skip locked
    limit greatest(1,least(batch_size,512))
  ),
  claimed as (
    update public.private_ai_knowledge_chunks c
       set embedding_claimed_at=now()
      from picked p where c.id=p.id
    returning c.id,c.source_id,c.content
  )
  select claimed.id,claimed.source_id,public.private_ai_decrypt_text(claimed.content)
  from claimed;
end;
$$;

create or replace function public.private_ai_match_chunks(
  query_embedding extensions.vector, match_count integer default 10,
  similarity_threshold double precision default 0.25
)
returns table(id bigint,source_id uuid,title text,content text,chunk_index integer,similarity double precision)
language sql stable security definer set search_path=''
as $$
  select c.id,c.source_id,s.title,public.private_ai_decrypt_text(c.content),c.chunk_index,
         1-(c.embedding OPERATOR(extensions.<=>) query_embedding)
  from public.private_ai_knowledge_chunks c
  join public.private_ai_knowledge_sources s on s.id=c.source_id
  where s.status='ready' and s.enabled=true and c.embedding is not null
    and 1-(c.embedding OPERATOR(extensions.<=>) query_embedding)>=similarity_threshold
  order by c.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(match_count,30));
$$;

create or replace function public.private_ai_match_memories(
  query_embedding extensions.vector, match_count integer default 12,
  similarity_threshold double precision default 0.24
)
returns table(id uuid,memory_key text,content text,category text,importance smallint,pinned boolean,similarity double precision)
language sql stable security definer set search_path=''
as $$
  select m.id,m.memory_key,public.private_ai_decrypt_text(m.content),m.category,m.importance,m.pinned,
         1-(m.embedding OPERATOR(extensions.<=>) query_embedding)
  from public.private_ai_memories m
  where m.active=true and m.embedding is not null
    and (m.pinned=true or 1-(m.embedding OPERATOR(extensions.<=>) query_embedding)>=similarity_threshold)
  order by m.pinned desc,m.importance desc,m.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(match_count,30));
$$;

revoke all on function public.private_ai_claim_knowledge_chunks(integer,integer) from public,anon,authenticated;
revoke all on function public.private_ai_match_chunks(extensions.vector,integer,double precision) from public,anon,authenticated;
revoke all on function public.private_ai_match_memories(extensions.vector,integer,double precision) from public,anon,authenticated;
grant execute on function public.private_ai_claim_knowledge_chunks(integer,integer) to service_role;
grant execute on function public.private_ai_match_chunks(extensions.vector,integer,double precision) to service_role;
grant execute on function public.private_ai_match_memories(extensions.vector,integer,double precision) to service_role;

-- Keep the worker authentication secret out of the runtime table too.
do $$
declare existing_token text;
begin
  if not exists(select 1 from vault.decrypted_secrets where name='private_ai_worker_token') then
    select worker_token into existing_token from public.private_ai_runtime_config where id=true;
    if existing_token is null or length(existing_token)<20 then
      existing_token:=pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
    end if;
    perform vault.create_secret(existing_token,'private_ai_worker_token','Uncensor AI background worker authentication');
  end if;
end $$;

create or replace function public.private_ai_worker_token()
returns text language sql stable security definer set search_path=''
as $$ select decrypted_secret from vault.decrypted_secrets where name='private_ai_worker_token' limit 1 $$;

create or replace function public.private_ai_validate_worker_token(candidate text)
returns boolean language sql stable security definer set search_path=''
as $$
  select candidate is not null and length(candidate)>=20
    and extensions.digest(candidate,'sha256')=extensions.digest(public.private_ai_worker_token(),'sha256')
$$;

create or replace function public.private_ai_dispatch_worker()
returns bigint language plpgsql security definer set search_path=''
as $$
declare project_url text; token text; request_id bigint;
begin
  select c.project_url into project_url from public.private_ai_runtime_config c where c.id=true;
  token:=public.private_ai_worker_token();
  if project_url is null or token is null then return null; end if;
  select net.http_post(
    url:=rtrim(project_url,'/')||'/functions/v1/uncensor-worker',
    headers:=jsonb_build_object('Content-Type','application/json','x-worker-token',token),
    body:='{}'::jsonb,timeout_milliseconds:=120000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.private_ai_worker_token() from public,anon,authenticated;
revoke all on function public.private_ai_validate_worker_token(text) from public,anon,authenticated;
grant execute on function public.private_ai_validate_worker_token(text) to service_role;

update public.private_ai_runtime_config
set worker_token=null,backend_version='v5-private',updated_at=now()
where id=true;

select cron.unschedule(jobid) from cron.job where jobname='uncensor-ai-background-worker';
select cron.schedule(
  'uncensor-ai-background-worker',
  '10 seconds',
  $$ select public.private_ai_dispatch_worker(); $$
);


-- Trigger helpers are invoked by PostgreSQL triggers only; never expose them through RPC.
revoke all on function public.private_ai_encrypt_message_content() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_memory_content() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_conversation_summary() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_chunk_content() from public,anon,authenticated;


-- v5.1 private metadata hardening
alter table public.private_ai_knowledge_sources
  add column if not exists title_hash text,
  add column if not exists file_size_bytes bigint;

create index if not exists private_ai_knowledge_title_size_idx
on public.private_ai_knowledge_sources(title_hash,file_size_bytes);

create or replace function public.private_ai_encrypt_json(value jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
begin
  if value is null then return null; end if;
  if value ? '_enc_v1' then return value; end if;
  return pg_catalog.jsonb_build_object('_enc_v1',public.private_ai_encrypt_text(value::text));
end;
$$;

create or replace function public.private_ai_decrypt_json(value jsonb)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare raw text;
begin
  if value is null then return null; end if;
  if not (value ? '_enc_v1') then return value; end if;
  raw:=public.private_ai_decrypt_text(value->>'_enc_v1');
  return raw::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

revoke all on function public.private_ai_encrypt_json(jsonb) from public,anon,authenticated;
revoke all on function public.private_ai_decrypt_json(jsonb) from public,anon,authenticated;
grant execute on function public.private_ai_encrypt_json(jsonb) to service_role;
grant execute on function public.private_ai_decrypt_json(jsonb) to service_role;

update public.private_ai_knowledge_sources
set title_hash=coalesce(title_hash,pg_catalog.encode(extensions.digest(public.private_ai_decrypt_text(title),'sha256'),'hex')),
    file_size_bytes=coalesce(
      file_size_bytes,
      case
        when (public.private_ai_decrypt_json(metadata)->>'file_size') ~ '^[0-9]+
create or replace function public.private_ai_encrypt_message_content()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  new.content:=public.private_ai_encrypt_text(new.content);
  new.sources:=public.private_ai_encrypt_json(coalesce(new.sources,'[]'::jsonb));
  new.attachments:=public.private_ai_encrypt_json(coalesce(new.attachments,'[]'::jsonb));
  return new;
end;
$$;

create or replace function public.private_ai_encrypt_conversation_summary()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.title is not null then new.title:=public.private_ai_encrypt_text(new.title); end if;
  if new.rolling_summary is not null then new.rolling_summary:=public.private_ai_encrypt_text(new.rolling_summary); end if;
  return new;
end;
$$;

create or replace function public.private_ai_encrypt_knowledge_source()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.title is not null and new.title not like 'enc:v1:%' then
    new.title_hash:=pg_catalog.encode(extensions.digest(new.title,'sha256'),'hex');
    new.title:=public.private_ai_encrypt_text(new.title);
  end if;
  if new.metadata is not null and not (new.metadata ? '_enc_v1') then
    if new.metadata ? 'file_size' and (new.metadata->>'file_size') ~ '^[0-9]+$' then
      new.file_size_bytes:=(new.metadata->>'file_size')::bigint;
    end if;
    new.metadata:=public.private_ai_encrypt_json(new.metadata);
  end if;
  return new;
end;
$$;

drop trigger if exists private_ai_encrypt_message_content_trigger on public.private_ai_messages;
create trigger private_ai_encrypt_message_content_trigger
before insert or update of content,sources,attachments on public.private_ai_messages
for each row execute function public.private_ai_encrypt_message_content();

drop trigger if exists private_ai_encrypt_conversation_summary_trigger on public.private_ai_conversations;
create trigger private_ai_encrypt_conversation_summary_trigger
before insert or update of title,rolling_summary on public.private_ai_conversations
for each row execute function public.private_ai_encrypt_conversation_summary();

drop trigger if exists private_ai_encrypt_knowledge_source_trigger on public.private_ai_knowledge_sources;
create trigger private_ai_encrypt_knowledge_source_trigger
before insert or update of title,metadata on public.private_ai_knowledge_sources
for each row execute function public.private_ai_encrypt_knowledge_source();

update public.private_ai_messages
set sources=public.private_ai_encrypt_json(public.private_ai_decrypt_json(sources)),
    attachments=public.private_ai_encrypt_json(public.private_ai_decrypt_json(attachments));

update public.private_ai_conversations
set title=public.private_ai_encrypt_text(public.private_ai_decrypt_text(title));

update public.private_ai_knowledge_sources
set title=public.private_ai_encrypt_text(public.private_ai_decrypt_text(title)),
    metadata=public.private_ai_encrypt_json(public.private_ai_decrypt_json(metadata));

create or replace view public.private_ai_messages_read with (security_invoker=false) as
select id,conversation_id,role,public.private_ai_decrypt_text(content) as content,
       model,public.private_ai_decrypt_json(sources) as sources,
       public.private_ai_decrypt_json(attachments) as attachments,created_at
from public.private_ai_messages;

create or replace view public.private_ai_conversations_read with (security_invoker=false) as
select id,public.private_ai_decrypt_text(title) as title,pinned,
       public.private_ai_decrypt_text(rolling_summary) as rolling_summary,
       summary_through_message_count,summary_version,summary_updated_at,
       total_message_count,created_at,updated_at
from public.private_ai_conversations;

create or replace view public.private_ai_knowledge_sources_read with (security_invoker=false) as
select id,public.private_ai_decrypt_text(title) as title,source_type,enabled,
       content_hash,file_sha256,title_hash,file_size_bytes,char_count,chunk_count,
       embedded_chunk_count,status,failure_count,last_error,
       public.private_ai_decrypt_json(metadata) as metadata,
       created_at,updated_at,completed_at
from public.private_ai_knowledge_sources;

revoke all on public.private_ai_messages_read from public,anon,authenticated;
revoke all on public.private_ai_conversations_read from public,anon,authenticated;
revoke all on public.private_ai_knowledge_sources_read from public,anon,authenticated;
grant select on public.private_ai_messages_read to service_role;
grant select on public.private_ai_conversations_read to service_role;
grant select on public.private_ai_knowledge_sources_read to service_role;

revoke all on function public.private_ai_encrypt_message_content() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_conversation_summary() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_knowledge_source() from public,anon,authenticated;

-- Memory keys are stable identifiers, not user-facing labels. Hash them to avoid
-- leaking memory semantics in a raw database dump.
update public.private_ai_memories
set memory_key=pg_catalog.encode(extensions.digest(memory_key,'sha256'),'hex')
where memory_key !~ '^[a-f0-9]{64}$';

          then (public.private_ai_decrypt_json(metadata)->>'file_size')::bigint
        else null
      end
    );

create or replace function public.private_ai_encrypt_message_content()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  new.content:=public.private_ai_encrypt_text(new.content);
  new.sources:=public.private_ai_encrypt_json(coalesce(new.sources,'[]'::jsonb));
  new.attachments:=public.private_ai_encrypt_json(coalesce(new.attachments,'[]'::jsonb));
  return new;
end;
$$;

create or replace function public.private_ai_encrypt_conversation_summary()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.title is not null then new.title:=public.private_ai_encrypt_text(new.title); end if;
  if new.rolling_summary is not null then new.rolling_summary:=public.private_ai_encrypt_text(new.rolling_summary); end if;
  return new;
end;
$$;

create or replace function public.private_ai_encrypt_knowledge_source()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.title is not null and new.title not like 'enc:v1:%' then
    new.title_hash:=pg_catalog.encode(extensions.digest(new.title,'sha256'),'hex');
    new.title:=public.private_ai_encrypt_text(new.title);
  end if;
  if new.metadata is not null and not (new.metadata ? '_enc_v1') then
    if new.metadata ? 'file_size' and (new.metadata->>'file_size') ~ '^[0-9]+$' then
      new.file_size_bytes:=(new.metadata->>'file_size')::bigint;
    end if;
    new.metadata:=public.private_ai_encrypt_json(new.metadata);
  end if;
  return new;
end;
$$;

drop trigger if exists private_ai_encrypt_message_content_trigger on public.private_ai_messages;
create trigger private_ai_encrypt_message_content_trigger
before insert or update of content,sources,attachments on public.private_ai_messages
for each row execute function public.private_ai_encrypt_message_content();

drop trigger if exists private_ai_encrypt_conversation_summary_trigger on public.private_ai_conversations;
create trigger private_ai_encrypt_conversation_summary_trigger
before insert or update of title,rolling_summary on public.private_ai_conversations
for each row execute function public.private_ai_encrypt_conversation_summary();

drop trigger if exists private_ai_encrypt_knowledge_source_trigger on public.private_ai_knowledge_sources;
create trigger private_ai_encrypt_knowledge_source_trigger
before insert or update of title,metadata on public.private_ai_knowledge_sources
for each row execute function public.private_ai_encrypt_knowledge_source();

update public.private_ai_messages
set sources=public.private_ai_encrypt_json(public.private_ai_decrypt_json(sources)),
    attachments=public.private_ai_encrypt_json(public.private_ai_decrypt_json(attachments));

update public.private_ai_conversations
set title=public.private_ai_encrypt_text(public.private_ai_decrypt_text(title));

update public.private_ai_knowledge_sources
set title=public.private_ai_encrypt_text(public.private_ai_decrypt_text(title)),
    metadata=public.private_ai_encrypt_json(public.private_ai_decrypt_json(metadata));

create or replace view public.private_ai_messages_read with (security_invoker=false) as
select id,conversation_id,role,public.private_ai_decrypt_text(content) as content,
       model,public.private_ai_decrypt_json(sources) as sources,
       public.private_ai_decrypt_json(attachments) as attachments,created_at
from public.private_ai_messages;

create or replace view public.private_ai_conversations_read with (security_invoker=false) as
select id,public.private_ai_decrypt_text(title) as title,pinned,
       public.private_ai_decrypt_text(rolling_summary) as rolling_summary,
       summary_through_message_count,summary_version,summary_updated_at,
       total_message_count,created_at,updated_at
from public.private_ai_conversations;

create or replace view public.private_ai_knowledge_sources_read with (security_invoker=false) as
select id,public.private_ai_decrypt_text(title) as title,source_type,enabled,
       content_hash,file_sha256,title_hash,file_size_bytes,char_count,chunk_count,
       embedded_chunk_count,status,failure_count,last_error,
       public.private_ai_decrypt_json(metadata) as metadata,
       created_at,updated_at,completed_at
from public.private_ai_knowledge_sources;

revoke all on public.private_ai_messages_read from public,anon,authenticated;
revoke all on public.private_ai_conversations_read from public,anon,authenticated;
revoke all on public.private_ai_knowledge_sources_read from public,anon,authenticated;
grant select on public.private_ai_messages_read to service_role;
grant select on public.private_ai_conversations_read to service_role;
grant select on public.private_ai_knowledge_sources_read to service_role;

revoke all on function public.private_ai_encrypt_message_content() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_conversation_summary() from public,anon,authenticated;
revoke all on function public.private_ai_encrypt_knowledge_source() from public,anon,authenticated;

-- Memory keys are stable identifiers, not user-facing labels. Hash them to avoid
-- leaking memory semantics in a raw database dump.
update public.private_ai_memories
set memory_key=pg_catalog.encode(extensions.digest(memory_key,'sha256'),'hex')
where memory_key !~ '^[a-f0-9]{64}$';


-- v5.2 rolling sessions and vector privacy
create or replace function public.private_ai_validate_device_session(candidate text)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare hashed text; found_id uuid;
begin
  if candidate is null or length(candidate)<32 then return false; end if;
  hashed:=pg_catalog.encode(extensions.digest(candidate,'sha256'),'hex');
  update public.private_ai_device_sessions
     set last_seen_at=now(),
         expires_at=case
           when expires_at < now()+interval '7 days' then now()+interval '30 days'
           else expires_at
         end
   where token_hash=hashed and revoked_at is null and expires_at>now()
  returning id into found_id;
  return found_id is not null;
end;
$$;
revoke all on function public.private_ai_validate_device_session(text) from public,anon,authenticated;
grant execute on function public.private_ai_validate_device_session(text) to service_role;

do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name='private_ai_vector_transform_key') then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(48),'hex'),
      'private_ai_vector_transform_key',
      'Uncensor AI searchable-vector transform key'
    );
  end if;
end $$;

create or replace function public.private_ai_vector_transform_key()
returns text language sql stable security definer set search_path=''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name='private_ai_vector_transform_key'
  limit 1
$$;
revoke all on function public.private_ai_vector_transform_key() from public,anon,authenticated;
grant execute on function public.private_ai_vector_transform_key() to service_role;


-- v6 automated security health
create table if not exists public.private_ai_health_status (
  id boolean primary key default true check (id),
  checked_at timestamptz not null default now(),
  status text not null default 'unknown',
  details jsonb not null default '{}'::jsonb
);
insert into public.private_ai_health_status(id) values(true) on conflict(id) do nothing;
alter table public.private_ai_health_status enable row level security;
revoke all on table public.private_ai_health_status from anon,authenticated;
grant select,insert,update,delete on table public.private_ai_health_status to service_role;

create table if not exists public.private_ai_enrollment_buckets (
  bucket_start timestamptz primary key,
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.private_ai_enrollment_buckets enable row level security;
revoke all on table public.private_ai_enrollment_buckets from anon,authenticated;
grant select,insert,update,delete on table public.private_ai_enrollment_buckets to service_role;

create or replace function public.private_ai_take_enrollment_limit(minute_limit integer default 6)
returns boolean language plpgsql security definer set search_path=''
as $$
declare b timestamptz:=date_trunc('minute',now()); n integer;
begin
  insert into public.private_ai_enrollment_buckets(bucket_start,request_count,updated_at)
  values(b,1,now())
  on conflict(bucket_start) do update
  set request_count=public.private_ai_enrollment_buckets.request_count+1,updated_at=now()
  returning request_count into n;
  delete from public.private_ai_enrollment_buckets where bucket_start<now()-interval '2 days';
  return n<=greatest(1,minute_limit);
end;
$$;
revoke all on function public.private_ai_take_enrollment_limit(integer) from public,anon,authenticated;
grant execute on function public.private_ai_take_enrollment_limit(integer) to service_role;

create or replace function public.private_ai_match_chunks(
  query_embedding extensions.vector, match_count integer default 10,
  similarity_threshold double precision default 0.25
)
returns table(id bigint,source_id uuid,title text,content text,chunk_index integer,similarity double precision)
language sql stable security definer set search_path=''
as $$
  select c.id,c.source_id,public.private_ai_decrypt_text(s.title),
         public.private_ai_decrypt_text(c.content),c.chunk_index,
         1-(c.embedding OPERATOR(extensions.<=>) query_embedding)
  from public.private_ai_knowledge_chunks c
  join public.private_ai_knowledge_sources s on s.id=c.source_id
  where s.status='ready' and s.enabled=true and c.embedding is not null
    and 1-(c.embedding OPERATOR(extensions.<=>) query_embedding)>=similarity_threshold
  order by c.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1,least(match_count,30));
$$;
revoke all on function public.private_ai_match_chunks(extensions.vector,integer,double precision) from public,anon,authenticated;
grant execute on function public.private_ai_match_chunks(extensions.vector,integer,double precision) to service_role;

create or replace function public.private_ai_security_maintenance()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  anon_grants integer:=0; storage_policies integer:=0; public_buckets integer:=0;
  plaintext_messages integer:=0; plaintext_memories integer:=0; plaintext_summaries integer:=0;
  plaintext_titles integer:=0; plaintext_chunks integer:=0; plaintext_source_titles integer:=0;
  plaintext_metadata integer:=0; plaintext_source_json integer:=0; plaintext_attachment_json integer:=0;
  unembedded integer:=0; queue_jobs integer:=0; source_errors integer:=0; active_sessions integer:=0;
  vault_keys integer:=0; worker_stale boolean:=false; worker_error text:=null; last_success timestamptz;
  health text; payload jsonb;
begin
  update public.private_ai_messages set content=public.private_ai_encrypt_text(content)
   where content is not null and content not like 'enc:v1:%';
  update public.private_ai_messages
     set sources=public.private_ai_encrypt_json(public.private_ai_decrypt_json(sources)),
         attachments=public.private_ai_encrypt_json(public.private_ai_decrypt_json(attachments))
   where not (coalesce(sources,'{}'::jsonb)?'_enc_v1')
      or not (coalesce(attachments,'{}'::jsonb)?'_enc_v1');
  update public.private_ai_memories set content=public.private_ai_encrypt_text(content)
   where content is not null and content not like 'enc:v1:%';
  update public.private_ai_conversations set title=public.private_ai_encrypt_text(title)
   where title is not null and title not like 'enc:v1:%';
  update public.private_ai_conversations set rolling_summary=public.private_ai_encrypt_text(rolling_summary)
   where rolling_summary is not null and rolling_summary<>'' and rolling_summary not like 'enc:v1:%';
  update public.private_ai_knowledge_chunks set content=public.private_ai_encrypt_text(content)
   where content is not null and content not like 'enc:v1:%';
  update public.private_ai_knowledge_sources set title=public.private_ai_encrypt_text(title)
   where title is not null and title not like 'enc:v1:%';
  update public.private_ai_knowledge_sources
     set metadata=public.private_ai_encrypt_json(public.private_ai_decrypt_json(metadata))
   where not (coalesce(metadata,'{}'::jsonb)?'_enc_v1');

  update storage.buckets set public=false,updated_at=now()
   where id='private-ai-attachments' and public=true;
  update public.private_ai_knowledge_chunks set embedding_claimed_at=null
   where embedding is null and embedding_claimed_at<now()-interval '10 minutes';
  delete from public.private_ai_device_sessions
   where (revoked_at is not null and revoked_at<now()-interval '7 days')
      or expires_at<now()-interval '7 days';

  select count(*) into anon_grants from information_schema.role_table_grants
   where table_schema='public' and table_name like 'private_ai_%' and grantee in ('anon','authenticated');
  select count(*) into storage_policies from pg_catalog.pg_policies
   where schemaname='storage' and tablename='objects';
  select count(*) into public_buckets from storage.buckets
   where id='private-ai-attachments' and public=true;
  select count(*) into plaintext_messages from public.private_ai_messages where content is not null and content not like 'enc:v1:%';
  select count(*) into plaintext_memories from public.private_ai_memories where content is not null and content not like 'enc:v1:%';
  select count(*) into plaintext_summaries from public.private_ai_conversations where rolling_summary<>'' and rolling_summary not like 'enc:v1:%';
  select count(*) into plaintext_titles from public.private_ai_conversations where title is not null and title not like 'enc:v1:%';
  select count(*) into plaintext_chunks from public.private_ai_knowledge_chunks where content is not null and content not like 'enc:v1:%';
  select count(*) into plaintext_source_titles from public.private_ai_knowledge_sources where title is not null and title not like 'enc:v1:%';
  select count(*) into plaintext_metadata from public.private_ai_knowledge_sources where not (coalesce(metadata,'{}'::jsonb)?'_enc_v1');
  select count(*) into plaintext_source_json from public.private_ai_messages where not (coalesce(sources,'{}'::jsonb)?'_enc_v1');
  select count(*) into plaintext_attachment_json from public.private_ai_messages where not (coalesce(attachments,'{}'::jsonb)?'_enc_v1');
  select count(*) into unembedded from public.private_ai_knowledge_chunks where embedding is null;
  select count(*) into queue_jobs from pgmq.q_uncensor_jobs;
  select count(*) into source_errors from public.private_ai_knowledge_sources where status='failed' or last_error is not null;
  select count(*) into active_sessions from public.private_ai_device_sessions where revoked_at is null and expires_at>now();
  select count(*) into vault_keys from vault.decrypted_secrets where name='private_ai_data_key';
  select last_worker_success_at,last_worker_error into last_success,worker_error from public.private_ai_runtime_config where id=true;
  worker_stale:=last_success is null or last_success<now()-interval '90 seconds';

  if worker_stale and (queue_jobs>0 or unembedded>0) then perform public.private_ai_dispatch_worker(); end if;

  health:=case when anon_grants=0 and storage_policies=0 and public_buckets=0
    and plaintext_messages=0 and plaintext_memories=0 and plaintext_summaries=0
    and plaintext_titles=0 and plaintext_chunks=0 and plaintext_source_titles=0
    and plaintext_metadata=0 and plaintext_source_json=0 and plaintext_attachment_json=0
    and source_errors=0 and vault_keys=1 and worker_error is null
    and (not worker_stale or (queue_jobs=0 and unembedded=0))
    then 'healthy' else 'attention' end;

  payload:=pg_catalog.jsonb_build_object(
    'status',health,'checked_at',now(),'unexpected_client_grants',anon_grants,
    'storage_policies',storage_policies,'public_attachment_buckets',public_buckets,
    'plaintext_rows',plaintext_messages+plaintext_memories+plaintext_summaries+plaintext_titles+
      plaintext_chunks+plaintext_source_titles+plaintext_metadata+plaintext_source_json+plaintext_attachment_json,
    'vault_data_key_count',vault_keys,'unembedded_chunks',unembedded,'queue_jobs',queue_jobs,
    'failed_sources',source_errors,'active_device_sessions',active_sessions,'worker_stale',worker_stale,
    'worker_error',worker_error
  );

  insert into public.private_ai_health_status(id,checked_at,status,details)
  values(true,now(),health,payload)
  on conflict(id) do update set checked_at=excluded.checked_at,status=excluded.status,details=excluded.details;

  update public.private_ai_runtime_config set backend_version='v6-private',updated_at=now() where id=true;
  return payload;
end;
$$;
revoke all on function public.private_ai_security_maintenance() from public,anon,authenticated;
grant execute on function public.private_ai_security_maintenance() to service_role;

select cron.unschedule(jobid) from cron.job where jobname='uncensor-ai-security-maintenance';
select cron.schedule(
  'uncensor-ai-security-maintenance',
  '*/5 * * * *',
  $$ select public.private_ai_security_maintenance(); $$
);


-- Exact duplicate protection across every uploaded binary source, including media.
drop index if exists public.private_ai_knowledge_file_sha256_uidx;
create unique index if not exists private_ai_knowledge_sha256_uidx
  on public.private_ai_knowledge_sources(file_sha256)
  where file_sha256 is not null;
