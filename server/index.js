import { PRODUCTION, configProblems, endSession, hashPass, intakePass, intakeUser, rateLimit, sameSecret, securityHeaders, sessionOk, siteName, sitePlace, startSession, validPassword, validUser, verifyPass } from "./security.js";
import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, get, query, run, transaction } from "./db.js";
import { looksGarbage, normalizeLot, readDocument, readLots } from "./intake.js";
import { aiEnabled, aiProvider, readWithAi } from "./intake-ai.js";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "dist");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(securityHeaders);
if (!PRODUCTION || process.env.CORS_ORIGIN) {
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (process.env.CORS_ORIGIN) return cb(null, process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).includes(origin));
      try {
        const host = new URL(origin).hostname;
        const ok = host === "localhost" || host === "127.0.0.1"
          || /^192\.168\.\d+\.\d+$/.test(host)
          || /^10\.\d+\.\d+\.\d+$/.test(host)
          || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host);
        cb(null, ok);
      } catch { cb(null, false); }
    }
  }));
}
app.use((req, res, next) => {
  if (req.path === "/api/intake/read") return next();
  express.json({ limit: "200kb" })(req, res, next);
});
app.use((req, _res, next) => { req.body ??= {}; next(); });

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}
function clean(value, field) {
  const text = String(value ?? "").replace(/\0/g, "").trim();
  if (text.length > 20000) fail("Текстът в " + field + " е твърде дълъг.");
  return text;
}
function amount(value, field, min = 0, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail("Невалидно число за " + field + ".");
  return Math.round(n * 1000) / 1000;
}
function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function dayStamp(value) {
  const text = clean(value || localToday(), "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail("Датата е във формат ГГГГ-ММ-ДД.");
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) fail("Няма такава дата.");
  return text;
}
function dayDiff(a, b) {
  return Math.round((Date.parse(a + "T12:00:00+03:00") - Date.parse(b + "T12:00:00+03:00")) / 86400000);
}
function needOperator(value) {
  const name = clean(value || "", "кой").slice(0, 80);
  if (!name) fail("Напиши кой попълва.");
  return name;
}
function logRecord(table, id, action, before, after, reason, operator) {
  run(
    "INSERT INTO record_log (table_name, record_id, action, before_json, after_json, reason, operator, at) VALUES (?,?,?,?,?,?,?,?)",
    [table, id, action, JSON.stringify(before || {}), JSON.stringify(after || {}), clean(reason || "", "причина").slice(0, 200), operator || "", new Date().toISOString()]
  );
}
function parseTemp(value, field) {
  const text = String(value ?? "").trim().replace("−", "-").replace(",", ".");
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < -60 || n > 300) fail("Невалидна температура за " + field + ".");
  return Math.round(n * 10) / 10;
}
function nid(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function auth(req, res, next) {
  if (!sessionOk(req.headers.authorization)) {
    return res.status(401).json({ error: "Влез в системата." });
  }
  next();
}

function siteLabel() {
  return [siteName || "Обект", sitePlace].filter(Boolean).join(", ");
}

function creds() {
  const row = get("SELECT value FROM settings WHERE key = 'intake_auth'");
  if (row?.value) {
    try {
      const saved = JSON.parse(row.value);
      if (saved?.user && saved?.hash) return { user: String(saved.user), hash: String(saved.hash) };
    } catch { /* fall back to env */ }
  }
  return { user: intakeUser, pass: intakePass };
}

function loginOk(user, pass) {
  const saved = creds();
  if (!saved.user || !pass) return false;
  if (!sameSecret(user, saved.user)) return false;
  if (saved.hash) return verifyPass(pass, saved.hash);
  return !!(saved.pass && sameSecret(pass, saved.pass));
}

app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
  const user = String(req.body.user ?? "").trim();
  const pass = String(req.body.pass ?? "");
  if (loginOk(user, pass)) {
    return res.json({ token: startSession() });
  }
  res.status(401).json({ error: "Невалиден вход." });
});
app.post("/api/auth/logout", (req, res) => {
  endSession(req.headers.authorization);
  res.json({ ok: true });
});
app.get("/api/auth/me", auth, (_req, res) => {
  res.json({ user: creds().user || "", site: siteLabel(), name: siteName, place: sitePlace });
});
app.put("/api/auth/password", auth, (req, res) => {
  const current = String(req.body.current ?? "");
  const next = String(req.body.next ?? "");
  const nextUser = String(req.body.user ?? creds().user ?? "").trim();
  if (!loginOk(creds().user, current)) {
    return res.status(400).json({ error: "Сегашната парола не е вярна." });
  }
  const userErr = validUser(nextUser);
  if (userErr) return res.status(400).json({ error: userErr });
  const passErr = validPassword(next);
  if (passErr) return res.status(400).json({ error: passErr });
  const json = JSON.stringify({ user: nextUser, hash: hashPass(next) });
  run("INSERT INTO settings (key, value) VALUES ('intake_auth', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [json]);
  res.json({ ok: true, user: nextUser });
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "intake", time: new Date().toISOString() });
});
app.get("/api/site", auth, (_req, res) => {
  res.json({ name: siteName, place: sitePlace, label: siteLabel() });
});

function journalRow(body) {
  const received = dayStamp(body.received_on || localToday());
  const supplier = clean(body.supplier, "supplier");
  if (!supplier) fail("Сложи доставчик.");
  const kind = body.doc_kind === "stock" ? "stock" : "invoice";
  const docNo = clean(body.doc_no, "document").slice(0, 40);
  if (!docNo) fail("Сложи номер на фактурата или стоковата.");
  const product = clean(body.product, "product");
  if (!product) fail("Сложи храната.");
  const lot = normalizeLot(body.lot);
  if (!/^[A-ZА-Я0-9./-]{3,40}$/.test(lot)) fail("L-номерът е празен или невалиден.");
  const look = clean(body.look || "", "look");
  const decision = body.decision === "отказва се" || body.decision === "приема се" ? body.decision : "";
  if (!decision) fail("Избери приема се или отказва се.");
  if (dayDiff(received, localToday()) > 0) fail("Датата на приемане не може да е в бъдещето.");
  const expiry = body.expiry ? dayStamp(body.expiry) : "";
  const note = clean(body.note || "", "бележка").slice(0, 200);
  let warning = "";
  if (expiry && dayDiff(expiry, received) < 0) {
    warning = "Срокът е преди датата на приемане.";
    if (decision !== "отказва се" && !note) fail("Срокът е минал. Откажи партидата или напиши защо я приемаш.");
  }
  const tempText = String(body.temp ?? "").trim().replace(/°\s*c/i, "").replace("°", "").trim();
  const tempN = tempText ? parseTemp(tempText, "температура") : null;
  return {
    received_on: received,
    supplier: supplier.slice(0, 120),
    doc_kind: kind,
    doc_no: docNo,
    product: product.slice(0, 120),
    qty: amount(body.qty, "qty", 0.001),
    unit: clean(body.unit || "бр", "unit").slice(0, 12) || "бр",
    lot,
    expiry,
    temp: tempN == null ? "" : String(tempN),
    look: look === "не съответства" ? look : "съответства",
    decision,
    operator: clean(body.operator || "", "кой").slice(0, 80),
    note, warning
  };
}

function decodeUpload(item) {
  const raw = String(item?.file ?? item ?? "").replace(/^data:[^;]+;base64,/, "");
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) fail("Файлът не се чете.");
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) fail("Файлът е празен.");
  if (buf.length > 8_000_000) fail("Файлът е над 8 MB. Снимай по-близо или я смали.");
  return { buf, name: clean(item?.filename || item?.name || "", "файл").slice(0, 120) };
}
app.get("/api/intake/ai", auth, (_req, res) => {
  res.json({ enabled: aiEnabled(), provider: aiProvider() });
});
app.post("/api/intake/read", auth, rateLimit({ windowMs: 15 * 60 * 1000, max: 40, message: "Твърде много четения. Изчакай малко." }), express.json({ limit: "25mb" }), async (req, res) => {
  req.body ??= {};
  const text = clean(req.body.text || "", "text");
  const listed = Array.isArray(req.body.files) ? req.body.files : (req.body.file ? [req.body] : []);
  const uploads = listed.map(decodeUpload).filter(Boolean);
  if (uploads.length > 20) fail("Наведнъж до 20 снимки или PDF.");
  if (aiEnabled() && (uploads.length || (text && req.body.ai !== false))) {
    const result = await readWithAi(uploads, text);
    return res.json(result);
  }
  if (uploads.length) {
    const chunks = [];
    const warnings = [];
    for (const file of uploads) {
      const extracted = await readDocument(file.buf);
      if (looksGarbage(extracted)) {
        warnings.push((file.name || "Документ") + ": текстът е нечетим. Сложи AI ключ (INTAKE_AI_KEY) или качи по-ясна снимка.");
        continue;
      }
      chunks.push(extracted);
    }
    const joined = chunks.join("\n");
    if (!joined.trim()) {
      return res.status(400).json({
        error: warnings[0] || "Няма текст за четене.",
        warnings,
        ai: false
      });
    }
    const parsed = readLots(joined);
    parsed.warnings = [...warnings, ...(parsed.warnings || [])];
    parsed.source = "ocr";
    parsed.text = joined;
    return res.json(parsed);
  }
  if (!text.trim()) return res.status(400).json({ error: "Няма текст за четене." });
  res.json({ ...readLots(text), text, source: "ocr" });
});

app.get("/api/intake", auth, (req, res) => {
  const from = req.query.from ? dayStamp(req.query.from) : "1970-01-01";
  const to = req.query.to ? dayStamp(req.query.to) : "2999-12-31";
  res.json({
    rows: query("SELECT * FROM intake_journal WHERE received_on >= ? AND received_on <= ? AND COALESCE(voided,0) = 0 ORDER BY received_on, id", [from, to])
  });
});

app.post("/api/intake", auth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "Няма редове за дневника." });
  if (rows.length > 80) return res.status(400).json({ error: "Наведнъж се записват най-много 80 реда." });
  const ids = [];
  const failed = [];
  const seen = new Set();
  transaction(() => {
    for (const row of rows) {
      let rec;
      try { rec = journalRow(row); }
      catch (e) {
        failed.push({ product: String(row?.product || "ред").slice(0, 80), lot: String(row?.lot || ""), error: e.message });
        continue;
      }
      const key = rec.supplier + "|" + rec.doc_no + "|" + rec.lot;
      if (seen.has(key)) {
        failed.push({ product: rec.product, lot: rec.lot, error: "Повтаря се в тази купчина." });
        continue;
      }
      seen.add(key);
      const dup = get(
        "SELECT id FROM intake_journal WHERE supplier = ? AND doc_no = ? AND lot = ? AND COALESCE(voided,0) = 0",
        [rec.supplier, rec.doc_no, rec.lot]
      );
      if (dup) {
        failed.push({ product: rec.product, lot: rec.lot, error: "Вече е в дневника." });
        continue;
      }
      const id = nid("IK");
      run(`INSERT INTO intake_journal
        (id, received_on, supplier, doc_kind, doc_no, product, qty, unit, lot, expiry, temp, look, decision, operator, note, warning, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, rec.received_on, rec.supplier, rec.doc_kind, rec.doc_no, rec.product, rec.qty, rec.unit,
        rec.lot, rec.expiry, rec.temp, rec.look, rec.decision, rec.operator, rec.note, rec.warning, new Date().toISOString()
      ]);
      ids.push(id);
    }
  });
  if (!ids.length) return res.status(400).json({ error: failed[0]?.error || "Нищо не се записа.", failed });
  res.json({ ids, failed });
});

app.patch("/api/intake/:id", auth, (req, res) => {
  const id = clean(req.params.id, "id");
  const prev = get("SELECT * FROM intake_journal WHERE id = ?", [id]);
  if (!prev) return res.status(404).json({ error: "Няма ред в дневника." });
  if (Number(prev.voided) === 1) fail("Анулиран ред не се пипа.");
  const reason = clean(req.body.reason || "поправка", "причина").slice(0, 200);
  const editor = clean(req.body.editor || req.body.operator || prev.operator || "оператор", "кой").slice(0, 80);
  const rec = journalRow({ ...prev, ...req.body, operator: prev.operator || req.body.operator });
  run(`UPDATE intake_journal SET received_on=?, supplier=?, doc_kind=?, doc_no=?, product=?, qty=?, unit=?, lot=?, expiry=?, temp=?, look=?, decision=?, note=?, warning=? WHERE id=?`, [
    rec.received_on, rec.supplier, rec.doc_kind, rec.doc_no, rec.product, rec.qty, rec.unit,
    rec.lot, rec.expiry, rec.temp, rec.look, rec.decision, rec.note, rec.warning, id
  ]);
  logRecord("intake_journal", id, "patch", prev, rec, reason, editor);
  res.json({ id, ...rec });
});

app.delete("/api/intake/:id", auth, (req, res) => {
  const id = clean(req.params.id, "id");
  const prev = get("SELECT * FROM intake_journal WHERE id = ?", [id]);
  if (!prev) return res.status(404).json({ error: "Няма ред в дневника." });
  const operator = clean(req.body.operator || prev.operator || "оператор", "кой").slice(0, 80);
  const reason = clean(req.body.reason || "премахнат от дневника", "причина").slice(0, 200);
  run("UPDATE intake_journal SET voided = 1, void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?", [
    reason, operator, new Date().toISOString(), id
  ]);
  logRecord("intake_journal", id, "void", prev, null, reason, operator);
  res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Няма такъв адрес." }));

if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(clientDist, "index.html"), (err) => err && next(err));
  });
}

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Файлът или заявката е твърде голяма." });
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Вътрешна грешка. Опитай пак." });
});
export { app, closeDb };
if (!process.env.INTAKE_TEST && !process.env.SCM_TEST) {
  const problems = configProblems();
  if (problems.length) {
    console.error("Входящият контрол не тръгва / Intake will not start:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3003;
  const host = process.env.HOST || (PRODUCTION ? "127.0.0.1" : "0.0.0.0");
  const server = app.listen(port, host, () => {
    console.log("Входящ контрол http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + port);
    console.log("AI: " + (aiEnabled() ? "включен" : "няма ключ"));
  });
  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
}
