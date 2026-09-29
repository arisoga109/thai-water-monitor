// ประเมินความเสี่ยงจากฝนสะสมรายจังหวัด + สร้าง "ค่าปกติ" จากข้อมูลย้อนหลัง
// ใช้: node scripts/risk.mjs --prev prev/data --out out/data
//
// - ค่าปกติ (climatology.json): ฝนรายวัน ERA5 ย้อนหลัง 10 ปีของจุดกลางแต่ละจังหวัด ผ่าน Open-Meteo Archive
//   ข้อมูลชุดนี้ใหญ่ จึงทยอยดึงรอบละไม่กี่จังหวัด (ไม่ให้เกินโควตาฟรีของ Open-Meteo) จนครบ 77 จังหวัดใน 2–3 วัน
//   ระหว่างนั้นจังหวัดที่ยังไม่มีค่าปกติจะใช้เกณฑ์ทั่วไปแทน
// - ความเสี่ยง (risk.json): ฝน 30 วันที่ผ่านมา + พยากรณ์ 8 วันจาก 3 โมเดล คำนวณทุก ~3 ชม.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildClimatology, assessRisk } from "../site/risk.js";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PREV = arg("--prev", "prev/data");
const OUT = arg("--out", "out/data");
const FORCE = process.argv.includes("--force");

const CLIM_YEARS = [2015, 2024];
const CLIM_PER_RUN = Number(process.env.CLIM_PER_RUN ?? 2); // จังหวัดต่อรอบ
const CLIM_EVERY_MS = 3 * 3600e3;
const CLIM_GAP_MS = Number(process.env.CLIM_GAP_MS ?? 35_000);
const RISK_EVERY_MS = 170 * 60e3;
const MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"];

const provinces = JSON.parse(await readFile(new URL("../site/provinces.json", import.meta.url), "utf8"));
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "thai-water-monitor (personal dashboard)" }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

await mkdir(OUT, { recursive: true });

// ---------------------------------------------------------------- ค่าปกติเดิม (ใช้คำนวณความเสี่ยงรอบนี้)
const clim = await readJson(join(PREV, "climatology.json"), null) ?? {
  source: "ERA5 reanalysis (Open-Meteo Archive API)", years: CLIM_YEARS, prov: {}, lastAttempt: 0,
};
clim.done = Object.keys(clim.prov).length;
clim.total = provinces.length;

// ---------------------------------------------------------------- ความเสี่ยง
const prevRisk = await readJson(join(PREV, "risk.json"), null);
const latest = await readJson(join(OUT, "latest.json"), await readJson(join(PREV, "latest.json"), {}));
const climChanged = prevRisk && prevRisk.climDone !== clim.done;

if (!FORCE && prevRisk && !climChanged && now - prevRisk.updated < RISK_EVERY_MS) {
  await writeFile(join(OUT, "risk.json"), JSON.stringify(prevRisk));
  console.log("ความเสี่ยง: ใช้ผลรอบก่อน (ยังไม่ครบ 3 ชม.)");
} else {

// สถานะแม่น้ำรายจังหวัด
const river = {};
for (const s of latest.wl ?? []) {
  const r = (river[s.p] ||= { n: 0, high: 0, over: 0, rising: 0 });
  r.n++;
  if (s.pct > 100) r.over++; else if (s.pct > 70) r.high++;
  if (s.msl !== null && s.prev !== null && s.msl - s.prev > 0.05) r.rising++;
}

const todayIso = new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
try {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${provinces.map((p) => p.lat).join(",")}`
    + `&longitude=${provinces.map((p) => p.lon).join(",")}&daily=precipitation_sum&models=${MODELS.join(",")}`
    + `&past_days=30&forecast_days=8&timezone=Asia%2FBangkok`;
  let res;
  try { res = await getJson(url); }
  catch (e) {
    if (e.status !== 429) throw e;
    console.log("ความเสี่ยง: โดนจำกัดโควตาชั่วคราว รอ 65 วินาทีแล้วลองใหม่");
    await sleep(65_000);
    res = await getJson(url);
  }
  const arr = Array.isArray(res) ? res : [res];
  const out = { updated: now, climDone: clim.done, climTotal: clim.total, climYears: clim.years, prov: {} };
  provinces.forEach((p, i) => {
    const d = arr[i]?.daily;
    if (!d) return;
    const models = Object.fromEntries(MODELS.map((m) => [m, d[`precipitation_sum_${m}`] ?? d.time.map(() => null)]));
    let today = d.time.indexOf(todayIso);
    if (today < 0) today = 30;
    const r = assessRisk({ dates: d.time, models, today, clim: clim.prov[p.code] ?? null, river: river[p.code] ?? null, stationMax: latest.rain?.byProv?.[p.code]?.max ?? null });
    // อนุกรมสำหรับกราฟ: 14 วันที่ผ่านมา + 7 วันข้างหน้า
    const s = Math.max(0, today - 14), e = Math.min(d.time.length, today + 8);
    r.series = {
      start: d.time[s], today: today - s,
      m: Object.fromEntries(MODELS.map((m) => [m, models[m].slice(s, e).map((x) => (x === null ? null : Math.round(x * 10) / 10))])),
    };
    out.prov[p.code] = r;
  });
  await writeFile(join(OUT, "risk.json"), JSON.stringify(out));
  const top = Object.entries(out.prov).sort((a, b) => b[1].score - a[1].score).slice(0, 5)
    .map(([c, r]) => `${provinces.find((p) => p.code == c).name} ${r.score}`);
  console.log(`ความเสี่ยง: ${Object.keys(out.prov).length} จังหวัด · สูงสุด ${top.join(", ")}`);
} catch (e) {
  console.error("ความเสี่ยง: ล้มเหลว —", e.message);
  if (prevRisk) await writeFile(join(OUT, "risk.json"), JSON.stringify({ ...prevRisk, stale: true }));
  process.exitCode = 2;
}
}

// ---------------------------------------------------------------- ทยอยสร้างค่าปกติ (ทำหลังคำนวณความเสี่ยง)
// Open-Meteo จำกัด ~600 หน่วย/นาที และข้อมูล 10 ปีของหนึ่งจุดนับราว 260 หน่วย จึงเว้น 35 วินาทีระหว่างจังหวัด
const pending = provinces.filter((p) => !clim.prov[p.code]);
if (pending.length && (FORCE || now - (clim.lastAttempt || 0) >= CLIM_EVERY_MS)) {
  clim.lastAttempt = now;
  for (const p of pending.slice(0, CLIM_PER_RUN)) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${p.lat}&longitude=${p.lon}`
      + `&start_date=${CLIM_YEARS[0]}-01-01&end_date=${CLIM_YEARS[1]}-12-31&daily=precipitation_sum&models=era5&timezone=Asia%2FBangkok`;
    try {
      const d = await getJson(url);
      clim.prov[p.code] = buildClimatology(d.daily.time, d.daily.precipitation_sum);
      console.log(`ค่าปกติ: ${p.name} ✓`);
    } catch (e) {
      console.error(`ค่าปกติ: ${p.name} ล้มเหลว — ${e.message}`);
      if (e.status === 429) break; // เกินโควตา รอรอบถัดไป
    }
    await sleep(CLIM_GAP_MS);
  }
}
clim.done = Object.keys(clim.prov).length;
clim.total = provinces.length;
await writeFile(join(OUT, "climatology.json"), JSON.stringify(clim));
console.log(`ค่าปกติ: ${clim.done}/${clim.total} จังหวัด`);

