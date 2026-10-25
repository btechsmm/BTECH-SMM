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
const TABS = [
  ["overview", "Overview"], ["findings", "Findings"], ["checks", "Checks"], ["events", "Events"],
  ["incidents", "Incidents"], ["sources", "Sources"], ["audit", "Audit trail"],
];

let root;
const st = { tab: "overview", overview: null, score: null, descriptions: {}, findingFilter: "open" };

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
  shell();
  await loadScore();
  await showTab(st.tab);
}

function shell() {
  root.innerHTML = `
    <div class="cd">
      <div class="cd-bar">
        <div class="cd-bar__id">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>
          <div><strong>BTECH CYBER DEFENSE</strong><span data-cd-mode></span></div>
        </div>
        <div class="cd-bar__actions">
          <button type="button" class="btn btn--secondary btn--sm" data-cd-refresh>Refresh</button>
          <button type="button" class="btn btn--primary btn--sm" data-cd-save title="Recalculate the score and keep it in the history">Save assessment</button>
        </div>
      </div>
      <div class="cd-tabs" role="tablist" aria-label="Cyber Defense sections">
        ${TABS.map(([k, l]) => `<button type="button" class="cd-tab" role="tab" data-cd-tab="${k}" aria-selected="${k === st.tab}">${l}</button>`).join("")}
      </div>
      <div class="cd-body" data-cd-body></div>
    </div>`;
  paintMode();
  root.querySelectorAll("[data-cd-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.cdTab)));
  root.querySelector("[data-cd-refresh]").addEventListener("click", () => reload());
  root.querySelector("[data-cd-save]").addEventListener("click", saveAssessment);
}

function paintMode() {
  const m = st.overview && st.overview.mode;
  const el = root.querySelector("[data-cd-mode]");
  if (el) el.textContent = m === "recommendation" ? "Recommendation mode · read-only toward the platform" : String(m || "");
}

async function reload() {
  try {
    st.overview = await rpc("security_overview");
    paintMode();
    await loadScore();
    await showTab(st.tab);
  } catch (e) { fail(e); }
}

async function saveAssessment() {
  const btn = root.querySelector("[data-cd-save]");
  btn.disabled = true;
  try {
    await rpc("security_compute_score", { p_persist: true });
    showToast("Assessment saved to the history.", "success");
    await reload();
  } catch (e) { fail(e); } finally { btn.disabled = false; }
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
  const body = root.querySelector("[data-cd-body]");
  body.innerHTML = '<div class="skeleton" style="height:140px"></div>';
  try {
    if (t === "overview") await overviewView(body);
    else if (t === "findings") await findingsView(body);
    else if (t === "checks") checksView(body);
    else if (t === "events") await eventsView(body);
    else if (t === "incidents") await incidentsView(body);
    else if (t === "sources") await sourcesView(body);
    else await auditView(body);
  } catch (e) {
    body.innerHTML = `<p class="muted">Could not load this section. ${esc((e && e.message) || "")}</p>`;
  }
}

/* -------------------------------------------------------------- overview */
function gauge(score, rating) {
  const R = 52, C = 2 * Math.PI * R;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, Number(score)));
  const cls = score == null ? "none" : rating;
  return `
    <div class="cd-gauge cd-gauge--${esc(cls)}" role="img" aria-label="${score == null ? "No score yet" : `Security score ${num(score)} out of 100`}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="cd-gauge__track" cx="60" cy="60" r="${R}"/>
        <circle class="cd-gauge__arc" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}"
          stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}" data-c="${C.toFixed(1)}" data-pct="${pct}"/>
      </svg>
      <div class="cd-gauge__txt"><b>${score == null ? "—" : num(score)}</b><small>of 100</small></div>
    </div>`;
}

function animateGauge() {
  const arc = root.querySelector(".cd-gauge__arc");
  if (!arc || reduceMotion()) return;
  const C = Number(arc.dataset.c), pct = Number(arc.dataset.pct);
  arc.style.transition = "none";
  arc.style.strokeDashoffset = String(C);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.transition = "stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)";
    arc.style.strokeDashoffset = String(C * (1 - pct / 100));
  }));
}

function checkTitle(key) {
  const c = ((st.score && st.score.breakdown && st.score.breakdown.checks) || []).find((x) => x.key === key);
  return c ? c.title : key;
}

async function overviewView(body) {
  const s = st.score, o = st.overview;
  const cats = (s.breakdown && s.breakdown.categories) || [];
  const srcs = o.sources || [];
  const connected = srcs.filter((x) => x.status === "connected").length;
  const of = o.open_findings || {};
  const ev = o.events_24h || {};
  const evTotal = Object.values(ev).reduce((a, b) => a + Number(b), 0);
  const { data: hist } = await supabase.from("security_assessments").select("computed_at,score,coverage")
    .order("computed_at", { ascending: false }).limit(12);
  const { data: top } = await supabase.from("security_findings").select("code,title,severity,evidence_level,recommendation,status")
    .in("status", ["open", "mitigating"]);
  const topList = (top || []).sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.code.localeCompare(b.code)).slice(0, 4);

  body.innerHTML = `
    <div class="cd-grid">
      <section class="cd-card cd-score">
        ${gauge(s.score, s.rating)}
        <div class="cd-score__meta">
          <div class="cd-score__rating">${esc(RATING_LABEL[s.rating] || s.rating)}${s.provisional ? " " + chip("prov", "Provisional", "Fewer than 60% of checks have evidence, so this score is a partial view.") : ""}</div>
          <div class="cd-cov" aria-label="Coverage ${num(s.coverage)} percent">
            <div class="cd-cov__bar"><i style="width:${Math.max(0, Math.min(100, Number(s.coverage)))}%"></i></div>
            <span><b>${num(s.coverage)}%</b> of checks have evidence</span>
          </div>
          ${s.raw_score != null && s.score != null && Number(s.raw_score) !== Number(s.score)
            ? `<p class="cd-note">Raw score ${num(s.raw_score)}, limited to ${num(s.score)} while serious checks fail.</p>` : ""}
          <p class="cd-note">${o.latest_assessment ? `Last saved ${esc(timeAgo(o.latest_assessment.computed_at))} (${num(o.latest_assessment.score)}).` : "No assessment saved yet."}</p>
        </div>
      </section>

      <section class="cd-card cd-tiles" aria-label="At a glance">
        <div class="cd-tile"><b>${Object.values(of).reduce((a, b) => a + Number(b), 0)}</b><span>Open findings</span>
          <small>${["critical", "high", "medium", "low"].filter((k) => of[k]).map((k) => `${of[k]} ${k}`).join(" · ") || "none"}</small></div>
        <div class="cd-tile"><b>${Number(o.open_incidents || 0)}</b><span>Open incidents</span><small>manual logging in a later phase</small></div>
        <div class="cd-tile"><b>${evTotal}</b><span>Events (24 h)</span><small>${evTotal ? "see Events" : "nothing collected"}</small></div>
        <div class="cd-tile"><b>${connected}/${srcs.length}</b><span>Sources connected</span><small>${connected ? "see Sources" : "none yet"}</small></div>
      </section>
    </div>

    ${(s.caps || []).map((c) => `
      <div class="cd-alert cd-alert--warn" role="note"><b>Score limited to ${esc(c.cap)}.</b> ${esc(c.reason)}:
        ${(c.checks || []).map((k) => `<span class="cd-code">${esc(checkTitle(k))}</span>`).join(" ")}</div>`).join("")}

    <div class="cd-grid cd-grid--2">
      <section class="cd-card">
        <h4 class="cd-h">Categories</h4>
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
        <section class="cd-card">
          <h4 class="cd-h">Recommended next steps</h4>
          ${topList.length ? `<ol class="cd-recs">${topList.map((f) => `
            <li><div>${sevChip(f.severity)} ${lvlChip(f.evidence_level)} <b>${esc(f.code)}</b> ${esc(f.title)}</div>
            <p>${esc(f.recommendation || "")}</p></li>`).join("")}</ol>
            <button type="button" class="btn btn--ghost btn--sm" data-cd-go="findings">View all findings</button>`
            : '<p class="muted">No open findings recorded.</p>'}
        </section>
        <section class="cd-card">
          <h4 class="cd-h">Score history</h4>
          ${sparkline(hist || [])}
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
  const { data, error } = await supabase.from("security_events")
    .select("id,occurred_at,source,event_type,severity,actor_id,subject_type,subject_id")
    .order("occurred_at", { ascending: false }).limit(50);
  if (error) throw error;
  if (!data.length) {
    const none = (st.overview.sources || []).every((s) => s.status === "not_connected");
    body.innerHTML = `<div class="cd-empty"><b>No security events recorded.</b>
      <p>${none ? "No collectors are connected yet, so an empty list does not mean nothing is happening. See Sources." : "Connected sources have not reported anything in the retention window."}</p></div>`;
    return;
  }
  body.innerHTML = `<div class="cd-tablewrap"><table class="cd-table">
    <thead><tr><th>Time</th><th>Severity</th><th>Source</th><th>Event</th><th>Actor</th><th>Subject</th></tr></thead>
    <tbody>${data.map((r) => `<tr><td>${esc(formatDateTime(r.occurred_at))}</td><td>${sevChip(r.severity)}</td><td>${esc(r.source)}</td>
      <td class="cd-code">${esc(r.event_type)}</td><td class="cd-code">${short(r.actor_id)}</td>
      <td>${esc([r.subject_type, r.subject_id].filter(Boolean).join(": ") || "—")}</td></tr>`).join("")}</tbody></table></div>
    <p class="cd-note">Latest 50 events. Events are kept 90 days.</p>`;
}

/* ------------------------------------------------------------- incidents */
async function incidentsView(body) {
  const { data, error } = await supabase.from("security_incidents")
    .select("id,title,severity,status,opened_at,resolved_at").order("opened_at", { ascending: false }).limit(50);
  if (error) throw error;
  if (!data.length) {
    body.innerHTML = `<div class="cd-empty"><b>No incidents recorded.</b>
      <p>Nothing is being detected automatically yet. Incident creation and review arrive in a later phase.</p></div>`;
    return;
  }
  body.innerHTML = `<div class="cd-tablewrap"><table class="cd-table">
    <thead><tr><th>Opened</th><th>Severity</th><th>Title</th><th>Status</th><th>Resolved</th></tr></thead>
    <tbody>${data.map((r) => `<tr><td>${esc(formatDateTime(r.opened_at))}</td><td>${sevChip(r.severity)}</td><td>${esc(r.title)}</td>
      <td>${chip("st-" + r.status, r.status.replace("_", " "))}</td><td>${r.resolved_at ? esc(formatDateTime(r.resolved_at)) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
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
    <div class="cd-filter">
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
    cbtn.disabled = true; out.textContent = "Collecting…";
    try {
      const r = await rpc("security_collect_now");
      const newEvents = ["admin_actions", "payments", "provider_logs", "admin_accounts", "auth_audit"].reduce((a, k) => a + Number((r && r[k]) || 0), 0);
      showToast(`Collection finished: ${newEvents} new event${newEvents === 1 ? "" : "s"}.`, "success");
      await reload();
    } catch (e) { fail(e); out.textContent = "Collection failed."; cbtn.disabled = false; }
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
    btn.disabled = true;
    try {
      const r = await rpc("security_verify_audit_chain");
      out.className = r.intact ? "cd-ok" : "cd-bad";
      out.textContent = r.intact
        ? `Intact: ${r.rows} entries verified.`
        : `Problem: ${(r.broken_at || []).length} entr${(r.broken_at || []).length === 1 ? "y does" : "ies do"} not verify (#${(r.broken_at || []).join(", #")}).`;
    } catch (e) { fail(e); } finally { btn.disabled = false; }
  });
}
