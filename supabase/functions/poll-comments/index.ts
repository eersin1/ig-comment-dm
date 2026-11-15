import { createInstagram } from "./instagram.ts";
import { secretsMatch } from "./logic.ts";
import { run } from "./run.ts";
import { createStore } from "./store.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

async function sendEmail(message: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("ALERT_EMAIL");
  if (!apiKey || !to) {
    console.error("Alert email isn't configured, so this alert was only logged.");
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Comment DMs <onboarding@resend.dev>",
      to,
      subject: "Instagram comment DMs need attention",
      text: message,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) console.error(`Alert email failed with HTTP ${response.status}`);
}

Deno.serve(async (request) => {
  if (!await secretsMatch(request.headers.get("x-cron-secret"), Deno.env.get("CRON_SECRET"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = Date.now();
  const { store, claimAlertSlot } = createStore(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const alert = async (message: string) => {
    console.error(`ALERT: ${message}`);
    try {
      if (await claimAlertSlot(now)) await sendEmail(message);
    } catch (error) {
      console.error(`Alert failed: ${(error as Error).message}`);
    }
  };

  try {
    const summary = await run({
      store,
      instagram: createInstagram(
        env("IG_TOKEN"),
        env("IG_USER_ID"),
        Deno.env.get("API_VERSION") ?? "v26.0",
      ),
      alert,
      ownUsername: env("IG_USERNAME"),
      now,
    });
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    await alert(`A comment DM run failed: ${(error as Error).message}`);
    return Response.json({ error: "run failed" }, { status: 500 });
  }
});
