/* Dashboard de finanzas – lógica del cliente */
"use strict";

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("es-CL", { notation: "compact", maximumFractionDigits: 1 });
const pct = (x) => `${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 1 : 0)}%`;
// Modo privado: oculta todos los montos (los porcentajes y cantidades siguen visibles).
let HIDE_AMOUNTS = false;
const MASK = "•••••";
const fmt = (n) => (HIDE_AMOUNTS ? `$${MASK}` : money.format(Math.round(n)));
const cmp = (n) => (HIDE_AMOUNTS ? "•••" : compact.format(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000) + 1;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const weekday = (s) => (D(s).getUTCDay() + 6) % 7; // 0 = lunes
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtDate = (s) => `${Number(s.slice(8))} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const keyOf = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const KIND_LABEL = { gasto: "Gasto", ingreso: "Ingreso", inversion: "Inversión", beneficio: "Beneficio", ahorro: "Ahorro (apartado)", interno: "Interno (mi cuenta, excluir)" };
const GRAN_LABEL = { dia: "día", semana: "semana", mes: "mes", trimestre: "trimestre" };
const DIM_LABEL = { category: "categoría", merchant: "comercio", channel: "medio de pago" };
const SUGGESTED_CATS = [
  "Comida y delivery", "Supermercado", "Transporte", "Cuentas y servicios", "Suscripciones y entretenimiento",
  "Salud y belleza", "Hogar", "Mascotas", "Educación", "Compras Mercado Libre", "Compras online", "Ropa",
  "Regalos", "Viajes", "Transferencias a personas", "Créditos y deudas", "Otros comercios",
];

// ---------- periodos ----------
function periodKey(date, gran) {
  if (gran === "dia") return date;
  if (gran === "semana") return addDays(date, -weekday(date));
  if (gran === "mes") return date.slice(0, 7);
  return `${date.slice(0, 4)}-T${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}
function periodLabel(key, gran) {
  if (gran === "dia") return `${Number(key.slice(8))} ${MONTHS[+key.slice(5, 7) - 1]}`;
  if (gran === "semana") return `Sem ${Number(key.slice(8))} ${MONTHS[+key.slice(5, 7) - 1]}`;
  if (gran === "mes") return `${MONTHS[+key.slice(5, 7) - 1]} ${key.slice(2, 4)}`;
  return `${key.slice(5)} ${key.slice(0, 4)}`;
}
function periodsBetween(from, to, gran) {
  const keys = [];
  const seen = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = periodKey(d, gran);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

// ---------- estado ----------
let RAW = [], TAGS = {}, MERCH_RULES = {}, SETTINGS = {}, FILES = [], TX = [];
let MIN_DATE = "", MAX_DATE = "";
const state = { from: "", to: "", gran: "mes", hidden: new Set(), dims: { pie: "category", stack: "category" }, heatMetric: "amount" };
let detail = null; // { title, filter, ignoreRange }
const charts = {};
const clickHandlers = {};

function store(key, val) { try { localStorage.setItem(key, val); } catch {} }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

/** Aplica reglas por comercio y etiquetas por movimiento sobre los datos crudos. */
function applyTags() {
  TX = RAW.map((t) => {
    const rule = MERCH_RULES[t.merchantKey] || {};
    const tag = TAGS[t.id] || {};
    return {
      ...t,
      baseCategory: t.category, baseKind: t.kind, baseMerchant: t.merchant,
      merchant: rule.name || t.merchant,
      category: tag.category || rule.category || t.category,
      kind: tag.kind || rule.kind || t.kind,
      note: tag.note || "",
      tagged: !!(TAGS[t.id] || MERCH_RULES[t.merchantKey]),
    };
  });
  buildColorOrders();
  $("#catList").innerHTML = [...new Set([...SUGGESTED_CATS, ...TX.map((t) => t.category)])].map((c) => `<option value="${esc(c)}">`).join("");
  $("#merchList").innerHTML = [...new Set(TX.filter((t) => t.amount < 0).map((t) => t.merchant))].sort((a, b) => a.localeCompare(b, "es")).map((m) => `<option value="${esc(m)}">`).join("");
}

/** Botón ✏️ para renombrar el comercio de un movimiento. */
const editBtn = (t) => `<button class="edit" data-rename="${esc(t.merchantKey)}" title="Renombrar comercio" aria-label="Renombrar ${esc(t.merchant)}">✏️</button>`;

// ---------- colores ----------
// El color sigue a la entidad, no a su ranking del filtro actual: el orden se calcula
// con todo el historial. Las 7 más grandes tienen color propio; el resto va a "Otros".
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
const ORDER = { category: [], merchant: [], channel: [] };
const rawDim = (t, dim) => (dim === "category" ? t.category : dim === "merchant" ? t.merchant : t.channel);
function buildColorOrders() {
  const spendAll = TX.filter((t) => t.kind === "gasto");
  for (const dim of Object.keys(ORDER)) {
    const by = groupSum(spendAll, (t) => rawDim(t, dim), spend);
    ORDER[dim] = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
}
function dimOf(t, dim) {
  const v = rawDim(t, dim);
  const order = ORDER[dim];
  return order.length > 8 && order.indexOf(v) >= 7 ? "Otros" : v;
}
function dimValues(dim) {
  const order = ORDER[dim];
  return order.length > 8 ? [...order.slice(0, 7), "Otros"] : order;
}
function colorOf(dim, value) {
  const i = ORDER[dim].indexOf(value);
  return value === "Otros" || i < 0 || i > 7 || (ORDER[dim].length > 8 && i >= 7) ? css("--other") : css(SLOTS[i]);
}
const catColor = (c) => colorOf("category", c);

const inRange = (t) => t.date >= state.from && t.date <= state.to;
const isSpend = (t) => t.kind === "gasto" && !state.hidden.has(t.category);
const spend = (t) => -t.amount;
const sum = (arr, f) => arr.reduce((a, t) => a + f(t), 0);
function groupSum(arr, keyFn, valFn) {
  const o = {};
  for (const t of arr) { const k = keyFn(t); o[k] = (o[k] || 0) + valFn(t); }
  return o;
}
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const t of arr) { const k = keyFn(t); (m.get(k) || m.set(k, []).get(k)).push(t); }
  return m;
}

// ---------- carga ----------
// Reporte exportado: los datos vienen incrustados en el HTML y no hay servidor donde guardar cambios.
const EMBEDDED = window.__FINANZAS_EXPORT__ || null;
const READONLY = !!EMBEDDED;

// ---------- configuración en localStorage ----------
// Se guarda con el mismo formato (y claves en español) que los antiguos archivos config/*.json:
// { comercios: {clave: {nombre, categoria, tipo, original}}, etiquetas: {id: {categoria, tipo, nota}}, ajustes: {presupuestoMensual} }
const CFG_KEY = "finanzas.configuracion";
const TO_ES = { name: "nombre", category: "categoria", kind: "tipo", note: "nota", original: "original", monthlyBudget: "presupuestoMensual" };
const FROM_ES = Object.fromEntries(Object.entries(TO_ES).map(([k, v]) => [v, k]));
const renameKeys = (o, map) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [map[k] || k, v]));
const mapEntries = (m, map) => Object.fromEntries(Object.entries(m || {}).map(([id, e]) => [id, renameKeys(e, map)]));

function configSnapshot() {
  return {
    app: "finanzas", version: 1, guardado: new Date().toISOString(),
    comercios: mapEntries(MERCH_RULES, TO_ES),
    etiquetas: mapEntries(TAGS, TO_ES),
    ajustes: renameKeys(SETTINGS, TO_ES),
  };
}
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch {}
  MERCH_RULES = mapEntries(cfg.comercios, FROM_ES);
  TAGS = mapEntries(cfg.etiquetas, FROM_ES);
  SETTINGS = renameKeys(cfg.ajustes, FROM_ES);
}
function saveConfig() {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(configSnapshot()));
  } catch (err) {
    toast("⚠ No se pudo guardar la configuración en este navegador: " + err.message, 6000);
  }
}
/** Aplica cambios {id: entrada | null}; borra entradas vacías ("original" solo es informativo). */
function mergeUpdates(target, updates) {
  for (const [id, value] of Object.entries(updates || {})) {
    const clean = {};
    for (const [k, v] of Object.entries(value || {})) if (typeof v === "string" && v.trim()) clean[k] = v.trim();
    if (Object.keys(clean).some((k) => k !== "original")) target[id] = clean;
    else delete target[id];
  }
}
const configCounts = () => {
  const c = Object.values(MERCH_RULES);
  return { renamed: c.filter((r) => r.name).length, categorized: c.filter((r) => r.category).length, internal: c.filter((r) => r.kind).length, tags: Object.keys(TAGS).length };
};

// ---------- carga de datos ----------
async function load() {
  if (EMBEDDED) return showData(EMBEDDED);
  loadConfig();
  showUpload();
}

/** Muestra el dashboard con un conjunto de movimientos ya procesados. */
function showData(data) {
  RAW = data.txs;
  if (EMBEDDED) {
    TAGS = data.tags || {};
    MERCH_RULES = data.merchants || {};
    SETTINGS = data.settings || {};
  }
  FILES = data.files || [];
  const dates = RAW.map((t) => t.date).sort();
  MIN_DATE = dates[0] || iso(new Date());
  MAX_DATE = dates.at(-1) || iso(new Date());
  if (!state.from || state.from < MIN_DATE || state.from > MAX_DATE) state.from = MIN_DATE;
  if (!state.to || state.to > MAX_DATE || state.to < MIN_DATE) state.to = MAX_DATE;
  for (const el of [$("#from"), $("#to")]) { el.min = MIN_DATE; el.max = MAX_DATE; }
  $("#dataInfo").textContent = RAW.length
    ? `${RAW.length.toLocaleString("es-CL")} movimientos de ${FILES.length} archivo${FILES.length === 1 ? "" : "s"} · ${fmtDate(MIN_DATE)} – ${fmtDate(MAX_DATE)}`
    : "Sin movimientos";
  if (READONLY) $("#dataInfo").textContent += ` · reporte exportado el ${new Date(EMBEDDED.exportedAt).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" })} (solo lectura)`;
  applyTags();
  renderAll();
}

/** En el reporte exportado los campos editables se muestran pero no se pueden cambiar. */
function lockInputs() {
  if (!READONLY) return;
  document.querySelectorAll(".tbl input, .tbl select, #budget").forEach((el) => { el.disabled = true; });
}
const readonlyNotice = () => toast("Este es un reporte exportado de solo lectura. Haz los cambios en el dashboard original.");

// ---------- exportar HTML autocontenido ----------
/**
 * Genera un único .html con datos, estilos, ECharts y la lógica del dashboard incrustados.
 * Se abre sin servidor ni internet y conserva la vista actual (periodo, agrupación, filtros).
 */
async function exportHtml() {
  const btn = $("#btnExport");
  btn.disabled = true;
  btn.textContent = "Generando…";
  try {
    const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.text(); });
    const [page, styles, echartsJs, appJs] = await Promise.all([get("index.html"), get("styles.css"), get("/vendor/echarts.min.js"), get("app.js")]);
    const payload = {
      txs: RAW, tags: TAGS, merchants: MERCH_RULES, settings: SETTINGS, files: FILES,
      exportedAt: new Date().toISOString(),
      view: { from: state.from, to: state.to, gran: state.gran, dims: state.dims, heatMetric: state.heatMetric, hidden: [...state.hidden], hideAmounts: HIDE_AMOUNTS },
    };
    // evita que un "</script>" dentro del código o los datos cierre la etiqueta antes de tiempo
    // (la barra invertida se arma con fromCharCode: un literal "<\\/script" lo simplifican algunos motores)
    const BS = String.fromCharCode(92);
    const safeJs = (s) => s.replace(/<\/script/gi, () => "<" + BS + "/script");
    const data = JSON.stringify(payload).replace(/</g, "\\u003c");
    const html = page
      .replace(/<link rel="stylesheet" href="styles\.css" \/>/, () => `<style>\n${styles}\n</style>`)
      .replace(/<script src="\/vendor\/echarts\.min\.js"><\/script>/, () => `<script>${safeJs(echartsJs)}</script>`)
      .replace(/<script src="loader\.js"><\/script>\n?/, "") // el reporte trae los datos ya procesados
      .replace(/<script src="app\.js"><\/script>/, () => `<script>window.__FINANZAS_EXPORT__ = ${data};</script>\n<script>${safeJs(appJs)}</script>`);
    const name = `finanzas-${state.from}_${state.to}.html`;
    downloadFile(name, html, "text/html;charset=utf-8");
    toast(`✓ Reporte descargado: ${name} (${(html.length / 1024 / 1024).toFixed(1)} MB)`, 5000);
  } catch (err) {
    toast("⚠ No se pudo exportar: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Exportar HTML";
  }
}

function downloadFile(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- pantalla de carga de CSV ----------
// Los archivos solo viven en memoria: al recargar la pestaña hay que volver a cargarlos.
let PENDING = []; // [{ name, size, buffer }]
let preview = null; // resultado de parseFiles sobre PENDING

function showUpload() {
  $("#upload").hidden = false;
  document.body.classList.add("uploading");
  $("#btnCancelUpload").hidden = !RAW.length;
  renderUpload();
}
function hideUpload() {
  $("#upload").hidden = true;
  document.body.classList.remove("uploading");
}
async function addFiles(fileList) {
  const csvs = [...fileList].filter((f) => /\.csv$/i.test(f.name));
  const ignored = fileList.length - csvs.length;
  for (const f of csvs) {
    if (PENDING.some((p) => p.name === f.name && p.size === f.size)) continue;
    PENDING.push({ name: f.name, size: f.size, buffer: await f.arrayBuffer() });
  }
  if (ignored) toast(`Se ignoraron ${ignored} archivo${ignored > 1 ? "s" : ""} que no son .csv`);
  renderUpload();
}
function renderUpload() {
  preview = PENDING.length ? FinanzasLoader.parseFiles(PENDING) : null;
  const byName = Object.fromEntries((preview?.report || []).map((r) => [r.name, r]));
  const label = { liberaciones: "Liberaciones ✓", liquidaciones: "Liquidaciones ✓", desconocido: "No reconocido" };
  $("#fileList").innerHTML = PENDING.map((p, i) => {
    const r = byName[p.name] || {};
    return `<li class="${r.kind === "desconocido" ? "bad" : ""}">
      <span class="fname" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="hint">${label[r.kind] || ""}${r.error ? ` · ${esc(r.error)}` : ` · ${(r.rows || 0).toLocaleString("es-CL")} filas`}</span>
      <button class="edit" data-remove-file="${i}" title="Quitar" aria-label="Quitar ${esc(p.name)}">✕</button>
    </li>`;
  }).join("");
  const n = preview?.txs.length || 0;
  const dates = n ? preview.txs.map((t) => t.date).sort() : [];
  $("#uploadSummary").textContent = n
    ? `${n.toLocaleString("es-CL")} movimientos · ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}`
    : PENDING.length ? "Ninguno de los archivos tiene movimientos reconocibles." : "";
  $("#btnStart").disabled = !n;
  const c = configCounts();
  $("#cfgInfo").textContent = c.renamed + c.categorized + c.internal + c.tags
    ? `Configuración guardada en este navegador: ${c.renamed} comercios renombrados, ${c.categorized} con categoría propia, ${c.internal} con tipo propio, ${c.tags} pagos etiquetados.`
    : "Aún no hay configuración guardada en este navegador. Puedes importar un respaldo.";
}
$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("#fileList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove-file]");
  if (b) { PENDING.splice(Number(b.dataset.removeFile), 1); renderUpload(); }
});
$("#btnStart").addEventListener("click", () => {
  if (!preview?.txs.length) return;
  state.from = state.to = ""; // el rango se ajusta a los nuevos datos
  hideUpload();
  showData(preview);
});
$("#btnCancelUpload").addEventListener("click", hideUpload);
// arrastrar y soltar en cualquier parte de la pantalla de carga
for (const ev of ["dragenter", "dragover"]) $("#upload").addEventListener(ev, (e) => { e.preventDefault(); $("#drop").classList.add("over"); });
for (const ev of ["dragleave", "drop"]) $("#upload").addEventListener(ev, (e) => { e.preventDefault(); $("#drop").classList.remove("over"); });
$("#upload").addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// ---------- respaldo de configuración ----------
function openConfig() {
  const c = configCounts();
  $("#cfgSummary").innerHTML = `<b>${c.renamed}</b> comercios renombrados · <b>${c.categorized}</b> con categoría propia · <b>${c.internal}</b> con tipo propio · <b>${c.tags}</b> pagos etiquetados${SETTINGS.monthlyBudget ? ` · presupuesto ${fmt(SETTINGS.monthlyBudget)}` : ""}`;
  $("#cfgDlg").showModal();
}
async function importConfig(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("⚠ El archivo no es un JSON válido"); }
  // acepta un respaldo completo o un antiguo config/comercios.json / etiquetas.json / ajustes.json
  const looksLike = (o, keys) => o && typeof o === "object" && Object.values(o).some((v) => v && typeof v === "object" && keys.some((k) => k in v));
  let com = {}, eti = {}, aju = {};
  if (data.comercios || data.etiquetas || data.ajustes) ({ comercios: com = {}, etiquetas: eti = {}, ajustes: aju = {} } = data);
  else if ("presupuestoMensual" in data) aju = data;
  else if (looksLike(data, ["nombre", "original"])) com = data;
  else if (looksLike(data, ["nota", "categoria", "tipo"])) eti = data;
  else return toast("⚠ No reconozco ese archivo de configuración");
  Object.assign(MERCH_RULES, mapEntries(com, FROM_ES));
  Object.assign(TAGS, mapEntries(eti, FROM_ES));
  Object.assign(SETTINGS, renameKeys(aju, FROM_ES));
  saveConfig();
  if (RAW.length) { applyTags(); renderAll(); }
  if (!$("#upload").hidden) renderUpload();
  $("#cfgDlg").close();
  toast(`✓ Configuración importada: ${Object.keys(com).length} comercios, ${Object.keys(eti).length} etiquetas`, 4000);
}
$("#btnConfig").addEventListener("click", openConfig);
$("#btnConfigUpload").addEventListener("click", openConfig);
$("#cfgExport").addEventListener("click", () => {
  downloadFile(`finanzas-configuracion-${iso(new Date())}.json`, JSON.stringify(configSnapshot(), null, 2), "application/json");
  toast("✓ Respaldo de configuración descargado");
});
$("#cfgImport").addEventListener("change", (e) => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ""; });
$("#cfgClear").addEventListener("click", () => {
  if (!confirm("¿Borrar todos los renombres, categorías, etiquetas y presupuesto guardados en este navegador?\n\nTe recomiendo descargar un respaldo antes.")) return;
  MERCH_RULES = {}; TAGS = {}; SETTINGS = {};
  saveConfig();
  if (RAW.length) { applyTags(); renderAll(); }
  if (!$("#upload").hidden) renderUpload();
  $("#cfgDlg").close();
  toast("Configuración borrada");
});
$("#cfgClose").addEventListener("click", () => $("#cfgDlg").close());

// ---------- render general ----------
function renderAll() {
  $("#from").value = state.from;
  $("#to").value = state.to;
  document.querySelectorAll("#gran button").forEach((b) => b.classList.toggle("on", b.dataset.gran === state.gran));
  document.querySelectorAll("[data-dim]").forEach((seg) =>
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.dims[seg.dataset.dim])));
  renderChips();
  const rows = TX.filter(inRange);
  renderKpis(rows);
  renderInsights(rows);
  renderBar(rows);
  renderPie(rows);
  renderStack(rows);
  renderLine(rows);
  renderMerchChart(rows);
  renderTop(rows);
  renderCalendar(rows);
  renderHeat(rows);
  renderRecurring();
  renderMerchTable(rows);
  if (detail) renderDetail();
  lockInputs();
}

function renderChips() {
  const cats = ORDER.category;
  $("#catChips").innerHTML = cats
    .map((c) => `<span class="chip ${state.hidden.has(c) ? "off" : ""}" data-cat="${esc(c)}" role="button" tabindex="0" aria-pressed="${!state.hidden.has(c)}"><span class="dot" style="background:${catColor(dimOf({ category: c }, "category"))}"></span>${esc(c)}</span>`)
    .join("");
}

// ---------- KPIs ----------
function renderKpis(rows) {
  const sp = rows.filter(isSpend);
  const gastos = sum(sp, spend);
  const ingresosRows = rows.filter((t) => t.kind === "ingreso");
  const ingresos = sum(ingresosRows, (t) => t.amount);
  const sueldo = sum(ingresosRows.filter((t) => t.category === "Sueldo"), (t) => t.amount);
  const rend = sum(ingresosRows.filter((t) => t.category === "Rendimientos"), (t) => t.amount);
  const beneficios = sum(rows.filter((t) => t.kind === "beneficio"), (t) => t.amount);
  const neto = ingresos + beneficios - gastos;
  const days = daysBetween(state.from, state.to);
  const nMerch = new Set(sp.map((t) => t.merchant)).size;

  // mes en curso (según el último dato disponible) vs. mismo tramo del mes anterior
  const curM = MAX_DATE.slice(0, 7);
  const dayN = Number(MAX_DATE.slice(8));
  const dim = new Date(Date.UTC(+curM.slice(0, 4), +curM.slice(5, 7), 0)).getUTCDate();
  const allSpend = TX.filter(isSpend);
  const mtd = sum(allSpend.filter((t) => t.date.startsWith(curM)), spend);
  const prev = D(curM + "-01"); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevM = iso(prev).slice(0, 7);
  const prevSame = sum(allSpend.filter((t) => t.date.startsWith(prevM) && Number(t.date.slice(8)) <= dayN), spend);
  const projection = (mtd / dayN) * dim;
  const budget = Number(SETTINGS.monthlyBudget) || 0;
  const delta = prevSame ? mtd / prevSame - 1 : 0;

  // saldo disponible al cierre del periodo (solo existe con el reporte de liberaciones)
  const withBalance = TX.filter((t) => t.balance !== null && t.date <= state.to);
  const lastBal = withBalance.length ? withBalance.reduce((a, t) => (t.date + t.time >= a.date + a.time ? t : a)) : null;
  const toPots = -sum(rows.filter((t) => t.kind === "ahorro"), (t) => t.amount);
  const transfers = sum(sp.filter((t) => t.category === "Transferencias enviadas"), spend);

  const tile = (label, value, foot) => `<div class="kpi"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-foot">${foot}</div></div>`;
  $("#kpis").innerHTML = [
    tile("Gasto total", fmt(gastos), `${sp.length} pagos a ${nMerch} destinos${transfers ? ` · ${fmt(transfers)} en transferencias` : ""}`),
    tile("Ingresos", fmt(ingresos), sueldo ? `sueldo ${fmt(sueldo)} · otros ${fmt(ingresos - sueldo)}` : `incluye ${fmt(rend)} en rendimientos`),
    tile("Ahorro neto", fmt(neto), (ingresos ? `tasa de ahorro <b class="${neto >= 0 ? "down" : "up"}">${pct(neto / ingresos)}</b>` : "sin ingresos en el periodo") + (toPots ? ` · ${fmt(toPots)} ${toPots > 0 ? "a" : "sacado de"} apartados` : "")),
    ...(lastBal ? [tile("Saldo disponible", fmt(lastBal.balance), `al ${fmtDate(lastBal.date)} · sin contar apartados`)] : []),
    tile("Gasto diario promedio", fmt(gastos / days), `≈ ${fmt((gastos / days) * 30)} al mes · ${days} días`),
    tile("Cashback + rendimientos", fmt(beneficios + rend), `cashback ${fmt(beneficios)} · rendimientos ${fmt(rend)}`),
    `<div class="kpi budget">
      <div class="k-label">Mes en curso (${MONTHS[+curM.slice(5) - 1]})</div>
      <div class="k-value">${fmt(mtd)}</div>
      <div class="k-foot">${prevSame ? `<span class="${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲" : "▼"} ${pct(Math.abs(delta))}</span> vs. mismos ${dayN} días del mes anterior` : ""}</div>
      <div class="k-foot">Proyección a fin de mes: <b>${fmt(projection)}</b></div>
      ${budget ? `<div class="bar-track" title="${pct(mtd / budget)} del presupuesto"><div class="bar-fill ${mtd > budget ? "over" : ""}" style="width:${Math.min(100, (mtd / budget) * 100)}%"></div></div>
      <div class="k-foot">${projection > budget ? "⚠ A este ritmo superarás" : "✓ Vas dentro de"} tu presupuesto</div>` : ""}
      <div class="k-foot">Presupuesto mensual: ${HIDE_AMOUNTS ? `<b>${budget ? fmt(budget) : "—"}</b>` : `<input type="number" id="budget" min="0" step="10000" value="${budget || ""}" placeholder="definir" />`}</div>
    </div>`,
  ].join("");
}

// ---------- ideas para optimizar ----------
function renderInsights(rows) {
  const out = [];
  const sp = rows.filter(isSpend);
  const total = sum(sp, spend);
  if (!total) { $("#insights").innerHTML = `<li class="empty">No hay gastos en el periodo seleccionado.</li>`; return; }
  const months = Math.max(1, daysBetween(state.from, state.to) / 30.44);

  const byCat = Object.entries(groupSum(sp, (t) => t.category, spend)).sort((a, b) => b[1] - a[1]);
  const [topCat, topCatVal] = byCat[0];
  out.push(["🏷️", `<b>${esc(topCat)}</b> es tu mayor categoría: <b>${pct(topCatVal / total)}</b> del gasto (${fmt(topCatVal / months)} al mes).`]);

  const byMerch = [...groupBy(sp, (t) => t.merchant)].map(([m, l]) => ({ m, l, s: sum(l, spend) })).sort((a, b) => b.s - a.s);
  const tm = byMerch[0];
  out.push(["🏪", `Donde más gastas es <b>${esc(tm.m)}</b>: ${tm.l.length} pago${tm.l.length > 1 ? "s" : ""} por <b>${fmt(tm.s)}</b> (ticket promedio ${fmt(tm.s / tm.l.length)}).`]);

  const delivery = sp.filter((t) => t.category === "Comida y delivery");
  if (delivery.length >= 3) {
    const d = sum(delivery, spend);
    out.push(["🛵", `<b>Comida y delivery</b>: ${delivery.length} compras por ${fmt(d)} (≈ ${fmt(d / months)} al mes). Reducir un tercio te ahorraría <b>~${fmt(d / months / 3)} al mes</b>.`]);
  }

  const transport = sp.filter((t) => t.category === "Transporte");
  const uber = transport.filter((t) => /uber|cabify|didi/i.test(t.merchant));
  if (uber.length >= 3) {
    const u = sum(uber, spend);
    out.push(["🚗", `Gastaste <b>${fmt(u)}</b> en ${uber.length} viajes de app (Uber, Cabify, DiDi), con un promedio de ${fmt(u / uber.length)} por viaje. Es ${pct(u / Math.max(1, sum(transport, spend)))} de tu gasto en transporte.`]);
  }

  const subs = sp.filter((t) => t.category === "Suscripciones y entretenimiento");
  if (subs.length) {
    const names = [...new Set(subs.map((t) => t.merchant))];
    out.push(["📺", `Suscripciones y entretenimiento: <b>${fmt(sum(subs, spend) / months)} al mes</b> (${names.slice(0, 4).map(esc).join(", ")}${names.length > 4 ? "…" : ""}). Revisa si las usas todas.`]);
  }

  const sorted = [...sp].sort((a, b) => spend(b) - spend(a));
  out.push(["🎯", `Tus <b>10 pagos más grandes</b> suman el <b>${pct(sum(sorted.slice(0, 10), spend) / total)}</b> del gasto. Optimizar pocos pagos grandes rinde más que recortar muchos chicos.`]);

  const hormiga = sp.filter((t) => spend(t) > 0 && spend(t) < 5000);
  if (hormiga.length) out.push(["🐜", `<b>Gastos hormiga</b> (menos de $5.000): ${hormiga.length} pagos por <b>${fmt(sum(hormiga, spend))}</b>. Al año serían ~${fmt((sum(hormiga, spend) / daysBetween(state.from, state.to)) * 365)}.`]);

  const byWd = Array(7).fill(0);
  sp.forEach((t) => (byWd[weekday(t.date)] += spend(t)));
  const wdMax = byWd.indexOf(Math.max(...byWd));
  out.push(["📅", `Los <b>${["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"][wdMax]}</b> son tu día de más gasto (${pct(byWd[wdMax] / total)} del total).`]);

  const fixed = findRecurring().filter((r) => r.fixed && r.months >= 2);
  if (fixed.length) {
    const monthly = fixed.reduce((a, r) => a + r.total / r.months, 0);
    out.push(["📌", `Tienes <b>${fixed.length} pagos fijos</b> que suman <b>~${fmt(monthly)} al mes</b> (${fixed.slice(0, 3).map((r) => `${esc(r.m)} ${fmt(r.l[0] ? spend(r.l[0]) : 0)}`).join(", ")}${fixed.length > 3 ? "…" : ""}). Son el piso de tu gasto mensual.`]);
  }

  const unnamed = sp.filter((t) => t.category === "Transferencias enviadas" && /^Cuenta terminada en /.test(t.merchant));
  if (unnamed.length) {
    const nAcc = new Set(unnamed.map((t) => t.merchant)).size;
    out.push(["🏦", `Enviaste <b>${fmt(sum(unnamed, spend))}</b> a ${nAcc} cuentas bancarias sin nombre. <a href="#" data-action="name-accounts">Ponles nombre</a> (ej. "Arriendo"). Si alguna es tuya, márcala como <i>Interno</i> para no contarla como gasto.`]);
  }

  const other = sp.filter((t) => ["Otros comercios", "Pagos y transferencias"].includes(t.category));
  if (other.length) {
    const nm = new Set(other.map((t) => t.merchant)).size;
    out.push(["✏️", `Hay <b>${nm} comercios sin categoría</b> (${fmt(sum(other, spend))}). <a href="#" data-action="tag-other">Clasifícalos</a> y el análisis será más preciso.`]);
  }

  const ingresos = sum(rows.filter((t) => t.kind === "ingreso"), (t) => t.amount);
  if (ingresos) {
    const rate = (ingresos - total) / ingresos;
    out.push([rate >= 0.2 ? "✅" : "⚠️", rate >= 0.2
      ? `Estás ahorrando el <b>${pct(rate)}</b> de lo que entra. Supera el 20% recomendado: considera invertir el excedente.`
      : `Tu tasa de ahorro es <b>${pct(rate)}</b>. La regla 50/30/20 sugiere apartar al menos el 20% de tus ingresos.`]);
  }
  $("#insights").innerHTML = out.map(([i, h]) => `<li><span class="ico">${i}</span><span>${h}</span></li>`).join("");
}

// ---------- configuración común de ECharts ----------
function chart(id) {
  if (!charts[id]) {
    charts[id] = echarts.init(document.getElementById(id));
    charts[id].on("click", (p) => clickHandlers[id]?.(p));
  }
  return charts[id];
}
function base() {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: css("--ink-2") },
    grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: css("--surface"),
      borderColor: css("--border"),
      textStyle: { color: css("--ink"), fontSize: 12.5 },
      extraCssText: "box-shadow:0 6px 24px rgba(0,0,0,.15);border-radius:8px;max-width:360px;white-space:normal;",
    },
    animationDuration: 400,
  };
}
const axisX = (data) => ({
  type: "category", data,
  axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
  axisLabel: { color: css("--muted"), hideOverlap: true },
});
const axisY = () => ({
  type: "value",
  axisLabel: { color: css("--muted"), formatter: (v) => cmp(v) },
  splitLine: { lineStyle: { color: css("--grid") } },
});
const legend = () => ({ top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: css("--ink-2") }, type: "scroll" });
const zoom = (n) => (n > 40 ? [{ type: "inside", start: Math.max(0, 100 - (40 / n) * 100), end: 100 }] : []);
const muted = (s) => `<span style="color:${css("--muted")}">${s}</span>`;

/** Resumen de los comercios principales dentro de un grupo de pagos (para tooltips). */
function topMerchantsHtml(list, n = 4) {
  const by = Object.entries(groupSum(list, (t) => t.merchant, spend)).sort((a, b) => b[1] - a[1]);
  if (!by.length) return "";
  return "<br>" + by.slice(0, n).map(([m, v]) => `· ${esc(m)} ${muted(fmt(v))}`).join("<br>") + (by.length > n ? `<br>${muted(`+ ${by.length - n} más`)}` : "");
}

// ---------- barras: gasto por periodo ----------
function renderBar(rows) {
  const g = state.gran;
  const keys = periodsBetween(state.from, state.to, g);
  const sp = rows.filter(isSpend);
  const groups = groupBy(sp, (t) => periodKey(t.date, g));
  const vals = keys.map((k) => Math.round(sum(groups.get(k) || [], spend)));
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const budget = g === "mes" ? Number(SETTINGS.monthlyBudget) || 0 : 0;
  $("#tBar").textContent = `Gasto por ${GRAN_LABEL[g]}`;

  const markData = [{ yAxis: avg, name: "Promedio", label: { formatter: `Prom. ${cmp(avg)}`, color: css("--ink-2"), position: "insideEndTop" }, lineStyle: { color: css("--muted") } }];
  if (budget) markData.push({ yAxis: budget, name: "Presupuesto", label: { formatter: `Presupuesto ${cmp(budget)}`, color: css("--bad"), position: "insideStartTop" }, lineStyle: { color: css("--bad") } });

  chart("cBar").setOption({
    ...base(),
    tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => {
        const p = ps[0]; const v = p.value; const d = avg ? v / avg - 1 : 0;
        return `<b>${p.name}</b> · ${fmt(v)}<br>${muted(`${d >= 0 ? "+" : ""}${pct(d)} vs. promedio${budget && v > budget ? " · ⚠ sobre presupuesto" : ""}`)}${topMerchantsHtml(groups.get(keys[p.dataIndex]) || [])}`;
      } },
    xAxis: axisX(keys.map((k) => periodLabel(k, g))),
    yAxis: axisY(),
    dataZoom: zoom(keys.length),
    series: [{
      type: "bar", data: vals.map((v) => ({ value: v, itemStyle: { color: budget && v > budget ? css("--bad") : css("--s1") } })),
      barMaxWidth: 36, itemStyle: { borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { opacity: 0.85 } },
      markLine: { symbol: "none", silent: true, lineStyle: { type: "solid", width: 1 }, data: markData },
    }],
  }, true);
  clickHandlers.cBar = (p) => openDetail(`Gastos · ${periodLabel(keys[p.dataIndex], g)}`, (t) => isSpend(t) && periodKey(t.date, g) === keys[p.dataIndex]);
}

// ---------- torta (dimensión elegible) ----------
function renderPie(rows) {
  const dim = state.dims.pie;
  const sp = rows.filter(isSpend);
  const groups = groupBy(sp, (t) => dimOf(t, dim));
  const total = sum(sp, spend);
  const data = dimValues(dim).filter((v) => groups.has(v))
    .map((v) => ({ name: v, value: Math.round(sum(groups.get(v), spend)), itemStyle: { color: colorOf(dim, v) } }))
    .filter((d) => d.value > 0);
  chart("cPie").setOption({
    ...base(),
    tooltip: { ...base().tooltip, trigger: "item",
      formatter: (p) => `${p.marker} <b>${esc(p.name)}</b><br>${fmt(p.value)} · ${p.percent}% · ${groups.get(p.name).length} pagos${dim !== "merchant" ? topMerchantsHtml(groups.get(p.name)) : ""}` },
    title: { text: cmp(total), subtext: "gasto total", left: "center", top: "41%",
      textStyle: { color: css("--ink"), fontSize: 22, fontWeight: 650 }, subtextStyle: { color: css("--muted") } },
    series: [{
      type: "pie", radius: ["52%", "74%"], center: ["50%", "50%"], data, minAngle: 2,
      itemStyle: { borderColor: css("--surface"), borderWidth: 2, borderRadius: 4 },
      label: { color: css("--ink-2"), formatter: (p) => `${p.name}\n${p.percent}%`, fontSize: 12, width: 120, overflow: "break" },
      labelLine: { lineStyle: { color: css("--axis") } },
      emphasis: { scale: true, scaleSize: 6 },
    }],
  }, true);
  clickHandlers.cPie = (p) => openDetail(`${p.name} · ${fmtDate(state.from)} – ${fmtDate(state.to)}`, (t) => isSpend(t) && dimOf(t, dim) === p.name);
}

// ---------- barras apiladas (dimensión elegible) ----------
function renderStack(rows) {
  const g = state.gran;
  const dim = state.dims.stack;
  const keys = periodsBetween(state.from, state.to, g);
  const sp = rows.filter(isSpend);
  const present = new Set(sp.map((t) => dimOf(t, dim)));
  $("#tStack").textContent = `Gasto por ${DIM_LABEL[dim]} y ${GRAN_LABEL[g]}`;
  const series = dimValues(dim).filter((v) => present.has(v)).map((v) => {
    const by = groupSum(sp.filter((t) => dimOf(t, dim) === v), (t) => periodKey(t.date, g), spend);
    return {
      name: v, type: "bar", stack: "g", data: keys.map((k) => Math.round(by[k] || 0)),
      barMaxWidth: 36, itemStyle: { color: colorOf(dim, v), borderColor: css("--surface"), borderWidth: 1 },
      emphasis: { focus: "series" },
    };
  });
  chart("cStack").setOption({
    ...base(),
    grid: { ...base().grid, top: 40 },
    legend: legend(),
    tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => {
        const tot = ps.reduce((a, p) => a + p.value, 0);
        return `<b>${ps[0].name}</b> · ${fmt(tot)}<br>${ps.filter((p) => p.value).sort((a, b) => b.value - a.value).map((p) => `${p.marker} ${esc(p.seriesName)}: ${fmt(p.value)} ${muted(`(${pct(p.value / tot)})`)}`).join("<br>")}`;
      } },
    xAxis: axisX(keys.map((k) => periodLabel(k, g))),
    yAxis: axisY(),
    dataZoom: zoom(keys.length),
    series,
  }, true);
  clickHandlers.cStack = (p) => {
    const k = keys[p.dataIndex];
    openDetail(`${p.seriesName} · ${periodLabel(k, g)}`, (t) => isSpend(t) && dimOf(t, dim) === p.seriesName && periodKey(t.date, g) === k);
  };
}

// ---------- líneas: ingresos vs gastos ----------
function renderLine(rows) {
  const g = state.gran;
  const keys = periodsBetween(state.from, state.to, g);
  const gas = groupSum(rows.filter(isSpend), (t) => periodKey(t.date, g), spend);
  const ing = groupSum(rows.filter((t) => t.kind === "ingreso"), (t) => periodKey(t.date, g), (t) => t.amount);
  $("#tLine").textContent = `Ingresos vs. gastos por ${GRAN_LABEL[g]}`;
  const mk = (name, by, color) => ({
    name, type: "line", data: keys.map((k) => Math.round(by[k] || 0)),
    smooth: 0.25, symbol: "circle", symbolSize: 8, showSymbol: keys.length <= 40,
    lineStyle: { width: 2, color }, itemStyle: { color, borderColor: css("--surface"), borderWidth: 2 },
    endLabel: { show: true, formatter: "{a}", color: css("--ink-2") },
    emphasis: { focus: "series" },
  });
  chart("cLine").setOption({
    ...base(),
    grid: { ...base().grid, right: 70 },
    legend: legend(),
    tooltip: { ...base().tooltip, trigger: "axis",
      formatter: (ps) => {
        const g0 = ps.find((p) => p.seriesName === "Gastos")?.value || 0;
        const i0 = ps.find((p) => p.seriesName === "Ingresos")?.value || 0;
        return `<b>${ps[0].name}</b><br>${ps.map((p) => `${p.marker} ${p.seriesName}: ${fmt(p.value)}`).join("<br>")}<br>${muted(`Neto: ${fmt(i0 - g0)}`)}`;
      } },
    xAxis: { ...axisX(keys.map((k) => periodLabel(k, g))), boundaryGap: false },
    yAxis: axisY(),
    dataZoom: zoom(keys.length),
    series: [mk("Gastos", gas, css("--s1")), mk("Ingresos", ing, css("--s2")), ...(balanceSeries(keys, g, mk))],
  }, true);
  clickHandlers.cLine = (p) => {
    const k = keys[p.dataIndex];
    const f = p.seriesName === "Gastos" ? isSpend : (t) => t.kind === "ingreso";
    openDetail(`${p.seriesName} · ${periodLabel(k, g)}`, (t) => f(t) && periodKey(t.date, g) === k);
  };
}

/** Saldo disponible al cierre de cada periodo (último saldo conocido). */
function balanceSeries(keys, g, mk) {
  const withBal = TX.filter((t) => t.balance !== null).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  if (!withBal.length) return [];
  const end = {};
  for (const t of withBal) end[periodKey(t.date, g)] = t.balance;
  let last = null;
  const first = withBal[0].date;
  const byKey = {};
  // arrastra el último saldo hacia periodos sin movimientos
  for (const t of withBal) if (t.date < state.from) last = t.balance;
  for (const k of keys) { if (k in end) last = end[k]; byKey[k] = last ?? (k < periodKey(first, g) ? 0 : null); }
  const s = mk("Saldo", byKey, css("--s3"));
  s.lineStyle.width = 1.5;
  s.areaStyle = { opacity: 0.08, color: css("--s3") };
  return [s];
}

// ---------- ranking de comercios ----------
function renderMerchChart(rows) {
  const sp = rows.filter(isSpend);
  const total = sum(sp, spend);
  const ranked = [...groupBy(sp, (t) => t.merchant)].map(([m, l]) => ({ m, l, s: sum(l, spend) })).sort((a, b) => b.s - a.s).slice(0, 15).reverse();
  chart("cMerch").setOption({
    ...base(),
    grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...base().tooltip, trigger: "item",
      formatter: (p) => {
        const r = ranked[p.dataIndex];
        const cats = [...new Set(r.l.map((t) => t.category))].join(", ");
        return `<b>${esc(r.m)}</b><br>${fmt(r.s)} · ${pct(r.s / total)} del gasto<br>${r.l.length} pago${r.l.length > 1 ? "s" : ""} · ticket prom. ${fmt(r.s / r.l.length)}<br>${muted(esc(cats))}`;
      } },
    xAxis: { ...axisY(), splitLine: { show: false }, axisLabel: { show: false } },
    yAxis: { type: "category", data: ranked.map((r) => r.m), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: css("--ink-2"), width: 170, overflow: "truncate" } },
    series: [{
      type: "bar", barMaxWidth: 18,
      data: ranked.map((r) => ({ value: Math.round(r.s), itemStyle: { color: catColor(dimOf(r.l[0], "category")) } })),
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: "right", color: css("--ink-2"), formatter: (p) => cmp(p.value) },
    }],
  }, true);
  clickHandlers.cMerch = (p) => openMerchant(ranked[p.dataIndex].m);
}

// ---------- top 10 ----------
function renderTop(rows) {
  const top = rows.filter(isSpend).sort((a, b) => spend(b) - spend(a)).slice(0, 10);
  const max = top.length ? spend(top[0]) : 1;
  $("#topList").innerHTML = top.length ? top.map((t, i) => {
    const color = catColor(dimOf(t, "category"));
    return `<li data-id="${esc(t.id)}" tabindex="0">
      <span class="rank">${i + 1}</span>
      <span><span class="who">${esc(t.merchant)}</span>${editBtn(t)}${t.detail ? `<div class="what" title="${esc(t.detail)}">${esc(t.detail)}</div>` : ""}<div class="meta">${fmtDate(t.date)} · ${esc(t.category)} · ${esc(t.channel)}</div></span>
      <span class="amt">${fmt(spend(t))}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(spend(t) / max) * 100}%;background:${color}"></div></div>
    </li>`;
  }).join("") : `<li class="empty">Sin gastos en el periodo</li>`;
}

// ---------- escala por tramos para mapas de calor ----------
// Con una escala lineal, unos pocos días enormes (arriendo, transferencias del día 1) dejan
// todo lo demás casi en blanco. Los tramos se cortan por cuantiles: cada color agrupa una
// cantidad parecida de celdas, así se distinguen los días normales entre sí.
const HEAT_TIERS = 14; // cantidad de tramos de color en los mapas de calor
// Escala verde → amarillo → rojo (ColorBrewer RdYlGn invertida): verde = poco gasto, rojo = mucho.
const HEAT_STOPS = ["#1a9850", "#66bd63", "#a6d96a", "#d9ef8b", "#fee08b", "#fdae61", "#f46d43", "#d73027", "#a50026"];

/** Genera n tonos interpolando la escala verde → rojo. */
function seqRamp(n) {
  const stops = HEAT_STOPS.map((hex) => hex.match(/\w\w/g).map((h) => parseInt(h, 16)));
  return Array.from({ length: n }, (_, i) => {
    const x = n === 1 ? stops.length - 1 : (i / (n - 1)) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(x));
    const f = x - j;
    return "#" + stops[j].map((c, k) => Math.round(c + (stops[j + 1][k] - c) * f).toString(16).padStart(2, "0")).join("");
  });
}

function quantilePieces(values, isMoney) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [{ min: 0, max: 0, color: HEAT_STOPS[0], label: "sin datos" }];
  const q = (p) => v[Math.min(v.length - 1, Math.round(p * (v.length - 1)))];
  const probs = Array.from({ length: HEAT_TIERS - 1 }, (_, i) => (i + 1) / HEAT_TIERS);
  // con pocos valores distintos (ej. N° de pagos) pueden quedar menos tramos
  const breaks = [...new Set(probs.map(q))].filter((b) => b < v.at(-1));
  const label = (n) => (isMoney ? `$${cmp(n)}` : String(n));
  const pieces = [];
  let lo = 0;
  for (const b of breaks) {
    pieces.push({ gt: lo, lte: b, label: lo === 0 ? `hasta ${label(b)}` : `${label(lo)} – ${label(b)}` });
    lo = b;
  }
  pieces.push({ gt: lo, label: lo === 0 ? `hasta ${label(v.at(-1))}` : `más de ${label(lo)}` });
  const colors = seqRamp(pieces.length);
  pieces.forEach((p, i) => (p.color = colors[i]));
  return pieces;
}
const heatLegend = (pieces, pos) => ({
  type: "piecewise", pieces, orient: "vertical", ...pos, itemWidth: 12, itemHeight: 9, itemGap: 3,
  textStyle: { color: css("--muted"), fontSize: 10.5 }, dimension: pos.dimension,
});
const heatValue = (list) => (state.heatMetric === "count" ? list.length : Math.round(sum(list, spend)));
const heatTip = (list) => `${fmt(sum(list, spend))} · ${list.length} pago${list.length === 1 ? "" : "s"}`;

// ---------- calendario ----------
function renderCalendar(rows) {
  const groups = groupBy(rows.filter(isSpend), (t) => t.date);
  const data = [...groups].map(([d, l]) => [d, heatValue(l)]).filter((d) => d[1] > 0);
  const pieces = quantilePieces(data.map((d) => d[1]), state.heatMetric !== "count");
  const el = document.getElementById("cCal");
  const weeks = Math.ceil(daysBetween(state.from, state.to) / 7) + 1;
  // deja espacio a la derecha para la leyenda vertical de tramos
  const cell = Math.max(10, Math.min(24, Math.floor((el.clientWidth - 220) / weeks)));
  chart("cCal").setOption({
    ...base(),
    tooltip: { ...base().tooltip, formatter: (p) => { const l = groups.get(p.value[0]) || []; return `<b>${fmtDate(p.value[0])}</b> (${WEEKDAYS[weekday(p.value[0])]}) · ${heatTip(l)}${topMerchantsHtml(l)}`; } },
    visualMap: heatLegend(pieces, { right: 0, top: "middle", dimension: 1 }),
    calendar: {
      range: [state.from, state.to], cellSize: [cell, cell], top: 22, left: 40,
      itemStyle: { color: css("--seq-empty"), borderColor: css("--surface"), borderWidth: 2 },
      splitLine: { show: false },
      dayLabel: { firstDay: 1, nameMap: ["D", "L", "M", "M", "J", "V", "S"], color: css("--muted") },
      monthLabel: { nameMap: MONTHS, color: css("--ink-2") },
      yearLabel: { show: false },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderColor: css("--surface"), borderWidth: 2, borderRadius: 3 } }],
  }, true);
  clickHandlers.cCal = (p) => p.value && openDetail(`Gastos del ${fmtDate(p.value[0])}`, (t) => isSpend(t) && t.date === p.value[0]);
}

// ---------- mapa de calor día × hora ----------
function renderHeat(rows) {
  const groups = groupBy(rows.filter(isSpend), (t) => `${t.hour}|${weekday(t.date)}`);
  const data = [...groups].map(([k, l]) => { const [h, w] = k.split("|").map(Number); return [h, w, heatValue(l)]; });
  const pieces = quantilePieces(data.map((d) => d[2]), state.heatMetric !== "count");
  chart("cHeat").setOption({
    ...base(),
    grid: { left: 8, right: 132, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...base().tooltip, formatter: (p) => { const l = groups.get(`${p.value[0]}|${p.value[1]}`) || []; return `<b>${WEEKDAYS[p.value[1]]} ${p.value[0]}:00–${p.value[0]}:59</b> · ${heatTip(l)}${topMerchantsHtml(l, 3)}`; } },
    xAxis: { ...axisX(Array.from({ length: 24 }, (_, i) => `${i}h`)), axisLabel: { color: css("--muted"), interval: 2 } },
    yAxis: { type: "category", data: WEEKDAYS, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: css("--muted") } },
    visualMap: heatLegend(pieces, { right: 0, top: "middle", dimension: 2 }),
    series: [{ type: "heatmap", data, itemStyle: { borderColor: css("--surface"), borderWidth: 2, borderRadius: 3 } }],
  }, true);
  clickHandlers.cHeat = (p) => openDetail(`Gastos · ${WEEKDAYS[p.value[1]]} entre ${p.value[0]}:00 y ${p.value[0]}:59`, (t) => isSpend(t) && t.hour === p.value[0] && weekday(t.date) === p.value[1]);
}

// ---------- gastos recurrentes por comercio ----------
function findRecurring() {
  const lastMonth = MAX_DATE.slice(0, 7);
  const monthsFrom = (m) => (+lastMonth.slice(0, 4) - +m.slice(0, 4)) * 12 + (+lastMonth.slice(5) - +m.slice(5)) + 1;
  return [...groupBy(TX.filter((t) => t.kind === "gasto"), (t) => t.merchant)]
    .map(([m, l]) => {
      const amounts = l.map(spend);
      const months = new Set(l.map((t) => t.date.slice(0, 7))).size;
      const total = sum(l, spend);
      const fixed = Math.max(...amounts) <= Math.min(...amounts) * 1.1;
      // meses desde el primer pago hasta el último dato: evita diluir pagos que empezaron hace poco
      const span = monthsFrom(l.map((t) => t.date).sort()[0].slice(0, 7));
      return { m, l, months, total, fixed, allMonths: span, annual: (total / span) * 12, last: l.map((t) => t.date).sort().at(-1) };
    })
    .filter((r) => r.months >= 3 || (r.months >= 2 && r.fixed && r.total >= 2000))
    .sort((a, b) => b.annual - a.annual);
}
function renderRecurring() {
  const rec = findRecurring();
  $("#recTable").innerHTML = rec.length ? `
    <thead><tr><th>Comercio</th><th>Categoría</th><th class="num">Meses</th><th class="num">Pagos</th><th>Tipo</th><th class="num">Promedio mensual</th><th class="num">Costo anual est.</th></tr></thead>
    <tbody>${rec.map((r, i) => `<tr class="click" data-rec="${i}">
      <td><span class="who">${esc(r.m)}</span>${editBtn(r.l[0])}<div class="what">último: ${fmtDate(r.last)}</div></td>
      <td>${pill(r.l[0].category)}</td>
      <td class="num">${r.months} de ${r.allMonths}</td>
      <td class="num">${r.l.length}</td>
      <td><span class="badge">${r.fixed ? "Monto fijo" : "Variable"}</span></td>
      <td class="num">${fmt(r.total / r.allMonths)}</td>
      <td class="num"><b>${fmt(r.annual)}</b></td>
    </tr>`).join("")}</tbody>` : `<tbody><tr><td class="empty">No se detectaron gastos repetidos.</td></tr></tbody>`;
  $("#recTable").onclick = (e) => {
    const tr = e.target.closest("tr[data-rec]");
    if (tr) openMerchant(rec[Number(tr.dataset.rec)].m, true);
  };
}
const pill = (cat) => `<span class="pill"><span class="dot" style="background:${catColor(dimOf({ category: cat }, "category"))}"></span>${esc(cat)}</span>`;

// ---------- tabla de comercios (renombrar / categorizar) ----------
let merchSort = { key: "total", dir: -1 };
function renderMerchTable(rows) {
  const q = $("#mSearch").value.trim().toLowerCase();
  // gastos + salidas marcadas como internas (para poder desmarcarlas)
  const sp = rows.filter((t) => t.amount < 0 && (isSpend(t) || t.kind === "interno"));
  const total = sum(rows.filter(isSpend), spend) || 1;
  let list = [...groupBy(sp, (t) => t.merchant)].map(([m, l]) => {
    const s = sum(l, spend);
    const top = (f) => Object.entries(groupSum(l, f, () => 1)).sort((a, b) => b[1] - a[1])[0][0];
    return { m, l, total: s, n: l.length, avg: s / l.length, last: l.map((t) => t.date).sort().at(-1), channel: top((t) => t.channel), category: top((t) => t.category), kind: top((t) => t.kind) };
  });
  if (q) list = list.filter((r) => [r.m, r.category, ...r.l.map((t) => t.detail)].join(" ").toLowerCase().includes(q));
  const k = merchSort.key;
  list.sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k], "es") : a[k] - b[k]) * merchSort.dir);
  const maxT = Math.max(1, ...list.map((r) => r.total));
  const arrow = (key) => (merchSort.key === key ? (merchSort.dir > 0 ? " ▲" : " ▼") : "");
  $("#merchTable").innerHTML = list.length ? `
    <thead><tr>
      <th data-msort="m">Comercio / destinatario${arrow("m")}</th>
      <th data-msort="category">Categoría${arrow("category")}</th>
      <th data-msort="kind">Tipo${arrow("kind")}</th>
      <th class="num" data-msort="n">Pagos${arrow("n")}</th>
      <th class="num" data-msort="total">Total${arrow("total")}</th>
      <th data-msort="total">% del gasto</th>
      <th class="num" data-msort="avg">Ticket prom.${arrow("avg")}</th>
      <th data-msort="last">Último${arrow("last")}</th>
      <th>Medio habitual</th>
      <th></th>
    </tr></thead>
    <tbody>${list.map((r) => `<tr data-merchant="${esc(r.m)}">
      <td><input data-mf="name" value="${esc(r.m)}" placeholder="vacío = nombre original" title="Nombre original: ${esc([...new Set(r.l.map((t) => t.baseMerchant))].join(", "))}" aria-label="Nombre del comercio" /></td>
      <td><input data-mf="category" list="catList" value="${esc(r.category)}" aria-label="Categoría" /></td>
      <td><select data-mf="kind" aria-label="Tipo"><option value="gasto" ${r.kind === "gasto" ? "selected" : ""}>Gasto</option><option value="interno" ${r.kind === "interno" ? "selected" : ""}>Interno (mi cuenta)</option></select></td>
      <td class="num">${r.n}</td>
      <td class="num"><b>${fmt(r.total)}</b></td>
      <td>${r.kind === "interno" ? `<span class="hint">no cuenta</span>` : `<span class="spark"><i style="width:${(r.total / maxT) * 100}%;background:${catColor(dimOf({ category: r.category }, "category"))}"></i></span> <span class="hint">${pct(r.total / total)}</span>`}</td>
      <td class="num">${fmt(r.avg)}</td>
      <td style="white-space:nowrap">${fmtDate(r.last)}</td>
      <td class="hint">${esc(r.channel)}</td>
      <td><button class="btn" data-open="${esc(r.m)}">Ver pagos →</button></td>
    </tr>`).join("")}</tbody>` : `<tbody><tr><td class="empty">Sin comercios para mostrar.</td></tr></tbody>`;
  lockInputs();
}

/**
 * Guarda una regla (nombre, categoría o tipo) para todos los comercios que se muestran con ese nombre.
 * Queda en config/comercios.json y se aplica en todo el dashboard.
 */
async function saveMerchantRule(displayName, field, value) {
  if (READONLY) return readonlyNotice();
  const keys = [...new Set(TX.filter((t) => t.merchant === displayName).map((t) => t.merchantKey))];
  if (!keys.length) return;
  const updates = {};
  for (const key of keys) {
    const sample = TX.find((t) => t.merchantKey === key);
    const cur = { ...(MERCH_RULES[key] || {}), original: sample.baseMerchant };
    if (field === "name") cur.name = value && value !== sample.baseMerchant ? value : "";
    if (field === "category") cur.category = value && value !== sample.baseCategory ? value : "";
    if (field === "kind") cur.kind = value && value !== sample.baseKind ? value : "";
    updates[key] = cur;
  }
  // si se cambia la categoría de todo el comercio, se limpian categorías puestas pago a pago
  if (field === "category") {
    const tagUpdates = {};
    for (const t of TX.filter((t) => t.merchant === displayName && TAGS[t.id]?.category)) tagUpdates[t.id] = { ...TAGS[t.id], category: "" };
    if (Object.keys(tagUpdates).length) await postTags(tagUpdates);
  }
  mergeUpdates(MERCH_RULES, updates);
  saveConfig();
  applyTags();
  renderAll();
  if (field === "name") toast(value ? `✓ "${displayName}" ahora se llama "${value}"` : `↺ Se restauró el nombre original`);
}

let toastT;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- renombrar comercio ----------
let renameTarget = null;
function openRename(merchantKey) {
  if (READONLY) return readonlyNotice();
  const sample = TX.find((t) => t.merchantKey === merchantKey);
  if (!sample) return;
  renameTarget = sample.merchant;
  const group = TX.filter((t) => t.merchant === renameTarget);
  const originals = [...new Set(group.map((t) => t.baseMerchant))];
  const renamed = originals.length > 1 || originals[0] !== renameTarget;
  $("#rTitle").textContent = `Renombrar "${renameTarget}"`;
  $("#rInfo").textContent = `${group.length} movimiento${group.length === 1 ? "" : "s"} · nombre original: ${originals.join(", ")}`;
  $("#rRestore").hidden = !renamed;
  $("#rInput").value = renameTarget;
  $("#renameDlg").showModal();
  $("#rInput").select();
}
$("#renameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("#rInput").value.trim();
  $("#renameDlg").close();
  if (renameTarget && value && value !== renameTarget) saveMerchantRule(renameTarget, "name", value);
});
$("#rRestore").addEventListener("click", () => {
  $("#renameDlg").close();
  if (renameTarget) saveMerchantRule(renameTarget, "name", "");
});
$("#rCancel").addEventListener("click", () => $("#renameDlg").close());
async function postTags(updates) {
  mergeUpdates(TAGS, updates);
  saveConfig();
}

// ---------- panel de detalle ----------
let sortKey = "date", sortDir = -1;
function openDetail(title, filter, opts = {}) {
  detail = { title, filter, ignoreRange: !!opts.ignoreRange, merchantKeys: opts.merchantKeys || null, suffix: "" };
  $("#dSearch").value = "";
  renderDetail();
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
}
/** Abre el detalle de un comercio. Se filtra por clave interna para que siga funcionando si se renombra. */
function openMerchant(name, allTime = false) {
  const keys = new Set(TX.filter((t) => t.merchant === name).map((t) => t.merchantKey));
  openDetail(name, (t) => keys.has(t.merchantKey), { ignoreRange: allTime, merchantKeys: keys });
  detail.suffix = allTime ? " · todo el historial" : "";
}
function closeDetail() {
  detail = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
}
function detailRows() {
  const q = $("#dSearch").value.trim().toLowerCase();
  let rows = TX.filter((t) => (detail.ignoreRange || inRange(t)) && detail.filter(t));
  if (q) rows = rows.filter((t) => [t.merchant, t.detail, t.category, t.channel, t.note, KIND_LABEL[t.kind], String(Math.abs(t.amount)), t.date].join(" ").toLowerCase().includes(q));
  const val = { date: (t) => t.date + t.time, abs: (t) => Math.abs(t.amount), merchant: (t) => t.merchant.toLowerCase(), category: (t) => t.category, channel: (t) => t.channel, kind: (t) => t.kind }[sortKey];
  return rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sortDir);
}
function renderDetail() {
  const body = $(".drawer-body");
  const scroll = body.scrollTop;
  const rows = detailRows();
  const out = sum(rows.filter((t) => t.amount < 0), (t) => -t.amount);
  const inn = sum(rows.filter((t) => t.amount > 0), (t) => t.amount);
  if (detail.merchantKeys) {
    // título con el nombre vigente del comercio (se actualiza al renombrar)
    const sample = TX.find((t) => detail.merchantKeys.has(t.merchantKey));
    $("#dTitle").innerHTML = sample ? `${esc(sample.merchant)}${esc(detail.suffix)} ${editBtn(sample)}` : esc(detail.title);
  } else $("#dTitle").textContent = detail.title;
  $("#dSummary").textContent = `${rows.length} movimiento${rows.length === 1 ? "" : "s"}${out ? ` · salidas ${fmt(out)}` : ""}${inn ? ` · entradas ${fmt(inn)}` : ""}`;
  const arrow = (k) => (sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : "");
  const kindOpts = (k) => Object.entries(KIND_LABEL).map(([v, l]) => `<option value="${v}" ${v === k ? "selected" : ""}>${l}</option>`).join("");
  const info = (t) => esc(`Tipo: ${t.type}\nSegmento: ${t.segment || "—"}\nDetalle original: ${t.rawDetail || "—"}\nID: ${t.sourceId}\nArchivo: ${t.file}`);
  $("#dTable").innerHTML = rows.length ? `
    <thead><tr>
      <th data-sort="date">Fecha${arrow("date")}</th>
      <th data-sort="merchant">Comercio / destinatario${arrow("merchant")}</th>
      <th class="num" data-sort="abs">Monto${arrow("abs")}</th>
      <th data-sort="category">Categoría${arrow("category")}</th>
      <th data-sort="channel">Medio${arrow("channel")}</th>
      <th data-sort="kind">Tipo${arrow("kind")}</th>
      <th>Nota</th>
      <th></th>
    </tr></thead>
    <tbody>${rows.map((t) => `
      <tr data-id="${esc(t.id)}" class="${t.tagged ? "tagged" : ""}">
        <td style="white-space:nowrap">${fmtDate(t.date)}<div class="mono">${t.time}</div></td>
        <td><span class="who">${esc(t.merchant)}</span>${editBtn(t)}${t.detail ? `<div class="what" title="${esc(t.detail)}">${esc(t.detail)}</div>` : ""}</td>
        <td class="num ${t.amount < 0 ? "neg" : "pos"}"><b>${t.amount < 0 ? "−" : "+"}${fmt(Math.abs(t.amount))}</b></td>
        <td><input data-f="category" list="catList" value="${esc(t.category)}" aria-label="Categoría" /></td>
        <td class="hint" style="white-space:nowrap">${esc(t.channel)}</td>
        <td><select data-f="kind" aria-label="Tipo">${kindOpts(t.kind)}</select></td>
        <td><input data-f="note" value="${esc(t.note)}" placeholder="ej. regalo, viaje…" aria-label="Nota" /></td>
        <td class="info" title="${info(t)}">ⓘ</td>
      </tr>`).join("")}</tbody>` : `<tbody><tr><td class="empty">Sin movimientos.</td></tr></tbody>`;
  body.scrollTop = scroll;
  lockInputs();
}

async function saveTxField(id, field, value) {
  if (READONLY) return readonlyNotice();
  const tx = TX.find((t) => t.id === id);
  if (!tx) return;
  if (field === "category" && $("#dWholeMerchant").checked) return saveMerchantRule(tx.merchant, "category", value);
  const cur = { ...(TAGS[id] || {}) };
  if (field === "category") cur.category = value && value !== (MERCH_RULES[tx.merchantKey]?.category || tx.baseCategory) ? value : "";
  if (field === "kind") cur.kind = value && value !== tx.baseKind ? value : "";
  if (field === "note") cur.note = value;
  await postTags({ [id]: cur });
  applyTags();
  renderAll();
}

function exportCsv() {
  const rows = detailRows();
  const head = ["fecha", "hora", "comercio", "detalle", "monto", "categoria", "medio", "tipo", "nota", "id"];
  const line = (a) => a.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";");
  const csv = "﻿" + [line(head), ...rows.map((t) => line([t.date, t.time, t.merchant, t.detail, t.amount, t.category, t.channel, KIND_LABEL[t.kind], t.note, t.sourceId]))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `movimientos-${state.from}_${state.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- eventos ----------
function setPreset(p) {
  document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.preset === p));
  const end = MAX_DATE;
  if (p === "all") { state.from = MIN_DATE; state.to = MAX_DATE; }
  else if (p === "month") { state.from = end.slice(0, 7) + "-01"; state.to = end; }
  else if (p === "prev") {
    const d = D(end.slice(0, 7) + "-01"); d.setUTCDate(0);
    state.to = iso(d); state.from = state.to.slice(0, 7) + "-01";
  } else { state.from = addDays(end, -(Number(p) - 1)); state.to = end; }
  if (state.from < MIN_DATE) state.from = MIN_DATE;
  if ((p === "month" || p === "prev") && (state.gran === "mes" || state.gran === "trimestre")) state.gran = "dia";
  renderAll();
}
const clearPreset = () => document.querySelectorAll("#presets button").forEach((b) => b.classList.remove("on"));

document.addEventListener("click", (e) => {
  const renameBtn = e.target.closest("[data-rename]");
  if (renameBtn) { e.preventDefault(); e.stopPropagation(); return openRename(renameBtn.dataset.rename); }
  const preset = e.target.closest("#presets button");
  if (preset) return setPreset(preset.dataset.preset);
  const gran = e.target.closest("#gran button");
  if (gran) { state.gran = gran.dataset.gran; store("gran", state.gran); return renderAll(); }
  const heatBtn = e.target.closest("[data-heat] button");
  if (heatBtn) {
    state.heatMetric = heatBtn.dataset.v;
    document.querySelectorAll("[data-heat] button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.heatMetric));
    const rows = TX.filter(inRange);
    renderCalendar(rows);
    return renderHeat(rows);
  }
  const dimBtn = e.target.closest("[data-dim] button");
  if (dimBtn) { state.dims[dimBtn.closest("[data-dim]").dataset.dim] = dimBtn.dataset.v; return renderAll(); }
  const chip = e.target.closest(".chip[data-cat]");
  if (chip) { const c = chip.dataset.cat; state.hidden.has(c) ? state.hidden.delete(c) : state.hidden.add(c); return renderAll(); }
  const top = e.target.closest("#topList li[data-id]");
  if (top) { const id = top.dataset.id; return openDetail("Pago seleccionado", (t) => t.id === id); }
  const th = e.target.closest("#dTable th[data-sort]");
  if (th) { const k = th.dataset.sort; sortDir = sortKey === k ? -sortDir : k === "merchant" || k === "category" ? 1 : -1; sortKey = k; return renderDetail(); }
  const mth = e.target.closest("#merchTable th[data-msort]");
  if (mth) { const k = mth.dataset.msort; merchSort = { key: k, dir: merchSort.key === k ? -merchSort.dir : k === "m" || k === "category" ? 1 : -1 }; return renderMerchTable(TX.filter(inRange)); }
  const openBtn = e.target.closest("[data-open]");
  if (openBtn) return openMerchant(openBtn.dataset.open);
  if (e.target.closest('[data-action="name-accounts"]')) {
    e.preventDefault();
    $("#mSearch").value = "Cuenta terminada en";
    renderMerchTable(TX.filter(inRange));
    return $("#merchTable").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (e.target.closest('[data-action="tag-other"]')) {
    e.preventDefault();
    sortKey = "abs"; sortDir = -1;
    $("#dWholeMerchant").checked = true;
    return openDetail("Comercios sin categoría", (t) => t.kind === "gasto" && ["Otros comercios", "Pagos y transferencias"].includes(t.category));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detail && !$("#renameDlg").open) closeDetail();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".chip[data-cat], #topList li")) { e.preventDefault(); e.target.click(); }
});
$("#from").addEventListener("change", (e) => { if (e.target.value) { state.from = e.target.value; clearPreset(); renderAll(); } });
$("#to").addEventListener("change", (e) => { if (e.target.value) { state.to = e.target.value; clearPreset(); renderAll(); } });
$("#kpis").addEventListener("change", async (e) => {
  if (e.target.id !== "budget") return;
  if (READONLY) return readonlyNotice();
  SETTINGS = { ...SETTINGS, monthlyBudget: Number(e.target.value) || 0 };
  saveConfig();
  renderAll();
});
$("#dTable").addEventListener("change", (e) => {
  const f = e.target.dataset.f;
  const tr = e.target.closest("tr[data-id]");
  if (f && tr) saveTxField(tr.dataset.id, f, e.target.value.trim());
});
$("#merchTable").addEventListener("change", (e) => {
  const f = e.target.dataset.mf;
  const tr = e.target.closest("tr[data-merchant]");
  if (f && tr) saveMerchantRule(tr.dataset.merchant, f, e.target.value.trim());
});
$("#mSearch").addEventListener("input", () => renderMerchTable(TX.filter(inRange)));
$("#dSearch").addEventListener("input", () => renderDetail());
$("#dClose").addEventListener("click", closeDetail);
$("#scrim").addEventListener("click", closeDetail);
$("#dExport").addEventListener("click", exportCsv);
$("#btnLoad").addEventListener("click", () => showUpload());
$("#btnAll").addEventListener("click", () => openDetail("Todos los movimientos del periodo", () => true));
function setHideAmounts(hide) {
  HIDE_AMOUNTS = hide;
  const btn = $("#btnHide");
  btn.setAttribute("aria-pressed", String(hide));
  btn.title = btn.ariaLabel = hide ? "Mostrar montos" : "Ocultar montos";
  store("hideAmounts", hide ? "1" : "0");
}
$("#btnHide").addEventListener("click", () => {
  setHideAmounts(!HIDE_AMOUNTS);
  renderAll();
});
$("#btnTheme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  store("theme", document.documentElement.dataset.theme);
  renderAll();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { Object.values(charts).forEach((c) => c.resize()); renderCalendar(TX.filter(inRange)); }, 150);
});

// ---------- inicio ----------
setHideAmounts(recall("hideAmounts") === "1");
const savedTheme = recall("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
state.gran = recall("gran") || "mes";
$("#btnExport").addEventListener("click", exportHtml);
if (READONLY) {
  // el reporte abre con la misma vista que tenía al exportarse
  document.body.classList.add("readonly");
  const v = EMBEDDED.view || {};
  Object.assign(state, { from: v.from || "", to: v.to || "", gran: v.gran || state.gran, heatMetric: v.heatMetric || "amount" });
  if (v.dims) state.dims = { ...state.dims, ...v.dims };
  state.hidden = new Set(v.hidden || []);
  setHideAmounts(!!v.hideAmounts);
  document.querySelectorAll("[data-heat] button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.heatMetric));
  clearPreset();
}
load().catch((err) => { $("#dataInfo").textContent = "Error al cargar datos: " + err.message; });
