// Trends tab. Uses el(), $(), api() and show() from the inline script in index.html.
(() => {
const HOT = 3;
const state = { data: null, loading: null, showAll: localGet("showAll") === "1", error: "", busy: false };

function localGet(key) { try { return localStorage.getItem(`trends.${key}`); } catch { return null; } }
function localSet(key, value) { try { localStorage.setItem(`trends.${key}`, value); } catch { /* private window */ } }

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const num = (value) => (value === null || value === undefined ? "—" : compact.format(value));

function age(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function ago(iso) {
  if (!iso) return "never";
  const minutes = (Date.now() - Date.parse(iso)) / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const RELOAD_MS = 30 * 60_000;
const ANALYSING_RELOAD_MS = 60_000;
const opened = new Set(); // reels whose "More" section is open, kept across reloads

async function load() {
  state.data = await api("/api/trends");
  state.loadedAt = Date.now();
}

// Supabase rescans every 6 hours, and videos are analysed in the background. While the tab is open,
// pick both up without a manual reload: every minute while analysis runs, else every 30 minutes.
async function reloadIfStale() {
  if (document.hidden || state.busy || !state.data) return;
  const every = state.data.analysis?.running ? ANALYSING_RELOAD_MS : RELOAD_MS;
  if (Date.now() - state.loadedAt < every) return;
  try { await load(); render(); } catch { /* keep showing the last good data */ }
}
setInterval(reloadIfStale, 15_000);
document.addEventListener("visibilitychange", reloadIfStale);

const fromVideo = (t) => t.source === "video";

function ctaTag(t) {
  const s = t.video?.stats;
  const at = fromVideo(t) && t.cta.kind === "Comment keyword" && s?.cta_comment_at_s != null && s.duration_s
    ? ` at ${Math.round((s.cta_comment_at_s / s.duration_s) * 100)}%` : "";
  return el("span", {
    class: `tag cta${t.cta.kind === "None" ? " none" : ""}`,
    textContent: t.cta.label + at,
    title: at ? "Call to action, and how far into the video it's said" : "Call to action",
  });
}

function reelTags(t) {
  return el("div", { class: "tags" },
    t.hook_type ? el("span", { class: "tag hook-type", textContent: t.hook_type, title: "Type of hook" }) : null,
    ...t.topics.map((topic) => el("span", { class: "tag", textContent: topic })),
    ctaTag(t),
    fromVideo(t) ? null : el("span", { class: "tag guess", textContent: "From caption", title: "The video hasn't been analysed yet, so these are guesses from the caption" }));
}

function cover(t) {
  if (!t.thumbnail_url) return el("div", { class: "cover empty-cover" });
  const img = el("img", { src: t.thumbnail_url, alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(el("div", { class: "cover empty-cover" })));
  return el("a", { class: "cover", href: t.permalink || `https://www.instagram.com/${t.username}/`, target: "_blank", rel: "noreferrer", tabIndex: -1 }, img);
}

function pacing(stats) {
  if (!stats) return null;
  const parts = [`${Math.round(stats.duration_s)}s`];
  if (stats.cuts) parts.push(`a cut every ${(stats.duration_s / stats.cuts).toFixed(1)}s`);
  else parts.push("no cuts");
  if (stats.wpm) parts.push(`${stats.wpm} words/min`);
  if (stats.first_word_s != null && stats.words) parts.push(`talks at ${stats.first_word_s}s`);
  return el("div", { class: "pacing", textContent: parts.join(" · ") });
}

function formatCell(t) {
  const l = t.video?.labels;
  const frames = t.video?.frames ?? [];
  return el("td", { class: "format-cell" },
    t.format === "Other" && !fromVideo(t) ? null : el("span", { class: "tag format", textContent: t.format, title: fromVideo(t) ? "Format, from the video" : "Format, guessed from the caption" }),
    l?.format_note ? el("p", { class: "format-note", textContent: l.format_note }) : null,
    frames.length
      ? el("a", { class: "frames-strip", href: t.permalink || "#", target: "_blank", rel: "noreferrer", title: "0s, 1s and 2s into the reel" },
          ...frames.map((src) => el("img", { src, alt: "", loading: "lazy" })))
      : cover(t),
    pacing(t.video?.stats));
}

function more(t) {
  const v = t.video;
  if (!v) return null;
  const l = v.labels;
  const details = el("details", { class: "reel-more", open: opened.has(t.media_id) },
    el("summary", { textContent: "More" }),
    l?.why_it_works ? el("p", {}, el("b", { textContent: "Why it works: " }), l.why_it_works) : null,
    l?.hook_on_screen && l.hook_on_screen !== t.hook ? el("p", {}, el("b", { textContent: "On-screen hook: " }), l.hook_on_screen) : null,
    l?.topic ? el("p", {}, el("b", { textContent: "Topic: " }), l.topic) : null,
    v.sheets.length ? el("div", { class: "watch-sheets" }, ...v.sheets.map((src) => el("img", { src, alt: "", loading: "lazy" }))) : null,
    v.transcript.trim() ? el("p", { class: "watch-transcript", textContent: v.transcript.trim() }) : null);
  details.addEventListener("toggle", () => details.open ? opened.add(t.media_id) : opened.delete(t.media_id));
  return details;
}

function renderTable(trends) {
  const rows = state.showAll ? trends : trends.filter((t) => t.multiple >= 2);
  if (!rows.length) {
    return el("div", { class: "table-wrap" }, el("div", {
      class: "empty",
      textContent: state.showAll
        ? "No reels from the last 14 days yet. The next scan may find some."
        : "Nothing is beating its creator's usual views by 2× right now. Show all recent reels to see the full list.",
    }));
  }
  const head = el("tr", {},
    ...["Above usual", "Reel", "Format", "Posted", "Views", "Their usual", "Likes", "Comments"].map((label, i) =>
      el("th", { class: i === 0 || i >= 3 ? "num" : "", textContent: label })));
  const body = rows.map((t) => el("tr", {},
    el("td", { class: "num" }, el("span", { class: `multiple${t.multiple >= HOT ? " hot" : ""}`, textContent: `${t.multiple.toFixed(1)}×` })),
    el("td", { class: "reel-cell" },
      el("a", { class: "creator", href: `https://www.instagram.com/${t.username}/`, target: "_blank", rel: "noreferrer", textContent: `@${t.username}` }),
      t.permalink
        ? el("a", { class: "trend-hook", href: t.permalink, target: "_blank", rel: "noreferrer", textContent: fromVideo(t) && t.hook ? `“${t.hook}”` : t.hook || "Open reel", title: (t.caption || "").slice(0, 600) })
        : el("span", { class: "trend-hook", textContent: t.hook || "" }),
      reelTags(t),
      more(t)),
    formatCell(t),
    el("td", { class: "num", textContent: age(t.age_days), title: new Date(t.posted_at).toLocaleString() }),
    el("td", { class: "num", textContent: num(t.views) }),
    el("td", { class: "num", textContent: num(Math.round(t.baseline)) }),
    el("td", { class: "num", textContent: num(t.likes) }),
    el("td", { class: "num", textContent: num(t.comments) }),
  ));
  return el("div", { class: "table-wrap" }, el("table", { class: "trends-table" }, el("thead", {}, head), el("tbody", {}, ...body)));
}

function analysisNote(a) {
  if (!a) return null;
  const text = a.running
    ? `Watching the videos: ${a.watched} of ${a.recent} reels done so far. This page updates as it goes.`
    : a.watched >= a.recent
      ? `All ${a.recent} recent reels have been watched. New ones are watched every 30 minutes while this page is open.`
      : `${a.watched} of ${a.recent} reels have been watched. The rest are labelled from their captions until the next pass, every 30 minutes while this page is open.`;
  return el("p", { class: "help", textContent: a.labels ? text : "Add ANTHROPIC_API_KEY to .env to label the videos. Until then, labels come from the captions." });
}

function renderPatterns(patterns, analysis) {
  const column = (title, rows) => el("div", { class: "pattern-col" },
    el("h3", { textContent: title }),
    rows.length
      ? el("ol", {}, ...rows.slice(0, 6).map((row) => el("li", {},
          el("span", { class: "pattern-label", textContent: row.label }),
          el("span", { class: `multiple${row.median >= 1 ? " hot" : ""}`, textContent: `${row.median.toFixed(1)}×` }),
          el("span", { class: "pattern-sub", textContent: `${row.hot} of ${row.reels} reels at 2× or more` }))))
      : el("p", { class: "help", textContent: "Not enough reels yet." }));
  return el("section", { class: "panel" },
    el("div", {},
      el("h2", { textContent: "What's working" }),
      el("p", { class: "help", textContent: "For reels from the last 14 days that are at least 2 days old: how a typical reel with each label did against its creator's usual. 1.0× is usual. Labels with fewer than 3 reels are left out." }),
      analysisNote(analysis)),
    el("div", { class: "patterns" },
      column("Formats", patterns.formats),
      column("Hooks", patterns.hookTypes ?? []),
      column("Topics", patterns.topics),
      column("Calls to action", patterns.ctas)));
}

function renderWatchlist(accounts) {
  const input = el("input", { type: "text", id: "watch-input", placeholder: "Username or profile link, e.g. @creator.name", autocomplete: "off" });
  const error = el("div", { class: "error", hidden: !state.error, textContent: state.error });
  const add = el("button", { class: "secondary", type: "submit", textContent: state.busy ? "Adding…" : "Add creator", disabled: state.busy });
  const form = el("form", { class: "watch-add", onsubmit: async (event) => {
    event.preventDefault();
    if (!input.value.trim() || state.busy) return;
    state.busy = true; state.error = ""; render();
    try {
      await api("/api/watchlist", { method: "POST", body: JSON.stringify({ username: input.value }) });
      await load();
    } catch (err) {
      state.error = err.message;
    }
    state.busy = false;
    render();
    $("watch-input")?.focus();
  } }, input, add);

  const items = accounts.map((a) => el("li", { class: a.last_error ? "bad" : "", title: a.last_error || `${num(a.followers)} followers, read ${ago(a.last_scanned_at)}` },
    el("a", { href: `https://www.instagram.com/${a.username}/`, target: "_blank", rel: "noreferrer", textContent: `@${a.username}` }),
    el("button", { type: "button", ariaLabel: `Remove @${a.username}`, textContent: "×", onclick: async () => {
      if (!confirm(`Stop watching @${a.username}? Their saved reels are removed too.`)) return;
      try {
        await api(`/api/watchlist/${encodeURIComponent(a.username)}`, { method: "DELETE" });
        await load();
      } catch (err) {
        state.error = err.message;
      }
      render();
    } })));
  const failing = accounts.filter((a) => a.last_error);
  return el("section", { class: "panel" },
    el("h2", { textContent: `Watchlist (${accounts.length})` }),
    el("p", { class: "help", textContent: "Business and creator accounts only. Instagram doesn't share personal accounts' reels." }),
    form, error,
    failing.length ? el("p", { class: "notice", textContent: `${failing.length} couldn't be read last time. Hover over the outlined names to see why.` }) : null,
    el("ul", { class: "watch-list" }, ...items));
}

function renderView(root) {
  const { accounts, trends, patterns, analysis } = state.data;
  const lastScan = accounts.map((a) => a.last_scanned_at).filter(Boolean).sort().at(-1);
  const toggle = el("label", { class: "help" },
    el("input", { type: "checkbox", checked: state.showAll, onchange: (event) => {
      state.showAll = event.target.checked; localSet("showAll", state.showAll ? "1" : "0"); render();
    } }),
    " Show all recent reels");
  root.replaceChildren(el("div", { class: "dash" },
    el("div", { class: "trends-head" },
      el("div", {},
        el("h1", { class: "view-title", textContent: "Trends" }),
        el("p", { textContent: `Reels from the last 14 days, ranked by how far they beat their creator's usual views. Usual is the median of that creator's other recent reels. Instagram was last read ${ago(lastScan)}. It's read again every 6 hours, and this page picks that up on its own.` })),
      toggle),
    renderPatterns(patterns, analysis),
    renderTable(trends),
    renderWatchlist(accounts)));
}

async function render() {
  if (location.hash.slice(1) !== "trends") return;
  const root = $("view-trends");
  if (!state.data) {
    root.replaceChildren(el("p", { class: "empty", textContent: "Loading trends…" }));
    try {
      await (state.loading ??= load());
    } catch (error) {
      state.loading = null;
      root.replaceChildren(el("div", { class: "error", textContent: `Couldn't load trends: ${error.message}` }));
      return;
    }
  }
  renderView(root);
}

window.addEventListener("hashchange", render);
render();
})();
