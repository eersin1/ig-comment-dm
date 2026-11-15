-- Reel performance over time, written by snapshot-insights. Locked down like the other tables.

create table public.reels (
  media_id text primary key,
  caption text,
  permalink text,
  posted_at timestamptz not null,
  product_type text,
  first_seen_at timestamptz not null default now()
);

-- One row per reel per check. `insights` holds whatever Meta returned, keyed by metric name,
-- so a metric Meta adds or drops later needs no schema change.
create table public.snapshots (
  id bigint generated always as identity primary key,
  media_id text not null references public.reels (media_id) on delete cascade,
  taken_at timestamptz not null default now(),
  age_hours numeric not null,
  views integer,
  likes integer,
  comments integer,
  insights jsonb not null default '{}'::jsonb,
  insights_error text
);
create index snapshots_media_taken on public.snapshots (media_id, taken_at desc);

create table public.account_snapshots (
  taken_at timestamptz primary key default now(),
  followers integer,
  media_count integer
);

alter table public.reels enable row level security;
alter table public.snapshots enable row level security;
alter table public.account_snapshots enable row level security;

create view public.latest_snapshots with (security_invoker = true) as
  select distinct on (media_id) media_id, taken_at
  from public.snapshots
  order by media_id, taken_at desc;
