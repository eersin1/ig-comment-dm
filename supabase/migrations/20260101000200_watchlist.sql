-- Creators to follow on the Trends tab. Starts empty: add creators at the bottom of the tab.
-- Locked down like the other tables.

create table public.watch_accounts (
  username text primary key,
  enabled boolean not null default true,
  added_at timestamptz not null default now(),
  display_name text,
  followers integer,
  media_count integer,
  last_scanned_at timestamptz,
  last_error text
);

create table public.watch_reels (
  media_id text primary key,
  username text not null references public.watch_accounts (username) on delete cascade,
  permalink text,
  caption text,
  posted_at timestamptz not null,
  product_type text,
  views integer,
  likes integer,
  comments integer,
  thumbnail_url text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index watch_reels_creator_posted on public.watch_reels (username, posted_at desc);

alter table public.watch_accounts enable row level security;
alter table public.watch_reels enable row level security;
