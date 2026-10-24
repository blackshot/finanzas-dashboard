/**
 * Lector de reportes CSV de Mercado Pago. Corre en el navegador (se empaqueta como /loader.js):
 * los archivos que cargas nunca salen de tu equipo.
 */

export type Kind = "gasto" | "ingreso" | "inversion" | "beneficio" | "ahorro" | "interno";

export interface Tx {
  id: string;
  date: string; // YYYY-MM-DD (hora local del reporte)
  time: string; // HH:MM
  hour: number;
  amount: number; // REAL_AMOUNT con signo
  kind: Kind;
  category: string;
  merchant: string; // comercio o destinatario legible
  merchantKey: string; // clave normalizada para agrupar y guardar reglas
  detail: string; // producto, glosa de la transferencia, activo cripto…
  channel: string; // medio de pago legible
  // datos técnicos (solo para el tooltip "ⓘ")
  sourceId: string;
  type: string;
  segment: string;
  rawDetail: string;
  file: string;
  balance: number | null; // saldo disponible después del movimiento (solo reporte de liberaciones)
}

type Row = Record<string, string>;

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const unquote = (s: string) => String(s ?? "").trim().replace(/^"+|"+$/g, "").trim();

// ---------- lectura de archivos ----------

function decode(buf: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // no es UTF-8 válido (Excel suele exportar en Windows-1252)
    text = new TextDecoder("windows-1252").decode(buf);
  }
  // Mercado Pago a veces ya trae las tildes rotas como "�"
  return text.replace(/^﻿/, "").replace(/�/g, "");
}

function parseCsv(text: string): Row[] {
  const firstLine = text.slice(0, text.indexOf("\n"));
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

// ---------- limpieza de comercios ----------

/** Prefijos de procesadores de pago que esconden el nombre real del comercio. */
const PROCESSOR = /^(payu|mercadopago|merpago|mercado pago|mp|tuu|dp|paypal|dl|google|fudo|sumup|redgloba|sq|flow|getnet|klap|webpay|pago ?facil|izi|haulmer|bsale|pedidosya|rappi)\s*\*\s*/i;

/** Alias para unificar comercios conocidos (se evalúan sobre el nombre limpio en minúsculas). */
const ALIASES: [RegExp, string][] = [
  [/uber\s*eats/, "Uber Eats"],
  [/^uber(\s+(trip|rides|bv).*)?$/, "Uber"],
  [/^c\.? ?verde|^cruz verde/, "Cruz Verde"],
  [/^sta\.? isabel|^santa isabel/, "Santa Isabel"],
  [/^jumbo/, "Jumbo"],
  [/^unimarc/, "Unimarc"],
  [/^tottus/, "Tottus"],
  [/^red movilidad/, "Red Movilidad (transporte público)"],
  [/youtube/, "YouTube Premium"],
  [/^efe[\s_]*valpo/, "EFE Valparaíso (Merval)"],
  [/^hip lider|^lider|^express de lider/, "Líder"],
  [/^epic games/, "Epic Games"],
  [/^cafe ?paxin/, "Café Paxin"],
  [/netflix/, "Netflix"],
  [/spotify/, "Spotify"],
  [/^movistar/, "Movistar"],
  [/^chilquinta/, "Chilquinta Energía"],
  [/^esval/, "Esval"],
];

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

export const merchantKeyOf = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function cleanMerchant(raw: string): string {
  let s = unquote(raw).replace(/"/g, "").replace(/^purchase at\s+/i, "");
  if (PROCESSOR.test(s)) s = s.replace(PROCESSOR, "");
  else if (s.includes("*")) {
    const [before, after = ""] = s.split("*");
    // "Efe_valpo*v264u01702": lo de después es un código de terminal
    s = /\d{3,}/.test(after) || !after.trim() ? before! : after;
  }
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const low = s.toLowerCase();
  for (const [re, name] of ALIASES) if (re.test(low)) return name;
  // respeta mayúsculas intencionales (ej. "SKiNOLOGY"), normaliza el resto
  const intentional = /[A-Z]/.test(s.slice(1)) && s !== s.toUpperCase();
  return intentional ? s : titleCase(s);
}

const CHANNEL: Record<string, string> = {
  Virtual: "Tarjeta virtual",
  Physical: "Tarjeta física",
  NFC: "Pago con celular (NFC)",
  Marketplace: "Mercado Libre",
  "Online Payments": "Pago online",
  "Merchant Services": "Link de pago",
  "Bill payments": "Pago de cuentas",
  "Bill Payments - Agenda": "Pago de cuentas (automático)",
  "Intra MP": "Transferencia Mercado Pago",
  crypto: "Cripto",
};

/** Reglas de categoría por nombre de comercio. La primera que calce gana. */
const CATEGORY_RULES: [RegExp, string][] = [
  [/uber eats|rappi|pedidos ?ya|justo|sush|subway|caf[eé]|arabic|torino|pizza|burger|mcdonald|kfc|starbucks|jarana|restaur|empanad|dunkin|doggis|juan maestro|sangucher|bar |pub |helad|pasteler|panader|bakery|rotiser|wok|shanghai|chin[ao]|sandwich|sanguch|completo|food/i, "Comida y delivery"],
  [/\bpet\b|mascota|veterin|petshop|pet ?city|super ?zoo/i, "Mascotas"],
  [/^uber$|cabify|didi|^efe|merval|metro|bip|copec|shell|petrobras|aramco|estacionam|peaje|autopista|turbus|pullman|flixbus|taxi|bencin|red movilidad/i, "Transporte"],
  [/l[ií]der|jumbo|unimarc|tottus|santa isabel|acuenta|ekono|mayorista|oxxo|ok market|supermerc|minimark|almac[eé]n|abarrotes|feria/i, "Supermercado"],
  [/esval|movistar|entel|claro|wom|vtr|enel|chilquinta|metrogas|gasvalpo|aguas|cge|gtd|mundo pac/i, "Cuentas y servicios"],
  [/youtube|google|netflix|spotify|disney|hbo|^max$|prime video|apple|epic games|steam|playstation|xbox|nintendo|openai|chatgpt|icloud/i, "Suscripciones y entretenimiento"],
  [/aliexpress|amazon|temu|shein|falabella\.com|paris\.cl|ripley\.com/i, "Compras online"],
  [/[oó]ptic|oftalmo|farmac|cruz verde|salud|salcobrand|ahumada|cl[ií]nica|dental|skinology|m[eé]dic|perfum|peluquer|barber/i, "Salud y belleza"],
  [/ikea|ferreter|sodimac|easy|homecenter|construmart|casaideas|lipiapp/i, "Hogar"],
  [/libro|librer|udemy|coursera|universidad|colegio/i, "Educación"],
];

const ASSET = (s: string) => ({ MUSD: "Mercado Dólar", BTC: "Bitcoin", ETH: "Ethereum", USDC: "USDC" })[s] ?? s;

/** Convierte una fila del reporte de Mercado Pago en un movimiento legible. */
function describe(r: Row, amount: number) {
  const type = r.TRANSACTION_TYPE ?? "";
  const method = r.PAYMENT_METHOD_TYPE ?? "";
  const segment = unquote(r.SEGMENT_DETAIL ?? "");
  const sale = unquote(r.SALE_DETAIL ?? "");
  const bu = r.BUSINESS_UNIT ?? "";
  const sub = r.SUB_UNIT ?? "";
  let channel = CHANNEL[segment] ?? (method === "bank_transfer" ? "Transferencia bancaria" : sub === "Wallet" ? "Billetera Mercado Pago" : "Saldo Mercado Pago");

  const out = (kind: Kind, category: string, merchant: string, detail = "") => ({ kind, category, merchant, detail, channel });

  if (type === "CASHBACK") {
    const detail = /cuenta remunerada/i.test(segment) ? "Beneficio cuenta remunerada" : /loyalty|cashback/i.test(sale) ? "Cashback por compras con tarjeta" : sale;
    return out("beneficio", "Cashback", "Mercado Pago", detail);
  }
  if (type === "CRYPTO_OPERATION") {
    channel = "Cripto";
    if (/EARN_BUY_MUSD/i.test(sale)) return out("inversion", "Mercado Dólar", "Mercado Pago", "Cashback convertido a Mercado Dólar");
    const m = sale.match(/^(BUY|SELL)-(\w+)/i);
    if (m) return out("inversion", "Cripto", "Mercado Pago Cripto", `${m[1]!.toUpperCase() === "BUY" ? "Compra" : "Venta"} de ${ASSET(m[2]!.toUpperCase())}`);
    return out("inversion", "Cripto", "Mercado Pago Cripto", sale);
  }
  if (type === "REFUND") return out("ingreso", "Reembolsos", sale ? cleanMerchant(sale) : "Reembolso", "Devolución");

  if (amount < 0) {
    if (segment === "Marketplace" || bu === "Mercado Libre") return out("gasto", "Compras Mercado Libre", "Mercado Libre", sale);
    if (segment === "Intra MP") return out("gasto", "Transferencias a personas", "Transferencia Mercado Pago", sale);
    if (/debt/i.test(sale)) return out("gasto", "Créditos y deudas", "Mercado Pago Créditos", "Pago de deuda / cuota");
    if (!sale) return out("gasto", "Pagos y transferencias", "Pago sin detalle", "");
    // en links de pago / checkout el detalle suele ser el producto, no el comercio
    if (/merchant|online/i.test(segment) && (sale.length > 35 || /item adicional/i.test(sale)))
      return out("gasto", "Compras online", "Compra online", sale.replace(/"/g, ""));
    const merchant = cleanMerchant(sale);
    const rule = CATEGORY_RULES.find(([re]) => re.test(merchant) || re.test(sale));
    const category = rule?.[1] ?? (/^bill payments/i.test(segment) ? "Cuentas y servicios" : /online|merchant/i.test(segment) || sub.startsWith("Checkout") ? "Compras online" : "Otros comercios");
    return out("gasto", category, merchant, merchant.toLowerCase() === sale.toLowerCase() ? "" : sale);
  }

  // entradas de dinero
  if (method === "bank_transfer") {
    const [who, ...rest] = sale.split(" - ");
    const isSalary = /sueldo|remuneraci|salario|liquidaci|anticipo/i.test(sale);
    if (sale && rest.length) return out("ingreso", isSalary ? "Sueldo" : "Transferencias recibidas", who!.trim(), rest.join(" - ").trim());
    return out("ingreso", isSalary ? "Sueldo" : "Transferencias recibidas", "Transferencia recibida", /^\d+$/.test(sale) ? "" : sale);
  }
  if (!method) return out("ingreso", "Rendimientos", "Mercado Pago", "Rendimiento diario cuenta remunerada");
  return out("ingreso", "Dinero recibido", sale ? cleanMerchant(sale) : "Dinero recibido", "");
}

// ---------- fechas ----------

/** Mercado Pago mezcla husos (-03:00 / -04:00); todo se lleva a la hora de Chile. */
const SANTIAGO = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function localParts(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: value.slice(0, 10), time: value.slice(11, 16), hour: Number(value.slice(11, 13)) || 0 };
  const s = SANTIAGO.format(d); // "2026-01-22 02:41"
  return { date: s.slice(0, 10), time: s.slice(11, 16), hour: Number(s.slice(11, 13)) };
}

// ---------- reporte de liberaciones (reserve-release) ----------

const isReleaseReport = (rows: Row[]) => rows.length > 0 && "NET_DEBIT_AMOUNT" in rows[0]!;

/**
 * El reporte de liberaciones registra cada movimiento del saldo disponible en varias filas
 * (reserva + pago). Se agrupan por SOURCE_ID y el monto real es Σ créditos − Σ débitos.
 */
function releaseToTxs(rows: (Row & { _file: string })[]): Tx[] {
  const groups = new Map<string, (Row & { _file: string })[]>();
  for (const r of rows) {
    if (r.RECORD_TYPE !== "release" || !r.SOURCE_ID) continue;
    (groups.get(r.SOURCE_ID) ?? groups.set(r.SOURCE_ID, []).get(r.SOURCE_ID)!).push(r);
  }
  const txs: Tx[] = [];
  for (const [sourceId, list] of groups) {
    const amount = Math.round(list.reduce((a, r) => a + num(r.NET_CREDIT_AMOUNT) - num(r.NET_DEBIT_AMOUNT), 0) * 100) / 100;
    if (Math.abs(amount) < 0.5) continue; // reservas que se anulan entre sí
    list.sort((a, b) => (a.DATE! < b.DATE! ? -1 : 1));
    const main = list.find((r) => !r.DESCRIPTION?.startsWith("reserve_for_")) ?? list[0]!;
    const last = list.at(-1)!;
    const desc = main.DESCRIPTION ?? "";
    const segment = unquote(main.SEGMENT_DETAIL ?? "");
    const sale = unquote(main.SALE_DETAIL ?? "");
    let info: Omit<Tx, "id" | "date" | "time" | "hour" | "amount" | "merchantKey" | "sourceId" | "type" | "segment" | "rawDetail" | "file" | "balance">;

    if (desc === "payout") {
      const acc = (main.PAYOUT_BANK_ACCOUNT_NUMBER ?? "").trim();
      info = {
        kind: "gasto", category: "Transferencias enviadas", channel: "Transferencia bancaria",
        merchant: acc ? `Cuenta terminada en ${acc.slice(-4)}` : "Transferencia enviada",
        detail: acc ? `Transferencia a la cuenta bancaria N° ${acc}` : "",
      };
    } else if (/partition transfer/i.test(segment)) {
      const toPot = amount < 0;
      info = {
        kind: "ahorro", category: "Apartados", channel: "Apartados Mercado Pago",
        merchant: "Apartados Mercado Pago", detail: toPot ? "Dinero movido a un apartado" : "Dinero retirado de un apartado",
      };
    } else {
      const type = desc === "cashback" ? "CASHBACK" : desc === "refund" ? "REFUND" : segment === "crypto" ? "CRYPTO_OPERATION" : "SETTLEMENT";
      const method = desc === "asset_management" ? "" : main.PAYMENT_METHOD_TYPE === "bank_transfer" ? "bank_transfer" : "available_money";
      info = describe({ ...main, TRANSACTION_TYPE: type, PAYMENT_METHOD_TYPE: method }, amount);
    }
    const when = localParts(main.TRANSACTION_DATE || main.DATE!);
    txs.push({
      id: `r:${sourceId}`,
      ...when,
      amount,
      ...info,
      merchantKey: info.merchant.startsWith("Cuenta terminada en ") ? `cuenta${(main.PAYOUT_BANK_ACCOUNT_NUMBER ?? "").trim()}` : merchantKeyOf(info.merchant),
      sourceId,
      type: desc,
      segment,
      rawDetail: sale,
      file: main._file,
      balance: num(last.BALANCE_AMOUNT),
    });
  }
  return txs;
}

// ---------- reporte de liquidaciones (settlement) ----------

function settlementToTxs(byKey: Map<string, { row: Row; file: string; count: number }>, skip: (date: string) => boolean): Tx[] {
  const txs: Tx[] = [];
  for (const [key, { row: r, file, count }] of byKey) {
    const when = localParts(String(r.TRANSACTION_DATE));
    if (skip(when.date)) continue;
    const amount = num(r.REAL_AMOUNT);
    const info = describe(r, amount);
    for (let i = 0; i < count; i++) {
      txs.push({
        id: i === 0 ? key : `${key}#${i}`,
        ...when,
        amount,
        ...info,
        merchantKey: merchantKeyOf(info.merchant),
        sourceId: r.SOURCE_ID!,
        type: r.TRANSACTION_TYPE ?? "",
        segment: unquote(r.SEGMENT_DETAIL ?? ""),
        rawDetail: unquote(r.SALE_DETAIL ?? ""),
        file,
        balance: null,
      });
    }
  }
  return txs;
}

export interface InputFile { name: string; buffer: ArrayBuffer }
export interface FileReport { name: string; kind: "liberaciones" | "liquidaciones" | "desconocido"; rows: number; error?: string }

/**
 * Procesa los CSV cargados por el usuario.
 * - Reporte de liberaciones (reserve-release): fuente principal, cuadra con el saldo de la cuenta.
 * - Reporte de liquidaciones (settlement): solo se usa para fechas que el de liberaciones no cubre.
 * Los movimientos repetidos entre archivos se eliminan.
 */
export function parseFiles(input: InputFile[]): { txs: Tx[]; files: string[]; report: FileReport[] } {
  const releaseRows = new Map<string, Row & { _file: string }>(); // fila única -> fila
  const settlement = new Map<string, { row: Row; file: string; count: number }>();
  const report: FileReport[] = [];
  let relFrom = "", relTo = "";

  for (const { name: file, buffer } of [...input].sort((a, b) => a.name.localeCompare(b.name))) {
    let rows: Row[];
    try {
      rows = parseCsv(decode(buffer));
    } catch (err) {
      report.push({ name: file, kind: "desconocido", rows: 0, error: (err as Error).message });
      continue;
    }

    if (isReleaseReport(rows)) {
      report.push({ name: file, kind: "liberaciones", rows: rows.length });
      for (const r of rows) {
        if (!r.DATE) continue;
        const d = localParts(r.DATE).date;
        if (!relFrom || d < relFrom) relFrom = d;
        if (!relTo || d > relTo) relTo = d;
        // el saldo posterior hace única cada fila aunque el archivo se descargue dos veces
        const key = [r.DATE, r.SOURCE_ID, r.DESCRIPTION, r.NET_CREDIT_AMOUNT, r.NET_DEBIT_AMOUNT, r.BALANCE_AMOUNT, r.RECORD_TYPE].join("|");
        if (!releaseRows.has(key)) releaseRows.set(key, { ...r, _file: file });
      }
      continue;
    }
    if (!rows.length || !("TRANSACTION_DATE" in rows[0]!) || !("REAL_AMOUNT" in rows[0]!)) {
      report.push({ name: file, kind: "desconocido", rows: rows.length, error: "No parece un reporte de Mercado Pago" });
      continue;
    }
    report.push({ name: file, kind: "liquidaciones", rows: rows.length });

    const local = new Map<string, number>();
    for (const r of rows) {
      if (!r.TRANSACTION_DATE || !r.SOURCE_ID) continue;
      const key = [r.SOURCE_ID, r.TRANSACTION_TYPE, num(r.REAL_AMOUNT).toFixed(2), r.TRANSACTION_DATE].join("|");
      const c = (local.get(key) ?? 0) + 1;
      local.set(key, c);
      const prev = settlement.get(key);
      if (!prev) settlement.set(key, { row: r, file, count: c });
      else {
        if (c > prev.count) prev.count = c;
        // si un archivo trae más columnas (CSV nuevo vs. Excel antiguo) se prefiere esa fila
        if (!prev.row.SALE_DETAIL && r.SALE_DETAIL) { prev.row = r; prev.file = file; }
      }
    }
  }

  const covered = (date: string) => !!relFrom && date >= relFrom && date <= relTo;
  const txs = [...releaseToTxs([...releaseRows.values()]), ...settlementToTxs(settlement, covered)];
  mergeTruncatedMerchants(txs);
  txs.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  const files = report.filter((r) => r.kind !== "desconocido").map((r) => r.name);
  return { txs, files, report };
}

/**
 * Los procesadores cortan el nombre del comercio ("Jacqueli" / "Jacquelinemar").
 * Si un nombre es el inicio de exactamente otro nombre más largo, se unifican.
 */
function mergeTruncatedMerchants(txs: Tx[]) {
  const names = new Map<string, string>();
  for (const t of txs) if (t.kind === "gasto") names.set(t.merchantKey, t.merchant);
  const keys = [...names.keys()];
  for (const short of keys) {
    if (short.length < 6) continue;
    const longer = keys.filter((k) => k !== short && k.startsWith(short));
    if (longer.length !== 1) continue;
    const target = longer[0]!;
    for (const t of txs) {
      if (t.merchantKey === short) { t.merchantKey = target; t.merchant = names.get(target)!; }
    }
  }
}

// expuesto para public/app.js (script clásico)
(globalThis as any).FinanzasLoader = { parseFiles };
