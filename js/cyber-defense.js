/**
 * BTECH CYBER DEFENSE — Admin Dashboard security module
 * ----------------------------------------------------------------
 * Mounts into [data-cyber-defense] on admin.html. RECOMMENDATION MODE: nothing in this module changes
 * customer data, wallets, payments, providers or access. It reads security_* tables and calls
 * security_* RPCs; every RPC re-checks is_security_admin() (admin role AND membership of the
 * server-side security_admins table) in the database.
 *
 * Hiding this panel from everyone else is a courtesy, NOT the security boundary: the panel stays
 * hidden unless security_overview() succeeds, and a denied call shows nothing at all. There is no
 * email check anywhere in this file.
 *
 * Honesty rules: a score is never shown without its coverage; "not assessed" / "out of date" are
 * not scored; sources that are not connected say so; findings carry an evidence level
 * (verified / potential / unverified). All dynamic text is escaped.
 */
import { supabase } from "./supabase.js";
import { escapeHtml as esc, showToast, formatDateTime, timeAgo } from "./utils.js";

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const RESULT_LABEL = { PASS: "Pass", PARTIAL: "Partial", FAIL: "Fail", UNKNOWN: "Not assessed", STALE: "Out of date" };
const LEVEL_LABEL = { verified: "Verified", potential: "Potential", unverified: "Unverified" };
const LEVEL_HELP = {
  verified: "Seen directly (a query result, a dashboard setting, a response).",
  potential: "Inferred from code or configuration; not demonstrated.",
  unverified: "An assumption. Not counted in the score.",
};
const RATING_LABEL = { strong: "Strong", good: "Good", fair: "Fair", poor: "Poor", no_data: "No data" };
const SRC_LABEL = { connected: "Connected", partial: "Partial", not_connected: "Not connected", error: "Error" };
const NAV = [
  ["SOC command", [["overview", "Command center", "grid"], ["events", "Event stream", "terminal"]]],
  ["Incident response", [["incidents", "Incidents", "alert"], ["findings", "Findings", "flag"], ["rules", "Detection rules", "sliders"]]],
  ["Defense workspaces", [["ws:identity", "Identity & Access", "user"], ["ws:database", "Database Defense", "db"],
  ["ws:payment", "Payment Shield", "card"], ["ws:provider", "Provider Defense", "server"], ["ws:surface", "Attack Surface", "globe"]]],
  ["Security lab", [["checks", "Security checks", "flask"], ["sources", "Sources & topology", "radar"], ["audit", "Audit vault", "lock"]]],
];
const TABS = NAV.flatMap(([, items]) => items.map(([k, l]) => [k, l]));
// Defense workspaces are filtered views over data that already exists: score categories, findings, events by source,
// and incidents by rule prefix. They add no new data source and invent nothing.
const WORKSPACES = {
  identity: { label: "Identity & Access", cats: ["authorization", "auth_sessions", "account_protection"], sources: ["supabase_auth", "app_admin"], rules: ["admin.", "auth."] },
  database: { label: "Database Defense", cats: ["database_rls", "data_protection"], sources: ["supabase_postgres"], rules: ["check."] },
  payment: { label: "Payment Shield", cats: ["payment_integrity"], sources: ["payments"], rules: ["pay."] },
  provider: { label: "Provider Defense", cats: ["api_edge"], sources: ["provider_delix", "edge_functions"], rules: ["provider."] },
  surface: { label: "Attack Surface", cats: ["frontend_exposure", "headers", "secrets", "dependency_config"], sources: ["render_hosting", "github_repo"], rules: [] },
};
const ICON = {
  grid: "M3 3h8v8H3zM13 3h8v5h-8zM13 11h8v10h-8zM3 14h8v7H3z", terminal: "M3 4h18v16H3zM7 9l3 3-3 3M12 15h5",
  flag: "M5 21V4M5 4h12l-2.5 4L17 12H5", alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  sliders: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h12M20 17h0M15 5v4M9 10v4M18 15v4",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  card: "M3 6h18v12H3zM3 10h18M7 15h3", server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3", radar: "M12 12h.01M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7M5.5 5.5a9 9 0 000 13M18.5 5.5a9 9 0 010 13",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 018 0v4M12 15v2", bell: "M6 9a6 6 0 0112 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 004 0",
  menu: "M4 6h16M4 12h16M4 18h16", expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5", shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  chev: "M9 6l6 6-6 6", spin: "M12 3a9 9 0 109 9",
};
const ic = (n, cls = "") => `<svg class="cd-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[n] || ""}"/></svg>`;

let root;
const st = {
  tab: "overview", overview: null, score: null, descriptions: {}, findingFilter: "open", incFilter: "active", prevPct: null, user: null, clock: null,
  ev: { q: "", sev: "all", src: "all", sort: "desc", page: 1 }
};

const rpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) throw error;
  return data;
};
const fail = (e) => showToast((e && e.message) || "Something went wrong.", "error");
const chip = (cls, text, title) => `<span class="cd-chip cd-chip--${esc(cls)}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
const sevChip = (s) => chip(s, s);
const lvlChip = (l) => chip("lvl-" + l, LEVEL_LABEL[l] || l, LEVEL_HELP[l]);
const resChip = (r) => chip("res-" + r.toLowerCase(), RESULT_LABEL[r] || r);
const short = (id) => (id ? esc(String(id).slice(0, 8)) : "—");
const num = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const pad2 = (n) => String(n).padStart(2, "0");
const stamp = (v) => { const d = new Date(v); return isNaN(d) ? "—" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ init */
export async function initCyberDefense() {
  root = document.querySelector("[data-cyber-defense]");
  if (!root) return;
  const panel = root.closest("[data-cyber-panel]") || root;
  const navLink = document.querySelector("[data-cyber-nav]");
  try {
    st.overview = await rpc("security_overview");
  } catch (e) {
    // Not a security administrator (or the module is not installed yet): show nothing at all.
    if (!e || (e.code !== "42501" && !/not authori[sz]ed|permission denied|does not exist|could not find/i.test(e.message || ""))) {
      console.warn("Cyber Defense unavailable:", e && e.message);
    }
    return;
  }
  panel.hidden = false;
  if (navLink) navLink.hidden = false;
  try {
    const { data } = await supabase.auth.getSession();
    st.user = (data && data.session && data.session.user && data.session.user.email) || null;   // display only; never used for access
  } catch (_) { /* profile chip simply omits the address */ }
  shell();
  await loadScore();
  await showTab(st.tab);
}

function shell() {
  const env = envLabel();
  root.innerHTML = `
    <div class="cd" data-cd-root>
      <div class="cd-progress" data-cd-progress hidden><i></i></div>
      <div class="cd-shell">
        <aside class="cd-side" data-cd-side aria-label="Cyber Defense workspaces">
          <div class="cd-brand">
            <svg class="cd-brand__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2l12 4v9c0 7-5 12.5-12 15C9 27.500 4 22 4 15V6z" fill="var(--cd-maroon)" stroke="var(--cd-brand)" stroke-width="1.5"/><path d="M11 16l3.500 3.500L21 12.500" fill="none" stroke="var(--cd-green)" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div><strong>BTECH CYBER DEFENSE</strong><span>Security Operations Center</span></div>
          </div>
          <nav class="cd-nav" role="tablist" aria-label="Sections" aria-orientation="vertical">
            ${NAV.map(([g, items]) => `<div class="cd-nav__group"><h3>${esc(g)}</h3>
              ${items.map(([k, l, i]) => `<button type="button" class="cd-tab" role="tab" data-cd-tab="${esc(k)}" title="${esc(l)}" aria-selected="${k === st.tab}">${ic(i)}<span>${esc(l)}</span><b class="cd-tab__n" data-cd-count="${esc(k)}" hidden></b></button>`).join("")}
            </div>`).join("")}
          </nav>
          <p class="cd-side__note">Recommendation mode: this workstation reads and recommends. It never changes customer data, wallets, payments or providers.</p>
        </aside>
        <button type="button" class="cd-scrim" data-cd-scrim aria-label="Close menu" tabindex="-1"></button>
        <div class="cd-work">
          <header class="cd-top">
            <button type="button" class="cd-iconbtn cd-menu" data-cd-menu aria-label="Open workspace menu" aria-expanded="false">${ic("menu")}</button>
            <div class="cd-top__title"><h2 data-cd-title>Command center</h2><span data-cd-mode></span></div>
            <div class="cd-top__status">
              <span class="cd-pill" data-cd-env title="Taken from the address of this page">${esc(env)}</span>
              <span class="cd-pill" data-cd-monitor></span>
              <time class="cd-clock" data-cd-clock></time>
            </div>
            <div class="cd-top__actions">
              <button type="button" class="cd-iconbtn cd-bell" data-cd-bell aria-label="Active incidents">${ic("bell")}<b data-cd-bellcount hidden></b></button>
              <span class="cd-user" data-cd-user title="Signed in as a security administrator"><i aria-hidden="true"></i><span></span></span>
              <button type="button" class="btn btn--secondary btn--sm" data-cd-refresh>Refresh</button>
              <button type="button" class="btn btn--primary btn--sm" data-cd-save title="Recalculate the score and keep it in the history">Save assessment</button>
              <button type="button" class="cd-iconbtn" data-cd-focus aria-pressed="false" aria-label="Full-screen workstation" title="Full-screen workstation">${ic("expand")}</button>
            </div>
          </header>
          <div class="cd-body" data-cd-body></div>
        </div>
      </div>
    </div>`;
  paintMode(); paintStatus();
  root.querySelectorAll("[data-cd-tab]").forEach((b) => b.addEventListener("click", () => { closeMenu(); showTab(b.dataset.cdTab); }));
  root.querySelector("[data-cd-refresh]").addEventListener("click", (e) => reload(e.currentTarget));
  root.querySelector("[data-cd-save]").addEventListener("click", saveAssessment);
  root.querySelector("[data-cd-bell]").addEventListener("click", () => showTab("incidents"));
  root.querySelector("[data-cd-menu]").addEventListener("click", toggleMenu);
  root.querySelector("[data-cd-scrim]").addEventListener("click", closeMenu);
  root.querySelector("[data-cd-focus]").addEventListener("click", toggleFocus);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (root.querySelector(".cd--nav-open")) closeMenu(); else if (root.querySelector(".cd--focus")) toggleFocus();
  });
  if (st.clock) clearInterval(st.clock);
  st.clock = setInterval(() => { if (!root.isConnected) { clearInterval(st.clock); return; } paintClock(); }, 30000);
}

function envLabel() {
  const h = location.hostname || "";
  if (!h || h === "localhost" || h === "127.0.0.1") return "Local";
  if (/(^|\.)btechsmm\.store$/.test(h)) return "Production · btechsmm.store";
  return h;
}

function paintMode() {
  const m = st.overview && st.overview.mode;
  const el = root.querySelector("[data-cd-mode]");
  if (el) el.textContent = m === "recommendation" ? "Recommendation mode · read-only toward the platform" : String(m || "");
}

function paintClock() {
  const el = root.querySelector("[data-cd-clock]");
  if (!el) return;
  const d = new Date();
  el.textContent = `${stamp(d).slice(0, 16)}`;
  el.dateTime = d.toISOString();
}

// Header indicators come straight from the overview the database returned; nothing is derived for show.
function paintStatus() {
  const o = st.overview || {}, srcs = o.sources || [];
  const n = srcs.length, ok = srcs.filter((x) => x.status === "connected").length;
  const bad = srcs.filter((x) => x.status === "error" || x.status === "partial").length;
  const mon = root.querySelector("[data-cd-monitor]");
  if (mon) {
    mon.className = "cd-pill cd-pill--" + (ok === n && n ? "ok" : ok || bad ? "warn" : "idle");
    mon.textContent = ok === 0 && !bad ? "Monitoring: no sources connected" : `Monitoring: ${ok}/${n} sources connected`;
  }
  const inc = Number(o.open_incidents || 0), bc = root.querySelector("[data-cd-bellcount]");
  if (bc) { bc.hidden = !inc; bc.textContent = String(inc); }
  const bell = root.querySelector("[data-cd-bell]");
  if (bell) bell.setAttribute("aria-label", inc ? `${inc} active incident${inc === 1 ? "" : "s"}` : "No active incidents");
  const ib = root.querySelector('[data-cd-count="incidents"]');
  if (ib) { ib.hidden = !inc; ib.textContent = String(inc); }
  const u = root.querySelector("[data-cd-user]");
  if (u) {
    u.hidden = !st.user;
    if (st.user) { u.querySelector("i").textContent = st.user.slice(0, 1).toUpperCase(); u.querySelector("span").textContent = st.user; }
  }
  paintClock();
}

function setLoading(on) {
  const bar = root.querySelector("[data-cd-progress]");
  if (bar) bar.hidden = !on;
}
// Mark a button busy only while its real request is in flight.
function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on; btn.classList.toggle("is-busy", on);
  if (on) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
}
function toggleMenu() {
  const c = root.querySelector("[data-cd-root]"), open = !c.classList.contains("cd--nav-open");
  c.classList.toggle("cd--nav-open", open);
  root.querySelector("[data-cd-menu]").setAttribute("aria-expanded", String(open));
}
function closeMenu() {
  const c = root.querySelector("[data-cd-root]");
  if (c) c.classList.remove("cd--nav-open");
  const m = root.querySelector("[data-cd-menu]"); if (m) m.setAttribute("aria-expanded", "false");
}
function toggleFocus() {
  const c = root.querySelector("[data-cd-root]"), on = !c.classList.contains("cd--focus");
  c.classList.toggle("cd--focus", on);
  document.documentElement.classList.toggle("cd-lock", on);
  const b = root.querySelector("[data-cd-focus]");
  b.setAttribute("aria-pressed", String(on));
  b.innerHTML = ic(on ? "shrink" : "expand");
  b.setAttribute("aria-label", on ? "Leave full-screen" : "Full-screen workstation");
}

async function reload(btn) {
  busy(btn, true); setLoading(true);
  try {
    st.overview = await rpc("security_overview");
    paintMode(); paintStatus();
    await loadScore();
    await showTab(st.tab);
  } catch (e) { fail(e); } finally { busy(btn, false); setLoading(false); }
}

async function saveAssessment() {
  const btn = root.querySelector("[data-cd-save]");
  busy(btn, true);
  try {
    await rpc("security_compute_score", { p_persist: true });
    showToast("Assessment saved to the history.", "success");
    await reload();
  } catch (e) { fail(e); } finally { busy(btn, false); }
}

async function loadScore() {
  st.score = await rpc("security_compute_score", { p_persist: false });
  if (!Object.keys(st.descriptions).length) {
    const { data } = await supabase.from("security_checks").select("key,description,valid_days,automated").eq("active", true);
    (data || []).forEach((c) => { st.descriptions[c.key] = c; });
  }
}

async function showTab(t) {
  st.tab = t;
  root.querySelectorAll("[data-cd-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cdTab === t)));
  const label = (TABS.find(([k]) => k === t) || [t, t])[1];
  const title = root.querySelector("[data-cd-title]"); if (title) title.textContent = label;
  const body = root.querySelector("[data-cd-body]");
  body.classList.remove("cd-body--in");
  body.innerHTML = '<div class="skeleton cd-skel" style="height:140px"></div>';
  setLoading(true);
  try {
    if (t === "overview") await overviewView(body);
    else if (t === "findings") await findingsView(body);
    else if (t === "checks") checksView(body);
    else if (t === "events") await eventsView(body);
    else if (t === "incidents") await incidentsView(body);
    else if (t === "rules") await rulesView(body);
    else if (t === "sources") await sourcesView(body);
    else if (t.startsWith("ws:") && WORKSPACES[t.slice(3)]) await workspaceView(body, t.slice(3));
    else await auditView(body);
  } catch (e) {
    body.innerHTML = `<p class="muted">Could not load this section. ${esc((e && e.message) || "")}</p>`;
  } finally {
    setLoading(false);
    if (!reduceMotion()) { void body.offsetWidth; body.classList.add("cd-body--in"); }
  }
}

/* -------------------------------------------------------------- overview */
const HEALTH = { strong: ["Healthy", "ok"], good: ["Healthy", "ok"], fair: ["Warning", "warn"], poor: ["Critical", "bad"], no_data: ["Not assessed", "none"] };
function gauge(score, rating) {
  const R = 52, C = 2 * Math.PI * R;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, Number(score)));
  const cls = score == null ? "none" : rating;
  return `
    <div class="cd-gauge cd-gauge--${esc(cls)}" role="img" aria-label="${score == null ? "No score yet" : `Security score ${num(score)} out of 100`}">
      <svg viewBox="0 0 140 140" aria-hidden="true">
        <circle class="cd-gauge__ticks" cx="70" cy="70" r="64" pathLength="100" stroke-dasharray="0.6 1.4"/>
        <circle class="cd-gauge__track" cx="70" cy="70" r="${R}"/>
        <circle class="cd-gauge__arc" cx="70" cy="70" r="${R}" stroke-dasharray="${C.toFixed(1)}"
          stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}" data-c="${C.toFixed(1)}" data-pct="${pct}"/>
      </svg>
      <div class="cd-gauge__txt"><b>${score == null ? "—" : num(score)}</b><small>of 100</small></div>
    </div>`;
}

// Animates only when the displayed value actually changes (first paint counts as a change from empty).
function animateGauge() {
  const arc = root.querySelector(".cd-gauge__arc");
  if (!arc) return;
  const C = Number(arc.dataset.c), pct = Number(arc.dataset.pct), from = st.prevPct == null ? 0 : st.prevPct;
  st.prevPct = pct;
  if (reduceMotion() || from === pct) return;
  const num$ = root.querySelector(".cd-gauge__txt b"), final = num$ && num$.textContent;
  arc.style.transition = "none";
  arc.style.strokeDashoffset = String(C * (1 - from / 100));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.transition = "stroke-dashoffset .9s cubic-bezier(.22,.8,.25,1)";
    arc.style.strokeDashoffset = String(C * (1 - pct / 100));
  }));
  if (num$ && final && final !== "—") {
    const t0 = performance.now(), dur = 700;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      num$.textContent = (from + (pct - from) * e).toFixed(1);
      if (k < 1) requestAnimationFrame(step); else num$.textContent = final;
    };
    requestAnimationFrame(step);
  }
}

function checkTitle(key) {
  const c = ((st.score && st.score.breakdown && st.score.breakdown.checks) || []).find((x) => x.key === key);
  return c ? c.title : key;
}

/* Service map: nodes are the monitored sources the database reports (status is theirs, not decorative); the lines show
   how this application is wired. A line is dimmed unless both ends are connected. */
const TOPO = {
  github_repo: [20, 236], render_hosting: [20, 126],
  supabase_auth: [292, 20], supabase_postgres: [292, 126], edge_functions: [292, 232],
  payments: [564, 20], app_admin: [564, 126], provider_delix: [564, 232],
};
const TOPO_EDGES = [
  ["github_repo", "render_hosting"], ["render_hosting", "supabase_auth"], ["render_hosting", "supabase_postgres"], ["render_hosting", "edge_functions"],
  ["supabase_postgres", "app_admin"], ["edge_functions", "payments"], ["edge_functions", "provider_delix"],
];
function topology(srcs) {
  const by = new Map((srcs || []).map((x) => [x.source, x]));
  const W = 170, H = 58;
  const nodes = Object.entries(TOPO).filter(([k]) => by.has(k));
  if (!nodes.length) return '<p class="muted">No monitored sources reported yet.</p>';
  const edges = TOPO_EDGES.filter(([a, b]) => by.has(a) && by.has(b)).map(([a, b]) => {
    const [x1, y1] = TOPO[a], [x2, y2] = TOPO[b], sx = x1 + W, sy = y1 + H / 2, ex = x2, ey = y2 + H / 2, mx = (sx + ex) / 2;
    const live = by.get(a).status === "connected" && by.get(b).status === "connected";
    return `<path class="cd-edge${live ? " cd-edge--live" : ""}" d="M${sx} ${sy} C${mx} ${sy} ${mx} ${ey} ${ex} ${ey}"/>`;
  }).join("");
  const trunc = (t) => (t.length > 24 ? t.slice(0, 23) + "…" : t);
  const total = by.size, ok = [...by.values()].filter((x) => x.status === "connected").length;
  return `<svg class="cd-topo" viewBox="0 0 754 306" role="img" aria-label="Service map: ${ok} of ${total} monitored sources connected">
      ${edges}
      ${nodes.map(([k, [x, y]]) => {
    const sv = by.get(k); return `<g class="cd-node cd-node--${esc(sv.status)}" transform="translate(${x} ${y})">
        <title>${esc(sv.label)}: ${esc(SRC_LABEL[sv.status] || sv.status)}</title>
        <rect width="${W}" height="${H}" rx="6"/><circle class="cd-node__dot" cx="16" cy="19" r="4.500"/>
        <text x="30" y="23" class="cd-node__t">${esc(trunc(sv.label))}</text>
        <text x="16" y="43" class="cd-node__s">${esc(SRC_LABEL[sv.status] || sv.status)}</text></g>`;
  }).join("")}
    </svg>
    <ul class="cd-topo-list">${nodes.map(([k]) => { const sv = by.get(k); return `<li class="cd-topo-list--${esc(sv.status)}"><i aria-hidden="true"></i><span>${esc(sv.label)}</span>${chip("src-" + sv.status, SRC_LABEL[sv.status] || sv.status)}</li>`; }).join("")}</ul>
    <ul class="cd-legend" aria-hidden="true"><li class="cd-legend--connected">Connected</li><li class="cd-legend--partial">Partial</li><li class="cd-legend--error">Error</li><li class="cd-legend--not_connected">Not connected</li></ul>
    <p class="cd-note">Lines show how the application is wired; a line lights up only when both ends are connected. A grey node means nothing is being collected there, not that it is safe.</p>`;
}

function describeEvent(e) {
  const d = e.details || {};
  const t = d.evidence || d.reason || (d.action ? `action: ${d.action}` : "") || [e.subject_type, e.subject_id].filter(Boolean).join(": ");
  return String(t || "—");
}

function streamRows(rows, incByEvent) {
  return rows.map((r) => {
    const inc = incByEvent && incByEvent.get(r.id);
    return `<tr class="cd-ev cd-ev--${esc(r.severity)}" data-cd-ev="${esc(r.id)}">
      <td><button type="button" class="cd-ev__tog" aria-expanded="false" aria-label="Show details for event ${esc(r.id)}">${ic("chev")}</button><time class="cd-mono">${esc(stamp(r.occurred_at))}</time></td>
      <td>${sevChip(r.severity)}</td><td class="cd-mono">${esc(r.event_type)}</td><td class="cd-mono">${esc(r.source)}</td>
      <td class="cd-ev__desc">${esc(describeEvent(r).slice(0, 110))}</td>
      <td>${inc ? `<span class="cd-chip cd-chip--st-${esc(inc.status)}">${esc(STATUS_LABEL[inc.status] || inc.status)}</span>` : '<span class="muted">No incident</span>'}</td>
      <td>${inc ? `<button type="button" class="btn btn--ghost btn--sm" data-cd-go="incidents">Open incident</button>` : ""}</td></tr>
      <tr class="cd-ev__detail" hidden><td colspan="7"><dl class="cd-kv">
        <dt>Event id</dt><dd class="cd-mono">${esc(r.id)}</dd><dt>Time</dt><dd class="cd-mono">${esc(r.occurred_at)}</dd>
        <dt>Actor</dt><dd class="cd-mono">${esc(r.actor_id || "—")}</dd><dt>Subject</dt><dd class="cd-mono">${esc([r.subject_type, r.subject_id].filter(Boolean).join(": ") || "—")}</dd>
        ${r.ip_hash ? `<dt>Network (hashed)</dt><dd class="cd-mono">${esc(r.ip_hash)}</dd>` : ""}
        ${inc ? `<dt>Incident</dt><dd>${esc(inc.title)}</dd>` : ""}</dl>
        ${r.details && Object.keys(r.details).length ? `<pre class="cd-pre">${esc(JSON.stringify(r.details, null, 2))}</pre>` : ""}</td></tr>`;
  }).join("");
}
function wireStream(scope) {
  scope.querySelectorAll(".cd-ev__tog").forEach((b) => b.addEventListener("click", () => {
    const row = b.closest("tr"), det = row.nextElementSibling, open = det.hidden;
    det.hidden = !open; b.setAttribute("aria-expanded", String(open)); row.classList.toggle("is-open", open);
  }));
  scope.querySelectorAll("[data-cd-go]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.cdGo)));
}

async function overviewView(body) {
  const s = st.score, o = st.overview;
  const cats = (s.breakdown && s.breakdown.categories) || [];
  const checks = (s.breakdown && s.breakdown.checks) || [];
  const srcs = o.sources || [];
  const connected = srcs.filter((x) => x.status === "connected").length;
  const of = o.open_findings || {};
  const ev = o.events_24h || {};
  const evTotal = Object.values(ev).reduce((a, b) => a + Number(b), 0);
  const openF = Object.values(of).reduce((a, b) => a + Number(b), 0);
  const [{ data: hist }, { data: top }, { data: recent }, { data: incs }, { data: audit }] = await Promise.all([
    supabase.from("security_assessments").select("computed_at,score,coverage").order("computed_at", { ascending: false }).limit(12),
    supabase.from("security_findings").select("code,title,severity,evidence_level,recommendation,status").in("status", ["open", "mitigating"]),
    supabase.from("security_events").select("id,occurred_at,source,event_type,severity").order("occurred_at", { ascending: false }).limit(8),
    supabase.from("security_incidents").select("id,title,severity,status,rule_key,event_count,last_event_at,opened_at").order("opened_at", { ascending: false }).limit(60),
    supabase.from("security_audit_log").select("chain_no,occurred_at,action,actor_id").order("chain_no", { ascending: false }).limit(6),
  ]);
  const topList = (top || []).sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.code.localeCompare(b.code)).slice(0, 4);
  const active = (incs || []).filter((i) => ACTIVE.includes(i.status)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).slice(0, 5);
  const [hLabel, hTone] = HEALTH[s.rating] || HEALTH.no_data;
  const tally = { PASS: 0, PARTIAL: 0, FAIL: 0, UNKNOWN: 0, STALE: 0 };
  checks.forEach((k) => { if (k.result in tally) tally[k.result] += 1; });
  const nChecks = checks.length || 1;
  const assessed = cats.reduce((a, c) => a + Number(c.scored || 0), 0), totalChecks = cats.reduce((a, c) => a + Number(c.checks || 0), 0);

  body.innerHTML = `
    <div class="cd-hero">
      <section class="cd-card cd-score" aria-label="Security health">
        ${gauge(s.score, s.rating)}
        <div class="cd-score__meta">
          <p class="cd-eyebrow">Security health</p>
          <div class="cd-score__rating">${esc(RATING_LABEL[s.rating] || s.rating)}${s.provisional ? " " + chip("prov", "Provisional", "Fewer than 60% of checks have evidence, so this score is a partial view.") : ""}</div>
          <div class="cd-state cd-state--${hTone}"><i aria-hidden="true"></i>${esc(hLabel)}</div>
          <div class="cd-cov" aria-label="Coverage ${num(s.coverage)} percent">
            <div class="cd-cov__bar"><i style="width:${Math.max(0, Math.min(100, Number(s.coverage)))}%"></i></div>
            <span><b>${num(s.coverage)}%</b> of checks have evidence</span>
          </div>
          ${s.raw_score != null && s.score != null && Number(s.raw_score) !== Number(s.score)
      ? `<p class="cd-note">Raw score ${num(s.raw_score)}, limited to ${num(s.score)} while serious checks fail.</p>` : ""}
          <p class="cd-note">${o.latest_assessment ? `Last saved ${esc(timeAgo(o.latest_assessment.computed_at))} (${num(o.latest_assessment.score)}).` : "No assessment saved yet."}</p>
        </div>
      </section>

      <section class="cd-tiles" aria-label="At a glance">
        <button type="button" class="cd-tile cd-tile--${of.critical ? "bad" : openF ? "warn" : "ok"}" data-cd-go="findings"><b>${openF}</b><span>Open findings</span>
          <small>${["critical", "high", "medium", "low"].filter((k) => of[k]).map((k) => `${of[k]} ${k}`).join(" · ") || "none"}</small></button>
        <button type="button" class="cd-tile cd-tile--${Number(o.open_incidents || 0) ? "bad" : "ok"}" data-cd-go="incidents"><b>${Number(o.open_incidents || 0)}</b><span>Active incidents</span><small>${Number(o.open_incidents || 0) ? "needs review" : "none open"}</small></button>
        <button type="button" class="cd-tile" data-cd-go="checks"><b>${assessed}/${totalChecks}</b><span>Security checks assessed</span><small>${tally.FAIL} failing · ${tally.PARTIAL} partial</small></button>
        <button type="button" class="cd-tile cd-tile--${connected === srcs.length && srcs.length ? "ok" : connected ? "warn" : "idle"}" data-cd-go="sources"><b>${connected}/${srcs.length}</b><span>Sources connected</span><small>${connected ? "see Sources" : "none yet"}</small></button>
        <button type="button" class="cd-tile cd-tile--cyan" data-cd-go="events"><b>${evTotal}</b><span>Events (24 h)</span><small>${evTotal ? ["critical", "high", "medium", "low", "info"].filter((k) => ev[k]).map((k) => `${ev[k]} ${k}`).join(" · ") : "nothing collected"}</small></button>
      </section>
    </div>

    ${(s.caps || []).map((c) => `
      <div class="cd-alert cd-alert--warn" role="note"><b>Score limited to ${esc(c.cap)}.</b> ${esc(c.reason)}:
        ${(c.checks || []).map((k) => `<span class="cd-code">${esc(checkTitle(k))}</span>`).join(" ")}</div>`).join("")}

    <div class="cd-grid">
      <section class="cd-card cd-panel">
        <header class="cd-panel__h"><h4>Service map</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="sources">Sources</button></header>
        ${topology(srcs)}
      </section>
      <section class="cd-card cd-panel">
        <header class="cd-panel__h"><h4>Recommended next steps</h4></header>
        ${topList.length ? `<ol class="cd-recs">${topList.map((f) => `
          <li><div>${sevChip(f.severity)} ${lvlChip(f.evidence_level)} <b class="cd-mono">${esc(f.code)}</b> ${esc(f.title)}</div>
          <p>${esc(f.recommendation || "")}</p></li>`).join("")}</ol>
          <button type="button" class="btn btn--ghost btn--sm" data-cd-go="findings">View all findings</button>`
      : '<p class="muted">No open findings recorded.</p>'}
      </section>
    </div>

    <div class="cd-grid cd-grid--2">
      <section class="cd-card cd-panel">
        <header class="cd-panel__h"><h4>Security event stream</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="events">Open stream</button></header>
        ${(recent || []).length ? `<ul class="cd-feed">${recent.slice(0, 8).map((r) => `<li class="cd-ev--${esc(r.severity)}"><time class="cd-mono">${esc(stamp(r.occurred_at).slice(5, 19))}</time>${sevChip(r.severity)}<span class="cd-mono">${esc(r.event_type)}</span><small class="muted">${esc(r.source)}</small></li>`).join("")}</ul>`
      : '<p class="muted">No events yet. Connect sources and press Collect now on the Sources page.</p>'}
      </section>
      <section class="cd-card cd-panel">
        <header class="cd-panel__h"><h4>Incident overview</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="incidents">All incidents</button></header>
        ${active.length ? `<ul class="cd-feed cd-feed--inc">${active.map((i) => `<li>${sevChip(i.severity)}<span>${esc(i.title)}</span><small class="muted">${esc(STATUS_LABEL[i.status] || i.status)} · ${esc(i.event_count)} event(s)</small></li>`).join("")}</ul>`
      : '<p class="muted">No active incidents. Incidents open automatically when a detection rule matches collected events.</p>'}
      </section>
    </div>

    <div class="cd-grid cd-grid--3">
      <section class="cd-card cd-panel">
        <header class="cd-panel__h"><h4>Categories</h4></header>
        <ul class="cd-cats">
          ${cats.map((c) => {
        const sp = c.score_pct;
        const tone = sp == null ? "none" : sp >= 90 ? "ok" : sp >= 60 ? "mid" : "bad";
        return `<li>
              <div class="cd-cat__top"><span>${esc(c.label)}</span><small>${c.scored}/${c.checks} assessed · weight ${esc(c.weight)}</small></div>
              <div class="cd-cat__bar cd-cat__bar--${tone}" role="img" aria-label="${sp == null ? "No evidence" : `${num(sp, 0)} percent`}"><i style="width:${sp == null ? 0 : Math.max(2, Number(sp))}%"></i></div>
              <div class="cd-cat__val">${sp == null ? "No evidence yet" : `${num(sp, 0)}%`}</div>
            </li>`;
      }).join("")}
        </ul>
      </section>
      <div class="cd-stack">
        <section class="cd-card cd-panel">
          <header class="cd-panel__h"><h4>Security-check status</h4></header>
          <div class="cd-seg" role="img" aria-label="${["PASS", "PARTIAL", "FAIL", "UNKNOWN", "STALE"].map((k) => `${tally[k]} ${RESULT_LABEL[k]}`).join(", ")}">
            ${["PASS", "PARTIAL", "FAIL", "UNKNOWN", "STALE"].filter((k) => tally[k]).map((k) => `<i class="cd-seg--${k.toLowerCase()}" style="flex:${tally[k]}"></i>`).join("")}</div>
          <ul class="cd-seglegend">${["PASS", "PARTIAL", "FAIL", "UNKNOWN", "STALE"].map((k) => `<li><i class="cd-seg--${k.toLowerCase()}"></i>${esc(RESULT_LABEL[k])} <b>${tally[k]}</b></li>`).join("")}</ul>
          <p class="cd-note">${nChecks} checks defined. Not assessed and out-of-date checks are left out of the score and lower coverage.</p>
        </section>
        <section class="cd-card cd-panel">
          <header class="cd-panel__h"><h4>Recent activity</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="audit">Audit vault</button></header>
          ${(audit || []).length ? `<ul class="cd-feed cd-feed--audit">${audit.slice(0, 6).map((r) => `<li><time class="cd-mono">${esc(stamp(r.occurred_at).slice(5, 16))}</time><span class="cd-mono">${esc(r.action)}</span><small class="muted cd-mono">${short(r.actor_id)}</small></li>`).join("")}</ul>`
      : '<p class="muted">Nothing recorded yet.</p>'}
        </section>
      </div>
      <div class="cd-stack">
        <section class="cd-card cd-panel">
          <header class="cd-panel__h"><h4>Score history</h4></header>
          ${sparkline(hist || [])}
        </section>
        <section class="cd-card cd-panel">
          <header class="cd-panel__h"><h4>Defense workspaces</h4></header>
          <div class="cd-quick">${Object.entries(WORKSPACES).map(([k, w]) => `<button type="button" class="cd-quick__b" data-cd-go="ws:${k}">${ic({ identity: "user", database: "db", payment: "card", provider: "server", surface: "globe" }[k])}<span>${esc(w.label)}</span></button>`).join("")}</div>
        </section>
        <details class="cd-card cd-explain">
          <summary>How is this score calculated?</summary>
          <p>Each check has a weight: its category's weight shared by severity (critical 4, high 3, medium 2, low 1). A pass counts fully, a partial counts half, a fail counts nothing.</p>
          <p>The score is the weighted average of the checks that have <b>current</b> evidence. Checks that are not assessed, out of date (older than their review period) or only unverified are left out of the score and lower the coverage figure instead, so missing data never inflates the score.</p>
          <p>A failing critical check limits the score to 59, and a failing high check limits it to 79, until it is fixed and re-checked. The calculation is plain arithmetic in the database (method ${esc(s.method_version)}); no AI is involved.</p>
        </details>
      </div>
    </div>`;
  body.querySelectorAll("[data-cd-go]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.cdGo)));
  animateGauge();
}

function sparkline(rows) {
  const pts = rows.filter((r) => r.score != null).reverse();
  if (pts.length < 2) return '<p class="muted">Save at least two assessments to see a trend.</p>';
  const W = 240, H = 56, P = 4;
  const xs = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  // Scale to the visible range (with padding) so small movements are legible; the labels below give the real values.
  const vals = pts.map((p) => Number(p.score));
  const lo = Math.max(0, Math.min(...vals) - 5), hi = Math.min(100, Math.max(...vals) + 5);
  const ys = (v) => H - P - (((Number(v) - lo) / Math.max(1, hi - lo)) * (H - 2 * P));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(p.score).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1], first = pts[0];
  return `<svg class="cd-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score moved from ${num(first.score)} to ${num(last.score)}"><path d="${d}"/><circle cx="${xs(pts.length - 1).toFixed(1)}" cy="${ys(last.score).toFixed(1)}" r="3"/></svg>
    <p class="cd-note">${num(first.score)} → ${num(last.score)} over ${pts.length} saved assessments.</p>`;
}

/* -------------------------------------------------------------- findings */
async function findingsView(body) {
  const { data, error } = await supabase.from("security_findings")
    .select("code,title,severity,status,evidence_level,category,description,recommendation,check_keys,detected_at,resolved_at,status_note,retest_due");
  if (error) throw error;
  const f = st.findingFilter;
  const rows = (data || []).filter((r) => f === "all" || (f === "open" ? ["open", "mitigating"].includes(r.status) : r.status === f))
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  body.innerHTML = `
    <div class="cd-filter">
      <label>Show <select data-cd-ff aria-label="Finding status filter">
        ${[["open", "Open & in progress"], ["accepted", "Accepted risk"], ["resolved", "Resolved"], ["all", "All"]]
      .map(([k, l]) => `<option value="${k}" ${k === f ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <span class="muted">${rows.length} finding${rows.length === 1 ? "" : "s"}</span>
    </div>
    <div class="cd-list">
    ${rows.map((r) => `
      <details class="cd-card cd-find">
        <summary>
          <span class="cd-find__head">${sevChip(r.severity)} ${lvlChip(r.evidence_level)} <b class="cd-code">${esc(r.code)}</b></span>
          <span class="cd-find__title">${esc(r.title)}</span>
          <span class="cd-find__status">${chip("st-" + r.status, r.status)}</span>
        </summary>
        <div class="cd-find__body">
          ${r.description ? `<h5>What we found</h5><p>${esc(r.description)}</p>` : ""}
          ${r.recommendation ? `<h5>Recommendation</h5><p>${esc(r.recommendation)}</p>` : ""}
          ${(r.check_keys || []).length ? `<h5>Linked checks</h5><p>${r.check_keys.map((k) => `<span class="cd-code">${esc(checkTitle(k))}</span>`).join(" ")}</p>` : ""}
          <p class="cd-note">Detected ${esc(formatDateTime(r.detected_at))}${r.resolved_at ? ` · resolved ${esc(formatDateTime(r.resolved_at))}` : ""}${r.status_note ? ` · note: ${esc(r.status_note)}` : ""}</p>
          <div class="cd-find__act">
            <select data-cd-st="${esc(r.code)}" aria-label="New status for ${esc(r.code)}">
              ${["open", "mitigating", "accepted", "resolved"].map((s) => `<option value="${s}" ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select>
            <input type="text" maxlength="300" placeholder="Note (required to accept or resolve)" data-cd-note="${esc(r.code)}" aria-label="Status note for ${esc(r.code)}" />
            <button type="button" class="btn btn--secondary btn--sm" data-cd-apply="${esc(r.code)}">Update status</button>
          </div>
        </div>
      </details>`).join("") || '<p class="muted">Nothing here.</p>'}
    </div>
    <p class="cd-note">Changing a status only updates this module's own records; it does not change the platform. Every change is written to the audit trail.</p>`;
  body.querySelector("[data-cd-ff]").addEventListener("change", (e) => { st.findingFilter = e.target.value; showTab("findings"); });
  body.querySelectorAll("[data-cd-apply]").forEach((b) => b.addEventListener("click", async () => {
    const code = b.dataset.cdApply;
    const status = body.querySelector(`[data-cd-st="${CSS.escape(code)}"]`).value;
    const note = body.querySelector(`[data-cd-note="${CSS.escape(code)}"]`).value.trim();
    b.disabled = true;
    try {
      await rpc("security_set_finding_status", { p_code: code, p_status: status, p_note: note || null });
      showToast(`${code} updated.`, "success");
      await reload();
    } catch (e) { fail(e); b.disabled = false; }
  }));
}

/* ---------------------------------------------------------------- checks */
function checksView(body) {
  const checks = (st.score.breakdown && st.score.breakdown.checks) || [];
  const cats = (st.score.breakdown && st.score.breakdown.categories) || [];
  body.innerHTML = `
    <p class="cd-note">Pass, partial and fail count toward the score. <b>Not assessed</b> and <b>out of date</b> do not: they lower coverage instead. Record a result only for something you have actually seen.</p>
    ${cats.map((c) => {
    const list = checks.filter((k) => k.category === c.category);
    return `<section class="cd-card cd-checkgrp">
        <h4 class="cd-h">${esc(c.label)} <small>weight ${esc(c.weight)}</small></h4>
        <ul class="cd-checks">${list.map((k) => {
      const d = st.descriptions[k.key] || {};
      return `<li>
            <div class="cd-check__main">
              <div class="cd-check__t">${resChip(k.result)} ${sevChip(k.severity)} <span>${esc(k.title)}</span>${d.automated ? ' <small class="muted">(automatable)</small>' : ""}</div>
              ${d.description ? `<p class="cd-check__d">${esc(d.description)}</p>` : ""}
              ${k.evidence ? `<p class="cd-check__e"><b>Evidence${k.evidence_level ? ` (${esc(LEVEL_LABEL[k.evidence_level] || k.evidence_level)})` : ""}${k.checked_at ? `, ${esc(formatDateTime(k.checked_at))}` : ""}:</b> ${esc(k.evidence)}</p>` : ""}
            </div>
            <button type="button" class="btn btn--ghost btn--sm" data-cd-rec="${esc(k.key)}">Record result</button>
          </li>`;
    }).join("")}</ul>
      </section>`;
  }).join("")}`;
  body.querySelectorAll("[data-cd-rec]").forEach((b) => b.addEventListener("click", () => {
    openCheckDialog(checks.find((k) => k.key === b.dataset.cdRec));
  }));
}

function openCheckDialog(check) {
  if (!check) return;
  const dlg = document.createElement("dialog");
  dlg.className = "cd-dialog";
  dlg.setAttribute("aria-labelledby", "cd-dlg-t");
  dlg.innerHTML = `
    <form class="cd-form">
      <h4 id="cd-dlg-t">Record a result</h4>
      <p><b>${esc(check.title)}</b></p>
      <label>Result
        <select name="result" required>
          <option value="PASS">Pass: requirement met</option>
          <option value="PARTIAL">Partial: partly met</option>
          <option value="FAIL" ${check.result === "FAIL" ? "selected" : ""}>Fail: not met</option>
          <option value="UNKNOWN">Not assessed</option>
        </select></label>
      <label>How do you know?
        <select name="level" required>
          ${Object.entries(LEVEL_LABEL).map(([k, l]) => `<option value="${k}" ${k === "verified" ? "selected" : ""}>${esc(l)}: ${esc(LEVEL_HELP[k])}</option>`).join("")}
        </select></label>
      <label>Evidence <small class="muted">(what you saw, when; no secrets)</small>
        <textarea name="evidence" rows="4" maxlength="1500" required minlength="10" placeholder="e.g. Supabase → Auth → Providers shows Confirm email ON (checked today)."></textarea></label>
      <div class="cd-form__act">
        <button type="button" class="btn btn--ghost btn--sm" data-cd-cancel>Cancel</button>
        <button type="submit" class="btn btn--primary btn--sm">Save result</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-cd-cancel]").addEventListener("click", close);
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const submit = e.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await rpc("security_set_check_result", {
        p_check_key: check.key, p_result: fd.get("result"), p_evidence_level: fd.get("level"), p_evidence: String(fd.get("evidence") || "").trim(),
      });
      close();
      showToast("Result recorded.", "success");
      await reload();
    } catch (err) { fail(err); submit.disabled = false; }
  });
  dlg.showModal();
}

/* ---------------------------------------------------------------- events */
async function eventsView(body) {
  const [{ data, error }, { data: incs }] = await Promise.all([
    supabase.from("security_events")
      .select("id,occurred_at,source,event_type,severity,actor_id,subject_type,subject_id,ip_hash,details")
      .order("occurred_at", { ascending: false }).limit(300),
    supabase.from("security_incidents").select("id,title,status,related_event_ids").order("opened_at", { ascending: false }).limit(100),
  ]);
  if (error) throw error;
  if (!data.length) {
    const none = (st.overview.sources || []).every((s) => s.status === "not_connected");
    body.innerHTML = `<div class="cd-empty"><b>No security events recorded.</b>
      <p>${none ? "No collectors are connected yet, so an empty list does not mean nothing is happening. See Sources." : "Connected sources have not reported anything in the retention window."}</p></div>`;
    return;
  }
  const incByEvent = new Map();
  (incs || []).forEach((i) => (i.related_event_ids || []).forEach((id) => { if (!incByEvent.has(id)) incByEvent.set(id, i); }));
  const sources = [...new Set(data.map((r) => r.source))].sort();
  const f = st.ev, PAGE = 25;
  const sevs = ["critical", "high", "medium", "low", "info"];
  const dist = st.overview.events_24h || {};
  body.innerHTML = `
    <div class="cd-streamhead">
      <div class="cd-filter cd-filter--stream">
        <label class="cd-search"><span class="cd-sr">Search events</span><input type="search" data-cd-q placeholder="Search type, source, subject, text" value="${esc(f.q)}" maxlength="80" autocomplete="off" /></label>
        <label><span class="cd-sr">Severity</span><select data-cd-sev><option value="all">All severities</option>${sevs.map((k) => `<option value="${k}" ${f.sev === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label><span class="cd-sr">Source</span><select data-cd-src><option value="all">All sources</option>${sources.map((k) => `<option value="${esc(k)}" ${f.src === k ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label>
        <span class="muted" data-cd-evcount></span>
      </div>
      <p class="cd-note">Last 24 h by severity: ${sevs.filter((k) => dist[k]).map((k) => `<b class="cd-sevtxt cd-sevtxt--${k}">${dist[k]} ${k}</b>`).join(" · ") || "none"}</p>
    </div>
    <div class="cd-tablewrap cd-stream"><table class="cd-table cd-table--stream">
      <thead><tr><th><button type="button" class="cd-sort" data-cd-sort aria-label="Sort by time">Time <span aria-hidden="true">${f.sort === "desc" ? "↓" : "↑"}</span></button></th><th>Severity</th><th>Event</th><th>Source</th><th>Description</th><th>Status</th><th>Action</th></tr></thead>
      <tbody data-cd-rows></tbody></table></div>
    <div class="cd-pager"><button type="button" class="btn btn--ghost btn--sm" data-cd-prev>Newer</button><span data-cd-page class="muted"></span><button type="button" class="btn btn--ghost btn--sm" data-cd-next>Older</button></div>
    <p class="cd-note">The latest 300 events are loaded, newest first. Events are kept 90 days. Open a row for the full record; the "Status" column shows whether an incident was opened from that event.</p>`;
  const rowsEl = body.querySelector("[data-cd-rows]");
  const paint = () => {
    const q = f.q.trim().toLowerCase();
    let rows = data.filter((r) => (f.sev === "all" || r.severity === f.sev) && (f.src === "all" || r.source === f.src)
      && (!q || `${r.event_type} ${r.source} ${r.subject_id || ""} ${describeEvent(r)}`.toLowerCase().includes(q)));
    if (f.sort === "asc") rows = rows.slice().reverse();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    f.page = Math.min(f.page, pages);
    rowsEl.innerHTML = streamRows(rows.slice((f.page - 1) * PAGE, f.page * PAGE), incByEvent)
      || `<tr><td colspan="7"><span class="muted">No events match these filters.</span></td></tr>`;
    wireStream(rowsEl);
    body.querySelector("[data-cd-evcount]").textContent = `${rows.length} of ${data.length} events`;
    body.querySelector("[data-cd-page]").textContent = `Page ${f.page} of ${pages}`;
    body.querySelector("[data-cd-prev]").disabled = f.page <= 1;
    body.querySelector("[data-cd-next]").disabled = f.page >= pages;
  };
  let timer;
  body.querySelector("[data-cd-q]").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; f.page = 1; paint(); }, 150); });
  body.querySelector("[data-cd-sev]").addEventListener("change", (e) => { f.sev = e.target.value; f.page = 1; paint(); });
  body.querySelector("[data-cd-src]").addEventListener("change", (e) => { f.src = e.target.value; f.page = 1; paint(); });
  body.querySelector("[data-cd-sort]").addEventListener("click", (e) => { f.sort = f.sort === "desc" ? "asc" : "desc"; e.currentTarget.querySelector("span").textContent = f.sort === "desc" ? "↓" : "↑"; paint(); });
  body.querySelector("[data-cd-prev]").addEventListener("click", () => { f.page -= 1; paint(); });
  body.querySelector("[data-cd-next]").addEventListener("click", () => { f.page += 1; paint(); });
  paint();
}

/* -------------------------------------------------------------- workspaces */
async function workspaceView(body, key) {
  const w = WORKSPACES[key];
  const cats = ((st.score.breakdown && st.score.breakdown.categories) || []).filter((c) => w.cats.includes(c.category));
  const checks = ((st.score.breakdown && st.score.breakdown.checks) || []).filter((k) => w.cats.includes(k.category));
  const srcs = (st.overview.sources || []).filter((x) => w.sources.includes(x.source));
  const [{ data: finds }, { data: evs }, { data: incs }] = await Promise.all([
    supabase.from("security_findings").select("code,title,severity,status,evidence_level,category,recommendation").in("category", w.cats),
    supabase.from("security_events").select("id,occurred_at,source,event_type,severity,actor_id,subject_type,subject_id,ip_hash,details").in("source", w.sources).order("occurred_at", { ascending: false }).limit(15),
    supabase.from("security_incidents").select("id,title,severity,status,rule_key,event_count").order("opened_at", { ascending: false }).limit(100),
  ]);
  const openF = (finds || []).filter((f) => ["open", "mitigating"].includes(f.status)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const wi = (incs || []).filter((i) => ACTIVE.includes(i.status) && w.rules.some((p) => (i.rule_key || "").startsWith(p)));
  const tally = { PASS: 0, PARTIAL: 0, FAIL: 0, UNKNOWN: 0, STALE: 0 };
  checks.forEach((k) => { if (k.result in tally) tally[k.result] += 1; });
  body.innerHTML = `
    <p class="cd-note cd-note--lead">${esc(w.label)} brings together the existing checks, findings, events and incidents that belong to it. Nothing here is separate data: it is a filtered view.</p>
    <div class="cd-tiles cd-tiles--row" aria-label="${esc(w.label)} summary">
      <div class="cd-tile cd-tile--${openF.length ? "warn" : "ok"}"><b>${openF.length}</b><span>Open findings</span><small>${openF.filter((f) => f.severity === "critical").length} critical</small></div>
      <div class="cd-tile cd-tile--${wi.length ? "bad" : "ok"}"><b>${wi.length}</b><span>Active incidents</span><small>${w.rules.length ? "from this area's rules" : "no rules map here yet"}</small></div>
      <div class="cd-tile"><b>${checks.length}</b><span>Security checks</span><small>${tally.FAIL} failing · ${tally.PASS} passing · ${tally.UNKNOWN + tally.STALE} not current</small></div>
      <div class="cd-tile"><b>${srcs.filter((x) => x.status === "connected").length}/${srcs.length}</b><span>Sources connected</span><small>${srcs.length ? "see below" : "none mapped"}</small></div>
    </div>
    <div class="cd-grid cd-grid--2">
      <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Monitoring sources</h4></header>
        ${srcs.length ? `<div class="cd-srcs cd-srcs--tight">${srcs.map((x) => `<article class="cd-src cd-src--${esc(x.status)}"><header><span class="cd-dot" aria-hidden="true"></span><b>${esc(x.label)}</b>${chip("src-" + x.status, SRC_LABEL[x.status] || x.status)}</header>
          <p>${esc(x.detail || "")}</p><small class="muted">Last event: ${x.last_event_at ? esc(formatDateTime(x.last_event_at)) : "never"}</small></article>`).join("")}</div>`
      : '<p class="muted">No monitored source is mapped to this area. Its checks are recorded by hand.</p>'}
      </section>
      <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Category health</h4></header>
        <ul class="cd-cats">${cats.map((c) => {
        const sp = c.score_pct, tone = sp == null ? "none" : sp >= 90 ? "ok" : sp >= 60 ? "mid" : "bad";
        return `<li><div class="cd-cat__top"><span>${esc(c.label)}</span><small>${c.scored}/${c.checks} assessed</small></div>
          <div class="cd-cat__bar cd-cat__bar--${tone}"><i style="width:${sp == null ? 0 : Math.max(2, Number(sp))}%"></i></div>
          <div class="cd-cat__val">${sp == null ? "No evidence yet" : `${num(sp, 0)}%`}</div></li>`;
      }).join("")}</ul>
      </section>
    </div>
    <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Findings</h4></header>
      ${openF.length ? `<ol class="cd-recs">${openF.map((f) => `<li><div>${sevChip(f.severity)} ${lvlChip(f.evidence_level)} <b class="cd-mono">${esc(f.code)}</b> ${esc(f.title)}</div><p>${esc(f.recommendation || "")}</p></li>`).join("")}</ol>`
      : '<p class="muted">No open findings in this area.</p>'}
    </section>
    <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Checks</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="checks">Record results</button></header>
      <ul class="cd-checks">${checks.map((k) => `<li><div class="cd-check__main"><div class="cd-check__t">${resChip(k.result)} ${sevChip(k.severity)} <span>${esc(k.title)}</span></div>
        ${k.evidence ? `<p class="cd-check__e"><b>Evidence${k.evidence_level ? ` (${esc(LEVEL_LABEL[k.evidence_level] || k.evidence_level)})` : ""}:</b> ${esc(k.evidence)}</p>` : ""}</div></li>`).join("")}</ul>
    </section>
    <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Recent events from these sources</h4><button type="button" class="btn btn--ghost btn--sm" data-cd-go="events">Open stream</button></header>
      ${(evs || []).length ? `<div class="cd-tablewrap cd-stream"><table class="cd-table cd-table--stream"><thead><tr><th>Time</th><th>Severity</th><th>Event</th><th>Source</th><th>Description</th><th>Status</th><th>Action</th></tr></thead><tbody data-cd-wsrows>${streamRows(evs, null)}</tbody></table></div>`
      : `<p class="muted">${srcs.length && srcs.every((x) => x.status === "not_connected") ? "These sources are not connected, so an empty list does not mean nothing is happening." : "No events from these sources in the retention window."}</p>`}
    </section>`;
  wireStream(body);
}

/* ------------------------------------------------------------- incidents */
const ACTIVE = ["open", "investigating", "contained"];
const STATUS_LABEL = { open: "Open", investigating: "Investigating", contained: "Contained", resolved: "Resolved", false_positive: "False positive" };

async function incidentsView(body) {
  const { data, error } = await supabase.from("security_incidents")
    .select("id,title,severity,status,summary,recommendation,evidence_level,rule_key,event_count,first_event_at,last_event_at,related_event_ids,opened_at,resolved_at")
    .order("opened_at", { ascending: false }).limit(100);
  if (error) throw error;
  const f = st.incFilter;
  const rows = (data || []).filter((r) => f === "all" || (f === "active" ? ACTIVE.includes(r.status) : !ACTIVE.includes(r.status)))
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.opened_at < b.opened_at ? 1 : -1));
  let notes = [];
  if (rows.length) {
    const r2 = await supabase.from("security_incident_notes").select("incident_id,at,kind,body")
      .in("incident_id", rows.map((r) => r.id)).order("at", { ascending: true }).limit(1000);
    notes = r2.data || [];
  }
  body.innerHTML = `
    <div class="cd-filter">
      <label>Show <select data-cd-if aria-label="Incident filter">
        ${[["active", "Active (open, investigating, contained)"], ["closed", "Closed"], ["all", "All"]]
      .map(([k, l]) => `<option value="${k}" ${k === f ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <span class="muted">${rows.length} incident${rows.length === 1 ? "" : "s"}</span>
    </div>
    ${rows.length ? "" : `<div class="cd-empty"><b>${f === "active" ? "No active incidents." : "Nothing here."}</b>
      <p>Incidents are opened automatically when a detection rule matches collected events (see the Rules tab). Absence of incidents only means
      the sources that are connected showed nothing matching; check the Sources tab for what is not being watched.</p></div>`}
    <div class="cd-list">
    ${rows.map((r) => `
      <details class="cd-card cd-find" data-cd-inc="${esc(r.id)}">
        <summary>
          <span class="cd-find__head">${sevChip(r.severity)} ${lvlChip(r.evidence_level)} <b class="cd-code">${esc(r.rule_key || "manual")}</b></span>
          <span class="cd-find__title">${esc(r.title)}</span>
          <span class="cd-find__status">${chip("st-" + r.status, STATUS_LABEL[r.status] || r.status)}</span>
        </summary>
        <div class="cd-find__body">
          ${r.summary ? `<h5>What was detected</h5><p>${esc(r.summary)}</p>` : ""}
          ${r.recommendation ? `<h5>Recommendation</h5><p>${esc(r.recommendation)}</p>` : ""}
          <p class="cd-note">${esc(r.event_count)} event(s)${r.first_event_at ? ` · first ${esc(formatDateTime(r.first_event_at))}` : ""}${r.last_event_at ? ` · latest ${esc(formatDateTime(r.last_event_at))}` : ""}
            · opened ${esc(formatDateTime(r.opened_at))}${r.resolved_at ? ` · closed ${esc(formatDateTime(r.resolved_at))}` : ""}</p>
          <h5>Matching events</h5>
          <div data-cd-evbox="${esc(r.id)}"><p class="muted">Open to load.</p></div>
          <h5>Timeline</h5>
          <ol class="cd-timeline">${notes.filter((n) => n.incident_id === r.id).map((n) =>
        `<li><time>${esc(formatDateTime(n.at))}</time> <span class="cd-chip cd-chip--lvl-unverified">${esc(n.kind)}</span> ${esc(n.body)}</li>`).join("")}</ol>
          <div class="cd-find__act">
            <select data-cd-ist="${esc(r.id)}" aria-label="New status">
              ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${l}</option>`).join("")}</select>
            <input type="text" maxlength="300" placeholder="Note (required, min 5 characters)" data-cd-inote="${esc(r.id)}" aria-label="Status note" />
            <button type="button" class="btn btn--secondary btn--sm" data-cd-iapply="${esc(r.id)}">Update status</button>
          </div>
          <div class="cd-find__act">
            <input type="text" maxlength="500" placeholder="Add an investigation note" data-cd-addnote="${esc(r.id)}" aria-label="Investigation note" />
            <button type="button" class="btn btn--ghost btn--sm" data-cd-addnote-btn="${esc(r.id)}">Add note</button>
          </div>
        </div>
      </details>`).join("")}
    </div>
    <p class="cd-note">Incidents are never closed automatically and nothing here changes the platform: you decide, and each change is written to the audit trail.
      A closed incident is only re-opened by newer matching events.</p>`;
  body.querySelector("[data-cd-if]").addEventListener("change", (e) => { st.incFilter = e.target.value; showTab("incidents"); });
  const byId = new Map(rows.map((r) => [r.id, r]));
  body.querySelectorAll("details[data-cd-inc]").forEach((d) => d.addEventListener("toggle", async () => {
    if (!d.open || d.dataset.loaded) return;
    d.dataset.loaded = "1";
    const r = byId.get(d.dataset.cdInc);
    const box = d.querySelector("[data-cd-evbox]");
    const ids = (r.related_event_ids || []).slice(0, 25);
    if (!ids.length) { box.innerHTML = '<p class="muted">No individual events are linked (system rule).</p>'; return; }
    const { data: evs, error: err } = await supabase.from("security_events")
      .select("id,occurred_at,severity,source,event_type,subject_type,subject_id").in("id", ids).order("occurred_at", { ascending: false });
    if (err) { box.innerHTML = `<p class="muted">Could not load events. ${esc(err.message)}</p>`; return; }
    box.innerHTML = (evs || []).length ? `<div class="cd-tablewrap"><table class="cd-table"><thead><tr><th>When</th><th>Severity</th><th>Source</th><th>Event</th><th>Subject</th></tr></thead>
      <tbody>${evs.map((e) => `<tr><td>${esc(formatDateTime(e.occurred_at))}</td><td>${sevChip(e.severity)}</td><td>${esc(e.source)}</td><td>${esc(e.event_type)}</td>
        <td>${esc([e.subject_type, e.subject_id].filter(Boolean).join(": ") || "—")}</td></tr>`).join("")}</tbody></table></div>
      <p class="cd-note">Up to 25 latest events. Events older than 90 days are purged, so old incidents may show fewer.</p>`
      : '<p class="muted">The linked events have been purged by retention.</p>';
  }));
  body.querySelectorAll("[data-cd-iapply]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.cdIapply;
    const status = body.querySelector(`[data-cd-ist="${CSS.escape(id)}"]`).value;
    const note = body.querySelector(`[data-cd-inote="${CSS.escape(id)}"]`).value.trim();
    b.disabled = true;
    try {
      await rpc("security_set_incident_status", { p_id: id, p_status: status, p_note: note });
      showToast("Incident updated.", "success");
      await reload();
    } catch (e) { fail(e); b.disabled = false; }
  }));
  body.querySelectorAll("[data-cd-addnote-btn]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.cdAddnoteBtn;
    const note = body.querySelector(`[data-cd-addnote="${CSS.escape(id)}"]`).value.trim();
    b.disabled = true;
    try {
      await rpc("security_add_incident_note", { p_id: id, p_note: note });
      showToast("Note added.", "success");
      await showTab("incidents");
    } catch (e) { fail(e); b.disabled = false; }
  }));
}

/* ----------------------------------------------------------------- rules */
async function rulesView(body) {
  const { data, error } = await supabase.from("security_rules")
    .select("key,kind,title,description,source,event_like,min_severity,window_minutes,threshold,group_by,severity,evidence_level,enabled,last_run_at,last_matches")
    .order("key");
  if (error) throw error;
  const rows = (data || []).sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.key.localeCompare(b.key));
  const win = (m) => (m % 1440 === 0 ? `${m / 1440} day(s)` : m % 60 === 0 ? `${m / 60} hour(s)` : `${m} min`);
  body.innerHTML = `
    <p class="cd-note">Rules are plain, fixed checks over collected events: <b>N matching events within a time window</b> opens one incident. No AI is involved.
      Thresholds are starting points; tune them once you see real traffic. A rule only sees the sources that are connected.</p>
    <div class="cd-tablewrap"><table class="cd-table">
      <thead><tr><th>Severity</th><th>Rule</th><th>Fires when</th><th>Last run</th><th>State</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${sevChip(r.severity)}</td>
        <td><b>${esc(r.title)}</b><br><small class="muted">${esc(r.key)} · ${esc(LEVEL_LABEL[r.evidence_level] || r.evidence_level)}</small></td>
        <td>${r.kind === "system" ? "Checked on every run" : `${esc(r.threshold)} or more in ${esc(win(r.window_minutes))}${r.group_by !== "none" ? ` (per ${esc(r.group_by)})` : ""}`}</td>
        <td>${r.last_run_at ? esc(timeAgo(r.last_run_at)) : "never"}${r.last_matches != null ? `<br><small class="muted">${esc(r.last_matches)} match(es)</small>` : ""}</td>
        <td>${r.enabled ? chip("res-pass", "Enabled") : chip("st-false_positive", "Disabled")}</td>
        <td><button type="button" class="btn btn--ghost btn--sm" data-cd-rule="${esc(r.key)}">Tune</button></td></tr>`).join("")}</tbody></table></div>`;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  body.querySelectorAll("[data-cd-rule]").forEach((b) => b.addEventListener("click", () => openRuleDialog(byKey.get(b.dataset.cdRule))));
}

function openRuleDialog(rule) {
  if (!rule) return;
  const dlg = document.createElement("dialog");
  dlg.className = "cd-dialog";
  dlg.setAttribute("aria-labelledby", "cd-dlg-t");
  const tunable = rule.kind === "event";
  dlg.innerHTML = `
    <form class="cd-form">
      <h4 id="cd-dlg-t">Tune rule</h4>
      <p><b>${esc(rule.title)}</b><br><small class="muted">${esc(rule.description || "")}</small></p>
      <label><input type="checkbox" name="enabled" ${rule.enabled ? "checked" : ""}> Enabled</label>
      ${tunable ? `<label>Threshold (number of matching events)
        <input type="number" name="threshold" min="1" max="10000" value="${esc(rule.threshold)}" required></label>
      <label>Window (minutes, 1 to 10080)
        <input type="number" name="window" min="1" max="10080" value="${esc(rule.window_minutes)}" required></label>` : ""}
      <label>Reason for the change <small class="muted">(kept in the audit trail)</small>
        <input type="text" name="reason" minlength="5" maxlength="300" required placeholder="e.g. Raised after seeing normal weekend traffic."></label>
      <div class="cd-form__act">
        <button type="button" class="btn btn--ghost btn--sm" data-cd-cancel>Cancel</button>
        <button type="submit" class="btn btn--primary btn--sm">Save</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-cd-cancel]").addEventListener("click", close);
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const submit = e.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await rpc("security_set_rule", {
        p_key: rule.key, p_enabled: fd.get("enabled") === "on",
        p_threshold: tunable ? Number(fd.get("threshold")) : null,
        p_window_minutes: tunable ? Number(fd.get("window")) : null,
        p_reason: String(fd.get("reason") || "").trim(),
      });
      close();
      showToast("Rule saved.", "success");
      await showTab("rules");
    } catch (err) { fail(err); submit.disabled = false; }
  });
  dlg.showModal();
}

/* --------------------------------------------------------------- sources */
const COLLECTOR_LABEL = {
  admin_actions: "Admin actions", payments: "Payments", provider_logs: "Provider failures",
  admin_accounts: "Admin accounts", auth_audit: "Sign-in events", db_checks: "Automatic checks",
};

async function sourcesView(body) {
  const srcs = st.overview.sources || [];
  const [{ data: cols }, { data: base }] = await Promise.all([
    supabase.from("security_collector_state").select("name,last_run_at,last_status,last_error,last_new_events,total_events"),
    supabase.from("security_admin_baseline").select("user_id,approved_at"),
  ]);
  const lastApproved = (base || []).reduce((m, r) => (!m || r.approved_at > m ? r.approved_at : m), null);
  body.innerHTML = `
    <section class="cd-card cd-panel"><header class="cd-panel__h"><h4>Service map</h4></header>${topology(srcs)}</section>
    <div class="cd-filter" style="margin-top:var(--sp-4)">
      <button type="button" class="btn btn--secondary btn--sm" data-cd-collect>Collect now</button>
      <span class="muted" data-cd-collect-out>Reads existing records (read-only) and runs the automatic checks.</span>
    </div>
    <p class="cd-note"><b>Not connected</b> means nothing from that source is being collected. It does not mean nothing is happening there.</p>
    <div class="cd-srcs">${srcs.map((s) => `
      <article class="cd-card cd-src cd-src--${esc(s.status)}">
        <header><span class="cd-dot" aria-hidden="true"></span><b>${esc(s.label)}</b>${chip("src-" + s.status, SRC_LABEL[s.status] || s.status)}</header>
        <p>${esc(s.detail || "")}</p>
        <small class="muted">Last event: ${s.last_event_at ? esc(formatDateTime(s.last_event_at)) : "never"} · last checked: ${s.last_checked_at ? esc(timeAgo(s.last_checked_at)) : "never"}</small>
      </article>`).join("")}</div>

    <h4 class="cd-h" style="margin-top:var(--sp-5)">Collectors</h4>
    ${(cols || []).length ? `<div class="cd-tablewrap"><table class="cd-table">
      <thead><tr><th>Collector</th><th>Last run</th><th>Result</th><th>New events</th><th>Total</th></tr></thead>
      <tbody>${cols.sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<tr>
        <td>${esc(COLLECTOR_LABEL[c.name] || c.name)}</td><td>${c.last_run_at ? esc(timeAgo(c.last_run_at)) : "never"}</td>
        <td>${c.last_status === "error" ? chip("res-fail", "Error") : chip("res-pass", "OK")}${c.last_error ? ` <small class="muted">${esc(c.last_error)}</small>` : ""}</td>
        <td>${esc(c.last_new_events)}</td><td>${esc(c.total_events)}</td></tr>`).join("")}</tbody></table></div>`
      : '<div class="cd-empty"><b>Collectors have not run yet.</b><p>Press "Collect now". Scheduling every 5 minutes is optional and needs your approval.</p></div>'}

    <h4 class="cd-h" style="margin-top:var(--sp-5)">Approved administrators</h4>
    <div class="cd-card">
      <p style="margin:0 0 var(--sp-2)">${(base || []).length
      ? `${(base || []).length} admin account${(base || []).length === 1 ? "" : "s"} approved, last on ${esc(formatDateTime(lastApproved))}. Any admin outside this list raises a critical event.`
      : "No approved list yet, so a newly created admin account would not be flagged."}</p>
      <button type="button" class="btn btn--ghost btn--sm" data-cd-approve>Approve current admin accounts</button>
      <p class="cd-note">Do this only after checking that every account with the admin role is yours and still needed.</p>
    </div>`;

  const out = body.querySelector("[data-cd-collect-out]");
  const cbtn = body.querySelector("[data-cd-collect]");
  cbtn.addEventListener("click", async () => {
    busy(cbtn, true); out.textContent = "Collecting…";
    try {
      const r = await rpc("security_collect_now");
      const newEvents = ["admin_actions", "payments", "provider_logs", "admin_accounts", "auth_audit"].reduce((a, k) => a + Number((r && r[k]) || 0), 0);
      showToast(`Collection finished: ${newEvents} new event${newEvents === 1 ? "" : "s"}.`, "success");
      await reload();
    } catch (e) { fail(e); out.textContent = "Collection failed."; busy(cbtn, false); }
  });
  body.querySelector("[data-cd-approve]").addEventListener("click", openApproveDialog);
}

function openApproveDialog() {
  const dlg = document.createElement("dialog");
  dlg.className = "cd-dialog";
  dlg.setAttribute("aria-labelledby", "cd-ap-t");
  dlg.innerHTML = `
    <form class="cd-form">
      <h4 id="cd-ap-t">Approve current admin accounts</h4>
      <p class="muted" style="margin:0">This records every account that has the admin role right now as approved. It does not change anyone's access.</p>
      <label>Note <small class="muted">(who they are; at least 5 characters)</small>
        <textarea name="note" rows="3" maxlength="300" required minlength="5" placeholder="e.g. Owner plus our two team accounts, reviewed today."></textarea></label>
      <div class="cd-form__act">
        <button type="button" class="btn btn--ghost btn--sm" data-cd-cancel>Cancel</button>
        <button type="submit" class="btn btn--primary btn--sm">Approve</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-cd-cancel]").addEventListener("click", close);
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const n = await rpc("security_approve_admins", { p_note: String(new FormData(e.target).get("note") || "").trim() });
      close();
      showToast(`${n} admin account${n === 1 ? "" : "s"} approved.`, "success");
      await reload();
    } catch (err) { fail(err); submit.disabled = false; }
  });
  dlg.showModal();
}

/* ----------------------------------------------------------------- audit */
async function auditView(body) {
  const { data, error } = await supabase.from("security_audit_log")
    .select("chain_no,occurred_at,actor_id,actor_role,action,target_type,target_id")
    .order("chain_no", { ascending: false }).limit(50);
  if (error) throw error;
  body.innerHTML = `
    <div class="cd-filter">
      <button type="button" class="btn btn--secondary btn--sm" data-cd-verify>Verify audit trail</button>
      <span class="muted" data-cd-verify-out>Checks that no entry was altered or removed.</span>
    </div>
    ${data.length ? `<div class="cd-tablewrap"><table class="cd-table">
      <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
      <tbody>${data.map((r) => `<tr><td class="cd-code">${esc(r.chain_no)}</td><td>${esc(formatDateTime(r.occurred_at))}</td>
        <td class="cd-code" title="${esc(r.actor_role || "")}">${short(r.actor_id)}</td><td class="cd-code">${esc(r.action)}</td>
        <td>${esc([r.target_type, r.target_id].filter(Boolean).join(": ") || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : '<div class="cd-empty"><b>The audit trail is empty.</b></div>'}
    <p class="cd-note">Entries cannot be edited or deleted. Each is chained to the one before it, so tampering is detectable. Kept one year.</p>`;
  const btn = body.querySelector("[data-cd-verify]");
  btn.addEventListener("click", async () => {
    const out = body.querySelector("[data-cd-verify-out]");
    busy(btn, true);
    try {
      const r = await rpc("security_verify_audit_chain");
      out.className = r.intact ? "cd-ok" : "cd-bad";
      out.textContent = r.intact
        ? `Intact: ${r.rows} entries verified.`
        : `Problem: ${(r.broken_at || []).length} entr${(r.broken_at || []).length === 1 ? "y does" : "ies do"} not verify (#${(r.broken_at || []).join(", #")}).`;
    } catch (e) { fail(e); } finally { busy(btn, false); }
  });
}