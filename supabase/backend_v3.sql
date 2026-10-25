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
