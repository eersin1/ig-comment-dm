#!/usr/bin/env bash
# Compares what Instagram counts with what the bot's API call returns on each post. Read-only.
# comments_count includes replies, which the bot doesn't act on, so they're added to the returned total.
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN=$(sed -n 's/^IG_TOKEN=//p' .env | tail -1)
VERSION=$(sed -n 's/^API_VERSION=//p' .env | tail -1)
BASE="https://graph.facebook.com/${VERSION:-v26.0}"
AUTH="Authorization: Bearer $TOKEN"

IG_ID=$(curl -sS -m 30 -H "$AUTH" "$BASE/me/assigned_instagram_accounts?fields=id" | jq -r '.data[0].id')
total_count=0
total_returned=0
printf '%-20s %7s %10s %8s\n' media counted top_level replies
while read -r media count; do
  top=0
  replies=0
  after=""
  for _ in $(seq 1 20); do
    page=$(curl -sS -m 30 -H "$AUTH" -G "$BASE/$media/ordered_comments" \
      --data-urlencode "fields=id,replies.limit(50){id}" --data-urlencode "limit=50" --data-urlencode "after=$after")
    top=$((top + $(jq '.data | length' <<< "$page")))
    replies=$((replies + $(jq '[.data[].replies.data // [] | length] | add // 0' <<< "$page")))
    [ "$(jq '.paging.next != null' <<< "$page")" = "true" ] || break
    after=$(jq -r '.paging.cursors.after // empty' <<< "$page")
    [ -n "$after" ] || break
  done
  printf '%-20s %7s %10s %8s\n' "$media" "$count" "$top" "$replies"
  total_count=$((total_count + count))
  total_returned=$((total_returned + top + replies))
done < <(curl -sS -m 30 -H "$AUTH" "$BASE/$IG_ID/media?fields=id,comments_count&limit=50" \
  | jq -r '.data[] | select((.comments_count // 0) > 0) | "\(.id) \(.comments_count)"')
echo "total: $total_returned of $total_count returned, counting replies"
