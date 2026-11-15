-- Calls the Edge Functions on a timer. pg_cron runs these as postgres, which can read Vault.
-- scripts/deploy.sh stores two Vault secrets these read:
-- project_url (https://<your-project-ref>.supabase.co) and cron_secret (checked by each function).
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.call_function(fn text, timeout_ms integer default 120000)
returns bigint
language sql
set search_path = ''
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := timeout_ms
  );
$$;
revoke all on function public.call_function(text, integer) from public, anon, authenticated;

-- Newest reel every 30 seconds. The function gives older reels their turns every 2 minutes.
select cron.schedule('poll-comments', '30 seconds', $$select public.call_function('poll-comments')$$);

-- Hourly. The function decides per reel whether it's due (hourly, then 6-hourly, then daily).
select cron.schedule('snapshot-insights', '7 * * * *', $$select public.call_function('snapshot-insights')$$);

-- Every 6 hours, about one API call per watched creator.
select cron.schedule('scan-watchlist', '23 */6 * * *', $$select public.call_function('scan-watchlist', 150000)$$);

-- pg_cron never clears its run log, and at one run every 30 seconds it would fill the free plan's database.
select cron.schedule('clean-cron-log', '17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
