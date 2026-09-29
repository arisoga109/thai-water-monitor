// เตือนก่อนฝนตก: พยากรณ์ฝนรายชั่วโมงของทุกอำเภอ (928 แห่ง) วันนี้ + 3 วันข้างหน้า
// ใช้: node scripts/alerts.mjs --prev prev/data --out out/data
//
// โควตาฟรีของ Open-Meteo นับ 1 หน่วยต่ออำเภอ (~930 หน่วยต่อรอบ) และจำกัด ~600 หน่วย/นาที
// จึงแบ่งยิงทีละ 150 อำเภอ เว้น 20 วินาที และคำนวณทุก 6 ชม. ระหว่างที่ยังสร้างค่าปกติไม่ครบ
// (เพื่อให้รวมกันไม่เกิน 10,000 หน่วย/วัน) หลังจากนั้นทุก 3 ชม.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findPeriods, packRows } from "../site/alerts.js";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PREV = arg("--prev", "prev/data");
const OUT = arg("--out", "out/data");
const FORCE = process.argv.includes("--force");
const CHUNK = 150;
const GAP_MS = Number(process.env.ALERT_GAP_MS ?? 20_000);

const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
await mkdir(OUT, { recursive: true });

const districts = JSON.parse(await readFile(new URL("../site/districts.json", import.meta.url), "utf8"));
const prev = await readJson(join(PREV, "alerts.json"), null);
const clim = await readJson(join(OUT, "climatology.json"), await readJson(join(PREV, "climatology.json"), null));
const climComplete = clim && Object.keys(clim.prov || {}).length >= 77;
const every = (climComplete ? 170 : 350) * 60e3;

if (!FORCE && prev && now - prev.updated < every) {
  await writeFile(join(OUT, "alerts.json"), JSON.stringify(prev));
  console.log(`เตือนฝน: ใช้ผลรอบก่อน (คำนวณใหม่ทุก ${climComplete ? 3 : 6} ชม.)`);
  process.exit(0);
}

// ถ้าขั้นก่อนหน้าเพิ่งดึงข้อมูลย้อนหลัง ให้พักก่อนเพื่อไม่ชนเพดานต่อนาที
if (clim?.lastAttempt && now - clim.lastAttempt < 5 * 60e3 && !process.env.ALERT_GAP_MS) await sleep(60_000);

const points = [];
for (const [pc, list] of Object.entries(districts)) list.forEach((d, i) => points.push({ p: +pc, i, lat: d[1], lon: d[2] }));

const dates = [0, 1, 2, 3].map((k) => new Date(now + 7 * 3600e3 + k * 864e5).toISOString().slice(0, 10));
const rows = [];
let ok = 0, failed = 0;
for (let c = 0; c < points.length; c += CHUNK) {
  const part = points.slice(c, c + CHUNK);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${part.map((x) => x.lat).join(",")}&longitude=${part.map((x) => x.lon).join(",")}`
    + `&hourly=precipitation,precipitation_probability&forecast_days=4&timezone=Asia%2FBangkok`;
  let res = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "thai-water-monitor (personal dashboard)" }, signal: AbortSignal.timeout(90_000) });
      if (r.status === 429) { console.log("เตือนฝน: โดนจำกัดโควตาชั่วคราว รอ 65 วินาที"); await sleep(65_000); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res = await r.json();
    } catch (e) { console.error(`เตือนฝน: ชุดที่ ${c / CHUNK + 1} ล้มเหลว — ${e.message}`); break; }
  }
  if (!res) { failed += part.length; continue; }
  const arr = Array.isArray(res) ? res : [res];
  part.forEach((pt, k) => {
    const h = arr[k]?.hourly;
    if (!h) return;
    ok++;
    rows.push(...packRows(pt.p, pt.i, findPeriods(h.time, h.precipitation, h.precipitation_probability, now), dates));
  });
  if (c + CHUNK < points.length) await sleep(GAP_MS);
}

if (!ok) {
  console.error("เตือนฝน: ดึงข้อมูลไม่ได้เลย ใช้ผลรอบก่อน");
  if (prev) await writeFile(join(OUT, "alerts.json"), JSON.stringify({ ...prev, stale: true }));
  process.exit(2);
}
await writeFile(join(OUT, "alerts.json"), JSON.stringify({ updated: now, dates, covered: ok, missing: failed, rows }));
console.log(`เตือนฝน: ${ok} อำเภอ · ${rows.length} ช่วงฝน${failed ? ` · ขาด ${failed} อำเภอ` : ""}`);
