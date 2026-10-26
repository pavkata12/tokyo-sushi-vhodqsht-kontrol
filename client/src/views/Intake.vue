<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../api";

const filter = reactive({ from: "", to: "" });
const saved = ref([]);
const preview = ref([]);
const warnings = ref([]);
const paste = ref("");
const err = ref("");
const msg = ref("");
const busy = ref(false);
const progress = ref("");
const ai = ref({ enabled: false, provider: "" });
const site = ref("Обект");
const remembered = localStorage.getItem("intake_operator") || "";
const operator = ref(remembered);
function printSheet() { window.print(); }

function monthRange() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return {
    from: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-01",
    to: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(last)
  };
}
function docLabel(kind) {
  return kind === "stock" ? "Стокова разписка" : "Фактура";
}
function bgDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + "." + m[2] + "." + m[1] + " г." : "";
}
const sheet = computed(() => saved.value);

async function load() {
  const data = await api("/api/intake?from=" + filter.from + "&to=" + filter.to);
  saved.value = data.rows || [];
}
onMounted(() => {
  Object.assign(filter, monthRange());
  load().catch((e) => { err.value = e.message; });
  api("/api/intake/ai").then((data) => { ai.value = data; }).catch(() => {});
  api("/api/site").then((data) => { if (data.label) site.value = data.label; }).catch(() => {});
});

function bytesToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function shrinkImage(file) {
  if (!file.type.startsWith("image/") || /heic|heif/i.test(file.type) || /\.heic$/i.test(file.name || "")) {
    return { b64: bytesToB64(await file.arrayBuffer()), name: file.name };
  }
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) return { b64: bytesToB64(await file.arrayBuffer()), name: file.name };
    return { b64: bytesToB64(await blob.arrayBuffer()), name: (file.name || "photo").replace(/\.\w+$/, "") + ".jpg" };
  } catch {
    return { b64: bytesToB64(await file.arrayBuffer()), name: file.name };
  }
}

function applyPreview(data) {
  preview.value = (data.rows || []).map((row) => ({ ...row, operator: row.operator || operator.value }));
  warnings.value = data.warnings || [];
  if (data.text) paste.value = data.text;
  if (!preview.value.length) err.value = warnings.value[0] || "Няма редове за дневника.";
}

async function readText(text) {
  err.value = "";
  msg.value = "";
  busy.value = true;
  progress.value = ai.value.enabled ? "AI чете текста…" : "Чета текста…";
  try {
    applyPreview(await api("/api/intake/read", { method: "POST", body: { text } }));
  } catch (e) { err.value = e.message; }
  finally { busy.value = false; progress.value = ""; }
}

async function onFile(event) {
  const picked = [...(event.target.files || [])].slice(0, 20);
  event.target.value = "";
  if (!picked.length) return;
  err.value = "";
  msg.value = "";
  busy.value = true;
  try {
    const uploads = [];
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      progress.value = "Подготвям " + (i + 1) + " от " + picked.length + "…";
      if (file.size > 12_000_000) throw new Error(file.name + " е над 12 MB.");
      const prepared = file.type.startsWith("image/") ? await shrinkImage(file) : { b64: bytesToB64(await file.arrayBuffer()), name: file.name };
      uploads.push({ file: prepared.b64, filename: prepared.name || file.name });
    }
    progress.value = ai.value.enabled
      ? "AI пълни дневника от " + uploads.length + " документ" + (uploads.length === 1 ? "" : "а") + "…"
      : "Чета " + uploads.length + " документ" + (uploads.length === 1 ? "" : "а") + "…";
    applyPreview(await api("/api/intake/read", { method: "POST", body: { files: uploads } }));
  } catch (e) { err.value = e.message; }
  finally { busy.value = false; progress.value = ""; }
}

function patchHeader(field, value) {
  if (field === "operator") {
    operator.value = value;
    localStorage.setItem("intake_operator", value);
  }
  for (const row of preview.value) row[field] = value;
}

async function commit() {
  err.value = "";
  msg.value = "";
  for (const row of preview.value) {
    if (!String(row.operator || "").trim()) row.operator = operator.value;
  }
  busy.value = true;
  try {
    const data = await api("/api/intake", { method: "POST", body: { rows: preview.value } });
    const failed = data.failed || [];
    if (failed.length) {
      const bad = new Set(failed.map((row) => row.product + "|" + row.lot));
      preview.value = preview.value.filter((row) => bad.has(row.product + "|" + row.lot));
      err.value = "Записах " + (data.ids || []).length + ". Останаха: " + failed.map((row) => row.product + " — " + row.error).join("; ");
    } else {
      preview.value = [];
      warnings.value = [];
      paste.value = "";
      msg.value = "Записано в дневника · " + (data.ids || []).length + " реда.";
    }
    await load();
  } catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

async function saveRow(row) {
  try {
    await api("/api/intake/" + row.id, {
      method: "PATCH",
      body: { ...row, reason: "температура", editor: operator.value || row.operator || "оператор" }
    });
    msg.value = "Редът е обновен.";
  } catch (e) { err.value = e.message; }
}

async function removeRow(row) {
  if (!confirm("Да махна този ред от дневника?")) return;
  try {
    await api("/api/intake/" + row.id, {
      method: "DELETE",
      body: { reason: "премахнат от дневника", operator: operator.value || row.operator || "оператор" }
    });
    await load();
  } catch (e) { err.value = e.message; }
}
</script>
<template>
  <div class="book-head no-print">
    <div>
      <h1>Входящ контрол</h1>
      <p class="muted">Качи до 20 снимки или PDF — AI пълни дневника. Прегледай редовете и запиши. На iPhone снимай JPEG, не HEIC.</p>
    </div>
    <button class="btn" type="button" @click="printSheet">Печат на дневника</button>
  </div>
  <p v-if="err" class="muted no-print" style="color:#9a2e08">{{ err }}</p>
  <p v-if="msg" class="muted no-print">{{ msg }}</p>

  <div class="panel no-print" style="margin-bottom:12px">
    <h2>Прочети документи</h2>
    <p v-if="ai.enabled" class="muted">AI е включен. Можеш да пуснеш куп снимки наведнъж.</p>
    <p v-else class="muted">Автоматичното четене не е включено. Постави текста ръчно или снимай документа.</p>
    <textarea v-model="paste" rows="4" placeholder="Или постави текст. След снимка тук може да се появи разчетеният текст."></textarea>
    <div class="pager">
      <button class="btn" type="button" :disabled="busy || !paste.trim()" @click="readText(paste)">Прочети текста</button>
      <label class="btn">Снимки или PDF
        <input type="file" multiple accept="image/*,application/pdf,text/plain,.txt,.pdf,.heic,.webp" hidden @change="onFile" />
      </label>
    </div>
    <p v-if="busy" class="muted">{{ progress || "Чета…" }}</p>
    <p v-for="w in warnings" :key="w" class="muted">{{ w }}</p>
    <div v-if="preview.length" class="row" style="gap:8px;flex-wrap:wrap;margin:10px 0">
      <div style="flex:2"><label>Доставчик</label><input :value="preview[0].supplier" @input="patchHeader('supplier', $event.target.value)" /></div>
      <div style="flex:1"><label>№ документ</label><input :value="preview[0].doc_no" @input="patchHeader('doc_no', $event.target.value)" /></div>
      <div style="width:160px"><label>Дата</label><input type="date" :value="preview[0].received_on" @input="patchHeader('received_on', $event.target.value)" /></div>
      <div style="flex:1"><label>Приел</label><input :value="operator" @input="patchHeader('operator', $event.target.value)" placeholder="име" /></div>
    </div>
    <table v-if="preview.length">
      <thead>
        <tr><th>Храна</th><th>Кол.</th><th>L / партида</th><th>Годно до</th><th>t °C</th><th>Оценка</th><th>Решение</th><th>Приел</th></tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in preview" :key="i">
          <td data-label="Храна"><input v-model="row.product" /></td>
          <td data-label="Кол."><input v-model.number="row.qty" type="number" step="0.001" /> {{ row.unit }}</td>
          <td data-label="Партида"><input v-model="row.lot" /></td>
          <td data-label="Годно до"><input v-model="row.expiry" type="date" /></td>
          <td data-label="t °C"><input v-model="row.temp" placeholder="°C" /></td>
          <td data-label="Оценка">
            <select v-model="row.look">
              <option value="съответства">съответства</option>
              <option value="не съответства">не съответства</option>
            </select>
          </td>
          <td data-label="Решение">
            <select v-model="row.decision">
              <option value="приема се">приема се</option>
              <option value="отказва се">отказва се</option>
            </select>
          </td>
          <td data-label="Приел"><input v-model="row.operator" placeholder="име" /></td>
        </tr>
      </tbody>
    </table>
    <p v-if="preview.length" class="muted">{{ docLabel(preview[0].doc_kind) }} · {{ preview.length }} ред{{ preview.length === 1 ? "" : "а" }}. Поправи ако трябва, после запиши.</p>
    <p v-if="err && preview.length" class="bad">{{ err }}</p>
    <button v-if="preview.length" class="btn" type="button" :disabled="busy" @click="commit">{{ busy ? "Записвам…" : "Запиши в дневника" }}</button>
  </div>

  <div class="panel journal-sheet">
    <h1>ДНЕВНИК<br>за входящ контрол на приетите храни</h1>
    <p class="book-meta">Обект: {{ site }}<span>Период: {{ bgDate(filter.from) }} — {{ bgDate(filter.to) }}</span></p>
    <div class="pager no-print">
      <input v-model="filter.from" type="date" />
      <input v-model="filter.to" type="date" />
      <button class="btn ghost" type="button" @click="load">Покажи</button>
    </div>
    <table>
      <colgroup>
        <col style="width:5%"><col style="width:9%"><col style="width:12%"><col style="width:11%">
        <col style="width:13%"><col style="width:7%"><col style="width:9%"><col style="width:9%">
        <col style="width:5%"><col style="width:7%"><col style="width:8%"><col style="width:5%">
        <col class="no-print" style="width:70px">
      </colgroup>
      <thead>
        <tr>
          <th>№</th>
          <th>Дата</th>
          <th>Доставчик</th>
          <th>Документ</th>
          <th>Храна</th>
          <th>Количество</th>
          <th>Партида</th>
          <th>Годно до</th>
          <th>°C</th>
          <th>Оценка</th>
          <th>Заключение</th>
          <th>Подпис</th>
          <th class="no-print"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in sheet" :key="row.id">
          <td>{{ i + 1 }}</td>
          <td>{{ bgDate(row.received_on) }}</td>
          <td class="left">{{ row.supplier }}</td>
          <td>{{ docLabel(row.doc_kind) }} № {{ row.doc_no }}</td>
          <td class="left">{{ row.product }}</td>
          <td>{{ row.qty }} {{ row.unit }}</td>
          <td>{{ row.lot }}</td>
          <td>{{ bgDate(row.expiry) }}</td>
          <td>
            <span class="ink">{{ row.temp }}</span>
            <input class="no-print" v-model="row.temp" @change="saveRow(row)" />
          </td>
          <td>{{ row.look }}</td>
          <td>{{ row.decision }}</td>
          <td>{{ row.operator }}</td>
          <td class="no-print"><button class="btn ghost" type="button" @click="removeRow(row)">Махни</button></td>
        </tr>
        <tr v-if="!sheet.length"><td colspan="13">Няма записи за периода.</td></tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
textarea, input, select { width: 100%; max-width: 100%; }
label.btn input { display: none; }
.ink { display: none; }
.journal-sheet h1 {
  font-family: "Times New Roman", Times, serif;
  font-size: 22px;
  line-height: 1.15;
  text-align: center;
  letter-spacing: 0.04em;
  margin: 0 0 8px;
}
.book-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-family: "Times New Roman", Times, serif;
  margin: 0 0 10px;
}
.journal-sheet table { width: 100%; min-width: 1100px; border-collapse: collapse; table-layout: fixed; }
.journal-sheet th, .journal-sheet td {
  border: 1px solid #1a1410;
  padding: 4px 5px;
  font-size: 12px;
  text-align: center;
  vertical-align: middle;
}
.journal-sheet th { font-family: "Times New Roman", Times, serif; font-weight: 700; }
.journal-sheet td.left { text-align: left; }
@media print {
  .ink { display: inline; }
  .journal-sheet {
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: 0;
    background: #fff;
    overflow: visible;
  }
  .journal-sheet h1 { font-size: 16pt; margin-bottom: 3mm; }
  .book-meta { font-size: 11pt; margin-bottom: 4mm; }
  .journal-sheet table { min-width: 0; font-family: "Times New Roman", Times, serif; font-size: 9pt; table-layout: fixed; }
  .journal-sheet th, .journal-sheet td { border: 1px solid #000; padding: 1.5mm 1mm; color: #000; overflow-wrap: anywhere; }
  .journal-sheet thead { display: table-header-group; }
  .journal-sheet tr { break-inside: avoid; }
}
</style>
