export type Rule = {
  id: number;
  media_id: string;
  keyword: string;
  dm_text: string;
  public_reply: string | null;
  enabled: boolean;
};

export type NewRule = { media_id: string; keyword: string; dm_text: string; public_reply: string | null; active_from?: string };

export type Post = {
  id: string;
  caption: string;
  permalink: string;
  timestamp: string;
  thumbnail: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
};

export type ContainerStatus = { code: string; message: string };

export type Meta = {
  account(): Promise<{ id: string; username: string }>;
  posts(igId: string): Promise<Post[]>;
  createContainer(igId: string, caption: string, videoUrl: string): Promise<{ id: string }>;
  containerStatus(containerId: string): Promise<ContainerStatus>;
  publish(igId: string, containerId: string): Promise<string>;
  permalink(mediaId: string): Promise<string | null>;
  // Normal reels read true. Trial reels read false until they're shared to everyone.
  sharedToFeed(mediaId: string): Promise<boolean>;
};

export type Hosting = {
  put(video: Uint8Array): Promise<{ url: string; name: string }>;
  remove(name: string): Promise<void>;
};

export type Rules = {
  list(): Promise<Rule[]>;
  add(rule: NewRule): Promise<Rule>;
  setEnabled(id: number, enabled: boolean): Promise<void>;
};

export class MetaError extends Error {}

const FEED_CHECK_DELAY_MS = 5_000;

const STEP_LABELS = {
  upload: "Upload the video",
  process: "Instagram processes it",
  publish: "Post the reel",
  keyword: "Turn on the keyword",
} as const;

export type StepKey = keyof typeof STEP_LABELS;
export type StepState = "pending" | "active" | "done" | "failed" | "skipped";
export type Job = {
  id: string;
  status: "running" | "done" | "failed";
  dryRun: boolean;
  steps: { key: StepKey; label: string; state: StepState }[];
  error: string | null;
  // True once Meta may have the post, so the page must never offer a plain retry.
  publishAttempted: boolean;
  mediaId: string | null;
  permalink: string | null;
  // true: Meta reports it as shared to Feed, so it went out as a normal reel. null: couldn't tell.
  postedAsNormal: boolean | null;
};

export type PublishInput = {
  video: Uint8Array;
  caption: string;
  rule: { keyword: string; dm_text: string; public_reply: string | null } | null;
};

export type Options = {
  pollMs?: number;
  maxPolls?: number;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export function newJob(id: string, hasKeyword: boolean, dryRun: boolean): Job {
  const keys: StepKey[] = ["upload", "process", "publish", "keyword"];
  return {
    id,
    status: "running",
    dryRun,
    steps: keys.map((key) => ({
      key,
      label: STEP_LABELS[key],
      state: key === "keyword" && !hasKeyword ? "skipped" : "pending",
    })),
    error: null,
    publishAttempted: false,
    mediaId: null,
    permalink: null,
    postedAsNormal: null,
  };
}

export async function runPublish(job: Job, input: PublishInput, meta: Meta, rules: Rules, hosting: Hosting, options: Options = {}) {
  const { pollMs = 5_000, maxPolls = 180, dryRun = false, now = () => new Date() } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let current: StepKey = "upload";
  let hostedName: string | null = null;

  const begin = (key: StepKey) => {
    current = key;
    job.steps.find((step) => step.key === key)!.state = "active";
  };
  const finish = (key: StepKey, state: StepState = "done") => {
    job.steps.find((step) => step.key === key)!.state = state;
  };

  try {
    begin("upload");
    const { id: igId } = await meta.account();
    const hosted = await hosting.put(input.video);
    hostedName = hosted.name;
    const container = await meta.createContainer(igId, input.caption, hosted.url);
    finish("upload");

    begin("process");
    let status: ContainerStatus = { code: "IN_PROGRESS", message: "" };
    for (let poll = 0; poll < maxPolls; poll++) {
      status = await meta.containerStatus(container.id);
      if (status.code === "FINISHED" || status.code === "ERROR" || status.code === "EXPIRED") break;
      await sleep(pollMs);
    }
    if (status.code !== "FINISHED") {
      throw new MetaError(
        status.code === "IN_PROGRESS"
          ? "Instagram is still processing the video after 15 minutes. Nothing was posted. Try again."
          : `Instagram couldn't process this video, so nothing was posted. ${status.message}`.trim(),
      );
    }
    finish("process");

    // Comments can arrive the moment the reel is live, so the rule's window opens before posting.
    const activeFrom = now().toISOString();

    begin("publish");
    if (dryRun) {
      finish("publish", "skipped");
      if (input.rule) finish("keyword", "skipped");
      job.status = "done";
      return;
    }
    job.publishAttempted = true;
    const mediaId = await meta.publish(igId, container.id);
    job.mediaId = mediaId;
    finish("publish");
    job.permalink = await meta.permalink(mediaId).catch(() => null);
    await sleep(FEED_CHECK_DELAY_MS);
    job.postedAsNormal = await meta.sharedToFeed(mediaId).catch(() => null);

    if (input.rule) {
      begin("keyword");
      await rules.add({ ...input.rule, media_id: mediaId, active_from: activeFrom });
      finish("keyword");
    }
    job.status = "done";
  } catch (error) {
    finish(current, "failed");
    job.status = "failed";
    job.error = describeFailure(current, (error as Error).message);
  } finally {
    // The video is only hosted so Meta can fetch it. The link expires by itself if this fails.
    if (hostedName) await hosting.remove(hostedName).catch((error) => console.error(`Hosted video not removed: ${error.message}`));
  }
}

function describeFailure(step: StepKey, message: string): string {
  if (step === "keyword") {
    return `The reel is live, but its keyword didn't turn on, so comments won't get a DM yet. Add it from your recent reels below. ${message}`;
  }
  if (step === "publish") {
    return `Instagram didn't confirm the post. Check your profile before trying again, so it isn't posted twice. ${message}`;
  }
  return message;
}

export function validatePublish(fields: { caption?: unknown; keyword?: unknown; dm_text?: unknown }): string | null {
  if (typeof fields.caption !== "string") return "The caption is missing.";
  if (fields.caption.length > 2200) return "The caption is over Instagram's 2,200 character limit.";
  return validateKeywordPair(fields.keyword, fields.dm_text);
}

export function validateKeywordPair(keyword: unknown, dmText: unknown): string | null {
  const word = String(keyword ?? "").trim();
  const dm = String(dmText ?? "").trim();
  if (word && !dm) return "Write the DM this keyword should send.";
  if (dm && !word) return "Add the keyword that should send this DM.";
  if (dm.length > 1000) return "The DM is over Instagram's 1,000 character limit.";
  return null;
}
