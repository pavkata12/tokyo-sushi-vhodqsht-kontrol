import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { normalizeLot, readLots } from "../intake.js";

const dir = mkdtempSync(join(tmpdir(), "intake-"));
process.env.INTAKE_DB = join(dir, "t.db");
process.env.INTAKE_TEST = "1";
process.env.SCM_TEST = "1";
process.env.SITE_NAME = "Друга фирма ООД";
process.env.SITE_PLACE = "София";
const { app, closeDb } = await import("../index.js");

let server;
let base;
const auth = { Authorization: "" };

before(() => new Promise((resolve, reject) => {
  server = http.createServer(app);
  server.listen(0, "127.0.0.1", async () => {
    base = "http://127.0.0.1:" + server.address().port;
    try {
      const login = await req("/api/auth/login", { method: "POST", body: { user: "intake", pass: "stef88" } });
      if (login.status !== 200 || !login.data.token) throw new Error("login failed");
      auth.Authorization = "Bearer " + login.data.token;
      resolve();
    } catch (e) { reject(e); }
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => {
    try { closeDb(); } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
    resolve();
  });
}));

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method: opts.method || "GET", headers, body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test("login rejects a bad password", async () => {
  const no = await req("/api/auth/login", { method: "POST", body: { user: "intake", pass: "nope" } });
  assert.equal(no.status, 401);
  const denied = await req("/api/intake");
  assert.equal(denied.status, 401);
  const ok = await req("/api/auth/login", { method: "POST", body: { user: "intake", pass: "stef88" } });
  assert.equal(ok.status, 200);
  assert.match(ok.data.token, /^[0-9a-f]{64}$/);
});

test("can change username and password", async () => {
  const me = await req("/api/auth/me", { headers: auth });
  assert.equal(me.status, 200);
  assert.equal(me.data.user, "intake");
  const short = await req("/api/auth/password", { method: "PUT", headers: auth, body: { current: "stef88", next: "short", user: "intake" } });
  assert.equal(short.status, 400);
  const ok = await req("/api/auth/password", { method: "PUT", headers: auth, body: { current: "stef88", next: "NewPass12345", user: "sklad" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user, "sklad");
  const old = await req("/api/auth/login", { method: "POST", body: { user: "intake", pass: "stef88" } });
  assert.equal(old.status, 401);
  const next = await req("/api/auth/login", { method: "POST", body: { user: "sklad", pass: "NewPass12345" } });
  assert.equal(next.status, 200);
  auth.Authorization = "Bearer " + next.data.token;
});

test("health and site are generic", async () => {
  const health = await req("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.app, "intake");
  const site = await req("/api/site", { headers: auth });
  assert.equal(site.status, 200);
  assert.equal(site.data.label, "Друга фирма ООД, София");
});

test("invoice and stock-note L-numbers fill the intake journal", async () => {
  const text = [
    "ФАКТУРА № 0001234567",
    "Дата: 13.10.2026",
    "Доставчик: Месокомбинат Юг ЕООД",
    "Кайма свинска 5 кг L251013-04 годно до 20.10.2026",
    "Шунка 2 кг партида L88421 срок 15.12.2026"
  ].join("\n");
  const read = await req("/api/intake/read", { method: "POST", headers: auth, body: { text } });
  assert.equal(read.status, 200);
  assert.equal(read.data.rows.length, 2);
  assert.equal(read.data.rows[0].lot, "L251013-04");
  assert.equal(read.data.rows[0].qty, 5);
  assert.equal(read.data.rows[0].product, "Кайма свинска");
  assert.equal(read.data.rows[1].lot, "L88421");
  assert.equal(read.data.doc_kind, "invoice");
  const saved = await req("/api/intake", {
    method: "POST", headers: auth,
    body: { rows: read.data.rows.map((row) => ({ ...row, temp: "4", operator: "Иванов" })) }
  });
  assert.equal(saved.status, 200);
  const list = await req("/api/intake?from=2026-10-01&to=2026-10-31", { headers: auth });
  assert.ok(list.data.rows.some((row) => row.lot === "L251013-04" && row.temp === "4" && row.operator === "Иванов"));
  const bare = await req("/api/intake", {
    method: "POST", headers: auth,
    body: { rows: [{ ...read.data.rows[0], lot: "L251013-99", temp: "", operator: "" }] }
  });
  assert.equal(bare.status, 200, bare.data?.error);
  const stock = [
    "СТОКОВА РАЗПИСКА № 5521",
    "13.10.2026",
    "Доставчик: Зеленчукова борса",
    "Домати 10 кг L9910 годно до 16.10.2026"
  ].join("\n");
  const note = await req("/api/intake/read", { method: "POST", headers: auth, body: { text: stock } });
  assert.equal(note.data.rows[0].doc_kind, "stock");
  assert.equal(note.data.rows[0].lot, "L9910");
  assert.equal(note.data.rows[0].doc_no, "5521");
  const pdf = Buffer.from(`%PDF-1.1
1 0 obj
<< /Length 48 >>
stream
BT (Domati 3 kg L4410) Tj ET
endstream
endobj
trailer <<>>
%%EOF`, "latin1").toString("base64");
  const fromPdf = await req("/api/intake/read", { method: "POST", headers: auth, body: { file: pdf } });
  assert.equal(fromPdf.status, 200);
  assert.equal(fromPdf.data.rows[0].lot, "L4410");
  const photo = await req("/api/intake/read", {
    method: "POST", headers: auth,
    body: { file: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }
  });
  assert.equal(photo.status, 400);
  const aiOff = await req("/api/intake/ai", { headers: auth });
  assert.equal(aiOff.data.enabled, false);
});

test("AI intake fills the journal from a vision response", async () => {
  process.env.INTAKE_AI_TEST = "1";
  process.env.INTAKE_AI_KEY = "AIzaSyTestKeyNotRealButLongEnough12";
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("127.0.0.1") || String(url).includes("localhost")) return orig(url, opts);
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                supplier: "Месокомбинат Юг ЕООД",
                doc_kind: "invoice",
                doc_no: "88",
                received_on: "2026-10-13",
                rows: [
                  { product: "Кайма свинска", qty: 5, unit: "кг", lot: "I251013-04", expiry: "20.10.2026" },
                  { product: "Шунка", qty: 2, unit: "кг", lot: "L88421", expiry: "2026-12-15" }
                ]
              })
            }]
          }
        }]
      })
    };
  };
  try {
    const on = await req("/api/intake/ai", { headers: auth });
    assert.equal(on.data.enabled, true);
    const tiny = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const read = await req("/api/intake/read", {
      method: "POST", headers: auth,
      body: { files: [{ file: tiny, filename: "a.jpg" }, { file: tiny, filename: "b.jpg" }] }
    });
    assert.equal(read.status, 200, read.data?.error);
    assert.equal(read.data.source, "ai");
    assert.equal(read.data.rows.length, 2);
    assert.equal(read.data.rows[0].lot, "L251013-04");
    assert.equal(read.data.rows[0].qty, 5);
    assert.equal(read.data.supplier, "Месокомбинат Юг ЕООД");
    assert.equal(read.data.rows[1].expiry, "2026-12-15");
  } finally {
    globalThis.fetch = orig;
    delete process.env.INTAKE_AI_TEST;
    delete process.env.INTAKE_AI_KEY;
  }
});

test("intake parser joins OCR-split lines and treats I as L", () => {
  assert.equal(normalizeLot("I251013-04"), "L251013-04");
  const parsed = readLots([
    "Ф-ра № 88",
    "Дата: 13.10.2026",
    "Месокомбинат Юг ЕООД",
    "Кайма свинска",
    "5 кг",
    "I251013-04",
    "годно до 20.10.2026",
    "Шунка 2 кг партида 88421 срок 15.12.2026"
  ].join("\n"));
  assert.equal(parsed.doc_no, "88");
  assert.match(parsed.supplier, /Месокомбинат/);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].lot, "L251013-04");
  assert.equal(parsed.rows[0].qty, 5);
  assert.equal(parsed.rows[0].unit, "кг");
  assert.match(parsed.rows[0].product, /Кайма/);
  assert.equal(parsed.rows[0].expiry, "2026-10-20");
  assert.equal(parsed.rows[1].lot, "88421");
  assert.equal(parsed.rows[1].qty, 2);
});

test("a phone photo of an invoice yields the L-number", { skip: process.platform !== "win32" }, async () => {
  const photoPath = join(dir, "invoice.png");
  const drawn = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap 1400, 220; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White); $font = New-Object System.Drawing.Font 'Segoe UI', 36; $g.DrawString('Кайма свинска 5 кг L251013-04', $font, [System.Drawing.Brushes]::Black, 40, 70); $bmp.Save('${photoPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`
  ], { encoding: "utf8" });
  assert.equal(drawn.status, 0, drawn.stderr || drawn.stdout);
  const photo = await req("/api/intake/read", {
    method: "POST", headers: auth,
    body: { file: readFileSync(photoPath).toString("base64"), filename: "invoice.png" }
  });
  assert.equal(photo.status, 200, photo.data?.error);
  assert.equal(photo.data.rows[0].lot, "L251013-04");
  assert.equal(photo.data.rows[0].qty, 5);
  assert.match(photo.data.rows[0].product, /Кайма/);
});
