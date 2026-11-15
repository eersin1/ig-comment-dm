# ig-comment-dm

Comment-to-DM automation for your own Instagram account, plus a local page for posting reels and tracking how they do.

- **Keyword DMs.** When someone comments a keyword on your reel, like "Comment GUIDE and I'll send it", they get one DM with your link and an optional public reply. A Supabase Edge Function checks the newest reel every 30 seconds and older ones every few minutes, so it keeps working while your computer is off.
- **Posting page.** Post trial reels from your Mac with a caption, keyword and DM in one go, and add keywords to reels you posted from the Instagram app.
- **Dashboard.** Every reel's views, likes, comments, skip rate and watch time over time, with transcripts, hook frames and pacing numbers per reel.
- **Trends.** Follow other creators and see which of their recent reels beat their usual views, and which formats, hooks, topics and calls to action are working.

It uses Meta's official Instagram API with your own Meta app and token, and a free Supabase project. Nothing goes through anyone else's server.

## Requirements

- A Mac (the posting page launcher is a `.command` file; the Edge Functions run anywhere)
- An Instagram **professional** account (Business or Creator) connected to a Facebook Page
- A [Meta developer](https://developers.facebook.com) account and a [Supabase](https://supabase.com) account (the free plan is enough)
- These tools, with [Homebrew](https://brew.sh):

  ```bash
  brew install deno ffmpeg jq supabase/tap/supabase
  ```

  For the dashboard's transcripts and the Trends tab's video analysis, also:

  ```bash
  brew install whisper-cpp yt-dlp
  ```

## Setup

### 1. Create a Meta app

1. At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app. Choose the **Business** type and connect it to a business portfolio that owns your Facebook Page and Instagram account.
2. Add the Instagram use case that uses **Facebook Login for Business** (shown as **API setup with Facebook login** or **Unified login**), not the "Instagram login" one.
3. Under **Facebook Login for Business > Configurations**, create a configuration with these permissions: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` and `business_management`. Pick a token that doesn't expire if offered.
4. In your Instagram app, turn on **Settings > Messages and story replies > Message controls > Allow access to messages** (wording varies). Without it, DMs fail.

The app only acts on your own account, which has a role on the app, so you don't need App Review. Meta asks for a privacy policy URL before switching the app to Live: fill in `docs/privacy-policy.md`, publish it somewhere public and paste its link under **App settings > Basic**.

Meta renames these screens often. If something doesn't match, look for the Instagram use case's **API setup** page.

### 2. Get an Instagram token

```bash
cp .env.example .env
```

1. Open the use case's **Login URL** (on the API setup page), log in with the Facebook account that manages your Instagram account, and approve everything.
2. Copy the whole address bar from the page you land on.
3. Straight away, because the code in that address expires within minutes:

   ```bash
   scripts/go-no-go.sh exchange
   ```

   It asks for the app ID and app secret from **App settings > Basic**, then the address, and saves the token to `.env`. The secret isn't stored.

Check it works:

```bash
scripts/go-no-go.sh whoami
```

```bash
scripts/go-no-go.sh media
```

### 3. Set up Supabase

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). Note the database password.
2. Put its project ID in `.env` as `SUPABASE_PROJECT_REF`. It's the part after `/project/` in the dashboard address.
3. Log in and deploy:

   ```bash
   supabase login
   ```

   ```bash
   scripts/deploy.sh
   ```

`deploy.sh` creates the tables, the scheduled jobs and the private `reel-uploads` storage bucket, saves the key the posting page needs into `.env`, sets the function secrets and deploys the three Edge Functions. Run it again after changing the token or the alert settings.

### 4. Optional extras

- **Transcripts.** Download the Whisper model the dashboard and Trends tab use (about 470 MB):

  ```bash
  mkdir -p models && curl -L -o models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
  ```

  To use a model stored elsewhere, set the `WHISPER_MODEL` environment variable to its path.
- **Trends labels.** Add `ANTHROPIC_API_KEY` to `.env` so Claude labels each watched reel's format, hook and topic, at about $0.0015 a reel. Without it, labels are guessed from captions. Edit `supabase/functions/scan-watchlist/niche.ts` to describe your niche and its topics.
- **Alert emails.** Add `RESEND_API_KEY` and `ALERT_EMAIL` to `.env` and run `scripts/deploy.sh`. Without them, alerts only go to the function logs.
- **Time zone.** Set `TIMEZONE` in `.env`, like `America/New_York`, if it differs from your computer's.

## Post a reel

Double-click **Post Reel.command** and keep its Terminal window open while posting. Drop in the video, write the caption, and optionally add a keyword and DM.

- Every post is a **trial reel**. To share one with everyone, use the Instagram app, because Meta's API doesn't offer that.
- Reels go to Instagram by link. The video sits in the private `reel-uploads` bucket until Instagram has processed it, and is then deleted. Videos over 49 MB are compressed first (the Supabase free plan's limit), and ones too long to compress cleanly are refused, so post those from the Instagram app.
- The page also lists recent reels with their numbers. **Add keyword** there turns on DMs for a reel or carousel you posted from the Instagram app.
- The page only accepts requests from itself on `127.0.0.1`.

To test without posting, run it with `--dry-run`. It uploads to Instagram and stops before publishing:

```bash
./Post\ Reel.command --dry-run
```

## How keyword DMs work

Each rule is a row in the `rules` table: a reel, a keyword, the DM and an optional public reply.

- Keywords match whole words in any casing, with or without hyphens and accents, so GUIDE, guide and Guide all count.
- Only comments posted after the rule is created count. Anyone who commented the keyword on that reel before then is skipped, and each comment gets at most one DM.
- Don't make the DM depend on following you. Non-followers get it in their message requests.
- The newest rule is checked every 30 seconds. Every 2 minutes, 2 older rules are checked too, taking turns. With 6 rules, a DM on an older reel can take up to 6 minutes.
- To pause a rule, click **Pause** next to it on the posting page, or set `enabled` to false.

To add a rule without the page, find the reel's ID with `scripts/go-no-go.sh media` and add a row to `rules` in the Supabase table editor.

The `events` table has one row per comment the bot acted on:

- `sent`: the DM went out. A `public_reply_error` means only the public reply failed.
- `failed`: see `error`. If `retryable` is true, a later run tries again, up to 3 attempts.
- `sending`: the function stopped mid-send and the outcome is unknown. This is never retried, so check it by hand.

Meta's `/comments` list silently leaves out many comments on older posts, and `/ordered_comments` can lag hours behind on new ones, so the function reads both and merges them. To compare what the bot can see with the counts Instagram shows:

```bash
scripts/coverage.sh
```

## Dashboard

`snapshot-insights` runs hourly and stores each reel's numbers in `snapshots`: hourly for 2 days, every 6 hours to day 7, then daily to day 30. Followers go in `account_snapshots`. To backfill every reel at once, POST `{"force": true}` to the function with the `x-cron-secret` header.

```bash
deno run -A scripts/library.ts
```

builds `library/` (git-ignored): one folder per reel with the video, transcript, hook frames, contact sheets, keyword and DMs sent, plus `library/reels.csv` with one row per reel. The **Dashboard** tab shows it: follower and median tiles, a scatter of anything you control against any outcome, hook tests, a sortable table, and a page per reel with the video, its first 3 seconds, a clickable transcript and its numbers over time. Opening the tab rebuilds the library if it's over an hour old. Anything you write in `library/review.md` shows up there as the latest review.

## Trends

The **Trends** tab ranks other creators' reels from the last 14 days by how far they beat that creator's usual views: the median of their other reels, ignoring reels under 2 days old and very low trial-like ones. Add creators at the bottom of the tab. Only business and creator accounts can be read. `scan-watchlist` reads every watched creator through Meta's Business Discovery API every 6 hours, about one API call per creator.

While the posting page is open, `scripts/watch-library.ts` watches each recent reel in the background every 30 minutes, newest first:

- It downloads the reel with yt-dlp from its public link, without logging in to Instagram. **This goes against Instagram's terms of use**, so the volume is kept small with a 3-second pause between downloads, and it stops after 3 failed downloads in a row. Leave yt-dlp uninstalled if you'd rather not.
- It makes the transcript, hook frames, contact sheets and pacing numbers, the same as for your own reels.
- If `ANTHROPIC_API_KEY` is set, Claude labels the reel's format, hook, hook type, topic and call to action from the screenshots and transcript (`scripts/watch-labels.ts`).
- It deletes the video and keeps the rest in `library/watch/<media_id>/`. Folders older than 30 days are removed.

Reels that haven't been watched fall back to caption guesses, marked "From caption". **What's working** shows how a typical reel with each label did against its creator's usual.

## Replace the token

The token doesn't expire, but it stops working if you remove the app from your business portfolio, change your password or move the Instagram account. You'll get an alert email if that's set up. Repeat [step 2](#2-get-an-instagram-token), then run `scripts/deploy.sh`.

## Develop

```bash
deno test supabase/functions/
```

```bash
deno test app/publisher_test.ts
```

Secrets stay in `.env`, which git ignores, and in Supabase. The scripts never print them.

## Disclaimer

Not affiliated with or endorsed by Meta or Instagram. Use it only on accounts you own, and follow Meta's [Platform Terms](https://developers.facebook.com/terms) and Instagram's [Terms of Use](https://help.instagram.com/581066165581870). Automated DMs that are unsolicited, misleading or too frequent can get an account restricted.

## License

[MIT](LICENSE)
