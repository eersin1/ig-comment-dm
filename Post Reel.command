#!/bin/zsh
# Double-click to open the posting page and dashboard. Keep this window open while posting.
# Extra arguments are passed to the server, e.g. --dry-run.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

for tool in deno ffmpeg ffprobe; do
  command -v "$tool" > /dev/null || { echo "$tool isn't installed. See Requirements in README.md."; exit 1; }
done
[ -f .env ] || { echo "No .env file yet. See Setup in README.md."; exit 1; }
PROJECT_REF=$(sed -n 's/^SUPABASE_PROJECT_REF=//p' .env | tail -1 | tr -d "\"' ")
[ -n "$PROJECT_REF" ] || { echo "SUPABASE_PROJECT_REF is empty in .env. See Setup in README.md."; exit 1; }

URL="http://127.0.0.1:8787"
if curl -s -o /dev/null -m 1 "$URL"; then
  open "$URL"
  exit 0
fi
(sleep 1 && open "$URL") &
exec deno run \
  --allow-net=127.0.0.1:8787,graph.facebook.com,rupload.facebook.com,"$PROJECT_REF.supabase.co" \
  --allow-read=app,.env,.uploads,library,scripts \
  --allow-write=.uploads \
  --allow-run=ffmpeg,ffprobe,deno \
  app/server.ts "$@"
