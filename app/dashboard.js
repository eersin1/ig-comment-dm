// Dashboard tab. Uses h(), $(), api() and show() from the inline script in index.html.
(() => {
const STALE_MS = 60 * 60 * 1000;
const AGES = [["24h", "24h"], ["72h", "3 days"], ["168h", "7 days"], ["latest", "Latest"]];

// Outcomes, per age column. `better` drives the variant winner and the colour-free "↑/↓ is good" hint.
const METRICS = {
  skip_rate: { label: "Skip rate", unit: "%", better: "low", help: "Share of viewers who scrolled away in the first ~3s. Hook quality." },
  watch_pct: { label: "% watched", unit: "%", better: "high", help: "Average watch time ÷ length. How well the body holds." },
  avg_watch_s: { label: "Avg watch", unit: "s", better: "high" },
  views: { label: "Views", unit: "", better: "high" },
  reach: { label: "Reach", unit: "", better: "high" },
  share_rate: { label: "Share rate", unit: "%", better: "high", help: "Shares ÷ reach." },
  save_rate: { label: "Save rate", unit: "%", better: "high", help: "Saves ÷ reach." },
  like_rate: { label: "Like rate", unit: "%", better: "high" },
  comment_rate: { label: "Comment rate", unit: "%", better: "high", help: "Comments ÷ reach. Driven by the CTA." },
};
// Things you control, for the x axis.
const FEATURES = {
  hook_words: { label: "Words in first 3s", unit: "" },
  duration_s: { label: "Length", unit: "s" },
  wpm: { label: "Words per minute", unit: "" },
  visual_changes_per_10s: { label: "Visual changes / 10s", unit: "" },
  first_visual_change_s: { label: "First visual change at", unit: "s" },
  cta_comment_at_pct: { label: "Keyword CTA position", unit: "% in" },
  hour: { label: "Posting hour", unit: "h" },
  hours_since_prev_post: { label: "Hours since previous post", unit: "h" },
  caption_chars: { label: "Caption length", unit: " chars" },
};

const state = {
  data: null,
  age: localGet("age") || "latest",
  x: localGet("x") || "hook_words",
  y: localGet("y") || "skip_rate",
  sort: { key: "posted_at", dir: -1 },
  filter: "all",
  reviewOpen: false,
  refreshing: false,
  detailMetric: "views",
};

function localGet(key) { try { return localStorage.getItem(`dash.${key}`); } catch { return null; } }
function localSet(key, value) { try { localStorage.setItem(`dash.${key}`, value); } catch { /* private window */ } }

// Like el() from index.html, but attributes with a dash (aria-*, data-*) and role are set as attributes.
function h(tag, props = {}, ...children) {
  const plain = {}, attrs = {};
  for (const [k, v] of Object.entries(props)) (k.includes("-") || k === "role" ? attrs : plain)[k] = v;
  const node = el(tag, plain, ...children);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  return node;
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  node.append(...children.filter(Boolean));
  return node;
}

const metricKey = (m, age = state.age) => `${m}_${age}`;
const fmt = (value, unit = "") => {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const n = Math.abs(value) >= 1000 ? Math.round(value).toLocaleString() : (Math.round(value * 10) / 10).toLocaleString();
  return unit === "%" ? `${n}%` : unit === "s" ? `${n}s` : `${n}${unit}`;
};
const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const hasKeyword = (r) => Boolean(r.keyword);
const thumb = (folder, frame = "h02") => `/library/${encodeURIComponent(folder)}/hook/${frame}.jpg`;
const shortDate = (posted) => {
  const [d] = String(posted).split(" ");
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

// Nice tick values for an axis.
function ticks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// Spearman rank correlation, for a plain-language read of the scatter.
function spearman(points) {
  const rank = (vals) => {
    const sorted = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(vals.length);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
      for (let k = i; k <= j; k++) ranks[sorted[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(points.map((p) => p.x)), ry = rank(points.map((p) => p.y));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

function tooltip(container) {
  const tip = h("div", { class: "tip", hidden: true });
  container.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = container.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = `${Math.min(Math.max(0, x + 12), box.width - w)}px`;
      tip.style.top = `${y - h - 12 < 0 ? y + 16 : y - h - 12}px`;
    },
    hide() { tip.hidden = true; },
  };
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- data ------------------------------------------------------------------------------------

async function load({ allowRefresh = true } = {}) {
  state.data = await api("/api/dashboard");
  state.refreshing = state.data.refreshing;
  const stale = !state.data.builtAt || Date.now() - Date.parse(state.data.builtAt) > STALE_MS;
  if (allowRefresh && stale && !state.refreshing) refresh();
}

async function refresh() {
  state.refreshing = true;
  render();
  try {
    const result = await api("/api/library/refresh", { method: "POST", body: "{}" });
    if (!result.ok) state.refreshError = "The library update failed. Details are in the Terminal window.";
    else state.refreshError = null;
  } catch (error) {
    state.refreshError = error.message;
  }
  state.refreshing = false;
  await load({ allowRefresh: false }).catch(() => {});
  render();
}

// ---- overview --------------------------------------------------------------------------------

function renderOverview(root) {
  const { reels, builtAt, followers } = state.data;
  const updated = state.refreshing
    ? "Updating the library… new reels take a few seconds each."
    : builtAt ? `Updated ${new Date(builtAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Not built yet";
  const head = h("div", { class: "dash-head" },
    h("h1", { textContent: "Dashboard" }),
    h("div", { class: "controls" },
      h("span", { textContent: updated }),
      h("button", { class: "linkish", type: "button", textContent: "Refresh now", disabled: state.refreshing, onclick: refresh }),
      h("label", { htmlFor: "age-select", textContent: "Compare at" }),
      ageSelect()));
  const parts = [head];
  if (state.refreshError) parts.push(h("div", { class: "error", textContent: state.refreshError }));
  if (!reels.length) {
    parts.push(h("div", { class: "panel" }, h("p", { class: "empty", textContent: state.refreshing ? "Building the library for the first time…" : "No reels in the library yet. Click Refresh now." })));
    return root.replaceChildren(h("div", { class: "dash" }, ...parts));
  }
  if (!reels.some((r) => r[metricKey("skip_rate", "latest")] !== null)) {
    parts.push(h("div", { class: "note", textContent: "Skip rate and watch time arrive with the next hourly snapshot. Until then only views, likes and comments are filled in." }));
  }
  parts.push(renderTiles(reels, followers), renderReview(), renderScatter(reels), renderPairs(reels), renderTable(reels));
  root.replaceChildren(h("div", { class: "dash" }, ...parts));
}

function ageSelect() {
  const select = h("select", { id: "age-select", onchange: (e) => { state.age = e.target.value; localSet("age", state.age); render(); } });
  for (const [value, label] of AGES) select.append(h("option", { value, textContent: label, selected: value === state.age }));
  return select;
}

function renderTiles(reels, followers) {
  const latest = followers.at(-1)?.followers ?? null;
  const first = followers[0];
  const tracked = first ? Date.now() - Date.parse(first.taken_at) : 0;
  const weekAgo = tracked >= 6.5 * 86_400_000 ? followers.find((f) => Date.parse(f.taken_at) >= Date.now() - 7 * 86_400_000)?.followers ?? null : null;
  const recent = [...reels].sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, 10);
  const lastWeek = reels.filter((r) => Date.parse(r.posted_at) >= Date.now() - 7 * 86_400_000).length;
  const tile = (k, v, d) => h("div", { class: "tile" }, h("span", { class: "k", textContent: k }), h("span", { class: "v", textContent: v }), h("span", { class: "d", textContent: d }));
  const diff = latest !== null && weekAgo !== null ? latest - weekAgo : null;
  return h("div", { class: "tiles" },
    tile("Followers", fmt(latest), diff !== null
      ? `${diff >= 0 ? "+" : ""}${diff.toLocaleString()} in 7 days`
      : first && latest !== null ? `${latest - first.followers >= 0 ? "+" : ""}${(latest - first.followers).toLocaleString()} since ${new Date(first.taken_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "Tracking starts this hour"),
    tile("Reels in the last 7 days", String(lastWeek), `${reels.length} in the library`),
    tile("Median skip rate", fmt(median(recent.map((r) => r[metricKey("skip_rate")])), "%"), "Last 10 reels · lower is better"),
    tile("Median % watched", fmt(median(recent.map((r) => r[metricKey("watch_pct")])), "%"), "Last 10 reels · higher is better"),
    tile("DMs sent", fmt(reels.reduce((s, r) => s + (r.dms_sent ?? 0), 0)), "From keyword comments"));
}

function markdown(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  let html = "", list = false;
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (bullet) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(bullet[1])}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    const head = line.match(/^(#{1,3})\s+(.*)/);
    if (head) html += `<h3>${inline(head[2])}</h3>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (list ? "</ul>" : "");
}

function renderReview() {
  const { review, reviewAt } = state.data;
  const panel = h("section", { class: "panel" });
  const when = reviewAt ? new Date(reviewAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  panel.append(h("div", { class: "panel-head" },
    h("h2", { textContent: "Latest review" }),
    h("span", { class: "muted", textContent: when ? `Updated ${when}` : "" })));
  if (!review) {
    panel.append(h("p", { class: "muted", textContent: "Write your notes, or have an AI assistant write a review, in library/review.md. It shows up here." }));
    return panel;
  }
  const body = h("div", { class: `review${state.reviewOpen ? "" : " clamped"}`, innerHTML: markdown(review) });
  panel.append(body, h("button", { class: "linkish", type: "button", textContent: state.reviewOpen ? "Show less" : "Show all", onclick: () => { state.reviewOpen = !state.reviewOpen; render(); } }));
  return panel;
}

// ---- scatter: one thing you control vs one outcome --------------------------------------------

function renderScatter(reels) {
  const xSel = h("select", { "aria-label": "X axis", onchange: (e) => { state.x = e.target.value; localSet("x", state.x); render(); } });
  for (const [k, f] of Object.entries(FEATURES)) xSel.append(h("option", { value: k, textContent: f.label, selected: k === state.x }));
  const ySel = h("select", { "aria-label": "Y axis", onchange: (e) => { state.y = e.target.value; localSet("y", state.y); render(); } });
  for (const [k, m] of Object.entries(METRICS)) ySel.append(h("option", { value: k, textContent: m.label, selected: k === state.y }));

  const fx = FEATURES[state.x], my = METRICS[state.y];
  const points = reels
    .map((r) => ({ r, x: r[state.x], y: r[metricKey(state.y)] }))
    .filter((p) => typeof p.x === "number" && typeof p.y === "number");

  const panel = h("section", { class: "panel" },
    h("div", { class: "panel-head" },
      h("h2", { textContent: "Patterns" }),
      h("div", { class: "controls" }, ySel, h("span", { textContent: "against" }), xSel)));
  if (my.help) panel.append(h("p", { class: "muted", textContent: my.help }));
  if (points.length < 3) {
    panel.append(h("p", { class: "empty", textContent: `Not enough reels with ${my.label.toLowerCase()} at ${AGES.find((a) => a[0] === state.age)[1].toLowerCase()} yet.` }));
    return panel;
  }

  const W = 900, H = 340, m = { l: 56, r: 16, t: 12, b: 44 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xt = ticks(Math.min(...xs), Math.max(...xs)), yt = ticks(Math.min(0, ...ys), Math.max(...ys));
  const sx = (v) => m.l + ((v - xt[0]) / (xt.at(-1) - xt[0])) * (W - m.l - m.r);
  const sy = (v) => H - m.b - ((v - yt[0]) / (yt.at(-1) - yt[0])) * (H - m.t - m.b);

  const grid = svg("g", { class: "grid" }), axis = svg("g", { class: "axis" });
  for (const v of yt) {
    grid.append(svg("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }));
    axis.append(svg("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, document.createTextNode(fmt(v, my.unit))));
  }
  for (const v of xt) axis.append(svg("text", { x: sx(v), y: H - m.b + 18, "text-anchor": "middle" }, document.createTextNode(fmt(v))));
  axis.append(svg("text", { class: "axis-title", x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle" }, document.createTextNode(`${fx.label}${fx.unit ? ` (${fx.unit.trim()})` : ""}`)));

  const chart = h("div", { class: "chart" });
  const tip = tooltip(chart);
  const dots = svg("g");
  for (const p of points) {
    const dot = svg("circle", { class: `dot${hasKeyword(p.r) ? "" : " hollow"}`, cx: sx(p.x), cy: sy(p.y), r: 6, tabindex: 0, role: "button", "aria-label": `${p.r.hook_spoken}: ${fmt(p.y, my.unit)}` });
    const html = `<div>${esc(p.r.hook_spoken || p.r.caption_first_line)}</div><div style="margin-top:4px">${esc(my.label)} <b>${fmt(p.y, my.unit)}</b> · ${esc(fx.label)} <b>${fmt(p.x, fx.unit)}</b></div><div style="opacity:.75">${esc(p.r.posted)}${p.r.keyword ? ` · ${esc(p.r.keyword)}` : ""}</div>`;
    const place = () => { const b = chart.getBoundingClientRect(); const d = dot.getBoundingClientRect(); tip.show(html, d.left - b.left + d.width / 2, d.top - b.top); };
    dot.addEventListener("mouseenter", place);
    dot.addEventListener("focus", place);
    dot.addEventListener("mouseleave", tip.hide);
    dot.addEventListener("blur", tip.hide);
    dot.addEventListener("click", () => openReel(p.r.folder));
    dot.addEventListener("keydown", (e) => { if (e.key === "Enter") openReel(p.r.folder); });
    dots.append(dot);
  }
  chart.prepend(svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${my.label} against ${fx.label}` }, grid, axis, dots));

  const rho = spearman(points);
  const strength = Math.abs(rho) < 0.2 ? "No clear link" : Math.abs(rho) < 0.4 ? "A weak link" : Math.abs(rho) < 0.6 ? "A moderate link" : "A strong link";
  const direction = Math.abs(rho) < 0.2 ? "" : ` — higher ${fx.label.toLowerCase()} goes with ${rho > 0 ? "higher" : "lower"} ${my.label.toLowerCase()}`;
  const dot = (hollow) => svg("svg", { viewBox: "0 0 12 12" }, svg("circle", { cx: 6, cy: 6, r: 4.5, class: `dot${hollow ? " hollow" : ""}`, style: "stroke-width:1.5" }));
  panel.append(chart,
    h("div", { class: "panel-head" },
      h("div", { class: "legend" }, h("span", {}, dot(false), "Keyword CTA"), h("span", {}, dot(true), "No keyword")),
      h("span", { class: "muted", textContent: `${strength}${direction}. ρ = ${rho.toFixed(2)}, ${points.length} reels${points.length < 12 ? " — too few to trust" : ""}.` })));
  return panel;
}

// ---- variant pairs ---------------------------------------------------------------------------

function renderPairs(reels) {
  const groups = new Map();
  for (const r of reels) groups.set(r.variant_group, [...(groups.get(r.variant_group) ?? []), r]);
  const pairs = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b[0].posted_at.localeCompare(a[0].posted_at));
  const panel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { textContent: "Hook tests" }),
      h("span", { class: "muted", textContent: "Same video, different hooks, posted minutes apart" })));
  if (!pairs.length) {
    panel.append(h("p", { class: "muted", textContent: "No variant pairs yet. Post two versions of one video as trial reels within a few hours." }));
    return panel;
  }
  const list = h("div", { class: "pairs" });
  for (const group of pairs) {
    // Lower skip rate wins; without skip rates, more views.
    const skip = (r) => r[metricKey("skip_rate", "latest")];
    const bySkip = group.every((r) => typeof skip(r) === "number");
    let best = bySkip ? group.reduce((a, b) => (skip(b) < skip(a) ? b : a)) : group.reduce((a, b) => ((b.views_now ?? 0) > (a.views_now ?? 0) ? b : a));
    // Under 2 points apart is noise at these view counts.
    const tie = bySkip && group.every((r) => skip(r) - skip(best) < 2);
    if (tie) best = null;
    const row = h("div", { class: "pair" });
    for (const r of group) {
      const win = r === best;
      row.append(h("button", { class: `variant${win ? " win" : ""}`, type: "button", onclick: () => openReel(r.folder) },
        h("img", { src: thumb(r.folder), alt: "", loading: "lazy" }),
        h("div", {},
          win ? h("div", { class: "winner", textContent: bySkip ? "✓ Lower skip rate" : "✓ More views (no skip rate yet)" }) : null,
          h("div", { class: "hook", textContent: r.hook_spoken || r.caption_first_line }),
          h("dl", {},
            h("dt", { textContent: "Skip rate" }), h("dd", { textContent: fmt(skip(r), "%") }),
            h("dt", { textContent: "% watched" }), h("dd", { textContent: fmt(r.watch_pct_latest, "%") }),
            h("dt", { textContent: "Views" }), h("dd", { textContent: fmt(r.views_now) }),
            h("dt", { textContent: "Comments" }), h("dd", { textContent: fmt(r.comments_now) }),
            h("dt", { textContent: "Shares" }), h("dd", { textContent: fmt(r.share_rate_latest, "%") })))));
    }
    list.append(h("div", {}, h("p", { class: "muted", style: "margin-bottom:6px", textContent: `${group[0].posted} · ${group[0].keyword ?? "no keyword"}${tie ? " · Tie: skip rates within 2 points" : ""}` }), row));
  }
  panel.append(list);
  return panel;
}

// ---- table -----------------------------------------------------------------------------------

function renderTable(reels) {
  const cols = [
    { key: "posted_at", label: "Reel", render: (r) => h("td", { class: "hookcell" }, h("b", { textContent: r.hook_spoken || r.caption_first_line }), h("small", { class: "muted", textContent: `${shortDate(r.posted)} · ${r.posted.split(" ")[1]}` })) },
    { key: "duration_s", label: "Length", unit: "s" },
    { key: "views_now", label: "Views" },
    { key: metricKey("skip_rate"), label: "Skip", unit: "%" },
    { key: metricKey("watch_pct"), label: "Watched", unit: "%" },
    { key: metricKey("share_rate"), label: "Shares", unit: "%" },
    { key: metricKey("save_rate"), label: "Saves", unit: "%" },
    { key: "comments_now", label: "Comments" },
    { key: "dms_sent", label: "DMs" },
    { key: "keyword", label: "CTA", render: (r) => h("td", {}, r.keyword ? h("span", { class: "kw", textContent: r.keyword }) : h("span", { class: "muted", textContent: "—" })) },
  ];
  const rows = reels.filter((r) => state.filter === "all" || (state.filter === "keyword") === hasKeyword(r));
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });

  const seg = h("div", { class: "seg", role: "group", "aria-label": "Filter by CTA" });
  for (const [value, label] of [["all", "All"], ["keyword", "Keyword CTA"], ["none", "No keyword"]]) {
    seg.append(h("button", { type: "button", textContent: label, "aria-pressed": String(state.filter === value), onclick: () => { state.filter = value; render(); } }));
  }

  const headRow = h("tr", {}, h("th", {}, h("span", { class: "sr-only", textContent: "Thumbnail" })));
  for (const c of cols) {
    const th = h("th", { class: c.render ? "" : "num" },
      h("button", { class: "sort", type: "button", textContent: `${c.label}${key === c.key ? (dir > 0 ? " ↑" : " ↓") : ""}`, onclick: () => {
        state.sort = { key: c.key, dir: key === c.key ? -dir : c.key === "posted_at" ? -1 : -1 };
        render();
      } }));
    if (key === c.key) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    headRow.append(th);
  }
  const body = h("tbody");
  for (const r of rows) {
    const tr = h("tr", { class: "clickable", tabIndex: 0, onclick: () => openReel(r.folder), onkeydown: (e) => { if (e.key === "Enter") openReel(r.folder); } },
      h("td", {}, h("img", { class: "thumb", src: thumb(r.folder), alt: "", loading: "lazy" })));
    for (const c of cols) tr.append(c.render ? c.render(r) : h("td", { class: "num", textContent: fmt(r[c.key], c.unit) }));
    body.append(tr);
  }
  return h("section", {},
    h("div", { class: "recent-head" }, h("h2", { textContent: "All reels" }), seg),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, headRow), body)));
}

// ---- one reel --------------------------------------------------------------------------------

async function renderDetail(root, folder) {
  root.replaceChildren(h("p", { class: "empty", textContent: "Loading…" }));
  let d;
  try {
    d = await api(`/api/reels/${encodeURIComponent(folder)}`);
  } catch (error) {
    root.replaceChildren(h("a", { class: "back", href: "#dashboard", textContent: "← Dashboard" }), h("div", { class: "error", textContent: error.message }));
    return;
  }
  const { reel, metrics, cues, hook, sheets } = d;
  const row = state.data?.reels.find((r) => r.folder === folder) ?? {};
  const base = `/library/${encodeURIComponent(folder)}/`;
  const video = h("video", { src: `${base}video.mp4`, controls: true, playsInline: true, preload: "metadata" });
  const seek = (t) => { video.currentTime = t; video.play().catch(() => {}); };

  const last = metrics.at(-1);
  const ins = last?.insights ?? {};
  const tile = (k, v, sub) => h("div", { class: "tile" }, h("span", { class: "k", textContent: k }), h("span", { class: "v", textContent: v }), sub ? h("span", { class: "d", textContent: sub }) : null);
  const avgWatch = ins.ig_reels_avg_watch_time != null ? ins.ig_reels_avg_watch_time / 1000 : null;
  const tiles = h("div", { class: "tiles" },
    tile("Views", fmt(ins.views ?? reel.now.views)),
    tile("Skip rate", fmt(ins.reels_skip_rate, "%"), "Lower is better"),
    tile("% watched", fmt(avgWatch != null ? (avgWatch / reel.duration_s) * 100 : null, "%"), avgWatch != null ? `${fmt(avgWatch, "s")} of ${fmt(reel.duration_s, "s")}` : null),
    tile("Shares", fmt(ins.shares), row[metricKey("share_rate", "latest")] != null ? `${fmt(row.share_rate_latest, "%")} of reach` : null),
    tile("Saves", fmt(ins.saved), row.save_rate_latest != null ? `${fmt(row.save_rate_latest, "%")} of reach` : null),
    tile("Comments", fmt(ins.comments ?? reel.now.comments), reel.keyword ? `${fmt(reel.dms_sent)} DMs sent` : null));

  const ctaStart = reel.cta_comment_at_s;
  const transcript = h("div", { class: "transcript" });
  const cueNodes = cues.map((c) => {
    const node = h("button", { class: `cue${c.start < 3 ? " hook-cue" : ""}${ctaStart != null && c.start === ctaStart ? " cta" : ""}`, type: "button", onclick: () => seek(c.start) },
      h("time", { textContent: `${Math.floor(c.start / 60)}:${String(Math.floor(c.start % 60)).padStart(2, "0")}` }),
      h("span", { textContent: c.text }));
    transcript.append(node);
    return node;
  });
  video.addEventListener("timeupdate", () => {
    const t = video.currentTime;
    cueNodes.forEach((n, i) => n.classList.toggle("now", t >= cues[i].start && t < cues[i].end));
  });

  const frames = h("div", { class: "frames" }, ...hook.map((f, i) => h("img", { src: base + f, alt: `Frame at ${(i / 3).toFixed(1)}s`, title: `${(i / 3).toFixed(1)}s`, loading: "lazy", onclick: () => seek(i / 3) })));

  const metricChoices = [
    ["views", "Views", (s) => s.insights.views ?? s.views, ""],
    ["reach", "Reach", (s) => s.insights.reach ?? null, ""],
    ["skip", "Skip rate", (s) => s.insights.reels_skip_rate ?? null, "%"],
    ["watch", "Avg watch", (s) => (s.insights.ig_reels_avg_watch_time != null ? s.insights.ig_reels_avg_watch_time / 1000 : null), "s"],
    ["shares", "Shares", (s) => s.insights.shares ?? null, ""],
    ["saves", "Saves", (s) => s.insights.saved ?? null, ""],
    ["comments", "Comments", (s) => s.insights.comments ?? s.comments, ""],
  ];
  const chartBox = h("div");
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Metric over time" });
  const drawChart = () => {
    const [, label, pick, unit] = metricChoices.find((m) => m[0] === state.detailMetric) ?? metricChoices[0];
    const pts = metrics.map((s) => ({ x: s.age_hours, y: pick(s) })).filter((p) => typeof p.y === "number");
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.key === state.detailMetric));
    chartBox.replaceChildren(lineChart(pts, label, unit));
  };
  for (const [k, label] of metricChoices) seg.append(h("button", { type: "button", textContent: label, "data-key": k, onclick: () => { state.detailMetric = k; drawChart(); } }));
  drawChart();

  const notes = [];
  if (reel.first_word_s) notes.push(`First word at ${fmt(reel.first_word_s, "s")}`);
  if (reel.wpm) notes.push(`${reel.wpm} words/min`);
  if (row.visual_changes_per_10s != null) notes.push(`${fmt(row.visual_changes_per_10s)} visual changes / 10s`);
  if (ctaStart != null) notes.push(`Keyword CTA at ${fmt(ctaStart, "s")} (${Math.round((ctaStart / reel.duration_s) * 100)}% in)`);

  root.replaceChildren(
    h("a", { class: "back", href: "#dashboard", textContent: "← Dashboard" }),
    h("div", { class: "detail" },
      h("div", { class: "side" }, video,
        h("a", { href: reel.permalink, target: "_blank", rel: "noreferrer", textContent: "Open on Instagram" }),
        h("span", { class: "muted", textContent: `${reel.posted_local} · ${fmt(reel.duration_s, "s")}` })),
      h("div", { class: "dash" },
        h("div", {}, h("h1", { style: "font-size:22px", textContent: reel.hook_spoken || reel.caption.split("\n")[0] }),
          h("p", { class: "muted", style: "margin-top:6px", textContent: notes.join(" · ") })),
        tiles,
        h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { textContent: "First 3 seconds" }), h("span", { class: "muted", textContent: "Click a frame to jump there" })), frames),
        h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { textContent: "Over time" }), seg), chartBox),
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", { textContent: "Transcript" }),
            h("div", { class: "legend" }, h("span", { class: "cue hook-cue", style: "display:inline;padding:2px 6px", textContent: "Hook" }), ctaStart != null ? h("span", { class: "cue cta", style: "display:inline;padding:2px 6px", textContent: "CTA" }) : null)),
          transcript),
        h("section", { class: "panel" }, h("h2", { textContent: "Caption" }), h("div", { class: "caption-box", textContent: reel.caption || "No caption" }),
          reel.dm_text ? h("h2", { textContent: `DM for ${reel.keyword}` }) : null,
          reel.dm_text ? h("div", { class: "caption-box", textContent: reel.dm_text }) : null),
        sheets.length ? h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { textContent: "Whole video" }), h("span", { class: "muted", textContent: "One frame per second, 9 seconds per sheet" })),
          h("div", { class: "sheets" }, ...sheets.map((s) => h("img", { src: base + s, alt: "", loading: "lazy" })))) : null)));
}

function lineChart(points, label, unit) {
  if (points.length < 2) {
    return h("p", { class: "muted", textContent: points.length ? `One snapshot so far: ${fmt(points[0].y, unit)} at ${fmt(points[0].x)}h. The line fills in as hourly snapshots arrive.` : `No ${label.toLowerCase()} recorded yet. Snapshots start within the hour.` });
  }
  const W = 820, H = 240, m = { l: 56, r: 16, t: 12, b: 40 };
  const xt = ticks(Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)));
  const yt = ticks(Math.min(0, ...points.map((p) => p.y)), Math.max(...points.map((p) => p.y)), 4);
  const sx = (v) => m.l + ((v - xt[0]) / (xt.at(-1) - xt[0])) * (W - m.l - m.r);
  const sy = (v) => H - m.b - ((v - yt[0]) / (yt.at(-1) - yt[0])) * (H - m.t - m.b);
  const grid = svg("g", { class: "grid" }), axis = svg("g", { class: "axis" });
  for (const v of yt) {
    grid.append(svg("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }));
    axis.append(svg("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, document.createTextNode(fmt(v, unit))));
  }
  for (const v of xt) axis.append(svg("text", { x: sx(v), y: H - m.b + 18, "text-anchor": "middle" }, document.createTextNode(`${fmt(v)}h`)));
  axis.append(svg("text", { class: "axis-title", x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle" }, document.createTextNode("Hours since posting")));
  const path = svg("path", { class: "line", d: points.map((p, i) => `${i ? "L" : "M"}${sx(p.x)},${sy(p.y)}`).join("") });
  const cross = svg("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const marker = svg("circle", { class: "marker", r: 5, visibility: "hidden" });
  const end = points.at(-1);
  const endDot = svg("circle", { class: "marker", r: 4, cx: sx(end.x), cy: sy(end.y) });
  const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${label} over time, now ${fmt(end.y, unit)}` }, grid, axis, path, endDot, cross, marker, hit);
  const box = h("div", { class: "chart" }, s);
  const tip = tooltip(box);
  hit.addEventListener("mousemove", (e) => {
    const rect = s.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const p = points.reduce((a, b) => (Math.abs(sx(b.x) - x) < Math.abs(sx(a.x) - x) ? b : a));
    for (const node of [cross, marker]) node.setAttribute("visibility", "visible");
    cross.setAttribute("x1", sx(p.x)); cross.setAttribute("x2", sx(p.x));
    marker.setAttribute("cx", sx(p.x)); marker.setAttribute("cy", sy(p.y));
    tip.show(`${esc(label)} <b>${fmt(p.y, unit)}</b><div style="opacity:.75">${fmt(p.x)} hours in</div>`, (sx(p.x) / W) * rect.width, (sy(p.y) / H) * rect.height);
  });
  hit.addEventListener("mouseleave", () => { for (const node of [cross, marker]) node.setAttribute("visibility", "hidden"); tip.hide(); });
  return box;
}

// ---- routing ---------------------------------------------------------------------------------

function openReel(folder) { location.hash = `reel/${encodeURIComponent(folder)}`; }

let loading = null;
async function render() {
  const hash = location.hash.slice(1) || "post";
  const onPost = hash === "post";
  const onTrends = hash === "trends";
  $("view-post").hidden = !onPost;
  $("view-trends").hidden = !onTrends;
  $("view-dashboard").hidden = onPost || onTrends;
  for (const [id, active] of [["tab-post", onPost], ["tab-dashboard", !onPost && !onTrends], ["tab-trends", onTrends]]) {
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  if (onPost || onTrends) return;

  const root = $("view-dashboard");
  if (!state.data) {
    root.replaceChildren(h("p", { class: "empty", textContent: "Loading the dashboard…" }));
    try {
      await (loading ??= load());
    } catch (error) {
      loading = null;
      root.replaceChildren(h("div", { class: "error", textContent: `Couldn't load the dashboard: ${error.message}` }));
      return;
    }
  }
  if (hash.startsWith("reel/")) {
    const y = window.scrollY;
    await renderDetail(root, decodeURIComponent(hash.slice(5)));
    if (state.lastHash === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
  } else {
    renderOverview(root);
  }
  state.lastHash = location.hash;
}

window.addEventListener("hashchange", render);
render();
})();
