import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksGarbage, normalizeLot, extractText } from "./intake.js";

const envFile = join(dirname(fileURLToPath(import.meta.url)), ".env");
const ENV_KEYS = new Set(["INTAKE_AI_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "INTAKE_AI_MODEL", "INTAKE_AI_PROVIDER"]);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").replace(/^\uFEFF/, "").split(/\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!ENV_KEYS.has(name) || process.env[name]) continue;
    process.env[name] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const PROMPT = `Ти четеш български фактури и стокови разписки за кухненски входящ контрол.
Върни САМО JSON:
{
  "supplier": "име на доставчика",
  "doc_kind": "invoice" или "stock",
  "doc_no": "номер на документа",
  "received_on": "ГГГГ-ММ-ДД",
  "rows": [
    {
      "product": "име на храната",
      "qty": число,
      "unit": "кг" | "бр" | "л" | "г",
      "lot": "партида или L-номер",
      "expiry": "ГГГГ-ММ-ДД или празно",
      "temp": ""
    }
  ]
}
Правила:
- Всеки ред храна е отделен елемент в rows.
- lot е партидният номер. Ако пише L / Л / партида / лот — вземи го. Ако OCR е чел I вместо L в началото, върни L.
- Не измисляй партиди. Ако няма партида, lot = "".
- Не смесвай цена с количество. Количеството е с кг/бр/л.
- doc_kind е stock само ако документът е стокова разписка, иначе invoice.
- Датата на документа е received_on. Годно до е expiry.
- Игнорирай ДДС, суми, ЕИК, банкови сметки.
- Текстът може да е на няколко снимки на един документ — обедини ги.`;

function aiKey() {
  return String(process.env.INTAKE_AI_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

export function aiEnabled() {
  if (process.env.SCM_TEST && process.env.INTAKE_AI_TEST !== "1") return false;
  return aiKey().length >= 20;
}

export function aiProvider() {
  if (!aiEnabled()) return "";
  const forced = String(process.env.INTAKE_AI_PROVIDER || "").toLowerCase();
  if (forced === "gemini" || forced === "openai") return forced;
  const key = aiKey();
  if (key.startsWith("sk-")) return "openai";
  return "gemini";
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function mimeOf(buf, name = "") {
  const sig = Buffer.from(buf).subarray(0, 12).toString("latin1");
  const lower = String(name || "").toLowerCase();
  if (sig.startsWith("%PDF") || lower.endsWith(".pdf")) return "application/pdf";
  if (sig.startsWith("\x89PNG") || lower.endsWith(".png")) return "image/png";
  if (sig.startsWith("GIF8")) return "image/gif";
  if (sig.startsWith("RIFF") && buf.length >= 12 && Buffer.from(buf).subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (lower.endsWith(".heic") || lower.endsWith(".heif") || (buf.length >= 12 && Buffer.from(buf).subarray(4, 8).toString("latin1") === "ftyp")) return "image/heic";
  return "image/jpeg";
}

function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) fail("AI не върна таблица. Опитай пак със по-ясна снимка.");
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    fail("AI върна нечетим отговор. Опитай пак.");
  }
}

function isoDate(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  const bg = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (!bg) return "";
  const y = bg[3].length === 2 ? "20" + bg[3] : bg[3];
  return y + "-" + String(bg[2]).padStart(2, "0") + "-" + String(bg[1]).padStart(2, "0");
}

function unitOf(value) {
  const t = String(value || "").toLowerCase();
  if (/кг|kil|kg/.test(t)) return "кг";
  if (/бр|pcs|bro/.test(t)) return "бр";
  if (/лит|ltr|\bл\b/.test(t)) return "л";
  if (/мл|ml/.test(t)) return "мл";
  if (/грама|\bг\b|\bg\b/.test(t)) return "г";
  return t.slice(0, 8) || "бр";
}

export function rowsFromAi(data) {
  const header = data && typeof data === "object" ? data : {};
  const list = Array.isArray(header.rows) ? header.rows : [];
  const supplier = String(header.supplier || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const docNo = String(header.doc_no || header.docNo || "").trim().slice(0, 40);
  const kind = String(header.doc_kind || header.docKind || "") === "stock" ? "stock" : "invoice";
  const received = isoDate(header.received_on || header.receivedOn || header.date);
  const warnings = [];
  const rows = [];
  const seen = new Set();
  for (const item of list) {
    const product = String(item.product || item.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!product) continue;
    let lot = normalizeLot(item.lot || item.batch || item.l || "");
    if (lot.length < 3) {
      lot = "БЕЗЛОТ";
      warnings.push(product + ": няма партида. Допиши L-номера преди запис.");
    }
    const key = lot + "|" + product;
    if (seen.has(key)) continue;
    seen.add(key);
    const qty = Number(String(item.qty ?? item.quantity ?? "1").replace(",", "."));
    rows.push({
      received_on: received,
      supplier,
      doc_kind: kind,
      doc_no: docNo,
      product,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 1000) / 1000 : 1,
      unit: unitOf(item.unit),
      lot,
      expiry: isoDate(item.expiry || item.best_before || item.bestBefore),
      temp: String(item.temp || "").trim().slice(0, 12),
      look: "съответства",
      decision: "приема се",
      operator: ""
    });
  }
  if (!rows.length) warnings.push("AI не намери храни на документа.");
  if (!supplier) warnings.push("Няма доставчик. Допиши го преди запис.");
  if (!docNo) warnings.push("Няма номер на фактура или стокова.");
  return { kind, doc_kind: kind, doc_no: docNo, supplier, received_on: received, rows, warnings, source: "ai" };
}

function geminiModels() {
  const primary = process.env.INTAKE_AI_MODEL || "gemini-3.8-flash";
  const rest = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"];
  return [primary, ...rest.filter((model) => model !== primary)];
}
function modelBusy(status, message) {
  return status === 429 || status === 503 || /high demand|unavailable|overloaded|try again|resource exhausted/i.test(message);
}
async function callGemini(parts) {
  let last = "AI е зает в момента. Опитай пак след малко.";
  for (const model of geminiModels()) {
    let res;
    try {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(aiKey()),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: "application/json" }
          }),
          signal: AbortSignal.timeout(90000)
        }
      );
    } catch {
      last = "AI не отговори. Провери интернет връзката.";
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String(data.error?.message || "AI върна грешка.");
      if (msg.includes("API key")) fail("AI ключът не е валиден.", 401);
      last = "AI: " + msg.slice(0, 180);
      if (modelBusy(res.status, msg)) continue;
      fail(last, 502);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
    return parseJson(text);
  }
  fail(last, 503);
}

async function callOpenAi(content) {
  const model = process.env.INTAKE_AI_MODEL || "gpt-4o-mini";
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + aiKey() },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }]
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch {
    fail("AI не отговори. Провери интернет връзката.", 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || "AI върна грешка.";
    fail(msg.includes("API key") || msg.includes("Incorrect API") ? "AI ключът не е валиден." : "AI: " + String(msg).slice(0, 180), res.status === 429 ? 429 : 502);
  }
  return parseJson(data.choices?.[0]?.message?.content || "");
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function mergeAi(parts) {
  const rows = [];
  const warnings = [];
  const seen = new Set();
  let supplier = "";
  let docNo = "";
  let kind = "invoice";
  let received = "";
  for (const part of parts) {
    if (!supplier && part.supplier) supplier = part.supplier;
    if (!docNo && part.doc_no) docNo = part.doc_no;
    if (part.doc_kind === "stock") kind = "stock";
    if (!received && part.received_on) received = part.received_on;
    warnings.push(...(part.warnings || []));
    for (const row of part.rows || []) {
      const key = row.lot + "|" + row.product;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...row,
        supplier: row.supplier || supplier,
        doc_no: row.doc_no || docNo,
        doc_kind: row.doc_kind || kind,
        received_on: row.received_on || received
      });
    }
  }
  return {
    kind, doc_kind: kind, doc_no: docNo, supplier, received_on: received,
    rows, warnings: [...new Set(warnings)], source: "ai"
  };
}

export async function readWithAi(uploads, extraText = "") {
  if (!aiEnabled()) fail("Липсва AI ключ. Сложи INTAKE_AI_KEY в server/.env");
  const provider = aiProvider();
  const files = Array.isArray(uploads) ? uploads : [];
  if (!files.length && !String(extraText || "").trim()) fail("Няма документ за четене.");
  const groups = chunk(files.length ? files : [{ text: extraText }], 4);
  const parsed = [];
  for (const group of groups) {
    if (provider === "openai") {
      const content = [{ type: "text", text: PROMPT + (extraText ? "\n\nТекст:\n" + extraText.slice(0, 12000) : "") }];
      for (const file of group) {
        if (file.text) {
          content.push({ type: "text", text: file.text });
          continue;
        }
        const mime = mimeOf(file.buf, file.name);
        if (mime === "application/pdf") {
          let text = "";
          try { text = extractText(file.buf); } catch { text = ""; }
          if (looksGarbage(text)) {
            parsed.push({ rows: [], warnings: [(file.name || "PDF") + ": този PDF е като снимка. Качи JPEG или ползвай Gemini ключ."] });
            continue;
          }
          content.push({ type: "text", text: "Документ " + (file.name || "") + ":\n" + text.slice(0, 12000) });
        } else {
          content.push({ type: "image_url", image_url: { url: "data:" + mime + ";base64," + Buffer.from(file.buf).toString("base64") } });
        }
      }
      if (content.length > 1) parsed.push(rowsFromAi(await callOpenAi(content)));
    } else {
      const parts = [{ text: PROMPT + (extraText ? "\n\nДопълнителен текст:\n" + extraText.slice(0, 8000) : "") }];
      for (const file of group) {
        if (file.text) {
          parts.push({ text: file.text });
          continue;
        }
        const mime = mimeOf(file.buf, file.name);
        parts.push({ inline_data: { mime_type: mime === "image/heic" ? "image/jpeg" : mime, data: Buffer.from(file.buf).toString("base64") } });
      }
      parsed.push(rowsFromAi(await callGemini(parts)));
    }
  }
  const out = mergeAi(parsed);
  out.text = extraText || "";
  return out;
}
