import { assertEquals } from "jsr:@std/assert@1";
import { ctaOf, describe, formatOf, hookOf, patterns, topicsOf } from "./describe.ts";

Deno.test("the hook is the first sentence, skipping an opening CTA, hashtags and styled letters", () => {
  assertEquals(hookOf("Comment PLAN and I'll send it. This robot can fold laundry! More below #ai"), "This robot can fold laundry!");
  assertEquals(hookOf("𝗧𝗛𝗘 𝗗𝗔𝗜𝗟𝗬 𝗣𝗔𝗣𝗘𝗥\nmore text"), "THE DAILY PAPER");
  assertEquals(hookOf("#ai #ml\n@someone"), null);
  assertEquals(hookOf(null), null);
  assertEquals(hookOf("x".repeat(200))!.length, 118);
});

Deno.test("finds the comment keyword in any quote style and ignores 'comment below'", () => {
  assertEquals(ctaOf("comment “dataset” and I’ll send you the link").label, 'Comment "DATASET"');
  assertEquals(ctaOf("Comment PLAN and I'll send you my breakdown").label, 'Comment "PLAN"');
  assertEquals(ctaOf("Comment below what you think").kind, "Question");
  assertEquals(ctaOf("Subscribe to my free newsletter (link in bio)!").kind, "Link in bio");
  assertEquals(ctaOf("follow for more ml content").kind, "Follow");
  assertEquals(ctaOf("what did I miss? #engineering #study").kind, "Question");
  assertEquals(ctaOf("so powerful").kind, "None");
});

Deno.test("tags topics and picks one format", () => {
  assertEquals(topicsOf("the AI addition to my resume. a new study on sleep"), ["AI", "Science", "Health & fitness"]);
  assertEquals(topicsOf("sunset at the beach"), []);
  assertEquals(formatOf("python for beginners pt 2"), "Series");
  assertEquals(formatOf("Yesterday a small lab revealed a new battery"), "News breakdown");
  assertEquals(formatOf("Tea vs coffee for focus"), "Comparison");
  assertEquals(formatOf("Why do we dream?"), "Explainer");
  assertEquals(formatOf("A student with no coding background built a weather app"), "Story about someone");
  assertEquals(formatOf("work hard, live harder"), "Other");
});

Deno.test("patterns rank labels by their typical multiple and skip rare ones", () => {
  const reel = (caption: string, multiple: number) => ({ ...describe(caption), multiple });
  const result = patterns([
    reel("gym routine news", 4), reel("new workout trial", 3), reel("sleep tips", 1),
    reel("AI agent", 0.5), reel("AI tool", 0.4), reel("AI model", 2), reel("rocket", 9),
  ]);
  assertEquals(result.topics.map((row) => row.label), ["Health & fitness", "AI"]);
  assertEquals(result.topics[0], { label: "Health & fitness", reels: 3, hot: 2, median: 3 });
});
