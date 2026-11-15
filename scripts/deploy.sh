#!/usr/bin/env bash
# Sets up or updates your Supabase project. Safe to re-run, and a run that fails halfway is fixed by
# running it again. Needs `supabase login` first, plus SUPABASE_PROJECT_REF and IG_TOKEN in .env.
#
#   1. finds the Instagram account on your token
#   2. links the project and applies the database migrations
#   3. saves the service role key the posting page needs into .env as SUPABASE_SECRET_KEY
#   4. sets the Edge Function secrets
#   5. stores the project address and a cron secret in Vault for the scheduled jobs
#   6. deploys poll-comments, snapshot-insights and scan-watchlist
#
# Values come from .env and never appear in the output.
# Optional .env keys for the alert email: RESEND_API_KEY, ALERT_EMAIL
set -euo pipefail
cd "$(dirname "$0")/.."
touch .env
chmod 600 .env

env_value() { sed -n "s/^$1=//p" .env | tail -1 | sed -E "s/^[\"']//; s/[\"']$//"; }
set_env() {
  local tmp
  tmp=$(mktemp)
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

project_ref=$(env_value SUPABASE_PROJECT_REF)
[ -n "$project_ref" ] || { echo "SUPABASE_PROJECT_REF is empty in .env. It's the ID in your project's dashboard address." >&2; exit 1; }
token=$(env_value IG_TOKEN)
[ -n "$token" ] || { echo "IG_TOKEN is empty in .env. See 'Get an Instagram token' in the README." >&2; exit 1; }
version=$(env_value API_VERSION)
version=${version:-v26.0}

accounts=$(curl -sS -m 30 -G "https://graph.facebook.com/$version/me/assigned_instagram_accounts" \
  --data-urlencode "fields=id,username" --data-urlencode "access_token=$token")
count=$(jq '.data | length' <<< "$accounts" 2>/dev/null || echo 0)
if [ "$count" != "1" ]; then
  echo "Expected one Instagram account on this token, found $count. Run: scripts/go-no-go.sh whoami" >&2
  exit 1
fi
ig_user_id=$(jq -r '.data[0].id' <<< "$accounts")
ig_username=$(jq -r '.data[0].username' <<< "$accounts")
echo "Instagram account: @$ig_username"

cron_secret=$(env_value CRON_SECRET)
if [ -z "$cron_secret" ]; then
  cron_secret=$(openssl rand -hex 32)
  set_env CRON_SECRET "$cron_secret"
fi
project_url="https://$project_ref.supabase.co"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
secrets="$workdir/secrets.env"
sql="$workdir/vault.sql"
umask 077

{
  echo "IG_TOKEN=$token"
  echo "IG_USER_ID=$ig_user_id"
  echo "IG_USERNAME=$ig_username"
  echo "API_VERSION=$version"
  echo "CRON_SECRET=$cron_secret"
  for key in RESEND_API_KEY ALERT_EMAIL; do
    value=$(env_value "$key")
    [ -z "$value" ] || echo "$key=$value"
  done
} > "$secrets"

cat > "$sql" <<SQL
do \$\$
declare existing uuid;
begin
  select id into existing from vault.secrets where name = 'cron_secret';
  if existing is null then
    perform vault.create_secret('$cron_secret', 'cron_secret');
  else
    perform vault.update_secret(existing, '$cron_secret');
  end if;
  select id into existing from vault.secrets where name = 'project_url';
  if existing is null then
    perform vault.create_secret('$project_url', 'project_url');
  else
    perform vault.update_secret(existing, '$project_url');
  end if;
end \$\$;
SQL

echo "Linking the project. If it asks for a database password, enter the one you chose when creating it."
supabase link --project-ref "$project_ref"

echo "Applying database migrations..."
supabase db push --linked

echo "Saving the service role key for the posting page..."
key=$(supabase projects api-keys --project-ref "$project_ref" --output-format json \
  | jq -r '(.keys // .)[] | select(.name == "service_role") | .api_key' | head -1)
[ -n "$key" ] || { echo "Couldn't read the service role key." >&2; exit 1; }
set_env SUPABASE_SECRET_KEY "$key"

echo "Setting function secrets..."
supabase secrets set --project-ref "$project_ref" --env-file "$secrets" > /dev/null

echo "Storing the project address and cron secret in Vault..."
supabase db query --linked -f "$sql" > /dev/null

for fn in poll-comments snapshot-insights scan-watchlist; do
  echo "Deploying $fn..."
  supabase functions deploy "$fn" --project-ref "$project_ref" --no-verify-jwt --use-api
done

echo "Done. Double-click 'Post Reel.command' to open the posting page."
