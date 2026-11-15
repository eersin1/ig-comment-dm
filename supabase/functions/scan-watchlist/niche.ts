// Your niche, for the Trends tab. Edit this file to fit the creators you watch.
//
// NICHE goes into the prompt Claude uses to label watched reels (scripts/watch-labels.ts).
// TOPICS are the topic labels. Claude picks from the names, and reels Claude hasn't watched yet
// get topics from their caption with the patterns. Order matters for captions: at most 3 topics are
// kept, first matches first. "Other" is added automatically.
//
// Example for a medicine creator:
//   ["Medicine", /\b(doctors?|surgery|patients?|hospitals?|clinical|medical|diagnos\w*|diseases?|cancer)\b/i],

export const NICHE = "tech, AI, science and self-improvement";

export const TOPICS: [string, RegExp][] = [
  ["AI", /\b(ai|a\.i\.|llms?|gpt[\w-]*|chatgpt|claude|gemini|openai|anthropic|deepmind|machine learning|deep learning|neural net\w*|ai agents?|ml)\b/i],
  ["Tech & gadgets", /\b(iphone|android|apple|samsung|laptops?|gadgets?|apps?|software|tech|chips?|gpus?)\b/i],
  ["Science", /\b(science|scientists?|physics|chemistry|biology|space|nasa|experiments?|research\w*|papers?|a (new )?study)\b/i],
  ["Health & fitness", /\b(health|fitness|workouts?|gym|sleep|diet|nutrition|doctors?|medical|medicine|brain)\b/i],
  ["Careers & study", /\b(careers?|resumes?|cv|internships?|jobs?|universit\w*|college|grad school|phd|students?|studying|exams?|interviews?)\b/i],
  ["Building projects", /\b(i built|we built|i'm building|building (a|an|my|this)|from scratch|side projects?|my project|github|coding|python|open[- ]source|vibe[- ]cod\w*)\b/i],
  ["Business & money", /\b(stocks?|funding|raised|startups?|business|money|invest\w*|billion|ipo|valuation|salary|side hustle)\b/i],
  ["Productivity", /\b(productiv\w*|habits?|routines?|focus|time management|notion|to-?do)\b/i],
];
