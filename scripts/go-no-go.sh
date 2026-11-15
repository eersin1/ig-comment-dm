#!/usr/bin/env bash
# Go/no-go test from the build spec, using Meta's Instagram API with Unified Login.
# Decides whether the polling design works.
#
#   scripts/go-no-go.sh exchange                turn the login redirect into a token, saved to .env
#   scripts/go-no-go.sh whoami                  account ID and username
#   scripts/go-no-go.sh media                   recent videos and their IDs
#   scripts/go-no-go.sh comments <MEDIA_ID>     read test: list a video's comments
#   scripts/go-no-go.sh dm <COMMENT_ID>         DM test: sends one real DM to the commenter
#   scripts/go-no-go.sh reply <COMMENT_ID>      public reply test: posts one real reply
#
# Reads IG_TOKEN and API_VERSION from .env. Output never includes the token or app secret.
set -euo pipefail

cd "$(dirname "$0")/.."
touch .env
chmod 600 .env

# Reads single keys rather than sourcing .env, so a stray character there can't break the script.
env_value() {
  sed -n "s/^$1=//p" .env | tail -1 | sed -E "s/^[\"']//; s/[\"']$//"
}

IG_TOKEN=$(env_value IG_TOKEN)
API_VERSION=$(env_value API_VERSION)
API_VERSION="${API_VERSION:-v26.0}"
BASE="https://graph.facebook.com/$API_VERSION"

# paging.next and paging.previous embed the access token, so they are reduced to a yes/no.
show() {
  jq 'if type == "object" and has("paging")
      then .paging = {has_next: (.paging.next != null)}
      else . end'
}

call() {
  local body status
  body=$(mktemp)
  trap 'rm -f "$body"' RETURN
  status=$(curl -sS -m 30 -o "$body" -w '%{http_code}' "$@")
  echo "HTTP $status"
  show < "$body"
  [ "${status:0:1}" = "2" ]
}

accounts() {
  curl -sS -m 30 -G "$BASE/me/assigned_instagram_accounts" \
    --data-urlencode "fields=id,username" --data-urlencode "access_token=$IG_TOKEN"
}

# The one Instagram account the token covers. Refuses to guess if there are several.
ig_id() {
  local list count
  list=$(accounts)
  count=$(jq '.data | length' <<< "$list" 2>/dev/null || echo 0)
  if [ "$count" != "1" ]; then
    echo "Expected one Instagram account on this token, found $count. Run: $0 whoami" >&2
    return 1
  fi
  jq -r '.data[0].id' <<< "$list"
}

save_token() {
  local tmp
  tmp=$(mktemp)
  grep -v '^IG_TOKEN=' .env > "$tmp" || true
  printf 'IG_TOKEN=%s\n' "$1" >> "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

cmd="${1:-}"
arg="${2:-}"

if [ "$cmd" = "exchange" ]; then
  read -rp "Meta app ID: " app_id
  read -rsp "App secret (hidden as you paste): " app_secret; echo
  read -rp "Full address bar URL after login: " redirected
  case "$redirected" in
    *code=*) ;;
    *) echo "That URL has no code in it. Copy the whole address bar after logging in." >&2; exit 2 ;;
  esac
  redirect_uri="${redirected%%\?*}"
  code="${redirected#*code=}"; code="${code%%&*}"; code="${code%%#*}"

  resp=$(curl -sS -m 30 -G "$BASE/oauth/access_token" \
    --data-urlencode "client_id=$app_id" --data-urlencode "client_secret=$app_secret" \
    --data-urlencode "redirect_uri=$redirect_uri" --data "code=$code")
  token=$(jq -r '.access_token // empty' <<< "$resp")
  if [ -z "$token" ]; then
    echo "Exchange failed:"
    jq . <<< "$resp"
    exit 1
  fi
  save_token "$token"
  IG_TOKEN="$token"
  echo "Token saved to .env."

  echo "Token details:"
  curl -sS -m 30 -G "$BASE/debug_token" --data-urlencode "input_token=$token" \
    --data-urlencode "access_token=$app_id|$app_secret" \
    | jq '.data // . | {type, is_valid, expires_at, data_access_expires_at, scopes, error}'
  echo "Instagram accounts:"
  accounts | show
  exit 0
fi

case "$cmd" in
  whoami|media|comments|dm|reply)
    : "${IG_TOKEN:?IG_TOKEN is empty in .env}"
    ;;
esac

case "$cmd" in
  whoami)
    call -G "$BASE/me/assigned_instagram_accounts" --data-urlencode "fields=id,username" \
      --data-urlencode "access_token=$IG_TOKEN"
    ;;
  media)
    id=$(ig_id)
    call -G "$BASE/$id/media" --data-urlencode "fields=id,caption,permalink,timestamp" \
      --data-urlencode "access_token=$IG_TOKEN"
    ;;
  comments)
    [ -n "$arg" ] || { echo "Usage: $0 comments <MEDIA_ID>" >&2; exit 2; }
    call -G "$BASE/$arg/comments" --data-urlencode "fields=id,text,timestamp,username" \
      --data-urlencode "access_token=$IG_TOKEN"
    ;;
  dm)
    [ -n "$arg" ] || { echo "Usage: $0 dm <COMMENT_ID>" >&2; exit 2; }
    id=$(ig_id)
    payload=$(jq -n --arg id "$arg" '{recipient: {comment_id: $id}, message: {text: "test"}}')
    call -X POST "$BASE/$id/messages" \
      -H "Authorization: Bearer $IG_TOKEN" -H "Content-Type: application/json" -d "$payload"
    ;;
  reply)
    [ -n "$arg" ] || { echo "Usage: $0 reply <COMMENT_ID>" >&2; exit 2; }
    call -X POST "$BASE/$arg/replies" --data-urlencode "message=test" \
      --data-urlencode "access_token=$IG_TOKEN"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
