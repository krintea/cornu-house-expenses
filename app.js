"use strict";
/* Cheltuieli construcție casă — app logic (schema v2). */

// ---------- Constants ----------
const STORAGE_KEY = "cornu-house-expenses-v1";
const FIRST_RUN_KEY = "cornu-house-expenses-first-run-v1";
const BACKUP_KEY = "cornu-house-expenses-backup-v1";
const SCHEMA_VERSION = 2;
const DEFAULT_RATE = 5.2776;
const DEFAULT_REPORT_TITLE = "Situație plăți construcție casă";
const DEFAULT_REPORT_SUBTITLE = "Raport complet al plăților înregistrate";
const LEGACY_REPORT_TITLES = ["Situatie Plati Constructie Casa"];
const LEGACY_REPORT_SUBTITLES = ["Raport complet al platilor inregistrate"];
const LEGACY_UNSPECIFIED = ["Descriere nespecificata", "Descriere nespecificată"];
const UNSPECIFIED = "Descriere nespecificată";
const NO_SUBCATEGORY = "Fără subcategorie";
const RATE_MODES = { reference: "Curs de referință unic", payment: "Curs per plată" };
const BACKUP_WARN_DAYS = 3, BACKUP_WARN_CHANGES = 10;

const DRIVE_CLIENT_ID = "747739289103-ue9lu57vkjs2vl632q7865njklo3nkm2.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE = "cornu-house-expenses.json";
const DRIVE_KEEP = 5; // max copies kept in the app folder (older legacy copies are pruned)

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const moneyFmt = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 0 });
const rateFmt = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const monthFmt = new Intl.DateTimeFormat("ro-RO", { month: "short", year: "numeric", timeZone: "UTC" });

function uid(p = "id") { return window.crypto && crypto.randomUUID ? `${p}-${crypto.randomUUID()}` : `${p}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function nowIso() { return new Date().toISOString(); }
function todayLocal() { const d = new Date(), o = d.getTimezoneOffset(); return new Date(d.getTime() - o * 60000).toISOString().slice(0, 10); }
function formatDate(s) { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}.${m}.${y}`; }
function formatRON(v) { return `${moneyFmt.format(Number(v || 0))} RON`; }
function formatEUR(v) { return `${moneyFmt.format(Number(v || 0))} EUR`; }
function formatRONShort(v) { return `${wholeFmt.format(Number(v || 0))} RON`; }
function formatOriginal(p) { return p.originalCurrency === "EUR" ? formatEUR(p.originalAmount) : formatRON(p.originalAmount); }
function roundMoney(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
const h = escapeHtml;
function ascii(s) { return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[șş]/g, "s").replace(/[ȘŞ]/g, "S").replace(/[țţ]/g, "t").replace(/[ȚŢ]/g, "T").replace(/[–—]/g, "-").replace(/→/g, "->"); }
function plural(n, one, many) { if (n === 1) return `1 ${one}`; const r = n % 100; return n !== 0 && (r === 0 || r >= 20) ? `${n} de ${many}` : `${n} ${many}`; }
function displayDescription(p) { return p.description || UNSPECIFIED; }
function downloadBlob(b, n) { const u = URL.createObjectURL(b), a = document.createElement("a"); a.href = u; a.download = n; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
function convert(amount, currency, rate) { return currency === "EUR" ? { ron: amount * rate, eur: amount } : { ron: amount, eur: amount / rate }; }
function rateSourceLabel(src) {
  if (src === "BNR") return "BNR";
  if (src === "ECB" || src === "Frankfurter / ECB") return "BCE (prin Frankfurter)";
  return "introdus manual";
}

function toast(message, { actionLabel, onAction, timeout } = {}) {
  const e = document.createElement("div");
  e.className = "toast";
  const span = document.createElement("span"); span.textContent = message; e.appendChild(span);
  let timer;
  if (actionLabel && onAction) {
    e.classList.add("has-undo");
    const b = document.createElement("button"); b.type = "button"; b.textContent = actionLabel;
    b.addEventListener("click", () => { clearTimeout(timer); e.remove(); onAction(); });
    e.appendChild(b);
  }
  $("toastWrap").appendChild(e);
  timer = setTimeout(() => e.remove(), timeout || (actionLabel ? 7000 : 3000));
}

// ---------- State, validation & migration ----------
function createEmptyState() {
  return { version: SCHEMA_VERSION, categories: [], payments: [], settings: { referenceRate: DEFAULT_RATE, reportTitle: DEFAULT_REPORT_TITLE, reportSubtitle: DEFAULT_REPORT_SUBTITLE, rateMode: "reference" } };
}
function str(v, max = 500) { return v == null ? "" : String(v).trim().slice(0, max); }
function num(v) { if (v === null || v === "" || v === undefined) return NaN; const n = Number(v); return Number.isFinite(n) ? n : NaN; }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates and normalizes any incoming state (localStorage, JSON import, Drive). Throws a readable error. */
function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.categories) || !Array.isArray(raw.payments)) throw new Error("Fișierul nu are structura unui backup (lipsesc categoriile sau plățile).");
  const catIds = new Set();
  const categories = raw.categories.map((c, i) => {
    const where = `Categoria ${i + 1}`;
    if (!c || typeof c !== "object") throw new Error(`${where} este invalidă.`);
    const id = str(c.id, 100), name = str(c.name, 120);
    if (!id || !name) throw new Error(`${where}: lipsește id-ul sau numele.`);
    if (catIds.has(id)) throw new Error(`${where}: id duplicat.`);
    catIds.add(id);
    const subIds = new Set();
    const subcategories = (Array.isArray(c.subcategories) ? c.subcategories : []).map((s, j) => {
      const sid = str(s && s.id, 100), sn = str(s && s.name, 120);
      if (!sid || !sn || subIds.has(sid)) throw new Error(`Subcategoria ${j + 1} din „${name}” este invalidă.`);
      subIds.add(sid);
      return { id: sid, name: sn };
    });
    const b = num(c.budget), so = num(c.sortOrder);
    return { id, name, sortOrder: Number.isFinite(so) ? so : i + 1, budget: b > 0 ? roundMoney(b) : null, subcategories };
  });
  const catMap = new Map(categories.map(c => [c.id, c]));
  const payIds = new Set();
  const payments = raw.payments.map((p, i) => {
    const where = `Plata ${i + 1}`;
    if (!p || typeof p !== "object") throw new Error(`${where} este invalidă.`);
    let id = str(p.id, 100); if (!id || payIds.has(id)) id = uid("pay"); payIds.add(id);
    const date = str(p.date, 10);
    if (!ISO_DATE.test(date) || isNaN(Date.parse(date))) throw new Error(`${where}: dată invalidă.`);
    const beneficiary = str(p.beneficiary, 200);
    if (!beneficiary) throw new Error(`${where}: lipsește beneficiarul.`);
    const cat = catMap.get(str(p.categoryId, 100));
    if (!cat) throw new Error(`${where}: categoria nu există.`);
    const subcategoryId = p.subcategoryId && cat.subcategories.some(s => s.id === p.subcategoryId) ? p.subcategoryId : null;
    const originalCurrency = p.originalCurrency === "EUR" ? "EUR" : p.originalCurrency === "RON" ? "RON" : null;
    if (!originalCurrency) throw new Error(`${where}: monedă necunoscută.`);
    const originalAmount = num(p.originalAmount);
    if (!(originalAmount > 0)) throw new Error(`${where}: sumă invalidă.`);
    const exchangeRate = num(p.exchangeRate);
    if (!(exchangeRate > 0)) throw new Error(`${where}: curs invalid.`);
    let description = str(p.description, 500);
    if (LEGACY_UNSPECIFIED.includes(description)) description = "";
    const { ron, eur } = convert(originalAmount, originalCurrency, exchangeRate);
    const t = nowIso();
    return {
      id, date, beneficiary, description, categoryId: cat.id, subcategoryId,
      originalAmount, originalCurrency, exchangeRate, amountRON: ron, amountEUR: eur,
      invoiceNumber: str(p.invoiceNumber, 100), notes: str(p.notes, 2000),
      rateSource: str(p.rateSource, 60) || "manual", rateDate: ISO_DATE.test(p.rateDate || "") ? p.rateDate : "",
      createdAt: str(p.createdAt, 40) || t, updatedAt: str(p.updatedAt, 40) || t
    };
  });
  const s = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const rr = num(s.referenceRate);
  let reportTitle = str(s.reportTitle, 200), reportSubtitle = str(s.reportSubtitle, 200);
  if (!reportTitle || LEGACY_REPORT_TITLES.includes(reportTitle)) reportTitle = DEFAULT_REPORT_TITLE;
  if (!reportSubtitle || LEGACY_REPORT_SUBTITLES.includes(reportSubtitle)) reportSubtitle = DEFAULT_REPORT_SUBTITLE;
  return { version: SCHEMA_VERSION, categories, payments, settings: { referenceRate: rr > 0 ? rr : DEFAULT_RATE, reportTitle, reportSubtitle, rateMode: s.rateMode === "payment" ? "payment" : "reference" } };
}

let loadProblem = "";
function loadState() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { loadProblem = "Browserul nu permite salvarea locală. Datele nu vor fi păstrate."; return createEmptyState(); }
  if (!raw) return createEmptyState();
  try { return sanitizeState(JSON.parse(raw)); }
  catch (e) {
    // Never silently discard: keep the unreadable copy aside.
    const key = `${STORAGE_KEY}-recuperare-${Date.now()}`;
    try { localStorage.setItem(key, raw); } catch {}
    loadProblem = `Datele locale nu au putut fi citite (${e.message}). O copie a fost păstrată în browser sub cheia „${key}”. Încarcă un backup din Setări.`;
    return createEmptyState();
  }
}

function getBackupMeta() { try { return { at: null, changes: 0, kind: "", ...JSON.parse(localStorage.getItem(BACKUP_KEY) || "{}") }; } catch { return { at: null, changes: 0, kind: "" }; } }
function setBackupMeta(m) { try { localStorage.setItem(BACKUP_KEY, JSON.stringify(m)); } catch {} }
function markBackup(kind) { setBackupMeta({ at: nowIso(), changes: 0, kind }); }

function saveState({ countAsChange = true } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (countAsChange) { const m = getBackupMeta(); m.changes = (m.changes || 0) + 1; setBackupMeta(m); scheduleAutoSync(); }
    return true;
  } catch {
    toast("Nu s-a putut salva în browser (spațiu plin sau stocare blocată). Fă un backup acum.");
    return false;
  }
}

/** Run a mutation, save, re-render; optionally offer Undo. */
function commit(mutator, message, { undo = false } = {}) {
  const snapshot = JSON.stringify(state);
  // Only the latest action can be undone: older undo snapshots would roll back newer changes.
  document.querySelectorAll(".toast.has-undo").forEach(t => t.remove());
  mutator();
  saveState();
  renderAll();
  if (!message) return;
  if (undo) toast(message, { actionLabel: "Anulează", onAction: () => { state = JSON.parse(snapshot); saveState(); renderAll(); toast("Acțiunea a fost anulată."); } });
  else toast(message);
}

let state = loadState();
let currentPage = "dashboard";
const filters = { search: "", dateFrom: "", dateTo: "", currency: "ALL", sort: "dateDesc" };

// ---------- Sample data ----------
const SAMPLE_ROWS = [["Fundație", "Furnizor exemplu", "Materiale", 500, 12000], ["Proiect general", "Proiectant exemplu", "Proiectare", 1000, 800], ["Structură lemn", "Furnizor exemplu", "Structură", 2000, 45000]];
function buildSampleState() {
  const s = createEmptyState(), t = nowIso();
  s.categories = SAMPLE_ROWS.map(([name, , , , budget], i) => ({ id: uid("cat"), name, sortOrder: i + 1, budget, subcategories: [] }));
  s.payments = SAMPLE_ROWS.map(([, b, d, a], i) => ({ id: uid("pay"), date: `2026-0${i + 1}-15`, beneficiary: b, description: d, categoryId: s.categories[i].id, subcategoryId: null, originalAmount: a, originalCurrency: "RON", exchangeRate: DEFAULT_RATE, amountRON: a, amountEUR: a / DEFAULT_RATE, invoiceNumber: "", notes: "", rateSource: "manual", rateDate: "", createdAt: t, updatedAt: t }));
  return s;
}
function loadSampleData() {
  commit(() => { state = buildSampleState(); }, "Datele exemplu au fost încărcate.", { undo: true });
  localStorage.setItem(FIRST_RUN_KEY, "1");
}

// ---------- Domain helpers ----------
function getSortedCategories() { return [...state.categories].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name, "ro")); }
function getCategory(id) { return state.categories.find(c => c.id === id); }
function getSubcategory(cid, sid) { if (!sid) return null; return getCategory(cid)?.subcategories?.find(s => s.id === sid) || null; }
function amountsFor(p, mode = state.settings.rateMode) {
  if (mode === "payment") return { ron: Number(p.amountRON), eur: Number(p.amountEUR) };
  return convert(Number(p.originalAmount), p.originalCurrency, Number(state.settings.referenceRate));
}
function totalsFor(ps, mode = state.settings.rateMode) { return ps.reduce((a, p) => { const x = amountsFor(p, mode); a.ron += x.ron; a.eur += x.eur; return a; }, { ron: 0, eur: 0 }); }
function categoryStats(ps, mode = state.settings.rateMode) {
  return getSortedCategories().map(c => {
    const list = ps.filter(p => p.categoryId === c.id), t = totalsFor(list, mode);
    return { c, count: list.length, ron: t.ron, eur: t.eur, budget: c.budget, remaining: c.budget ? c.budget - t.ron : null };
  });
}
function budgetTotals(stats) {
  const withBudget = stats.filter(s => s.budget);
  const budget = withBudget.reduce((a, s) => a + s.budget, 0), spent = withBudget.reduce((a, s) => a + s.ron, 0);
  return { budget, spent, remaining: budget - spent, over: withBudget.filter(s => s.ron > s.budget).length, count: withBudget.length };
}

// ---------- Backup health ----------
function daysSince(iso) { return Math.floor((Date.now() - Date.parse(iso)) / 86400000); }
function relativeDay(iso) { const d = daysSince(iso); return d <= 0 ? "azi" : d === 1 ? "ieri" : `acum ${plural(d, "zi", "zile")}`; }
function backupHealth() {
  const m = getBackupMeta();
  if (!state.payments.length && !m.at) return { level: "none", text: "" };
  const kind = m.kind === "drive" ? "Google Drive" : m.kind === "file" ? "fișier JSON" : "";
  if (!m.at) return { level: "warn", text: "Nu ai încă niciun backup. Datele sunt salvate doar în acest browser și se pot pierde (ex. iPhone le poate șterge după câteva zile fără vizite)." };
  const changes = m.changes ? ` · ${plural(m.changes, "modificare", "modificări")} de atunci` : "";
  const text = `Ultimul backup: ${relativeDay(m.at)}${kind ? ` (${kind})` : ""}${changes}.`;
  return { level: daysSince(m.at) >= BACKUP_WARN_DAYS && m.changes || m.changes >= BACKUP_WARN_CHANGES ? "warn" : "ok", text };
}
function renderBackupBanners() {
  const b = backupHealth();
  const problem = loadProblem ? `<div class="danger-note" style="margin-bottom:12px">${h(loadProblem)}</div>` : "";
  let html = "";
  if (b.level === "warn" && !getSync().enabled) html = `<div class="warning backup-banner"><span>${h(b.text)}</span><div class="actions"><button class="btn btn-small" data-action="drive-save">Salvează în Drive</button><button class="btn btn-small" data-action="export-json">Export JSON</button></div></div>`;
  else if (b.level === "ok") html = `<p class="backup-ok">${h(b.text)}</p>`;
  $("dashBackup").innerHTML = problem + html;
  $("settingsBackupStatus").innerHTML = (problem) + (b.text ? `<span class="${b.level === "warn" ? "neg" : ""}">${h(b.text)}</span>` : "Nu există încă date de salvat.");
}

// ---------- Rendering ----------
function renderNav() {
  const pages = [["dashboard", "Dashboard"], ["payments", "Plăți"], ["categories", "Categorii"], ["settings", "Setări"]];
  $("nav").innerHTML = pages.map(([id, l]) => `<button data-page="${id}" class="${currentPage === id ? "active" : ""}"${currentPage === id ? ' aria-current="page"' : ""}>${h(l)}</button>`).join("");
}
function renderRateModeOptions() {
  const o = Object.entries(RATE_MODES).map(([v, l]) => `<option value="${v}">${h(l)}</option>`).join("");
  ["globalRateMode", "settingsRateMode", "pdfRateMode"].forEach(id => { $(id).innerHTML = o; $(id).value = state.settings.rateMode; });
}

function barRow(label, widthPct, cls, value, title = "") {
  return `<div class="bar-row"${title ? ` title="${h(title)}"` : ""}><div class="bar-label">${h(label)}</div><div class="bar-track"><div class="bar-fill ${cls}" style="width:${widthPct > 0 ? Math.max(1, Math.min(100, widthPct)).toFixed(1) : 0}%"></div></div><div class="bar-value">${h(value)}</div></div>`;
}

function renderDashboard() {
  const all = state.payments, t = totalsFor(all), stats = categoryStats(all), bt = budgetTotals(stats);
  const budgetCard = bt.budget
    ? `<div class="stat"><div class="stat-label">Buget total</div><div class="stat-value">${formatRON(bt.budget)}</div><div class="stat-sub">${Math.round(bt.spent / bt.budget * 100)}% folosit · ${plural(bt.count, "categorie", "categorii")} cu buget</div></div>
       <div class="stat"><div class="stat-label">Rămas din buget</div><div class="stat-value ${bt.remaining < 0 ? "neg" : ""}">${formatRON(bt.remaining)}</div><div class="stat-sub ${bt.over ? "neg" : ""}">${bt.over ? `${plural(bt.over, "categorie depășită", "categorii depășite")}` : "Nicio categorie depășită"}</div></div>`
    : `<div class="stat"><div class="stat-label">Buget total</div><div class="stat-value">Nesetat</div><div class="stat-sub">Setează bugete în <a href="#" data-page="categories">Categorii</a></div></div>
       <div class="stat"><div class="stat-label">Rămas din buget</div><div class="stat-value">—</div><div class="stat-sub">Apare după ce setezi bugete</div></div>`;
  $("stats").innerHTML = `<div class="stat"><div class="stat-label">Total cheltuit</div><div class="stat-value">${formatRON(t.ron)}</div><div class="stat-sub">≈ ${formatEUR(t.eur)} · ${h(RATE_MODES[state.settings.rateMode])}</div></div>${budgetCard}<div class="stat"><div class="stat-label">Plăți</div><div class="stat-value">${all.length}</div><div class="stat-sub">${plural(stats.length, "categorie", "categorii")}</div></div>`;

  const rows = stats.map(s => `<tr><td>${h(s.c.name)}</td><td class="num">${s.count}</td><td class="num">${formatRON(s.ron)}</td><td class="num">${formatEUR(s.eur)}</td><td class="num">${s.budget ? formatRON(s.budget) : "—"}</td><td class="num ${s.remaining < 0 ? "neg" : ""}">${s.budget ? formatRON(s.remaining) : "—"}</td></tr>`).join("");
  $("summaryTable").innerHTML = `<thead><tr><th>Categorie</th><th class="num">Plăți</th><th class="num">Cheltuit RON</th><th class="num">EUR aprox.</th><th class="num">Buget</th><th class="num">Rămas</th></tr></thead><tbody>${rows || `<tr><td colspan="6">Nu există date de afișat.</td></tr>`}<tr class="total-row"><td>TOTAL GENERAL</td><td class="num">${all.length}</td><td class="num">${formatRON(t.ron)}</td><td class="num">${formatEUR(t.eur)}</td><td class="num">${bt.budget ? formatRON(bt.budget) : "—"}</td><td class="num ${bt.remaining < 0 ? "neg" : ""}">${bt.budget ? formatRON(bt.remaining) : "—"}</td></tr></tbody>`;

  const maxNoBudget = Math.max(1, ...stats.filter(s => !s.budget).map(s => s.ron));
  $("categoryChart").innerHTML = stats.length ? stats.map(s => {
    if (s.budget) { const pct = s.ron / s.budget * 100; return barRow(s.c.name, pct, pct > 100 ? "over" : "", `${formatRONShort(s.ron)} · ${Math.round(pct)}%`, `${formatRON(s.ron)} din ${formatRON(s.budget)}`); }
    return barRow(s.c.name, s.ron / maxNoBudget * 100, "nobudget", formatRONShort(s.ron), "Fără buget setat");
  }).join("") : `<div class="empty">Nu există date de afișat.</div>`;
  $("categoryChartLegend").textContent = stats.length ? (bt.count ? "Bara arată cât din bugetul categoriei a fost folosit; roșu = depășit. Categoriile fără buget (gri) sunt comparate între ele." : "Nicio categorie nu are buget. Barele gri compară categoriile între ele.") : "";

  const byMonth = new Map();
  all.forEach(p => { const k = p.date.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + amountsFor(p).ron); });
  const months = [];
  if (byMonth.size) {
    const keys = [...byMonth.keys()].sort(), last = keys[keys.length - 1] > todayLocal().slice(0, 7) ? keys[keys.length - 1] : todayLocal().slice(0, 7);
    let [y, m] = last.split("-").map(Number);
    for (let i = 0; i < 12; i++) { const k = `${y}-${String(m).padStart(2, "0")}`; months.unshift(k); if (k <= keys[0]) break; m--; if (!m) { m = 12; y--; } }
  }
  const maxM = Math.max(1, ...months.map(k => byMonth.get(k) || 0));
  $("monthlyChart").innerHTML = months.length ? months.map(k => barRow(monthFmt.format(new Date(`${k}-01T00:00:00Z`)), (byMonth.get(k) || 0) / maxM * 100, "", formatRONShort(byMonth.get(k) || 0))).join("") + (byMonth.size > months.length || [...byMonth.keys()].some(k => k < months[0]) ? `<div class="chart-legend">Sunt afișate ultimele 12 luni.</div>` : "") : `<div class="empty">Nu există date de afișat.</div>`;
}

function filtersActive() { return !!(filters.search.trim() || filters.dateFrom || filters.dateTo || filters.currency !== "ALL"); }
function filteredPayments() {
  let a = [...state.payments];
  const q = filters.search.trim().toLocaleLowerCase("ro");
  if (q) a = a.filter(p => {
    const c = getCategory(p.categoryId), s = getSubcategory(p.categoryId, p.subcategoryId);
    return [p.beneficiary, p.description, p.invoiceNumber, p.notes, c?.name, s?.name].join(" ").toLocaleLowerCase("ro").includes(q);
  });
  if (filters.dateFrom) a = a.filter(p => p.date >= filters.dateFrom);
  if (filters.dateTo) a = a.filter(p => p.date <= filters.dateTo);
  if (filters.currency !== "ALL") a = a.filter(p => p.originalCurrency === filters.currency);
  const v = p => amountsFor(p).ron;
  const sorters = { dateAsc: (x, y) => x.date.localeCompare(y.date), dateDesc: (x, y) => y.date.localeCompare(x.date), amountAsc: (x, y) => v(x) - v(y), amountDesc: (x, y) => v(y) - v(x), beneficiaryAsc: (x, y) => x.beneficiary.localeCompare(y.beneficiary, "ro") };
  return a.sort(sorters[filters.sort] || sorters.dateDesc);
}

function paymentRowHtml(p) {
  const a = amountsFor(p);
  return `<tr><td data-label="Data:">${formatDate(p.date)}</td><td data-label="Beneficiar:"><strong>${h(p.beneficiary)}</strong>${p.invoiceNumber ? `<div class="muted" style="font-size:12px">Factura ${h(p.invoiceNumber)}</div>` : ""}</td><td data-label="Descriere:">${h(displayDescription(p))}</td><td class="num" data-label="RON:">${formatRON(a.ron)}</td><td class="num" data-label="EUR:">${formatEUR(a.eur)}</td><td data-label="Original:"><span class="badge ${p.originalCurrency === "RON" ? "badge-ron" : "badge-eur"}">${formatOriginal(p)}</span></td><td class="action-cell"><button class="btn btn-small" data-edit-payment="${h(p.id)}">Editează</button> <button class="btn btn-small btn-danger" data-delete-payment="${h(p.id)}">Șterge</button></td></tr>`;
}
function subtotalRow(label, ps) { const t = totalsFor(ps); return `<tr class="subtotal-row"><td colspan="3">${h(label)} (${ps.length})</td><td class="num" data-label="RON:">${formatRON(t.ron)}</td><td class="num" data-label="EUR:">${formatEUR(t.eur)}</td><td colspan="2"></td></tr>`; }
function paymentTableHtml(ps, extra = "") { return `<div class="table-wrap"><table class="payment-table"><thead><tr><th>Data</th><th>Beneficiar</th><th>Descriere</th><th class="num">RON</th><th class="num">EUR aprox.</th><th>Original</th><th>Acțiuni</th></tr></thead><tbody>${ps.map(paymentRowHtml).join("")}${extra}</tbody></table></div>`; }

function renderPayments() {
  const expanded = new Set(Array.from($("paymentsGroups").querySelectorAll("details[open]"), d => d.dataset.category));
  $("filterSearch").value = filters.search; $("filterDateFrom").value = filters.dateFrom; $("filterDateTo").value = filters.dateTo; $("filterCurrency").value = filters.currency; $("filterSort").value = filters.sort;
  const badRange = filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo;
  $("filterWarning").textContent = badRange ? "Data de început este după data de sfârșit." : "";
  $("filterWarning").classList.toggle("hidden", !badRange);
  const visible = filteredPayments(), active = filtersActive();
  const cats = getSortedCategories();
  const groups = cats.map(c => {
    const ps = visible.filter(p => p.categoryId === c.id);
    if (active && !ps.length) return "";
    const ct = totalsFor(ps);
    let body;
    if (!ps.length) body = `<div class="empty" style="margin:14px">Această categorie nu are încă plăți.</div>`;
    else if (c.subcategories?.length) {
      const gs = [...c.subcategories.map(s => ({ name: s.name, ps: ps.filter(p => p.subcategoryId === s.id) })), { name: NO_SUBCATEGORY, ps: ps.filter(p => !p.subcategoryId) }].filter(g => g.ps.length);
      body = gs.map(g => `<div style="padding:12px 12px 0;font-weight:850;color:var(--primary)">${h(g.name)}</div>${paymentTableHtml(g.ps, subtotalRow(`Subtotal ${g.name}`, g.ps))}`).join("");
      body += `<div style="padding:12px 14px;background:var(--greenSoft);font-weight:850;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><span>Subtotal ${h(c.name)}</span><span>${formatRON(ct.ron)} | ${formatEUR(ct.eur)}</span></div>`;
    } else body = paymentTableHtml(ps, subtotalRow(`Subtotal ${c.name}`, ps));
    const open = expanded.has(c.id) || (active && ps.length) ? "open" : "";
    return `<details class="category-block" data-category="${h(c.id)}" ${open}><summary><span class="ledger-name">${h(c.name)}</span><span class="ledger-count">${ps.length}<span class="ledger-unit"> ${ps.length === 1 ? "plată" : "plăți"}</span></span><strong class="ledger-ron">${formatRON(ct.ron)}</strong><span class="ledger-eur">${formatEUR(ct.eur)}</span></summary>${body}</details>`;
  }).join("");
  if (!cats.length) $("paymentsGroups").innerHTML = `<div class="empty">Nu există categorii. Adaugă una din pagina Categorii.</div>`;
  else if (!groups) $("paymentsGroups").innerHTML = `<div class="empty filter-empty"><span>Nicio plată nu corespunde filtrelor.</span><button class="btn btn-small" data-action="reset-filters">Resetează filtrele</button></div>`;
  else $("paymentsGroups").innerHTML = groups;
}

function renderCategories() {
  const expanded = new Set(Array.from($("categoryManageList").querySelectorAll("details[open]"), d => d.dataset.category));
  const cats = getSortedCategories(), stats = new Map(categoryStats(state.payments).map(s => [s.c.id, s]));
  $("categoryManageList").innerHTML = cats.length ? cats.map((c, i) => {
    const st = stats.get(c.id), subs = c.subcategories || [];
    const budgetText = c.budget ? ` · buget ${formatRONShort(c.budget)}${st.remaining < 0 ? " (depășit)" : ""}` : " · fără buget";
    return `<details class="manage-card" data-category="${h(c.id)}" ${expanded.has(c.id) ? "open" : ""}><summary class="manage-summary"><span class="manage-name">${h(c.name)}</span><span class="summary-meta ${st.remaining < 0 ? "neg" : ""}">${plural(st.count, "plată", "plăți")}${h(budgetText)}</span></summary>
<div class="manage-head"><div class="actions"><button class="btn btn-small" data-cat-up="${h(c.id)}" ${i === 0 ? "disabled" : ""} aria-label="Mută ${h(c.name)} mai sus">Sus</button><button class="btn btn-small" data-cat-down="${h(c.id)}" ${i === cats.length - 1 ? "disabled" : ""} aria-label="Mută ${h(c.name)} mai jos">Jos</button><button class="btn btn-small" data-cat-rename="${h(c.id)}">Redenumește</button><button class="btn btn-small" data-cat-budget="${h(c.id)}">Buget</button><button class="btn btn-small" data-sub-add="${h(c.id)}">Adaugă subcategorie</button><button class="btn btn-small btn-danger" data-cat-delete="${h(c.id)}">Șterge</button></div></div>
<div class="subcat-list"><div style="font-size:12px;font-weight:800;color:#475467">Subcategorii</div>${subs.length ? subs.map(sc => { const n = state.payments.filter(p => p.categoryId === c.id && p.subcategoryId === sc.id).length; return `<div class="subcat-item"><span>${h(sc.name)} <span class="muted">(${n})</span></span><div class="actions"><button class="btn btn-small" data-sub-rename="${h(c.id)}|${h(sc.id)}">Redenumește</button><button class="btn btn-small btn-danger" data-sub-delete="${h(c.id)}|${h(sc.id)}">Șterge</button></div></div>`; }).join("") : `<div class="muted" style="font-size:12px">Fără subcategorii</div>`}</div></details>`;
  }).join("") : `<div class="empty">Nu există categorii încă.</div>`;
}

function renderSettings() {
  $("settingsReferenceRate").value = Number(state.settings.referenceRate).toFixed(4);
  $("settingsReportTitle").value = state.settings.reportTitle;
  $("settingsReportSubtitle").value = state.settings.reportSubtitle;
}

function renderAll() { renderNav(); renderRateModeOptions(); renderBackupBanners(); renderDashboard(); renderPayments(); renderCategories(); renderSettings(); }
function showPage(p) { currentPage = p; document.querySelectorAll(".page").forEach(x => x.classList.toggle("active", x.id === `page-${p}`)); renderNav(); window.scrollTo(0, 0); }

// ---------- Generic dialog (replaces prompt/confirm) ----------
let askState = null;
function ask({ title, message = "", label = "", type = "text", value = "", options = [], okLabel = "Salvează", danger = false, required = true, validate = null }) {
  return new Promise(resolve => {
    const hasField = type !== "none", isSelect = type === "select", inp = $("askInput"), sel = $("askSelect");
    $("askTitle").textContent = title;
    $("askMessage").textContent = message; $("askMessage").classList.toggle("hidden", !message);
    $("askFieldWrap").classList.toggle("hidden", !hasField);
    $("askLabel").textContent = label; $("askLabel").htmlFor = isSelect ? "askSelect" : "askInput";
    inp.classList.toggle("hidden", isSelect); sel.classList.toggle("hidden", !isSelect);
    if (isSelect) { sel.innerHTML = options.map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join(""); sel.value = value || options[0]?.value || ""; }
    else if (hasField) {
      inp.type = type === "number" ? "number" : "text";
      if (type === "number") { inp.step = "0.01"; inp.min = "0"; inp.inputMode = "decimal"; } else { inp.removeAttribute("step"); inp.removeAttribute("min"); inp.inputMode = "text"; }
      inp.value = value ?? "";
    }
    $("askError").classList.add("hidden");
    $("askOk").textContent = okLabel; $("askOk").className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    askState = { resolve, hasField, isSelect, required, validate };
    $("askDialog").showModal();
    if (hasField) (isSelect ? sel : inp).focus(); else $("askOk").focus();
  });
}
function finishAsk(value) { const s = askState; askState = null; if ($("askDialog").open) $("askDialog").close(); s?.resolve(value); }
function submitAsk(e) {
  e.preventDefault(); if (!askState) return;
  const { hasField, isSelect, required, validate } = askState;
  const v = !hasField ? true : isSelect ? $("askSelect").value : $("askInput").value.trim();
  const err = hasField && !isSelect && required && !v ? "Câmpul este obligatoriu." : validate ? validate(v) : "";
  if (err) { $("askError").textContent = err; $("askError").classList.remove("hidden"); return; }
  finishAsk(v);
}

// ---------- Payments ----------
function renderBeneficiaryDatalist() { const n = [...new Set(state.payments.map(p => p.beneficiary.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ro")); $("beneficiaryList").innerHTML = n.map(x => `<option value="${h(x)}"></option>`).join(""); }
function renderPaymentCategoryOptions(cid = null, sid = null) { const c = getSortedCategories(); $("paymentCategory").innerHTML = c.map(x => `<option value="${h(x.id)}">${h(x.name)}</option>`).join(""); if (cid && c.some(x => x.id === cid)) $("paymentCategory").value = cid; renderPaymentSubcategoryOptions($("paymentCategory").value, sid); }
function renderPaymentSubcategoryOptions(cid, sid = null) { const s = getCategory(cid)?.subcategories || []; $("paymentSubcategory").innerHTML = `<option value="">${NO_SUBCATEGORY}</option>` + s.map(x => `<option value="${h(x.id)}">${h(x.name)}</option>`).join(""); $("paymentSubcategory").disabled = !s.length; if (sid && s.some(x => x.id === sid)) $("paymentSubcategory").value = sid; }

let rateSeq = 0, rateTouched = false;
function setRateStatus(text, withBnrLink = false) {
  $("rateStatus").innerHTML = h(text) + (withBnrLink ? ` <a href="https://www.bnr.ro/Cursurile-pietei-valutare-in-format-XML-3424.aspx" target="_blank" rel="noopener">Verifică pe bnr.ro</a>` : "");
}
function updateRateSummary() {
  const r = Number($("paymentRate").value), src = $("paymentRate").dataset.source, rd = $("paymentRate").dataset.rateDate;
  $("rateSummary").textContent = r > 0 ? `Curs EUR → RON: ${rateFmt.format(r)} · ${rateSourceLabel(src)}${rd ? ` (${formatDate(rd)})` : ""}` : "Curs EUR → RON: necompletat";
}
function syncRateBoxToCurrency() { $("rateBox").open = $("paymentCurrency").value === "EUR"; }

function openPaymentDialog(id = null) {
  if (!state.categories.length) { toast("Adaugă mai întâi o categorie."); showPage("categories"); return; }
  renderBeneficiaryDatalist();
  const p = id ? state.payments.find(x => x.id === id) : null;
  $("paymentId").value = p?.id || "";
  $("paymentDialogTitle").textContent = p ? "Editează plata" : "Adaugă plată";
  $("paymentDate").value = p?.date || todayLocal();
  $("paymentBeneficiary").value = p?.beneficiary || "";
  $("paymentDescription").value = p?.description || "";
  renderPaymentCategoryOptions(p?.categoryId || getSortedCategories()[0]?.id || null, p?.subcategoryId || null);
  $("paymentAmount").value = p ? Number(p.originalAmount).toFixed(2) : "";
  $("paymentCurrency").value = p?.originalCurrency || "RON";
  $("paymentRate").value = p ? Number(p.exchangeRate).toFixed(4) : Number(state.settings.referenceRate).toFixed(4);
  $("paymentRate").dataset.source = p?.rateSource || "manual";
  $("paymentRate").dataset.rateDate = p?.rateDate || "";
  $("paymentInvoiceNumber").value = p?.invoiceNumber || "";
  $("paymentNotes").value = p?.notes || "";
  $("paymentError").classList.add("hidden");
  resetDocUpload();
  rateTouched = false; rateSeq++;
  setRateStatus(p ? `Sursa cursului salvat: ${rateSourceLabel(p.rateSource)}${p.rateDate ? ` (${formatDate(p.rateDate)})` : ""}.` : "");
  syncRateBoxToCurrency(); updateRateSummary(); updateConversionPreview(); checkDuplicate();
  $("paymentDialog").showModal();
  $("paymentAmount").focus();
  if (!p) autoFetchRate($("paymentDate").value);
}

function updateConversionPreview() {
  const a = Number($("paymentAmount").value), c = $("paymentCurrency").value, r = Number($("paymentRate").value);
  if (!(a > 0) || !(r > 0)) { $("conversionPreview").innerHTML = `<span>Conversie</span><strong>–</strong>`; return; }
  const x = convert(a, c, r);
  $("conversionPreview").innerHTML = `<span>Conversie</span><strong>${formatRON(x.ron)} = ${formatEUR(x.eur)}</strong>`;
}
function checkDuplicate() {
  const id = $("paymentId").value, b = $("paymentBeneficiary").value.trim().toLocaleLowerCase("ro"), d = $("paymentDate").value, a = Number($("paymentAmount").value), c = $("paymentCurrency").value;
  const dup = !!(b && d && a > 0) && state.payments.some(p => p.id !== id && p.beneficiary.trim().toLocaleLowerCase("ro") === b && p.date === d && p.originalCurrency === c && Math.abs(Number(p.originalAmount) - a) < .005);
  $("duplicateWarning").classList.toggle("hidden", !dup);
}

async function fetchWithTimeout(url, ms = 5000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { cache: "no-store", signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; }
  finally { clearTimeout(t); }
}
function parseBNREurRate(xml, target) {
  const d = new DOMParser().parseFromString(xml, "application/xml");
  if (d.querySelector("parsererror")) throw new Error("BNR XML parse error");
  let best = null;
  for (const n of d.querySelectorAll("[date]")) {
    const date = n.getAttribute("date"); if (!date || date > target) continue;
    const e = [...n.querySelectorAll("Rate")].find(r => (r.getAttribute("currency") || "").toUpperCase() === "EUR");
    const v = e ? Number(String(e.textContent).replace(",", ".")) : 0;
    if (v > 0 && (!best || date > best.date)) best = { date, value: v };
  }
  return best;
}
// Note: BNR's XML usually does not allow cross-site browser requests (CORS); if it fails we fall back to ECB.
async function fetchBNRRate(date) {
  const y = Number(date.slice(0, 4)), urls = [];
  if (date >= todayLocal()) urls.push("https://www.bnr.ro/nbrfxrates.xml");
  urls.push(`https://www.bnr.ro/files/xml/years/nbrfxrates${y}.xml`, `https://www.bnr.ro/files/xml/years/nbrfxrates${y - 1}.xml`);
  let err;
  for (const u of urls) { try { const f = parseBNREurRate(await (await fetchWithTimeout(u, 4000)).text(), date); if (f) return { rate: f.value, effectiveDate: f.date, source: "BNR" }; } catch (e) { err = e; } }
  throw err || new Error("BNR indisponibil");
}
async function fetchECBRate(date) {
  const d = encodeURIComponent(date);
  const urls = [`https://api.frankfurter.dev/v2/providers/ecb/rate/eur/ron?date=${d}`, `https://api.frankfurter.dev/v2/rate/eur/ron?date=${d}`, `https://api.frankfurter.dev/v1/${d}?base=EUR&symbols=RON`];
  let err;
  for (const u of urls) {
    try { const j = await (await fetchWithTimeout(u)).json(); const v = Number(j.rate ?? j.rates?.RON); if (v > 0) return { rate: v, effectiveDate: j.date || date, source: "ECB" }; }
    catch (e) { err = e; }
  }
  throw err || new Error("Frankfurter indisponibil");
}
async function autoFetchRate(date, { userInitiated = false } = {}) {
  if (!date) return;
  const seq = ++rateSeq;
  if (userInitiated) rateTouched = false;
  setRateStatus("Se caută cursul…"); $("fetchRateBtn").disabled = true;
  let res = null;
  try { res = await fetchBNRRate(date); } catch {}
  if (!res) { try { res = await fetchECBRate(date); } catch {} }
  if (seq !== rateSeq) return; // a newer lookup (or a new dialog) superseded this one
  $("fetchRateBtn").disabled = false;
  if (!res) { setRateStatus("Cursul automat nu este disponibil. Introdu cursul manual.", true); return; }
  if (rateTouched) { setRateStatus(`Ai introdus cursul manual; nu l-am suprascris. Curs găsit: ${rateFmt.format(res.rate)} (${rateSourceLabel(res.source)}).`); return; }
  $("paymentRate").value = Number(res.rate).toFixed(4);
  $("paymentRate").dataset.source = res.source;
  $("paymentRate").dataset.rateDate = res.effectiveDate;
  setRateStatus(res.source === "BNR" ? `Curs BNR din ${formatDate(res.effectiveDate)}.` : `Curs BCE din ${formatDate(res.effectiveDate)} (BNR nu a putut fi accesat). Poate diferi ușor de cursul BNR.`, res.source !== "BNR");
  updateRateSummary(); updateConversionPreview();
}

function savePaymentFromForm(e) {
  e.preventDefault();
  const id = $("paymentId").value, date = $("paymentDate").value, beneficiary = $("paymentBeneficiary").value.trim(), description = $("paymentDescription").value.trim(), categoryId = $("paymentCategory").value, subcategoryId = $("paymentSubcategory").value || null, originalAmount = Number($("paymentAmount").value), originalCurrency = $("paymentCurrency").value, exchangeRate = Number($("paymentRate").value);
  const missing = [];
  if (!(originalAmount > 0)) missing.push("suma"); if (!date) missing.push("data"); if (!beneficiary) missing.push("beneficiarul"); if (!categoryId) missing.push("categoria");
  if (!(exchangeRate > 0)) { missing.push("cursul"); $("rateBox").open = true; }
  if (missing.length) { $("paymentError").textContent = `Completează: ${missing.join(", ")}.`; $("paymentError").classList.remove("hidden"); return; }
  const { ron, eur } = convert(originalAmount, originalCurrency, exchangeRate), old = id ? state.payments.find(p => p.id === id) : null, t = nowIso();
  const rec = { id: old?.id || uid("pay"), date, beneficiary, description, categoryId, subcategoryId, originalAmount, originalCurrency, exchangeRate, amountRON: ron, amountEUR: eur, invoiceNumber: $("paymentInvoiceNumber").value.trim(), notes: $("paymentNotes").value.trim(), rateSource: $("paymentRate").dataset.source || "manual", rateDate: $("paymentRate").dataset.rateDate || "", createdAt: old?.createdAt || t, updatedAt: t };
  rateSeq++; // ignore any in-flight rate lookup
  $("paymentDialog").close();
  commit(() => { if (old) Object.assign(old, rec); else state.payments.push(rec); }, old ? "Plata a fost actualizată." : "Plata a fost salvată.");
}
function deletePayment(id) {
  const p = state.payments.find(x => x.id === id); if (!p) return;
  commit(() => { state.payments = state.payments.filter(x => x.id !== id); }, `Plata către ${p.beneficiary} a fost ștearsă.`, { undo: true });
}

// ---------- Categories ----------
const nameTaken = (list, name, exceptId) => list.some(x => x.id !== exceptId && x.name.toLocaleLowerCase("ro") === name.toLocaleLowerCase("ro"));
function parseBudget(v) { if (!v) return null; const n = Number(String(v).replace(/\s/g, "").replace(",", ".")); return n; }

async function addCategory() {
  const n = await ask({ title: "Categorie nouă", label: "Numele categoriei", okLabel: "Adaugă", validate: v => nameTaken(state.categories, v) ? "Există deja o categorie cu acest nume." : "" });
  if (!n) return;
  commit(() => state.categories.push({ id: uid("cat"), name: n, sortOrder: Math.max(0, ...state.categories.map(c => Number(c.sortOrder) || 0)) + 1, budget: null, subcategories: [] }), "Categoria a fost adăugată.");
}
async function renameCategory(id) {
  const c = getCategory(id); if (!c) return;
  const n = await ask({ title: "Redenumește categoria", label: "Noul nume", value: c.name, validate: v => nameTaken(state.categories, v, id) ? "Există deja o categorie cu acest nume." : "" });
  if (!n || n === c.name) return;
  commit(() => { c.name = n; }, "Categoria a fost redenumită.", { undo: true });
}
async function setCategoryBudget(id) {
  const c = getCategory(id); if (!c) return;
  const v = await ask({ title: `Buget pentru „${c.name}”`, message: "Bugetul este în RON. Lasă gol pentru a elimina bugetul.", label: "Buget (RON)", type: "number", value: c.budget ?? "", required: false, validate: v => { const n = parseBudget(v); return n !== null && !(n > 0) ? "Introdu o sumă pozitivă sau lasă gol." : ""; } });
  if (v === null) return;
  const n = parseBudget(v);
  commit(() => { c.budget = n ? roundMoney(n) : null; }, n ? "Bugetul a fost salvat." : "Bugetul a fost eliminat.", { undo: true });
}
function reorderCategory(id, dir) {
  const a = getSortedCategories(), i = a.findIndex(c => c.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return;
  a.forEach((c, k) => { c.sortOrder = k + 1; }); // normalize, then swap
  commit(() => { a[i].sortOrder = j + 1; a[j].sortOrder = i + 1; });
}
async function deleteCategory(id) {
  const c = getCategory(id); if (!c) return;
  const linked = state.payments.filter(p => p.categoryId === id);
  if (!linked.length) { commit(() => { state.categories = state.categories.filter(x => x.id !== id); }, `Categoria „${c.name}” a fost ștearsă.`, { undo: true }); return; }
  const alt = getSortedCategories().filter(x => x.id !== id);
  if (!alt.length) { toast("Categoria are plăți și nu există altă categorie în care să le muți. Adaugă mai întâi o categorie."); return; }
  const target = await ask({ title: `Șterge „${c.name}”`, message: `Categoria are ${plural(linked.length, "plată", "plăți")}. Alege categoria în care vor fi mutate (fără subcategorie).`, label: "Mută plățile în", type: "select", options: alt.map(x => ({ value: x.id, label: x.name })), okLabel: "Mută și șterge", danger: true });
  if (!target) return;
  commit(() => { const t = nowIso(); linked.forEach(p => { p.categoryId = target; p.subcategoryId = null; p.updatedAt = t; }); state.categories = state.categories.filter(x => x.id !== id); }, `Categoria „${c.name}” a fost ștearsă, iar plățile au fost mutate.`, { undo: true });
}
async function addSubcategory(cid) {
  const c = getCategory(cid); if (!c) return;
  const n = await ask({ title: `Subcategorie nouă în „${c.name}”`, label: "Numele subcategoriei", okLabel: "Adaugă", validate: v => nameTaken(c.subcategories || [], v) ? "Există deja o subcategorie cu acest nume." : "" });
  if (!n) return;
  commit(() => { c.subcategories ||= []; c.subcategories.push({ id: uid("sub"), name: n }); }, "Subcategoria a fost adăugată.");
}
async function renameSubcategory(cid, sid) {
  const c = getCategory(cid), s = c?.subcategories?.find(x => x.id === sid); if (!s) return;
  const n = await ask({ title: "Redenumește subcategoria", label: "Noul nume", value: s.name, validate: v => nameTaken(c.subcategories, v, sid) ? "Există deja o subcategorie cu acest nume." : "" });
  if (!n || n === s.name) return;
  commit(() => { s.name = n; }, "Subcategoria a fost redenumită.", { undo: true });
}
async function deleteSubcategory(cid, sid) {
  const c = getCategory(cid), s = c?.subcategories?.find(x => x.id === sid); if (!s) return;
  const linked = state.payments.filter(p => p.categoryId === cid && p.subcategoryId === sid);
  let target = null;
  if (linked.length) {
    const alt = c.subcategories.filter(x => x.id !== sid);
    const v = await ask({ title: `Șterge „${s.name}”`, message: `Subcategoria are ${plural(linked.length, "plată", "plăți")}. Alege unde vor fi mutate.`, label: "Mută plățile în", type: "select", options: [{ value: "__none__", label: NO_SUBCATEGORY }, ...alt.map(x => ({ value: x.id, label: x.name }))], okLabel: "Mută și șterge", danger: true });
    if (!v) return;
    target = v === "__none__" ? null : v;
  }
  commit(() => { const t = nowIso(); linked.forEach(p => { p.subcategoryId = target; p.updatedAt = t; }); c.subcategories = c.subcategories.filter(x => x.id !== sid); }, `Subcategoria „${s.name}” a fost ștearsă.`, { undo: true });
}

// ---------- Settings, import/export ----------
function saveSettingsFromForm() {
  const r = Number($("settingsReferenceRate").value);
  if (!(r > 0)) { toast("Introdu un curs de referință valid."); return; }
  commit(() => {
    state.settings.referenceRate = r;
    state.settings.reportTitle = $("settingsReportTitle").value.trim() || DEFAULT_REPORT_TITLE;
    state.settings.reportSubtitle = $("settingsReportSubtitle").value.trim() || DEFAULT_REPORT_SUBTITLE;
    state.settings.rateMode = $("settingsRateMode").value;
  }, "Setările au fost salvate.");
}
function exportBackup() {
  downloadBlob(new Blob([JSON.stringify({ ...state, exportedAt: nowIso() }, null, 2)], { type: "application/json" }), `backup_constructie_casa_${todayLocal()}.json`);
  markBackup("file"); renderBackupBanners();
  toast("Backup JSON exportat. Păstrează fișierul într-un loc sigur (ex. Drive, e-mail).");
}
async function importBackupFile(f) {
  if (!f) return;
  try {
    let parsed; try { parsed = JSON.parse(await f.text()); } catch { throw new Error("Fișierul nu este JSON valid."); }
    const clean = sanitizeState(parsed);
    const ok = await ask({ title: "Importă backup", message: `Fișierul conține ${plural(clean.payments.length, "plată", "plăți")} în ${plural(clean.categories.length, "categorie", "categorii")}. Datele curente vor fi înlocuite (poți anula imediat după).`, type: "none", okLabel: "Importă", danger: true });
    if (!ok) return;
    commit(() => { state = clean; }, "Backup importat cu succes.", { undo: true });
    localStorage.setItem(FIRST_RUN_KEY, "1");
    markBackup("file"); renderBackupBanners();
  } catch (e) { toast(`Import eșuat: ${e.message}`, { timeout: 7000 }); }
  finally { $("importJsonFile").value = ""; }
}
function csvEscape(v) { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportCsv() {
  const head = ["id", "date", "beneficiary", "description", "category", "subcategory", "originalAmount", "originalCurrency", "exchangeRate", "rateSource", "rateDate", "amountRON", "amountEUR", "invoiceNumber", "notes", "createdAt", "updatedAt"];
  const rows = state.payments.map(p => { const c = getCategory(p.categoryId), s = getSubcategory(p.categoryId, p.subcategoryId); return [p.id, p.date, p.beneficiary, p.description, c?.name || "", s?.name || "", p.originalAmount, p.originalCurrency, p.exchangeRate, p.rateSource, p.rateDate, roundMoney(p.amountRON), roundMoney(p.amountEUR), p.invoiceNumber || "", p.notes || "", p.createdAt, p.updatedAt]; });
  downloadBlob(new Blob(["﻿" + [head, ...rows].map(r => r.map(csvEscape).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }), `plati_constructie_casa_${todayLocal()}.csv`);
  toast("Fișierul CSV a fost exportat.");
}

// ---------- Google Drive (manual + automatic save) ----------
const SYNC_KEY = "cornu-house-expenses-sync-v1";
const AUTO_SYNC_DELAY = 2000;
const codeErr = (code, msg) => Object.assign(new Error(msg), { code });
function getSync() { try { return { enabled: false, modified: null, consented: false, ...JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") }; } catch { return { enabled: false, modified: null, consented: false }; } }
function setSync(patch) { const s = { ...getSync(), ...patch }; try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch {} return s; }

let driveToken = null, driveSilent = false;
function hasDriveToken() { return !!(driveToken && Date.now() < driveToken.exp - 60000); }
function driveAuthorize() {
  if (hasDriveToken()) return Promise.resolve(driveToken.value);
  // Background saves must never open a Google pop-up (browsers block pop-ups without a tap).
  if (driveSilent) return Promise.reject(codeErr("auth", "Este nevoie de reconectare la Google Drive."));
  return new Promise((resolve, reject) => {
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) return reject(new Error("Serviciul Google nu este disponibil. Verifică conexiunea și reîncarcă pagina."));
    const client = oauth.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE, include_granted_scopes: false,
      callback: r => {
        if (r.access_token && oauth.hasGrantedAllScopes(r, DRIVE_SCOPE)) { setSync({ consented: true }); driveToken = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 }; resolve(r.access_token); }
        else reject(new Error("Accesul la Drive nu a fost acordat."));
      },
      error_callback: () => reject(new Error("Conectarea la Google a fost întreruptă."))
    });
    client.requestAccessToken(getSync().consented ? { prompt: "" } : {});
  });
}
async function driveRequest(path, options = {}, retry = true) {
  const token = await driveAuthorize();
  const r = await fetch("https://www.googleapis.com/" + path, { ...options, headers: { ...options.headers, Authorization: "Bearer " + token } });
  if (r.status === 401) { driveToken = null; if (retry && !driveSilent) return driveRequest(path, options, false); throw codeErr("auth", "Sesiunea Google a expirat."); }
  if (!r.ok) throw new Error("Google Drive: eroare HTTP " + r.status);
  return r;
}
async function driveListBackups() {
  const q = new URLSearchParams({ spaces: "appDataFolder", q: `trashed = false and name = '${DRIVE_FILE}'`, fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "100" });
  return (await (await driveRequest("drive/v3/files?" + q)).json()).files || [];
}
const remoteChanged = files => files.length > 0 && files[0].modifiedTime !== getSync().modified;

/** Writes the current state to the single Drive file. With checkConflict, refuses to overwrite a copy saved from another device. */
async function driveSave({ checkConflict = false } = {}) {
  const body = JSON.stringify({ ...state, exportedAt: nowIso() });
  const files = await driveListBackups();
  if (checkConflict && remoteChanged(files)) throw codeErr("conflict", "Copia din Drive a fost modificată de pe alt dispozitiv.");
  let saved;
  if (files.length) {
    saved = await (await driveRequest(`upload/drive/v3/files/${encodeURIComponent(files[0].id)}?uploadType=media&fields=id,modifiedTime`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })).json();
  } else {
    const boundary = "cornu-" + uid("b");
    const meta = JSON.stringify({ name: DRIVE_FILE, parents: ["appDataFolder"], mimeType: "application/json" });
    const multipart = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", meta, `--${boundary}`, "Content-Type: application/json", "", body, `--${boundary}--`, ""].join("\r\n");
    saved = await (await driveRequest("upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart })).json();
  }
  const check = await (await driveRequest(`drive/v3/files/${encodeURIComponent(saved.id)}?alt=media`)).text();
  if (check !== body) throw new Error("Copia din Drive nu a putut fi verificată.");
  setSync({ modified: saved.modifiedTime });
  // Earlier versions created a new file on every save: keep only the newest few.
  for (const f of files.slice(DRIVE_KEEP)) { try { await driveRequest(`drive/v3/files/${encodeURIComponent(f.id)}`, { method: "DELETE" }); } catch {} }
  markBackup("drive");
  return "Copie salvată și verificată în Drive.";
}
async function driveLoad({ confirm = true } = {}) {
  const files = await driveListBackups();
  if (!files.length) throw new Error("Nu există o copie în acest cont Google.");
  let clean;
  try { clean = sanitizeState(await (await driveRequest(`drive/v3/files/${encodeURIComponent(files[0].id)}?alt=media`)).json()); }
  catch (e) { throw new Error(`Copia din Drive nu poate fi folosită: ${e.message}`); }
  if (confirm) {
    const when = new Date(files[0].modifiedTime).toLocaleString("ro-RO");
    const ok = await ask({ title: "Restaurezi copia din Drive?", message: `Copia din ${when} conține ${plural(clean.payments.length, "plată", "plăți")}. Datele de pe acest dispozitiv vor fi înlocuite (poți anula imediat după).`, type: "none", okLabel: "Restaurează", danger: true });
    if (!ok) return "Restaurare anulată.";
  }
  commit(() => { state = clean; }, "Copia din Drive a fost încărcată.", { undo: true });
  // The local data now equals the Drive copy: nothing to upload.
  clearTimeout(syncTimer); syncDirty = false;
  setSync({ modified: files[0].modifiedTime });
  localStorage.setItem(FIRST_RUN_KEY, "1");
  markBackup("drive");
  return "Ultima copie din Drive a fost încărcată.";
}
async function runDrive(action) {
  const buttons = [$("driveSave"), $("driveLoad"), ...document.querySelectorAll('[data-action^="drive-"]')];
  buttons.forEach(b => b.disabled = true);
  $("driveStatus").textContent = "Conectare…";
  try {
    const msg = await (action === "save" ? driveSave() : driveLoad());
    $("driveStatus").textContent = msg; toast(msg);
    if (getSync().enabled && msg !== "Restaurare anulată.") { syncDirty = false; clearTimeout(syncTimer); setSyncStatus("ok"); }
  } catch (e) { $("driveStatus").textContent = e.message; toast(e.message, { timeout: 6000 }); }
  finally { buttons.forEach(b => b.disabled = false); renderBackupBanners(); }
}

// --- automatic save ---
let syncStatus = { state: "idle", msg: "", at: null }, syncTimer = null, syncDirty = false, syncRunning = false;
function setSyncStatus(st, msg = "") { syncStatus = { state: st, msg, at: st === "ok" ? new Date() : syncStatus.at }; renderSyncBar(); }
function scheduleAutoSync() {
  if (!getSync().enabled) return;
  syncDirty = true;
  if (syncStatus.state === "conflict") return renderSyncBar();
  clearTimeout(syncTimer);
  if (!hasDriveToken()) return setSyncStatus("needs-auth");
  setSyncStatus("pending");
  syncTimer = setTimeout(autoSync, AUTO_SYNC_DELAY);
}
async function autoSync() {
  if (!getSync().enabled || !syncDirty) return;
  if (syncRunning) { clearTimeout(syncTimer); syncTimer = setTimeout(autoSync, 1000); return; }
  if (!hasDriveToken()) return setSyncStatus("needs-auth");
  syncRunning = true; syncDirty = false; driveSilent = true;
  setSyncStatus("saving");
  try { await driveSave({ checkConflict: true }); setSyncStatus("ok"); }
  catch (e) {
    syncDirty = true;
    setSyncStatus(e.code === "conflict" ? "conflict" : e.code === "auth" ? "needs-auth" : "error", e.message);
  } finally {
    syncRunning = false; driveSilent = false; renderBackupBanners();
    if (syncDirty && syncStatus.state === "ok") scheduleAutoSync(); // changes made while saving
  }
}
/** Tap handler: get a Google token (pop-up allowed), check for newer data from another device, then save. */
async function connectDrive() {
  try {
    await driveAuthorize();
    setSyncStatus("saving");
    const files = await driveListBackups();
    if (remoteChanged(files)) return setSyncStatus("conflict", "Copia din Drive a fost modificată de pe alt dispozitiv.");
    if (syncDirty || !files.length) { syncDirty = true; await autoSync(); } else setSyncStatus("ok");
  } catch (e) { setSyncStatus(e.code === "auth" ? "needs-auth" : "error", e.message); }
}
function resolveConflict(keep) { return runDrive(keep === "drive" ? "load" : "save"); }

async function setAutoSync(on) {
  const box = $("autoSyncToggle");
  if (!on) { setSync({ enabled: false }); clearTimeout(syncTimer); setSyncStatus("idle"); renderBackupBanners(); toast("Salvarea automată în Drive a fost oprită."); return; }
  try {
    await driveAuthorize(); // must be the first await: it opens the Google pop-up from this tap
    const files = await driveListBackups();
    if (remoteChanged(files)) {
      const when = new Date(files[0].modifiedTime).toLocaleString("ro-RO");
      const choice = await ask({ title: "Există deja o copie în Drive", message: `În Drive există o copie din ${when}. Alege ce date păstrezi de acum înainte.`, label: "Păstrează", type: "select", options: [{ value: "local", label: `Datele de pe acest dispozitiv (${plural(state.payments.length, "plată", "plăți")})` }, { value: "drive", label: "Copia din Drive (înlocuiește datele de aici)" }], okLabel: "Continuă" });
      if (!choice) { box.checked = false; return; }
      if (choice === "drive") await driveLoad({ confirm: false }); else await driveSave();
    } else await driveSave();
    setSync({ enabled: true }); syncDirty = false; setSyncStatus("ok"); renderBackupBanners();
    toast("Salvarea automată în Drive este pornită.");
  } catch (e) { box.checked = false; toast(e.message, { timeout: 6000 }); }
}

function renderSyncBar() {
  const el = $("syncBar"), s = getSync();
  if ($("autoSyncToggle")) $("autoSyncToggle").checked = !!s.enabled;
  if (!s.enabled) { el.innerHTML = ""; return; }
  const time = syncStatus.at ? syncStatus.at.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" }) : "";
  const btn = (action, label, primary) => `<button class="btn btn-small${primary ? " btn-primary" : ""}" data-action="${action}">${label}</button>`;
  const bar = (cls, text, buttons = "") => `<div class="${cls} backup-banner sync-bar"><span>${h(text)}</span>${buttons ? `<div class="actions">${buttons}</div>` : ""}</div>`;
  switch (syncStatus.state) {
    case "ok": el.innerHTML = `<p class="backup-ok sync-ok">✓ Salvat automat în Google Drive${time ? ` la ${time}` : ""}.</p>`; break;
    case "pending": case "saving": el.innerHTML = `<p class="backup-ok sync-ok">Se salvează în Google Drive…</p>`; break;
    case "conflict": el.innerHTML = bar("warning", "Copia din Drive a fost modificată de pe alt dispozitiv. Alege ce date păstrezi; salvarea automată e în pauză până atunci.", btn("drive-keep-drive", "Folosește copia din Drive", true) + btn("drive-keep-local", "Păstrează datele de aici")); break;
    case "error": el.innerHTML = bar("danger-note", `Salvarea în Drive a eșuat: ${syncStatus.msg} Modificările sunt păstrate în browser.`, btn("drive-connect", "Reîncearcă", true)); break;
    default: el.innerHTML = bar("warning", syncDirty ? "Ai modificări care nu sunt încă în Google Drive. Conectează-te ca să fie salvate." : "Salvarea automată în Google Drive este pornită. Conectează-te pentru această sesiune.", btn("drive-connect", "Conectează Drive", true));
  }
}

// ---------- Document upload & automatic field filling ----------
const DOC_KEY = "cornu-house-expenses-docreader-v1"; // device-only (API key never goes into backups)
function getDocSettings() { try { return { method: "local", model: "claude-haiku-5-5", apiKey: "", ...JSON.parse(localStorage.getItem(DOC_KEY) || "{}") }; } catch { return { method: "local", model: "claude-haiku-5-5", apiKey: "" }; } }
function setDocSettings(s) { try { localStorage.setItem(DOC_KEY, JSON.stringify(s)); } catch {} }
function renderDocSettings() {
  const s = getDocSettings();
  $("docMethod").value = s.method; $("docModel").value = s.model; $("docApiKey").value = s.apiKey;
  toggleClaudeFields();
}
function toggleClaudeFields() { const on = $("docMethod").value === "claude"; document.querySelectorAll(".claude-only").forEach(e => e.classList.toggle("hidden", !on)); }
function saveDocSettingsFromForm() {
  const method = $("docMethod").value, apiKey = $("docApiKey").value.trim();
  if (method === "claude" && !apiKey) { $("docSettingsStatus").textContent = "Introdu cheia API pentru a folosi Claude."; return; }
  setDocSettings({ method, model: $("docModel").value, apiKey });
  $("docSettingsStatus").textContent = method === "claude" ? "Salvat. Documentele vor fi citite cu Claude." : "Salvat. Documentele vor fi citite local, în browser.";
}
async function testDocKey() {
  const key = $("docApiKey").value.trim();
  if (!key) { $("docSettingsStatus").textContent = "Introdu mai întâi cheia API."; return; }
  $("docSettingsStatus").textContent = "Se testează…"; $("testDocKey").disabled = true;
  try { await window.DocReader.testClaudeKey(key, $("docModel").value); $("docSettingsStatus").textContent = "Cheia funcționează. Apasă „Salvează” ca să o folosești."; }
  catch (e) { $("docSettingsStatus").textContent = e.message; }
  finally { $("testDocKey").disabled = false; }
}

const touchedFields = new Set();
const AUTO_FIELDS = ["paymentAmount", "paymentCurrency", "paymentDate", "paymentBeneficiary", "paymentDescription", "paymentCategory", "paymentInvoiceNumber", "paymentNotes"];
function resetDocUpload() {
  touchedFields.clear(); docSeq++;
  AUTO_FIELDS.forEach(id => $(id).classList.remove("autofilled", "uncertain"));
  $("docStatus").className = "doc-status hidden"; $("docStatus").textContent = "";
  $("docTextBox").classList.add("hidden"); $("docTextBox").open = false; $("docText").textContent = "";
  $("docDrop").classList.remove("busy"); $("docFile").value = "";
}
function setDocStatus(text, cls = "") { const e = $("docStatus"); e.className = `doc-status ${cls}`; e.textContent = text; }
function lastCategoryFor(beneficiary) {
  const b = fold(beneficiary); const p = [...state.payments].filter(x => fold(x.beneficiary) === b).sort((a, c) => c.date.localeCompare(a.date))[0];
  return p?.categoryId || null;
}
function fold(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }

let docSeq = 0;
async function handleDocument(file) {
  if (!file) return;
  const seq = ++docSeq, ds = getDocSettings();
  $("docDrop").classList.add("busy");
  setDocStatus(`Se citește „${file.name}”…`);
  try {
    const res = await window.DocReader.readDocument(file, {
      method: ds.method, apiKey: ds.apiKey, model: ds.model,
      categories: getSortedCategories().map(c => c.name),
      beneficiaries: [...new Set(state.payments.map(p => p.beneficiary))],
      onProgress: msg => { if (seq === docSeq) setDocStatus(msg); }
    });
    if (seq !== docSeq || !$("paymentDialog").open) return;
    applyExtracted(res, file);
  } catch (e) {
    if (seq === docSeq) setDocStatus(`Documentul nu a putut fi citit: ${e.message}`, "err");
  } finally { if (seq === docSeq) { $("docDrop").classList.remove("busy"); $("docFile").value = ""; } }
}
function applyExtracted(res, file) {
  const f = res.fields, filled = [], missing = [];
  const set = (id, value, label) => {
    if (value == null || value === "") { missing.push(label); return; }
    if (touchedFields.has(id)) return; // never overwrite what the user typed
    $(id).value = value; $(id).classList.add("autofilled"); filled.push(label);
    $(id).classList.toggle("uncertain", (f.uncertain || []).includes(id.replace("payment", "").toLowerCase()));
  };
  const oldDate = $("paymentDate").value;
  set("paymentAmount", f.amount != null ? Number(f.amount).toFixed(2) : null, "suma");
  set("paymentCurrency", f.currency, "moneda");
  set("paymentDate", f.date, "data");
  set("paymentBeneficiary", f.beneficiary, "furnizorul");
  set("paymentInvoiceNumber", f.invoiceNumber, "nr. facturii");
  if (f.description) set("paymentDescription", f.description, "descrierea");
  // Category: Claude's suggestion, otherwise the category last used for this supplier.
  const byName = f.category && getSortedCategories().find(c => fold(c.name) === fold(f.category));
  const catId = byName?.id || (f.beneficiary && lastCategoryFor(f.beneficiary));
  if (catId && !touchedFields.has("paymentCategory") && $("paymentCategory").value !== catId) { $("paymentCategory").value = catId; renderPaymentSubcategoryOptions(catId); $("paymentCategory").classList.add("autofilled"); filled.push("categoria"); }
  if (!touchedFields.has("paymentNotes") && !$("paymentNotes").value.trim()) { $("paymentNotes").value = `Document: ${file.name}`; }
  syncRateBoxToCurrency(); updateConversionPreview(); checkDuplicate(); updateRateSummary();
  if (!$("paymentId").value && $("paymentDate").value !== oldDate) autoFetchRate($("paymentDate").value);
  const how = res.method === "claude" ? "Citit cu Claude" : res.ocr ? "Citit local (recunoaștere text din imagine)" : "Citit local";
  const parts = [`${how}.`];
  if (filled.length) parts.push(`Am completat: ${filled.join(", ")}.`);
  const realMissing = missing.filter(m => m !== "descrierea");
  if (realMissing.length) parts.push(`Nu am găsit: ${realMissing.join(", ")}.`);
  if ((f.uncertain || []).length) parts.push("Câmpurile cu chenar portocaliu sunt nesigure.");
  parts.push("Verifică valorile marcate înainte de salvare.");
  if (res.warning) parts.unshift(res.warning);
  setDocStatus(parts.join(" "), !filled.length ? "err" : realMissing.length || res.warning || (f.uncertain || []).length ? "warn" : "ok");
  if (res.text) { $("docText").textContent = res.text.slice(0, 20000); $("docTextBox").classList.remove("hidden"); }
}
function bindDocEvents() {
  $("docFile").addEventListener("change", e => handleDocument(e.target.files[0]));
  const drop = $("docDrop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("dragover"); }));
  drop.addEventListener("drop", e => handleDocument(e.dataTransfer?.files?.[0]));
  AUTO_FIELDS.forEach(id => $(id).addEventListener("input", e => { if (!e.isTrusted) return; touchedFields.add(id); $(id).classList.remove("autofilled", "uncertain"); }));
  AUTO_FIELDS.forEach(id => $(id).addEventListener("change", e => { if (!e.isTrusted) return; touchedFields.add(id); $(id).classList.remove("autofilled", "uncertain"); }));
  $("docMethod").addEventListener("change", toggleClaudeFields);
  $("saveDocSettings").addEventListener("click", saveDocSettingsFromForm);
  $("testDocKey").addEventListener("click", testDocKey);
}

// ---------- PDF ----------
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); }); }
let pdfLibPromise = null, pdfFontCache = null;
async function loadPdfLib() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return;
  pdfLibPromise ||= loadScript("vendor/jspdf.umd.min.js").then(() => loadScript("vendor/jspdf.plugin.autotable.min.js"));
  try { await pdfLibPromise; } catch (e) { pdfLibPromise = null; throw e; }
}
async function loadPdfFonts() {
  if (pdfFontCache) return pdfFontCache;
  const b64 = async u => { const buf = new Uint8Array(await (await fetchWithTimeout(u, 8000)).arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
  pdfFontCache = { regular: await b64("fonts/Roboto-Regular.ttf"), bold: await b64("fonts/Roboto-Bold.ttf") };
  return pdfFontCache;
}
function openPdfDialog() {
  $("pdfDateFrom").value = ""; $("pdfDateTo").value = ""; $("pdfRateMode").value = state.settings.rateMode;
  $("pdfCategoryList").innerHTML = getSortedCategories().map(c => `<label class="check-row"><input type="checkbox" value="${h(c.id)}" checked><span>${h(c.name)}</span></label>`).join("") || `<span class="muted">Nu există categorii.</span>`;
  $("pdfDialog").showModal();
}
function pdfFilteredPayments() {
  const f = $("pdfDateFrom").value, t = $("pdfDateTo").value;
  if (f && t && f > t) { toast("Data de început este după data de sfârșit."); return null; }
  const ids = [...$("pdfCategoryList").querySelectorAll("input:checked")].map(x => x.value);
  return state.payments.filter(p => (!f || p.date >= f) && (!t || p.date <= t) && ids.includes(p.categoryId));
}
async function generatePdf() {
  const ps = pdfFilteredPayments(); if (ps === null) return;
  if (!ps.length) { toast("Nu există plăți pentru filtrele selectate."); return; }
  const btn = $("generatePdfBtn"); btn.disabled = true; btn.textContent = "Se generează…";
  try {
    try { await loadPdfLib(); } catch { toast("Biblioteca PDF nu a putut fi încărcată. Reîncarcă pagina și încearcă din nou."); return; }
    const mode = $("pdfRateMode").value, { jsPDF } = window.jspdf, doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    let F = "Roboto", tx = s => String(s ?? "");
    try {
      const fonts = await loadPdfFonts();
      doc.addFileToVFS("Roboto-Regular.ttf", fonts.regular); doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.addFileToVFS("Roboto-Bold.ttf", fonts.bold); doc.addFont("Roboto-Bold.ttf", "Roboto", "bold");
    } catch { F = "helvetica"; tx = ascii; } // fallback: built-in font without ș/ț
    const W = doc.internal.pageSize.getWidth(), M = 12, dark = [31, 58, 95], slate = [46, 74, 98], blue = [74, 123, 183], light = [234, 241, 247], peach = [251, 227, 207], green = [233, 246, 239], line = [205, 213, 221], red = [180, 35, 24];
    let y = 16;
    doc.setTextColor(...dark); doc.setFont(F, "bold"); doc.setFontSize(18); doc.text(tx(state.settings.reportTitle), W / 2, y, { align: "center" }); y += 7;
    doc.setTextColor(100, 105, 112); doc.setFont(F, "normal"); doc.setFontSize(9); doc.text(tx(state.settings.reportSubtitle), W / 2, y, { align: "center" }); y += 5;
    const conv = mode === "reference" ? `Conversie de referință: 1 EUR = ${rateFmt.format(state.settings.referenceRate)} RON | Total plăți: ${ps.length}` : `Conversie: curs individual per plată | Total plăți: ${ps.length}`;
    doc.text(tx(conv), W / 2, y, { align: "center" }); y += 4;
    doc.text(tx(`Generat la ${formatDate(todayLocal())}`), W / 2, y, { align: "center" }); y += 6;
    const banner = (l, c = slate) => { if (y > 270) { doc.addPage(); y = 16; } doc.setFillColor(...c); doc.rect(M, y, W - M * 2, 8, "F"); doc.setTextColor(255, 255, 255); doc.setFont(F, "bold"); doc.setFontSize(10); doc.text(tx(l), M + 3, y + 5.5); y += 10; };
    const baseStyles = { font: F, lineColor: line, lineWidth: .15 };
    banner("Rezumat general");
    const stats = categoryStats(ps, mode).filter(s => s.count), gt = totalsFor(ps, mode), bt = budgetTotals(stats);
    const remCell = (v, extra = {}) => ({ content: v == null ? "—" : formatRON(v), styles: { ...(v < 0 ? { textColor: red } : {}), ...extra } });
    const sumBody = stats.map(s => [tx(s.c.name), String(s.count), formatRON(s.ron), formatEUR(s.eur), s.budget ? formatRON(s.budget) : "—", remCell(s.remaining)]);
    const tot = { fontStyle: "bold", fillColor: peach };
    sumBody.push([{ content: tx("TOTAL GENERAL"), styles: tot }, { content: String(ps.length), styles: tot }, { content: formatRON(gt.ron), styles: tot }, { content: formatEUR(gt.eur), styles: tot }, { content: bt.budget ? formatRON(bt.budget) : "—", styles: tot }, remCell(bt.budget ? bt.remaining : null, tot)]);
    doc.autoTable({ startY: y, margin: { left: M, right: M, bottom: 16 }, head: [[tx("Categorie"), tx("Plăți"), tx("Cheltuit RON"), tx("EUR aprox."), tx("Buget"), tx("Rămas")]], body: sumBody, theme: "grid", styles: { ...baseStyles, fontSize: 8, cellPadding: 2 }, headStyles: { fillColor: light, textColor: [37, 52, 75], fontStyle: "bold" }, columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } } });
    y = doc.lastAutoTable.finalY + 7;
    const row = p => { const a = amountsFor(p, mode); return [formatDate(p.date), tx(p.beneficiary), tx(displayDescription(p)), formatRON(a.ron), formatEUR(a.eur)]; };
    const subRow = (label, list) => { const st = totalsFor(list, mode), sty = { fontStyle: "bold", fillColor: green }; return [{ content: tx(label), colSpan: 3, styles: sty }, { content: formatRON(st.ron), styles: { ...sty, halign: "right" } }, { content: formatEUR(st.eur), styles: { ...sty, halign: "right" } }]; };
    for (const s of stats) {
      const c = s.c, cp = ps.filter(p => p.categoryId === c.id).sort((a, b) => a.date.localeCompare(b.date) || a.beneficiary.localeCompare(b.beneficiary, "ro"));
      banner(c.name, blue);
      const body = [], subs = c.subcategories || [];
      if (subs.length) {
        const gs = [...subs.map(sc => ({ name: sc.name, ps: cp.filter(p => p.subcategoryId === sc.id) })), { name: NO_SUBCATEGORY, ps: cp.filter(p => !p.subcategoryId) }].filter(g => g.ps.length);
        for (const g of gs) { g.ps.forEach(p => body.push(row(p))); body.push(subRow(`Subtotal ${g.name}`, g.ps)); }
      } else cp.forEach(p => body.push(row(p)));
      body.push(subRow(`Subtotal ${c.name}${c.budget ? ` (buget ${formatRON(c.budget)})` : ""}`, cp));
      doc.autoTable({ startY: y, margin: { left: M, right: M, bottom: 16 }, head: [[tx("Data"), tx("Beneficiar"), tx("Descriere"), "RON", tx("EUR aprox.")]], body, theme: "grid", styles: { ...baseStyles, fontSize: 7.2, cellPadding: 1.8, overflow: "linebreak" }, headStyles: { fillColor: light, textColor: [37, 52, 75], fontStyle: "bold" }, columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 47 }, 2: { cellWidth: 56 }, 3: { cellWidth: 31, halign: "right" }, 4: { cellWidth: 31, halign: "right" } }, showHead: "everyPage" });
      y = doc.lastAutoTable.finalY + 7;
    }
    if (y > 255) { doc.addPage(); y = 18; }
    doc.setTextColor(90, 95, 102); doc.setFont(F, "normal"); doc.setFontSize(7.5);
    const note = mode === "reference" ? "Notă: valorile EUR sunt aproximative și folosesc același curs de referință pentru toate plățile. Bugetele sunt în RON." : "Notă: valorile RON și EUR folosesc cursul salvat pentru fiecare plată. Bugetele sunt în RON.";
    const notes = doc.splitTextToSize(tx(note), W - M * 2); doc.text(notes, M, y); y += notes.length * 3.5 + 2;
    const unspecified = ps.filter(p => !p.description);
    if (unspecified.length) doc.text(doc.splitTextToSize(tx(`Plăți cu descriere nespecificată: ${unspecified.map(p => p.beneficiary).join("; ")}`), W - M * 2), M, y);
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); const H = doc.internal.pageSize.getHeight();
      doc.setDrawColor(220, 225, 230); doc.line(M, H - 11, W - M, H - 11);
      doc.setFont(F, "normal"); doc.setFontSize(7.5); doc.setTextColor(100, 105, 112);
      doc.text(tx("Situație plăți construcție"), M, H - 6); doc.text(tx(`Pagina ${i} din ${pages}`), W - M, H - 6, { align: "right" });
    }
    doc.save(`Situatie_Plati_Constructie_${todayLocal()}.pdf`);
    $("pdfDialog").close(); toast("Raportul PDF a fost generat.");
  } catch (e) { toast(`PDF-ul nu a putut fi generat: ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = "Generează PDF"; }
}

// ---------- Events ----------
function bindEvents() {
  bindDocEvents();
  document.addEventListener("click", e => {
    const t = e.target, attr = (sel, key) => t.closest(sel)?.dataset[key];
    const pg = attr("[data-page]", "page"); if (pg) { e.preventDefault(); showPage(pg); return; }
    const action = attr("[data-action]", "action");
    if (action === "add-payment") return openPaymentDialog();
    if (action === "open-pdf") return openPdfDialog();
    if (action === "drive-save") return runDrive("save");
    if (action === "drive-connect") return connectDrive();
    if (action === "drive-keep-drive") return resolveConflict("drive");
    if (action === "drive-keep-local") return resolveConflict("local");
    if (action === "export-json") return exportBackup();
    if (action === "reset-filters") { Object.assign(filters, { search: "", dateFrom: "", dateTo: "", currency: "ALL" }); return renderPayments(); }
    const cl = attr("[data-close-dialog]", "closeDialog"); if (cl) { if (cl === "paymentDialog") rateSeq++; return $(cl).close(); }
    if (t.closest("[data-ask-cancel]")) return finishAsk(null);
    const handlers = [["[data-edit-payment]", "editPayment", openPaymentDialog], ["[data-delete-payment]", "deletePayment", deletePayment], ["[data-cat-up]", "catUp", id => reorderCategory(id, -1)], ["[data-cat-down]", "catDown", id => reorderCategory(id, 1)], ["[data-cat-rename]", "catRename", renameCategory], ["[data-cat-budget]", "catBudget", setCategoryBudget], ["[data-cat-delete]", "catDelete", deleteCategory], ["[data-sub-add]", "subAdd", addSubcategory], ["[data-sub-rename]", "subRename", v => renameSubcategory(...v.split("|"))], ["[data-sub-delete]", "subDelete", v => deleteSubcategory(...v.split("|"))]];
    for (const [sel, key, fn] of handlers) { const v = attr(sel, key); if (v) { fn(v); return; } }
  });
  $("askForm").addEventListener("submit", submitAsk);
  $("askDialog").addEventListener("cancel", e => { e.preventDefault(); finishAsk(null); });
  $("globalRateMode").addEventListener("change", e => commit(() => { state.settings.rateMode = e.target.value; }));
  $("filterSearch").addEventListener("input", e => { filters.search = e.target.value; renderPayments(); });
  $("filterDateFrom").addEventListener("change", e => { filters.dateFrom = e.target.value; renderPayments(); });
  $("filterDateTo").addEventListener("change", e => { filters.dateTo = e.target.value; renderPayments(); });
  $("filterCurrency").addEventListener("change", e => { filters.currency = e.target.value; renderPayments(); });
  $("filterSort").addEventListener("change", e => { filters.sort = e.target.value; renderPayments(); });
  $("paymentCategory").addEventListener("change", e => renderPaymentSubcategoryOptions(e.target.value));
  $("paymentCurrency").addEventListener("change", () => { syncRateBoxToCurrency(); updateConversionPreview(); checkDuplicate(); });
  $("paymentAmount").addEventListener("input", () => { updateConversionPreview(); checkDuplicate(); });
  $("paymentRate").addEventListener("input", () => { rateTouched = true; $("paymentRate").dataset.source = "manual"; $("paymentRate").dataset.rateDate = ""; updateRateSummary(); updateConversionPreview(); });
  ["paymentBeneficiary", "paymentDate"].forEach(id => $(id).addEventListener("input", checkDuplicate));
  $("paymentDate").addEventListener("change", e => {
    if (!$("paymentId").value) autoFetchRate(e.target.value); // new payments only — never overwrite a saved rate silently
    else setRateStatus("Data s-a schimbat. Cursul salvat a rămas neschimbat; apasă „Preia cursul pentru dată” dacă vrei cursul noii date.");
  });
  $("fetchRateBtn").addEventListener("click", () => autoFetchRate($("paymentDate").value, { userInitiated: true }));
  $("paymentForm").addEventListener("submit", savePaymentFromForm);
  $("paymentDialog").addEventListener("close", () => { rateSeq++; docSeq++; });
  $("addCategoryBtn").addEventListener("click", addCategory);
  $("saveSettingsBtn").addEventListener("click", saveSettingsFromForm);
  $("exportJsonBtn").addEventListener("click", exportBackup);
  $("importJsonBtn").addEventListener("click", () => $("importJsonFile").click());
  $("importJsonFile").addEventListener("change", e => importBackupFile(e.target.files[0]));
  $("exportCsvBtn").addEventListener("click", exportCsv);
  $("loadSampleBtn").addEventListener("click", loadSampleData);
  $("driveSave").addEventListener("click", () => runDrive("save"));
  $("autoSyncToggle").addEventListener("change", e => setAutoSync(e.target.checked));
  // Flush a pending automatic save when the tab is hidden; warn before closing with unsaved Drive changes.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && syncDirty && hasDriveToken() && syncStatus.state === "pending") { clearTimeout(syncTimer); autoSync(); } });
  window.addEventListener("beforeunload", e => { if (getSync().enabled && (syncRunning || (syncDirty && hasDriveToken() && syncStatus.state !== "conflict"))) { e.preventDefault(); e.returnValue = ""; } });
  $("driveLoad").addEventListener("click", () => runDrive("load"));
  $("generatePdfBtn").addEventListener("click", generatePdf);
  $("startEmptyBtn").addEventListener("click", () => { state = createEmptyState(); saveState({ countAsChange: false }); localStorage.setItem(FIRST_RUN_KEY, "1"); $("firstRunDialog").close(); renderAll(); });
  $("firstRunLoadSampleBtn").addEventListener("click", () => { $("firstRunDialog").close(); loadSampleData(); });
}

function init() {
  bindEvents();
  renderDocSettings();
  // Migrate stored data to schema v2 once (without counting it as a user change).
  if (localStorage.getItem(STORAGE_KEY) && !loadProblem) saveState({ countAsChange: false });
  renderAll();
  if (getSync().enabled) setSyncStatus("needs-auth"); else renderSyncBar();
  // Ask the browser not to evict our data (helps on Safari/iOS; silently ignored elsewhere).
  try { navigator.storage?.persist?.(); } catch {}
  if (!localStorage.getItem(FIRST_RUN_KEY)) $("firstRunDialog").showModal();
}
init();
