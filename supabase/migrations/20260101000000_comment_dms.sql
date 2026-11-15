-- Keyword rules and the comments the bot acted on. Row-level security with no policies locks every
-- table to the service role key that the Edge Functions and the posting page use.

create table public.rules (
  id bigint generated always as identity primary key,
  media_id text not null,
  keyword text not null check (length(trim(keyword)) > 0),
  dm_text text not null check (length(trim(dm_text)) > 0),
  public_reply text,
  enabled boolean not null default true,
  active_from timestamptz not null default now()
);

create table public.events (
  comment_id text primary key,
  rule_id bigint references public.rules (id) on delete set null,
  username text,
  comment_text text,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  retryable boolean not null default false,
  attempts integer not null default 1,
  error text,
  public_reply_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The access token lives in Edge Function secrets, so this only tracks when the last alert went out.
create table public.settings (
  id integer primary key default 1 check (id = 1),
  last_alert_at timestamptz
);
insert into public.settings (id) values (1);

alter table public.rules enable row level security;
alter table public.events enable row level security;
alter table public.settings enable row level security;

-- Private bucket the posting page puts videos in until Instagram has fetched them.
insert into storage.buckets (id, name, public) values ('reel-uploads', 'reel-uploads', false)
on conflict (id) do nothing;
