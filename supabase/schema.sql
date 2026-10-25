-- Uncensor AI — private single-user data layer
-- Run in a dedicated Supabase project. The browser never receives service-role credentials.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.private_ai_conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.private_ai_conversations add column if not exists pinned boolean not null default false;
create index if not exists private_ai_conversations_sort_idx on public.private_ai_conversations(pinned desc, updated_at desc);

create table if not exists public.private_ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.private_ai_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  model text,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists private_ai_messages_conversation_created_idx on public.private_ai_messages(conversation_id, created_at);

create table if not exists public.private_ai_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type text not null default 'paste',
  enabled boolean not null default true,
  char_count integer not null default 0,
  chunk_count integer not null default 0,
  status text not null default 'processing',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.private_ai_knowledge_sources add column if not exists enabled boolean not null default true;

create table if not exists public.private_ai_knowledge_chunks (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.private_ai_knowledge_sources(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  unique(source_id, chunk_index)
);
create index if not exists private_ai_knowledge_chunks_source_idx on public.private_ai_knowledge_chunks(source_id, chunk_index);
create index if not exists private_ai_knowledge_hnsw_idx on public.private_ai_knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists public.private_ai_usage (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.private_ai_conversations(id) on delete set null,
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists private_ai_usage_created_idx on public.private_ai_usage(created_at desc);

-- Service-role-only design. There are deliberately no anon/authenticated table policies.
alter table public.private_ai_conversations enable row level security;
alter table public.private_ai_messages enable row level security;
alter table public.private_ai_knowledge_sources enable row level security;
alter table public.private_ai_knowledge_chunks enable row level security;
alter table public.private_ai_usage enable row level security;

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
language sql
stable
set search_path = ''
as $$
  select c.id,c.source_id,s.title,c.content,c.chunk_index,1 - (c.embedding <=> query_embedding) as similarity
  from public.private_ai_knowledge_chunks c
  join public.private_ai_knowledge_sources s on s.id = c.source_id
  where s.status = 'ready' and s.enabled = true and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) >= similarity_threshold
  order by c.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

revoke all on function public.private_ai_match_chunks(extensions.vector, integer, double precision) from public, anon, authenticated;
grant execute on function public.private_ai_match_chunks(extensions.vector, integer, double precision) to service_role;
