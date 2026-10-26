import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const ocrScript = join(dirname(fileURLToPath(import.meta.url)), "ocr.ps1");

const LABELED = /(?:партиден\s*(?:номер|№)?|партида|партия|l\s*[-–]?\s*номер|лот|lot|batch)\s*[:№#\-.]?\s*([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9./\-]{2,})/gi;
const BARE = /(?:^|[\s,;|(])((?:L|Л|I)[\s\-./]*\d[A-Za-zА-Яа-я0-9./\-]{1,})/gi;
const QTY = /(\d+(?:[.,]\d+)?)\s*(килограма|кг|kg|броя|бр\.?|литра|литър|мл|ml|грама|г|g)\.?(?=$|[\s,;.|])/i;
const EXP = /(?:годно(?:ст)?\s*до|годен\s*до|срок(?:\s*на\s*годност)?|exp\.?|best before)\s*[:\-]?\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})/i;
const HEADER = /фактура|ф-ра|стокова|доставчик|издател|продавач|invoice|документ|дата|ддс|общо|сума|получател|еоод|\bоод\b|еад\b|еик/i;

function isoDate(day, month, year) {
  const y = String(year).length === 2 ? "20" + year : String(year);
  return y + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

export function normalizeLot(raw) {
  let text = String(raw || "").replace(/\s+/g, "").replace(/^Л/i, "L").toUpperCase();
  text = text.replace(/^[I|](?=\d)/, "L");
  text = text.replace(/^L[-./]?/, "L");
  return text.slice(0, 40);
}

export function looksGarbage(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return true;
  const letters = (s.match(/[A-Za-zА-Яа-я]/g) || []).length;
  const cyr = (s.match(/[А-Яа-я]/g) || []).length;
  if (letters < 8) return true;
  if (letters / s.length < 0.18) return true;
  if (s.length > 80 && cyr < 4 && /[ÃÂÐÑœ]/.test(s)) return true;
  return false;
}

export function tidyOcr(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/([A-ZА-Я0-9])-\r?\n\s*([A-ZА-Я0-9])/g, "$1-$2")
    .replace(/\r\n/g, "\n")
    .replace(/[|]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function lotsOnLine(line) {
  LABELED.lastIndex = 0;
  BARE.lastIndex = 0;
  const found = [];
  const push = (raw) => {
    const lot = normalizeLot(raw);
    if (lot.length >= 3 && !found.includes(lot)) found.push(lot);
  };
  for (const match of String(line || "").matchAll(LABELED)) push(match[1]);
  for (const match of String(line || "").matchAll(BARE)) push(match[1]);
  return found;
}

function qtyOn(line) {
  const match = String(line || "").match(QTY);
  if (!match) return { qty: 1, unit: "бр", guessed: true };
  const unit = match[2].toLowerCase().replace(/\.$/, "")
    .replace("килограма", "кг").replace("броя", "бр").replace("литра", "л").replace("литър", "л").replace("грама", "г");
  return { qty: Number(match[1].replace(",", ".")), unit, guessed: false };
}

function expiryOn(line, received) {
  const labeled = String(line || "").match(EXP);
  if (labeled) return isoDate(labeled[1], labeled[2], labeled[3]);
  const any = String(line || "").match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (!any) return "";
  const value = isoDate(any[1], any[2], any[3]);
  return value === received ? "" : value;
}

function stripMeta(text) {
  LABELED.lastIndex = 0;
  BARE.lastIndex = 0;
  return String(text || "")
    .replace(LABELED, " ")
    .replace(BARE, " ")
    .replace(QTY, " ")
    .replace(EXP, " ")
    .replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s*г\.?)?/g, " ")
    .replace(/\d+[.,]\d{2}/g, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productName(chunk, lines, index) {
  const current = stripMeta(lines[index]);
  if (current.length >= 2 && !HEADER.test(current) && !/^\d/.test(current)) return current.slice(0, 120);
  const fromChunk = stripMeta(chunk);
  if (fromChunk.length >= 2 && !HEADER.test(fromChunk) && !/^\d/.test(fromChunk)) return fromChunk.slice(0, 120);
  for (let k = index - 1; k >= Math.max(0, index - 4); k--) {
    const cand = stripMeta(lines[k]);
    if (cand.length >= 2 && !HEADER.test(cand) && !/^\d/.test(cand)) return cand.slice(0, 120);
  }
  return (current || fromChunk || "храна").slice(0, 120);
}

function pickDocNo(joined) {
  const labeled = joined.match(/(?:фактура|ф-ра|стокова(?:\s+разписка)?|invoice|документ)\s*(?:№|No\.?|N[oº°])?\s*[:.]?\s*([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9./\-]{1,})/i);
  if (labeled) return labeled[1];
  const hashed = joined.match(/(?:№|No\.?)\s*([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9./\-]{1,})/i);
  return hashed ? hashed[1] : "";
}

function pickSupplier(joined, lines) {
  const labeled = ((joined.match(/доставчик\s*[:\-–]?\s*(.+)/i) || joined.match(/(?:издател|продавач)\s*[:\-–]?\s*(.+)/i) || [])[1] || "").trim();
  if (labeled) return labeled.replace(/\s+/g, " ").slice(0, 120);
  const firm = lines.find((line) => /ЕООД|ООД|ЕАД|ЕИК/i.test(line) && !/получател/i.test(line));
  return (firm || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function readLots(text) {
  const lines = tidyOcr(text).split(/\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join("\n");
  const kind = /стокова/i.test(joined) ? "stock" : "invoice";
  const docNo = pickDocNo(joined);
  const labeledDate = joined.match(/(?:дата|date)\s*[:\-]?\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})/i);
  const anyDate = joined.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  const date = labeledDate || anyDate;
  const received = date ? isoDate(date[1], date[2], date[3]) : "";
  const supplier = pickSupplier(joined, lines);
  const rows = [];
  const warnings = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const found = lotsOnLine(lines[i]);
    if (!found.length) continue;
    const chunk = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join(" ");
    if (HEADER.test(lines[i]) && qtyOn(chunk).guessed) continue;
    const qty = qtyOn(chunk).guessed
      ? qtyOn([lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join(" "))
      : qtyOn(chunk);
    if (qty.guessed) warnings.push("Ред с " + found[0] + ": количеството не се чете, сложих 1.");
    for (const lot of found) {
      if (seen.has(lot)) continue;
      seen.add(lot);
      rows.push({
        received_on: received,
        supplier,
        doc_kind: kind,
        doc_no: docNo,
        product: productName(chunk, lines, i),
        qty: qty.qty,
        unit: qty.unit,
        lot,
        expiry: expiryOn(chunk, received) || expiryOn(lines[i + 1] || "", received),
        temp: "",
        look: "съответства",
        decision: "приема се",
        operator: ""
      });
    }
  }
  if (!rows.length) warnings.push("Не намерих L-номер или партида. Снимай по-близо текста с партидата, или го допиши в полето.");
  if (!supplier) warnings.push("Няма ред „Доставчик“. Допиши го преди запис.");
  if (!docNo) warnings.push("Няма номер на фактура или стокова.");
  return { kind, doc_kind: kind, doc_no: docNo, supplier, received_on: received, rows, warnings };
}

function decodePdfString(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next >= "0" && next <= "7") {
      let oct = next;
      for (let k = 0; k < 2 && body[i + 1] >= "0" && body[i + 1] <= "7"; k++) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (next) out += next;
  }
  return out;
}

function pdfLiterals(src) {
  const out = [];
  const re = /\((?:\\[0-7]{1,3}|\\.|[^\\)])*\)/g;
  for (const match of String(src || "").matchAll(re)) {
    const text = decodePdfString(match[0].slice(1, -1)).replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out.join("\n");
}

function isImage(data) {
  const sig = data.subarray(0, 12).toString("latin1");
  if (sig.startsWith("\x89PNG") || sig.startsWith("\xff\xd8") || sig.startsWith("GIF8")) return true;
  if (sig.startsWith("RIFF") && data.length >= 12 && data.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp") return true;
  return false;
}

function imageExt(data) {
  const sig = data.subarray(0, 12).toString("latin1");
  if (sig.startsWith("\x89PNG")) return ".png";
  if (sig.startsWith("GIF8")) return ".gif";
  if (sig.startsWith("RIFF")) return ".webp";
  if (data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp") return ".heic";
  return ".jpg";
}

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function runProcess(cmd, args, { timeoutMs = 45000, collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let settled = false;
    if (collect) child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(text || "");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(fail("Снимката се чете твърде бавно."));
    }, timeoutMs);
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        finish(fail("На сървъра липсва четене на снимки. Сложи: sudo apt install tesseract-ocr tesseract-ocr-bul tesseract-ocr-eng"));
      } else finish(err);
    });
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout);
      else finish(fail("Снимката не се разчете. Снимай я право и на светло, или я запази като JPEG."));
    });
  });
}

function lotHits(text) {
  return tidyOcr(text).split(/\n/).reduce((n, line) => n + lotsOnLine(line).length, 0);
}

async function tesseractText(image, psm) {
  return runProcess("tesseract", [
    image, "stdout", "-l", "bul+eng", "--oem", "3", "--psm", String(psm),
    "-c", "preserve_interword_spaces=1"
  ], { collect: true });
}

export async function ocrImage(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  if (data.length < 32) throw fail("Снимката е празна или счупена.");
  if (imageExt(data) === ".heic" && platform() !== "win32") {
    throw fail("iPhone снимка (HEIC) не се чете. Снимай като JPEG: Настройки → Камера → Формати → Най-съвместим.");
  }
  const dir = await mkdtemp(join(tmpdir(), "intake-ocr-"));
  const image = join(dir, "page" + imageExt(data));
  const out = join(dir, "text.txt");
  try {
    await writeFile(image, data);
    let text = "";
    if (platform() === "win32") {
      await runProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ocrScript, "-ImagePath", image, "-OutPath", out
      ]);
      text = await readFile(out, "utf8");
    } else {
      const block = await tesseractText(image, 6);
      if (lotHits(block)) text = block;
      else {
        const sparse = await tesseractText(image, 4).catch(() => "");
        text = lotHits(sparse) >= lotHits(block) ? (sparse || block) : block;
      }
    }
    text = tidyOcr(text);
    if (!text.trim()) throw fail("На снимката не се вижда текст. Снимай по-близо, право и без сянка.");
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readDocument(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  if (isImage(data)) return ocrImage(data);
  return extractText(data);
}

export function extractText(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  if (data.length < 4) {
    const err = new Error("Празен файл.");
    err.status = 400;
    throw err;
  }
  const sig = data.subarray(0, 12).toString("latin1");
  if (sig.startsWith("\x89PNG") || sig.startsWith("\xff\xd8") || sig.startsWith("GIF8") || sig.startsWith("RIFF")) {
    const err = new Error("Снимка не се чете. Качи PDF с текстов слой или постави текста от фактурата / стоковата.");
    err.status = 400;
    throw err;
  }
  if (!sig.startsWith("%PDF")) return data.toString("utf8");
  const raw = data.toString("latin1");
  const pieces = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const bin = Buffer.from(match[1], "latin1");
    let text = match[1];
    try { text = inflateSync(bin, { maxOutputLength: 20_000_000 }).toString("latin1"); } catch { /* plain stream */ }
    const literals = pdfLiterals(text);
    if (literals) pieces.push(literals);
  }
  if (pieces.length) return pieces.join("\n");
  return pdfLiterals(raw);
}
