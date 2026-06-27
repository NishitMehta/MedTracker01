\/* ============================================================
   Taper — app logic (vanilla, no build step)
   Data model
   ----------
   med = {
     id, name, color, notes,
     type: 'fixed' | 'taper',
     times: ['08:00', ...],
     dose: '20 mg',                 // fixed
     startDate: 'YYYY-MM-DD',
     endless: bool, endDate: str|null,   // fixed
     stages: [{ dose:'40 mg', days:5 }], // taper (uses startDate as plan start)
     calEventIds: [], createdAt
   }
   log = { 'YYYY-MM-DD': { 'medId|HH:MM': true } }
   ============================================================ */

/* ---------- storage (localStorage, falls back to memory) ---------- */
const store = (() => {
  let ok = true, mem = {};
  try { const k = "__t"; localStorage.setItem(k, "1"); localStorage.removeItem(k); }
  catch { ok = false; }
  return {
    persistent: ok,
    get(k, def) {
      try { const v = ok ? localStorage.getItem(k) : mem[k]; return v == null ? def : JSON.parse(v); }
      catch { return def; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { if (ok) localStorage.setItem(k, s); else mem[k] = s; } catch { mem[k] = s; }
    },
    del(k) { try { ok ? localStorage.removeItem(k) : delete mem[k]; } catch {} }
  };
})();

/* ---------- state ---------- */
let meds = store.get("meds", []);
let logs = store.get("logs", {});
let settings = store.get("settings", {
  notify: false, calendarSync: false, clientId: "", reminderLead: 0
});
let selectedDate = ymd(new Date());
let editingId = null;
let formDraft = null;       // working copy while sheet is open
let noteTimers = [];
let toastTimer = null;

const COLORS = ["#5eead4", "#fbbf24", "#a78bfa", "#fb7185", "#60a5fa", "#34d399", "#f472b6", "#fb923c"];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ---------- date helpers ---------- */
function ymd(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseYMD(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function utcms(s) { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }
function dayDiff(a, b) { return Math.round((utcms(b) - utcms(a)) / 86400000); }
function addDays(s, n) { const d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); }
function fmtDate(s) {
  return parseYMD(s).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ---------- taper engine ---------- */
function taperTotalDays(med) { return (med.stages || []).reduce((s, x) => s + (+x.days || 0), 0); }

// returns { active, dose } for a med on a given date
function doseOn(med, dateStr) {
  if (med.type === "fixed") {
    if (dateStr < med.startDate) return { active: false };
    if (!med.endless && med.endDate && dateStr > med.endDate) return { active: false };
    return { active: true, dose: med.dose || "" };
  }
  if (med.type === "interval") {
    return intervalDoseDates(med).includes(dateStr)
      ? { active: true, dose: med.dose || "" } : { active: false };
  }
  // taper (dose-step)
  const idx = dayDiff(med.startDate, dateStr);
  if (idx < 0) return { active: false };
  let acc = 0;
  for (const st of med.stages) {
    const len = +st.days || 0;
    if (idx < acc + len) return { active: true, dose: st.dose || "" };
    acc += len;
  }
  return { active: false }; // taper complete
}

// interval (spacing) taper: same dose, gap between dose-days grows.
// dates = start, then each next gap = intervalStart + (n-1)*intervalStep.
function intervalDoseDates(med) {
  const n = +med.doseCount || 0;
  if (n <= 0) return [];
  const out = [med.startDate];
  let cur = med.startDate;
  for (let i = 1; i < n; i++) {
    const gap = (+med.intervalStart || 0) + (i - 1) * (+med.intervalStep || 0);
    cur = addDays(cur, gap);
    out.push(cur);
  }
  return out;
}
function intervalGaps(med) {
  const n = +med.doseCount || 0;
  const g = [];
  for (let i = 1; i < n; i++) g.push((+med.intervalStart || 0) + (i - 1) * (+med.intervalStep || 0));
  return g;
}
function planEnd(med) {
  if (med.type === "taper") return addDays(med.startDate, taperTotalDays(med) - 1);
  if (med.type === "interval") { const d = intervalDoseDates(med); return d[d.length - 1] || med.startDate; }
  return med.endDate;
}

// list of dose entries for a date, sorted by time
function dosesForDate(dateStr) {
  const out = [];
  for (const med of meds) {
    const d = doseOn(med, dateStr);
    if (!d.active) continue;
    for (const t of med.times) {
      out.push({ medId: med.id, name: med.name, color: med.color, dose: d.dose, time: t,
        key: `${med.id}|${t}` });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/* ---------- persistence ---------- */
function save() {
  store.set("meds", meds);
  store.set("logs", logs);
  store.set("settings", settings);
}

/* =====================================================================
   RENDER
   ===================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function renderAll() { renderToday(); renderMeds(); renderSettings(); scheduleNotifications(); }

/* ---- Today ---- */
function renderToday() {
  const today = ymd(new Date());
  $("#todayTitle").textContent =
    selectedDate === today ? "Today" :
    selectedDate === addDays(today, -1) ? "Yesterday" :
    selectedDate === addDays(today, 1) ? "Tomorrow" : "Schedule";
  $("#todayDate").textContent = fmtDate(selectedDate);

  // day strip: 3 days back -> 10 forward
  const strip = $("#dayStrip"); strip.innerHTML = "";
  for (let i = -3; i <= 10; i++) {
    const ds = addDays(today, i);
    const d = parseYMD(ds);
    const chip = document.createElement("button");
    chip.className = "day-chip" + (ds === today ? " today" : "") + (ds === selectedDate ? " sel" : "");
    chip.innerHTML = `<small>${d.toLocaleDateString(undefined, { weekday: "short" })}</small><b>${d.getDate()}</b>`;
    chip.onclick = () => { selectedDate = ds; renderToday(); scheduleNotifications(); };
    strip.appendChild(chip);
  }

  const doses = dosesForDate(selectedDate);
  const list = $("#doseList");
  const log = logs[selectedDate] || {};

  // adherence
  const card = $("#adherenceCard");
  if (doses.length) {
    const taken = doses.filter(x => log[x.key]).length;
    const pct = Math.round((taken / doses.length) * 100);
    card.style.display = "flex";
    $("#adherencePct").textContent = pct + "%";
    $("#adherenceText").textContent = `${taken} of ${doses.length} doses`;
    drawRing(pct);
  } else card.style.display = "none";

  if (!doses.length) {
    list.innerHTML = emptyState(
      meds.length ? "Nothing scheduled for this day." : "No medicines yet.",
      meds.length ? "Pick another day or add a medicine." : "Tap + to add your first one."
    );
    return;
  }

  const now = new Date();
  const isToday = selectedDate === ymd(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  list.innerHTML = "";
  for (const x of doses) {
    const done = !!log[x.key];
    const [h, m] = x.time.split(":").map(Number);
    const doseMin = h * 60 + m;
    let cls = "dose glass";
    if (done) cls += " done";
    else if (isToday && doseMin < nowMin - 5) cls += " overdue";
    else if (isToday && doseMin <= nowMin + 60) cls += " due";

    const row = document.createElement("div");
    row.className = cls;
    row.innerHTML = `
      <button class="check" aria-label="Mark ${done ? "not taken" : "taken"}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>
      </button>
      <div class="dose-info">
        <div class="name"><span class="swatch" style="background:${x.color}"></span>${esc(x.name)}</div>
        <div class="meta">${esc(x.dose) || "—"}</div>
      </div>
      <div class="dose-time">${fmtTime(x.time)}</div>`;
    row.querySelector(".check").onclick = () => toggleDose(selectedDate, x.key);
    list.appendChild(row);
  }
}

function toggleDose(date, key) {
  if (!logs[date]) logs[date] = {};
  if (logs[date][key]) delete logs[date][key];
  else logs[date][key] = true;
  save(); renderToday();
}

function drawRing(pct) {
  const r = 15.9, c = 2 * Math.PI * r;
  $("#ring").innerHTML = `
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="3.4"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="${pct === 100 ? "#5eead4" : "#fbbf24"}"
      stroke-width="3.4" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"
      transform="rotate(-90 18 18)" style="transition:stroke-dashoffset .6s ease"/>`;
}

/* ---- Meds ---- */
function renderMeds() {
  const list = $("#medList");
  const today = ymd(new Date());
  $("#medsSub").textContent = meds.length ? `${meds.length} medicine${meds.length > 1 ? "s" : ""}` : "Your active plans";
  if (!meds.length) {
    list.innerHTML = emptyState("No medicines yet.", "Tap + to create a schedule or taper plan.");
    return;
  }
  list.innerHTML = "";
  for (const med of meds) {
    const state = doseOn(med, today);
    const el = document.createElement("div");
    el.className = "med glass";
    let tag, tagCls;
    if (med.type === "taper") {
      const done = !state.active && dayDiff(med.startDate, today) >= taperTotalDays(med);
      tagCls = done ? "done" : "taper"; tag = done ? "Complete" : "Taper";
    } else if (med.type === "interval") {
      const done = today > planEnd(med);
      tagCls = done ? "done" : "taper"; tag = done ? "Complete" : "Spacing";
    } else {
      const done = !med.endless && med.endDate && today > med.endDate;
      tagCls = done ? "done" : "fixed"; tag = done ? "Ended" : "Fixed";
    }

    let meta = `<span>${clock()} ${med.times.map(fmtTime).join(", ")}</span>`;
    if (med.type === "fixed") {
      meta += `<span>${pill()} ${esc(med.dose) || "—"}</span>`;
      meta += `<span>${cal()} ${med.endless ? "Ongoing" : "Until " + shortD(med.endDate)}</span>`;
    } else if (med.type === "interval") {
      meta += `<span>${pill()} ${esc(med.dose) || "—"}</span>`;
      meta += `<span>${cal()} ${med.doseCount} doses · ends ${shortD(planEnd(med))}</span>`;
    } else {
      meta += `<span>${pill()} ${med.stages.length} steps · ${taperTotalDays(med)} days</span>`;
      meta += `<span>${cal()} Ends ${shortD(planEnd(med))}</span>`;
    }

    el.innerHTML = `
      <div class="med-top">
        <span class="med-swatch" style="background:${med.color}"></span>
        <span class="name">${esc(med.name)}</span>
        <span class="tag ${tagCls}">${tag}</span>
      </div>
      <div class="med-meta">${meta}</div>
      ${med.type === "taper" ? taperRamp(med, today) : med.type === "interval" ? intervalTimeline(med, today) : ""}`;
    el.onclick = () => openSheet(med.id);
    list.appendChild(el);
  }
}

// the signature visual: dose stepping down, amber -> mint, active step outlined
function taperRamp(med, today) {
  const vals = med.stages.map(s => parseFloat(s.dose));
  const numeric = vals.every(v => !isNaN(v));
  const max = numeric ? Math.max(...vals) : med.stages.length;
  const curIdx = activeStageIndex(med, today);
  const bars = med.stages.map((s, i) => {
    const h = numeric ? Math.max(12, (vals[i] / max) * 100) : ((med.stages.length - i) / med.stages.length) * 100;
    const col = lerpColor("#fbbf24", "#5eead4", med.stages.length === 1 ? 1 : i / (med.stages.length - 1));
    return `<div class="ramp-bar${i === curIdx ? " active" : ""}" style="height:${h}%;background:${col}"></div>`;
  }).join("");
  const labels = med.stages.map(s => `<span>${esc(s.dose) || "·"}</span>`).join("");
  return `<div class="ramp"><div class="ramp-bars">${bars}</div><div class="ramp-labels">${labels}</div></div>`;
}
function activeStageIndex(med, dateStr) {
  if (med.type !== "taper") return -1;
  const idx = dayDiff(med.startDate, dateStr);
  if (idx < 0) return -1;
  let acc = 0;
  for (let i = 0; i < med.stages.length; i++) {
    acc += +med.stages[i].days || 0;
    if (idx < acc) return i;
  }
  return -1;
}

// signature for spacing taper: dose dots on a timeline, spreading apart as gaps grow.
function intervalTimeline(med, today) {
  const dates = intervalDoseDates(med);
  if (dates.length < 2) return "";
  const span = dayDiff(dates[0], dates[dates.length - 1]) || 1;
  let nextIdx = dates.findIndex(d => d >= today);
  const dots = dates.map((d, i) => {
    const x = (dayDiff(dates[0], d) / span) * 100;
    const past = d < today, isNext = i === nextIdx;
    const cls = "tl-dot" + (isNext ? " next" : past ? " past" : "");
    return `<span class="${cls}" style="left:${x.toFixed(1)}%"></span>`;
  }).join("");
  const gaps = intervalGaps(med);
  const gapText = gaps.length <= 9 ? gaps.join(", ") : gaps.slice(0, 8).join(", ") + ", …";
  return `<div class="ramp">
    <div class="timeline"><div class="tl-line"></div>${dots}</div>
    <div class="ramp-labels" style="justify-content:space-between">
      <span style="text-align:left">${shortD(dates[0])}</span>
      <span style="text-align:right">${shortD(dates[dates.length - 1])}</span>
    </div>
    <div class="small-note" style="margin-top:6px">Gaps grow (days): ${gapText}</div>
  </div>`;
}

/* ---- Settings ---- */
function renderSettings() {
  $("#tglNotify").classList.toggle("on", !!settings.notify);
  $("#tglCalendar").classList.toggle("on", !!settings.calendarSync);
  $("#calConfig").style.display = settings.calendarSync ? "block" : "none";
  $("#clientId").value = settings.clientId || "";
  $("#reminderLead").value = String(settings.reminderLead || 0);
  updateSyncPill();
}
function updateSyncPill() {
  const pill = $("#syncPill"), label = $("#syncPillLabel");
  if (settings.calendarSync && gcalToken) { pill.classList.add("on"); label.textContent = "Calendar on"; }
  else if (settings.calendarSync) { pill.classList.remove("on"); label.textContent = "Connect calendar"; }
  else { pill.classList.remove("on"); label.textContent = "Calendar off"; }
}

/* ---------- tiny svg/util helpers ---------- */
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function shortD(s) { return s ? parseYMD(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"; }
function emptyState(t, h) {
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="4"/><path d="M3 9h18M8 2v4M16 2v4"/></svg><p>${t}</p><p class="hint">${h}</p></div>`;
}
function clock() { return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/></svg>`; }
function pill() { return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)"/></svg>`; }
function cal() { return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4" stroke-linecap="round"/></svg>`; }
function lerpColor(a, b, t) {
  const h = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(a), [r2, g2, b2] = h(b);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(r1, r2)},${m(g1, g2)},${m(b1, b2)})`;
}
function toast(msg, kind = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* =====================================================================
   ADD / EDIT SHEET
   ===================================================================== */
function openSheet(id = null) {
  editingId = id;
  const med = id ? meds.find(m => m.id === id) : null;
  formDraft = med ? JSON.parse(JSON.stringify(med)) : {
    name: "", color: COLORS[meds.length % COLORS.length], notes: "",
    type: "fixed", times: ["08:00"], dose: "",
    startDate: ymd(new Date()), endless: true, endDate: addDays(ymd(new Date()), 30),
    stages: [{ dose: "", days: 5 }],
    intervalStart: 1, intervalStep: 1, doseCount: 6
  };
  renderSheet();
  $("#scrim").classList.add("open");
  $("#sheet").classList.add("open");
}
function closeSheet() {
  $("#scrim").classList.remove("open");
  $("#sheet").classList.remove("open");
  editingId = null; formDraft = null;
}

function renderSheet() {
  const f = formDraft;
  const sheet = $("#sheet");
  sheet.innerHTML = `
    <div class="grabber"></div>
    <h2 id="sheetTitle">${editingId ? "Edit medicine" : "New medicine"}</h2>

    <div class="field">
      <label for="fName">Name</label>
      <input class="input" id="fName" placeholder="e.g. Prednisone" value="${esc(f.name)}" />
    </div>

    <div class="field">
      <label>Colour</label>
      <div class="colors" id="fColors">
        ${COLORS.map(c => `<button data-c="${c}" class="${c === f.color ? "on" : ""}" style="background:${c}" aria-label="colour"></button>`).join("")}
      </div>
    </div>

    <div class="field">
      <label>Schedule type</label>
      <div class="seg seg-3" id="fType">
        <button data-t="fixed" class="${f.type === "fixed" ? "on" : ""}">Daily</button>
        <button data-t="taper" class="${f.type === "taper" ? "on" : ""}">Dose taper</button>
        <button data-t="interval" class="${f.type === "interval" ? "on" : ""}">Spacing</button>
      </div>
      <p class="small-note" id="fTypeHint" style="margin-top:8px">${typeHint(f.type)}</p>
    </div>

    <div class="field">
      <label>Dose times</label>
      <div class="times" id="fTimes">${renderTimeChips()}</div>
      <div style="display:flex; gap:8px; margin-top:10px">
        <input class="input" type="time" id="fNewTime" value="08:00" style="flex:1" />
        <button class="btn btn-ghost sm" id="fAddTime" style="white-space:nowrap">Add time</button>
      </div>
    </div>

    <div id="fFixed" style="${f.type === "fixed" ? "" : "display:none"}">
      <div class="field">
        <label for="fDose">Dose each time</label>
        <input class="input" id="fDose" placeholder="e.g. 20 mg · 1 tablet" value="${esc(f.dose)}" />
      </div>
      <div class="row">
        <div class="field">
          <label for="fStart">Start date</label>
          <input class="input" type="date" id="fStart" value="${f.startDate}" />
        </div>
        <div class="field">
          <label for="fEnd">End date</label>
          <input class="input" type="date" id="fEnd" value="${f.endDate || ""}" ${f.endless ? "disabled" : ""} />
        </div>
      </div>
      <label style="display:flex; align-items:center; gap:10px; font-size:14px; color:var(--ink-dim); margin-bottom:8px">
        <input type="checkbox" id="fEndless" ${f.endless ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--mint)"/>
        Ongoing — no end date
      </label>
    </div>

    <div id="fTaper" style="${f.type === "taper" ? "" : "display:none"}">
      <div class="field">
        <label for="fTStart">Taper start date</label>
        <input class="input" type="date" id="fTStart" value="${f.startDate}" />
      </div>
      <div class="field">
        <label>Steps (dose → days at that dose)</label>
        <div id="fStages">${renderStages()}</div>
        <button class="add-time" id="fAddStage" style="margin-top:6px">+ Add step</button>
        <div class="taper-summary" id="fTaperSummary">${taperSummaryText()}</div>
      </div>
    </div>

    <div id="fInterval" style="${f.type === "interval" ? "" : "display:none"}">
      <div class="field">
        <label for="fIDose">Dose each time</label>
        <input class="input" id="fIDose" placeholder="e.g. 1 tablet · 5 mg" value="${esc(f.dose)}" />
      </div>
      <div class="field">
        <label for="fIStart">First dose date</label>
        <input class="input" type="date" id="fIStart" value="${f.startDate}" />
      </div>
      <div class="row">
        <div class="field">
          <label for="fIFirst">First gap</label>
          <input class="input" type="number" id="fIFirst" min="1" value="${f.intervalStart}" />
        </div>
        <div class="field">
          <label for="fIStep">Increase by</label>
          <input class="input" type="number" id="fIStep" min="0" value="${f.intervalStep}" />
        </div>
        <div class="field">
          <label for="fICount">Doses</label>
          <input class="input" type="number" id="fICount" min="1" value="${f.doseCount}" />
        </div>
      </div>
      <div class="taper-summary" id="fIntervalPreview">${intervalPreviewHTML()}</div>
    </div>

    <div class="field">
      <label for="fNotes">Notes <span style="color:var(--ink-faint);font-weight:400">(optional)</span></label>
      <textarea class="input" id="fNotes" placeholder="With food, etc.">${esc(f.notes)}</textarea>
    </div>

    <div style="display:flex; gap:10px; margin-top:6px">
      ${editingId ? `<button class="btn btn-danger" id="fDelete" style="flex:0 0 auto;width:auto;padding:14px 18px">Delete</button>` : ""}
      <button class="btn btn-ghost" id="fCancel" style="flex:1">Cancel</button>
      <button class="btn btn-primary" id="fSave" style="flex:1.4">Save</button>
    </div>
    <p class="small-note" id="fSyncNote" style="margin-top:12px; text-align:center; ${settings.calendarSync ? "" : "display:none"}">
      Saving will update your Google Calendar.
    </p>`;

  wireSheet();
}

function renderTimeChips() {
  return formDraft.times.map((t, i) =>
    `<span class="time-chip">${fmtTime(t)}<button data-i="${i}" aria-label="remove time">×</button></span>`).join("")
    || `<span class="small-note">No times yet — add at least one.</span>`;
}
function renderStages() {
  return formDraft.stages.map((s, i) => `
    <div class="stage">
      <span class="idx">${i + 1}</span>
      <input class="input" data-i="${i}" data-k="dose" placeholder="dose" value="${esc(s.dose)}" style="flex:1.3" />
      <input class="input" data-i="${i}" data-k="days" type="number" min="1" placeholder="days" value="${s.days || ""}" style="flex:0.8" />
      <span class="unit">days</span>
      <button class="del" data-i="${i}" aria-label="remove step"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>`).join("");
}
function taperSummaryText() {
  const total = taperTotalDays(formDraft);
  if (!total) return "Add steps to see the plan length.";
  const end = addDays(formDraft.startDate, total - 1);
  return `Plan runs ${total} day${total > 1 ? "s" : ""} — ${shortD(formDraft.startDate)} to ${shortD(end)}.`;
}
function typeHint(t) {
  if (t === "fixed") return "Same dose every day at the set times.";
  if (t === "taper") return "Dose drops in steps — each dose held for a number of days.";
  return "Same dose, but the gap between doses grows each time (e.g. 1, 2, 3, 4 days apart).";
}
function intervalPreviewHTML() {
  const dates = intervalDoseDates(formDraft);
  if (dates.length < 1) return "Set the dose count to see the schedule.";
  const gaps = intervalGaps(formDraft);
  const chips = dates.map((d, i) => {
    const wd = parseYMD(d).toLocaleDateString(undefined, { weekday: "short" });
    const g = i === 0 ? "start" : "+" + gaps[i - 1];
    return `<span class="prev-chip"><b>${wd} ${shortD(d)}</b><small>${g}</small></span>`;
  }).join("");
  const last = dates[dates.length - 1];
  return `<div style="margin-bottom:8px">Dose 1 to ${dates.length}, ending <b>${shortD(last)}</b>:</div>
    <div class="prev-list">${chips}</div>`;
}

function wireSheet() {
  const f = formDraft;
  $("#fName").oninput = e => f.name = e.target.value;
  $("#fNotes").oninput = e => f.notes = e.target.value;

  $$("#fColors button").forEach(b => b.onclick = () => {
    f.color = b.dataset.c; $$("#fColors button").forEach(x => x.classList.toggle("on", x === b));
  });

  $$("#fType button").forEach(b => b.onclick = () => {
    f.type = b.dataset.t;
    if (f.type === "interval") {
      if (f.intervalStart == null) f.intervalStart = 1;
      if (f.intervalStep == null) f.intervalStep = 1;
      if (f.doseCount == null) f.doseCount = 6;
    }
    if (f.type === "taper" && (!f.stages || !f.stages.length)) f.stages = [{ dose: "", days: 5 }];
    $$("#fType button").forEach(x => x.classList.toggle("on", x === b));
    $("#fFixed").style.display = f.type === "fixed" ? "" : "none";
    $("#fTaper").style.display = f.type === "taper" ? "" : "none";
    $("#fInterval").style.display = f.type === "interval" ? "" : "none";
    $("#fTypeHint").textContent = typeHint(f.type);
    if (f.type === "interval") { renderSheet(); }  // rebuild so interval inputs bind cleanly
  });

  // times
  $("#fAddTime").onclick = () => {
    const t = $("#fNewTime").value;
    if (t && !f.times.includes(t)) { f.times.push(t); f.times.sort(); refreshTimes(); }
  };
  bindTimeRemovers();

  // fixed
  const fd = $("#fDose"); if (fd) fd.oninput = e => f.dose = e.target.value;
  const fs = $("#fStart"); if (fs) fs.onchange = e => f.startDate = e.target.value;
  const fe = $("#fEnd"); if (fe) fe.onchange = e => f.endDate = e.target.value;
  const fel = $("#fEndless"); if (fel) fel.onchange = e => {
    f.endless = e.target.checked; $("#fEnd").disabled = f.endless;
  };

  // taper
  const ts = $("#fTStart"); if (ts) ts.onchange = e => { f.startDate = e.target.value; $("#fTaperSummary").textContent = taperSummaryText(); };
  const as = $("#fAddStage"); if (as) as.onclick = () => { f.stages.push({ dose: "", days: 5 }); refreshStages(); };
  bindStageInputs();

  // interval (spacing)
  const refreshPrev = () => { const p = $("#fIntervalPreview"); if (p) p.innerHTML = intervalPreviewHTML(); };
  const idose = $("#fIDose"); if (idose) idose.oninput = e => f.dose = e.target.value;
  const istart = $("#fIStart"); if (istart) istart.onchange = e => { f.startDate = e.target.value; refreshPrev(); };
  const ifirst = $("#fIFirst"); if (ifirst) ifirst.oninput = e => { f.intervalStart = +e.target.value || 0; refreshPrev(); };
  const istep = $("#fIStep"); if (istep) istep.oninput = e => { f.intervalStep = +e.target.value || 0; refreshPrev(); };
  const icount = $("#fICount"); if (icount) icount.oninput = e => { f.doseCount = Math.max(0, +e.target.value || 0); refreshPrev(); };

  // actions
  $("#fCancel").onclick = closeSheet;
  $("#fSave").onclick = saveForm;
  const del = $("#fDelete"); if (del) del.onclick = deleteMed;
}
function refreshTimes() { $("#fTimes").innerHTML = renderTimeChips(); bindTimeRemovers(); }
function bindTimeRemovers() {
  $$("#fTimes button[data-i]").forEach(b => b.onclick = () => { formDraft.times.splice(+b.dataset.i, 1); refreshTimes(); });
}
function refreshStages() { $("#fStages").innerHTML = renderStages(); bindStageInputs(); $("#fTaperSummary").textContent = taperSummaryText(); }
function bindStageInputs() {
  $$("#fStages .stage .input").forEach(inp => {
    inp.oninput = () => {
      const i = +inp.dataset.i, k = inp.dataset.k;
      formDraft.stages[i][k] = k === "days" ? (+inp.value || 0) : inp.value;
      if (k === "days") $("#fTaperSummary").textContent = taperSummaryText();
    };
  });
  $$("#fStages .del").forEach(b => b.onclick = () => {
    formDraft.stages.splice(+b.dataset.i, 1);
    if (!formDraft.stages.length) formDraft.stages.push({ dose: "", days: 5 });
    refreshStages();
  });
}

async function saveForm() {
  const f = formDraft;
  if (!f.name.trim()) return toast("Give it a name first.", "err");
  if (!f.times.length) return toast("Add at least one dose time.", "err");
  if (f.type === "taper") {
    f.stages = f.stages.filter(s => (+s.days || 0) > 0);
    if (!f.stages.length) return toast("A taper needs at least one step with days.", "err");
  } else if (f.type === "interval") {
    if (!f.startDate) return toast("Pick a first dose date.", "err");
    if ((+f.doseCount || 0) < 1) return toast("Set how many doses there are.", "err");
    if ((+f.intervalStart || 0) < 1 && (+f.doseCount || 0) > 1) return toast("First gap must be at least 1 day.", "err");
  } else if (!f.startDate) return toast("Pick a start date.", "err");

  let med;
  if (editingId) { med = meds.find(m => m.id === editingId); Object.assign(med, f); }
  else { med = { ...f, id: "m" + Date.now().toString(36), calEventIds: [], createdAt: Date.now() }; meds.push(med); }
  save();
  closeSheet();
  renderAll();
  toast(editingId ? "Saved." : "Medicine added.", "ok");

  if (settings.calendarSync) {
    if (!gcalToken) { ensureToken(() => syncMed(med)); }
    else syncMed(med);
  }
}

function deleteMed() {
  const med = meds.find(m => m.id === editingId);
  const hasEvents = settings.calendarSync && med.calEventIds && med.calEventIds.length;
  if (!confirm(`Delete "${med.name}"?` + (hasEvents ? " Its calendar events will be removed too." : ""))) return;
  closeSheet();
  // remove from the app immediately
  meds = meds.filter(m => m.id !== med.id);
  save(); renderAll();

  if (!hasEvents) { toast("Deleted."); return; }

  const cleanup = async () => {
    const failed = await deleteMedEvents(med);
    if (failed.length) { queueDeletes(failed); toast("Deleted. A few calendar events will clear next time you sign in.", ""); }
    else toast("Deleted, calendar cleared.", "ok");
  };

  if (gcalToken && Date.now() < gcalExp) {
    cleanup().catch(() => { queueDeletes(med.calEventIds); toast("Deleted. Calendar events will clear on next sign-in.", ""); });
  } else {
    // not signed in — queue the events and ask Google for access to remove them
    queueDeletes(med.calEventIds);
    toast("Deleted. Sign in to clear its calendar events…", "");
    ensureToken(flushPendingDeletes);
  }
}

/* =====================================================================
   NOTIFICATIONS (in-app, while open)
   ===================================================================== */
function scheduleNotifications() {
  noteTimers.forEach(clearTimeout); noteTimers = [];
  if (!settings.notify || Notification?.permission !== "granted") return;
  if (selectedDate !== ymd(new Date())) return;
  const now = new Date();
  const log = logs[selectedDate] || {};
  for (const x of dosesForDate(selectedDate)) {
    if (log[x.key]) continue;
    const [h, m] = x.time.split(":").map(Number);
    const when = new Date(); when.setHours(h, m, 0, 0);
    const delay = when - now;
    if (delay <= 0 || delay > 86400000) continue;
    noteTimers.push(setTimeout(() => {
      try {
        new Notification("Time for " + x.name, {
          body: (x.dose ? x.dose + " · " : "") + fmtTime(x.time),
          icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: x.key
        });
      } catch {}
    }, delay));
  }
}

async function enableNotify() {
  if (!("Notification" in window)) return toast("This browser has no notifications.", "err");
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") { settings.notify = false; save(); renderSettings(); return toast("Permission denied.", "err"); }
  settings.notify = true; save(); renderSettings(); scheduleNotifications();
  toast("Reminders on for while the app is open.", "ok");
}

/* =====================================================================
   GOOGLE CALENDAR
   ===================================================================== */
let tokenClient = null, gcalToken = null, gcalExp = 0, pendingAfterToken = null;
let pendingDeletes = store.get("pendingDeletes", []);

function queueDeletes(ids) {
  if (!ids || !ids.length) return;
  pendingDeletes = [...new Set([...pendingDeletes, ...ids])];
  store.set("pendingDeletes", pendingDeletes);
}
async function flushPendingDeletes() {
  if (!gcalToken || !pendingDeletes.length) return;
  const failed = await deleteIds(pendingDeletes);
  pendingDeletes = failed;
  store.set("pendingDeletes", pendingDeletes);
}

function loadStoredToken() {
  const t = store.get("gcalTok", null);
  if (t && t.token && t.exp > Date.now()) { gcalToken = t.token; gcalExp = t.exp; }
}
function clearStoredToken() { gcalToken = null; gcalExp = 0; store.del("gcalTok"); }

function initTokenClient() {
  if (!window.google?.accounts?.oauth2 || !settings.clientId) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId.trim(),
    scope: "https://www.googleapis.com/auth/calendar.events",
    callback: (resp) => {
      if (resp.error) {
        // Silent attempts that need interaction fail quietly — don't nag.
        if (resp.error !== "interaction_required" && resp.error !== "access_denied")
          toast("Google sign-in failed.", "err");
        pendingAfterToken = null;
        return;
      }
      gcalToken = resp.access_token;
      gcalExp = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600000) - 60000;
      store.set("gcalTok", { token: gcalToken, exp: gcalExp });
      updateSyncPill();
      toast("Google Calendar connected.", "ok");
      flushPendingDeletes();   // clean up anything left from earlier offline deletes
      const cb = pendingAfterToken; pendingAfterToken = null; if (cb) cb();
    }
  });
  return true;
}
function ensureToken(after) {
  pendingAfterToken = after || null;
  if (gcalToken && Date.now() < gcalExp) { pendingAfterToken = null; return after && after(); }
  if (!tokenClient && !initTokenClient()) {
    return toast("Add your Google Client ID in Settings first.", "err");
  }
  // Interactive grant only happens when the user actually does something that needs it.
  tokenClient.requestAccessToken({ prompt: gcalToken ? "" : "consent" });
}

async function gcal(path, method = "GET", body) {
  const res = await fetch("https://www.googleapis.com/calendar/v3" + path, {
    method,
    headers: { Authorization: "Bearer " + gcalToken, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { clearStoredToken(); throw new Error("auth"); }
  if (!res.ok) throw new Error("gcal " + res.status);
  return res.status === 204 ? null : res.json();
}

function rfc3339(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0);
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = n => String(Math.abs(n)).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:00${sign}${p(Math.trunc(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
function untilUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// build event payloads for a med
function eventsFor(med) {
  const lead = +settings.reminderLead || 0;
  const reminders = { useDefault: false, overrides: [{ method: "popup", minutes: lead }] };
  const evts = [];
  if (med.type === "fixed") {
    for (const t of med.times) {
      const rule = med.endless ? "RRULE:FREQ=DAILY"
        : `RRULE:FREQ=DAILY;UNTIL=${untilUTC(med.endDate)}`;
      evts.push(baseEvent(med, med.dose, med.startDate, t, [rule], reminders));
    }
  } else if (med.type === "interval") {
    // one single (non-recurring) event per dose date per time
    for (const d of intervalDoseDates(med)) {
      for (const t of med.times) {
        evts.push(baseEvent(med, med.dose, d, t, undefined, reminders));
      }
    }
  } else {
    let cursor = med.startDate;
    for (const st of med.stages) {
      const days = +st.days || 0; if (!days) continue;
      for (const t of med.times) {
        evts.push(baseEvent(med, st.dose, cursor, t, [`RRULE:FREQ=DAILY;COUNT=${days}`], reminders));
      }
      cursor = addDays(cursor, days);
    }
  }
  return evts;
}
function baseEvent(med, dose, dateStr, time, recurrence, reminders) {
  const ev = {
    summary: `💊 ${med.name}${dose ? " — " + dose : ""}`,
    description: (med.notes ? med.notes + "\n\n" : "") + "Scheduled with Taper.",
    start: { dateTime: rfc3339(dateStr, time), timeZone: TZ },
    end: { dateTime: rfc3339(dateStr, time), timeZone: TZ },
    reminders,
    transparency: "transparent",
    colorId: "7",
    extendedProperties: { private: { taperApp: "1", taperMed: med.id } }
  };
  if (recurrence) ev.recurrence = recurrence;
  return ev;
}

async function syncMed(med) {
  if (!gcalToken) return;
  try {
    toast("Syncing to calendar…");
    await flushPendingDeletes();
    const failed = await deleteMedEvents(med);   // clear old events first
    if (failed.length) queueDeletes(failed);
    const ids = [];
    for (const ev of eventsFor(med)) {
      const created = await gcal("/calendars/primary/events", "POST", ev);
      if (created?.id) ids.push(created.id);
    }
    med.calEventIds = ids; save();
    toast(`Synced ${ids.length} reminder${ids.length === 1 ? "" : "s"} to calendar.`, "ok");
  } catch (e) {
    if (e.message === "auth") { updateSyncPill(); ensureToken(() => syncMed(med)); }
    else toast("Calendar sync failed.", "err");
  }
}

// delete one event; treat already-gone (404/410) as success
async function deleteEvent(id) {
  try { await gcal("/calendars/primary/events/" + id, "DELETE"); return "ok"; }
  catch (e) {
    if (e.message === "auth") return "auth";
    if (e.message === "gcal 404" || e.message === "gcal 410") return "gone";
    return "fail";
  }
}
async function deleteIds(ids) {
  const arr = [...new Set(ids)].filter(Boolean), failed = [];
  for (let i = 0; i < arr.length; i++) {
    const r = await deleteEvent(arr[i]);
    if (r === "ok" || r === "gone") continue;
    if (r === "auth") { failed.push(...arr.slice(i)); break; }
    failed.push(arr[i]);
  }
  return failed;
}
// list event IDs matching a query param (handles recurring masters + pagination)
async function listEventIds(paramStr) {
  const ids = []; let pageToken;
  do {
    const q = `/calendars/primary/events?${paramStr}&showDeleted=false&singleEvents=false&maxResults=250`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const data = await gcal(q);
    (data.items || []).forEach(it => it.id && ids.push(it.id));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

// Remove every calendar event for a med — found by tag AND by stored IDs, so
// nothing is missed even if a previous sync was interrupted. Returns failed IDs.
async function deleteMedEvents(med) {
  let ids = (med.calEventIds || []).slice();
  try {
    const tagged = await listEventIds(`privateExtendedProperty=${encodeURIComponent("taperMed=" + med.id)}`);
    ids = [...new Set([...ids, ...tagged])];
  } catch (e) { if (e.message === "auth") throw e; }  // fall back to stored IDs
  med.calEventIds = []; save();
  return deleteIds(ids);
}

async function syncAll() {
  if (!gcalToken) return ensureToken(syncAll);
  for (const med of meds) await syncMed(med);
}

// Thorough cleanup: tagged events, older untagged ones (by text), tracked IDs, and the queue.
async function purgeAllTaperEvents() {
  if (!gcalToken) return ensureToken(purgeAllTaperEvents);
  try {
    toast("Finding Taper events…");
    const ids = new Set();
    try { (await listEventIds(`privateExtendedProperty=${encodeURIComponent("taperApp=1")}`)).forEach(i => ids.add(i)); }
    catch (e) { if (e.message === "auth") throw e; }
    try { (await listEventIds(`q=${encodeURIComponent("Scheduled with Taper")}`)).forEach(i => ids.add(i)); }
    catch (e) { if (e.message === "auth") throw e; }
    pendingDeletes.forEach(i => ids.add(i));
    meds.forEach(m => (m.calEventIds || []).forEach(i => ids.add(i)));
    if (!ids.size) { toast("No Taper events found in your calendar.", "ok"); return; }
    const failed = await deleteIds([...ids]);
    meds.forEach(m => { m.calEventIds = []; });
    pendingDeletes = failed; store.set("pendingDeletes", pendingDeletes); save();
    const removed = ids.size - failed.length;
    toast(failed.length ? `Removed ${removed}; ${failed.length} will retry on next sign-in.` : `Removed ${removed} event${removed === 1 ? "" : "s"}.`, failed.length ? "" : "ok");
  } catch (e) {
    if (e.message === "auth") { updateSyncPill(); ensureToken(purgeAllTaperEvents); }
    else toast("Couldn't reach Google Calendar.", "err");
  }
}

/* =====================================================================
   SETTINGS WIRING + EXPORT/IMPORT
   ===================================================================== */
function wireSettings() {
  $("#tglNotify").onclick = () => settings.notify ? (settings.notify = false, save(), renderSettings(), scheduleNotifications()) : enableNotify();

  $("#tglCalendar").onclick = () => {
    settings.calendarSync = !settings.calendarSync;
    save(); renderSettings();
    if (settings.calendarSync) toast("Add your Client ID, then connect.", "");
  };
  $("#clientId").onchange = e => { settings.clientId = e.target.value.trim(); tokenClient = null; clearStoredToken(); save(); updateSyncPill(); };
  $("#reminderLead").onchange = e => { settings.reminderLead = +e.target.value; save(); };
  $("#btnConnect").onclick = () => ensureToken(() => { if (meds.length && confirm("Sync your medicines to Google Calendar now?")) syncAll(); });
  $("#btnPurge").onclick = () => {
    if (!confirm("Remove every event Taper created from your Google Calendar? Your medicines stay in the app.")) return;
    ensureToken(purgeAllTaperEvents);
  };
  $("#syncPill").onclick = () => { switchView("settings"); if (settings.calendarSync && !gcalToken) ensureToken(); };
  $("#setupHelp").onclick = (e) => { e.preventDefault(); showSetupHelp(); };

  $("#btnExport").onclick = exportData;
  $("#btnImport").onclick = () => $("#importFile").click();
  $("#importFile").onchange = importData;
  $("#btnReset").onclick = () => {
    if (!confirm("Erase all medicines and logs from this device? Calendar events stay unless removed separately.")) return;
    meds = []; logs = {}; store.del("meds"); store.del("logs"); save(); renderAll(); toast("All data erased.");
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify({ meds, logs, settings: { reminderLead: settings.reminderLead }, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `taper-backup-${ymd(new Date())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Backup downloaded.", "ok");
}
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.meds)) throw 0;
      meds = data.meds; logs = data.logs || {};
      meds.forEach(m => { if (!m.calEventIds) m.calEventIds = []; });
      save(); renderAll(); toast("Data imported.", "ok");
    } catch { toast("That file could not be read.", "err"); }
    e.target.value = "";
  };
  r.readAsText(file);
}

function showSetupHelp() {
  alert(
    "Connect Google Calendar (one-time, ~3 min):\n\n" +
    "1. Go to console.cloud.google.com and create a project.\n" +
    "2. APIs & Services → Library → enable “Google Calendar API”.\n" +
    "3. APIs & Services → OAuth consent screen → External → add yourself as a Test user.\n" +
    "4. Credentials → Create credentials → OAuth client ID → Web application.\n" +
    "5. Under “Authorized JavaScript origins” add the exact URL this app runs at\n" +
    "   (e.g. https://yourname.github.io ).\n" +
    "6. Copy the Client ID (ends with .apps.googleusercontent.com) and paste it here.\n\n" +
    "Full steps are in the README."
  );
}

/* =====================================================================
   NAV + BOOT
   ===================================================================== */
function switchView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  $$(".tab[data-view]").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "today") { selectedDate = ymd(new Date()); renderToday(); }
}

function boot() {
  if (!store.persistent) toast("Private mode: data won't be saved after you close this.", "err");
  loadStoredToken();   // reuse a still-valid token so reopening needs no sign-in
  $$(".tab[data-view]").forEach(t => t.onclick = () => switchView(t.dataset.view));
  $("#tabAdd").onclick = () => openSheet();
  $("#scrim").onclick = closeSheet;
  wireSettings();
  renderAll();

  // service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Prepare the Google client but DO NOT prompt on launch — auth happens lazily
  // only when the user actually adds or changes a medicine, or taps the sync pill.
  window.addEventListener("load", () => {
    if (settings.calendarSync && settings.clientId) setTimeout(initTokenClient, 600);
  });
  // re-evaluate due/overdue + notifications every minute
  setInterval(() => { if ($("#view-today").classList.contains("active")) renderToday(); }, 60000);
}

document.addEventListener("DOMContentLoaded", boot);