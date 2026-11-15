import { type Hosting, type Meta, MetaError, type NewRule, type Post, type Rule, type Rules } from "./publisher.ts";

export function createMeta(token: string, version: string): Meta {
  const base = `https://graph.facebook.com/${version}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function request(url: string, init: RequestInit = {}, timeoutMs = 30_000) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...auth, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new MetaError(`Couldn't reach Instagram (${(cause as Error).name}). Check your connection.`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const { code, message, error_user_msg: userMessage } = body.error ?? {};
      if (code === 200 && /api access blocked/i.test(message ?? "")) {
        throw new MetaError(
          "Meta has blocked API access for this app or account, so nothing can be read or posted. Check Alert Inbox and Required actions in your Meta developer dashboard. (code 200)",
        );
      }
      throw new MetaError(`${userMessage ?? message ?? `Instagram returned HTTP ${response.status}`}${code ? ` (code ${code})` : ""}`);
    }
    return body;
  }

  const post = (path: string, payload: unknown) =>
    request(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  return {
    async account() {
      const body = await request(`${base}/me/assigned_instagram_accounts?fields=id,username`);
      const account = body.data?.[0];
      if (!account) throw new MetaError("This token isn't connected to an Instagram account.");
      return account;
    },

    async posts(igId) {
      const fields = "id,caption,permalink,timestamp,thumbnail_url,media_url,total_views_count,like_count,comments_count";
      const body = await request(`${base}/${igId}/media?fields=${fields}&limit=25`);
      return (body.data ?? []).map((item: Record<string, unknown>): Post => ({
        id: String(item.id),
        caption: String(item.caption ?? ""),
        permalink: String(item.permalink ?? ""),
        timestamp: String(item.timestamp ?? ""),
        thumbnail: (item.thumbnail_url ?? item.media_url ?? null) as string | null,
        views: (item.total_views_count ?? null) as number | null,
        likes: (item.like_count ?? null) as number | null,
        comments: (item.comments_count ?? null) as number | null,
      }));
    },

    // Every post is a trial reel, and "Share to everyone" stays a manual choice in the Instagram app.
    // Sent by link on purpose: two direct uploads with these settings came out as normal reels, and
    // the same settings by link came out as a trial.
    async createContainer(igId, caption, videoUrl) {
      const body = await post(`${igId}/media`, {
        media_type: "REELS",
        video_url: videoUrl,
        caption,
        trial_params: { graduation_strategy: "MANUAL" },
      });
      return { id: body.id };
    },

    async containerStatus(containerId) {
      const body = await request(`${base}/${containerId}?fields=status_code,status`);
      return { code: String(body.status_code), message: String(body.status ?? "") };
    },

    async publish(igId, containerId) {
      const body = await post(`${igId}/media_publish`, { creation_id: containerId });
      return String(body.id);
    },

    async sharedToFeed(mediaId) {
      const body = await request(`${base}/${mediaId}?fields=is_shared_to_feed`);
      return Boolean(body.is_shared_to_feed);
    },

    async permalink(mediaId) {
      const body = await request(`${base}/${mediaId}?fields=permalink`);
      return body.permalink ?? null;
    },
  };
}

export function createRules(url: string, key: string): Rules {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new Error("Couldn't reach Supabase. Check your connection.");
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Supabase refused the change: ${body?.message ?? response.status}`);
    return body;
  }

  return {
    list: () => request("rules?select=*&order=id.desc") as Promise<Rule[]>,
    async add(rule: NewRule) {
      const rows = await request("rules", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(rule),
      });
      return rows[0];
    },
    async setEnabled(id, enabled) {
      await request(`rules?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    },
  };
}

// Supabase's free plan refuses files over 50 MB, so larger videos are compressed first.
const MAX_HOSTED_BYTES = 49 * 1024 * 1024;
const TARGET_BYTES = 46 * 1024 * 1024;
const AUDIO_BITRATE = 192_000;
const MAX_VIDEO_BITRATE = 10_000_000;
const MIN_VIDEO_BITRATE = 3_000_000;
const BUCKET = "reel-uploads";
// Found on PATH. Install with `brew install ffmpeg` on a Mac.
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

async function run(command: string, args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command(command, { args, stdout: "piped", stderr: "piped" }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr).trim().split("\n").at(-1) ?? "unknown error");
  return new TextDecoder().decode(stdout);
}

export function videoBitrate(durationSeconds: number): number | null {
  const bitrate = Math.floor((TARGET_BYTES * 8) / durationSeconds) - AUDIO_BITRATE;
  return bitrate < MIN_VIDEO_BITRATE ? null : Math.min(bitrate, MAX_VIDEO_BITRATE);
}

async function shrink(video: Uint8Array, workDir: URL): Promise<Uint8Array> {
  const id = crypto.randomUUID();
  const input = new URL(`${id}-in`, workDir).pathname;
  const output = new URL(`${id}-out.mp4`, workDir).pathname;
  try {
    await Deno.writeFile(input, video);
    const duration = Number(await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]));
    const bitrate = videoBitrate(duration);
    if (bitrate === null) {
      throw new MetaError("This video is too long to compress without hurting its quality, so nothing was posted. Post it from the Instagram app, then add its keyword below.");
    }
    await run(FFMPEG, [
      "-y", "-v", "error", "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "medium", "-b:v", String(bitrate), "-maxrate", String(Math.floor(bitrate * 1.5)),
      "-bufsize", String(bitrate * 2), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", String(AUDIO_BITRATE),
      "-movflags", "+faststart", output,
    ]);
    const smaller = await Deno.readFile(output);
    if (smaller.byteLength > MAX_HOSTED_BYTES) {
      throw new MetaError("This video didn't compress small enough, so nothing was posted. Post it from the Instagram app, then add its keyword below.");
    }
    return smaller;
  } catch (error) {
    if (error instanceof MetaError) throw error;
    throw new MetaError(`Couldn't compress this video, so nothing was posted. ${(error as Error).message}`);
  } finally {
    await Deno.remove(input).catch(() => {});
    await Deno.remove(output).catch(() => {});
  }
}

export function createHosting(url: string, key: string, workDir: URL): Hosting {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  async function storage(path: string, init: RequestInit, timeoutMs = 30_000) {
    const response = await fetch(`${url}/storage/v1/${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((cause) => {
      throw new MetaError(`Couldn't reach Supabase (${cause.name}), so nothing was posted. Try again.`);
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new MetaError(`Supabase refused the video, so nothing was posted. ${body.message ?? response.status}`);
    return body;
  }

  return {
    async put(video) {
      const file = video.byteLength > MAX_HOSTED_BYTES ? await shrink(video, workDir) : video;
      const name = `${crypto.randomUUID()}.mp4`;
      await storage(`object/${BUCKET}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "video/mp4" },
        body: file as Uint8Array<ArrayBuffer>,
      }, 10 * 60_000);
      const signed = await storage(`object/sign/${BUCKET}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      return { url: `${url}/storage/v1${signed.signedURL}`, name };
    },
    async remove(name) {
      await storage(`object/${BUCKET}/${name}`, { method: "DELETE" });
    },
  };
}
