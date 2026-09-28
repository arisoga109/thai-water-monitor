// สร้างข้อมูลจำลองไว้ลองหน้าเว็บในเครื่อง (ไม่ต้องต่อเน็ต): node scripts/mock.mjs
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { buildClimatology, assessRisk } from "../site/risk.js";
import { normalizeWaterLevels, normalizeRain, normalizeDams, mergeWaterHistory, mergeDamHistory, mergeRainHistory } from "./lib.mjs";

const OUT = "out/data";
const provinces = JSON.parse(await readFile(new URL("../site/provinces.json", import.meta.url), "utf8"));
const now = Date.now();
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const thTime = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

const wlRaw = [], rainRaw = [];
let id = 1;
for (const p of provinces) {
  const wet = rnd();
  for (let i = 0; i < 4 + Math.floor(rnd() * 12); i++) {
    const pct = Math.max(5, Math.min(135, 30 + wet * 70 + (rnd() - 0.5) * 60));
    const msl = 10 + rnd() * 200;
    wlRaw.push({
      id: id, waterlevel_datetime: thTime(now - rnd() * 2 * 3600e3), waterlevel_msl: msl.toFixed(2),
      waterlevel_msl_previous: (msl - (rnd() - 0.4) * 0.3).toFixed(2), storage_percent: pct.toFixed(2),
      diff_wl_bank: ((pct - 100) / 20).toFixed(2), discharge: (rnd() * 800).toFixed(1),
      station: { id: id++, tele_station_name: { th: `สถานี ${p.name} ${i + 1}` }, tele_station_lat: p.lat + (rnd() - 0.5) * 0.4, tele_station_long: p.lon + (rnd() - 0.5) * 0.4 },
      geocode: { province_name: { th: p.name }, amphoe_name: { th: `อำเภอ${i + 1}` } },
      basin: { basin_name: { th: "ลุ่มน้ำตัวอย่าง" } }, agency: { agency_shortname: { th: "สสน." } },
    });
  }
  for (let i = 0; i < 20; i++) {
    const mm = rnd() < 0.5 ? 0 : Math.pow(rnd(), 2) * 140 * wet;
    rainRaw.push({
      rain_24h: +mm.toFixed(1), rainfall_datetime: thTime(now - 3600e3),
      station: { id: id++, tele_station_name: { th: `ฝน ${p.name} ${i + 1}` }, tele_station_lat: p.lat, tele_station_long: p.lon },
      geocode: { province_name: { th: p.name }, amphoe_name: { th: `อำเภอ${i + 1}` } },
    });
  }
}

const DAMS = [
  ["ภาคเหนือ", ["เขื่อนภูมิพล", 13462], ["เขื่อนสิริกิติ์", 9510], ["เขื่อนแม่งัดสมบูรณ์ชล", 265], ["เขื่อนกิ่วลม", 106]],
  ["ภาคตะวันออกเฉียงเหนือ", ["เขื่อนอุบลรัตน์", 2431], ["เขื่อนลำปาว", 1980], ["เขื่อนสิรินธร", 1966], ["เขื่อนลำตะคอง", 314]],
  ["ภาคกลาง", ["เขื่อนป่าสักชลสิทธิ์", 960], ["เขื่อนทับเสลา", 160]],
  ["ภาคตะวันตก", ["เขื่อนศรีนครินทร์", 17745], ["เขื่อนวชิราลงกรณ", 8860], ["เขื่อนแก่งกระจาน", 710]],
  ["ภาคตะวันออก", ["เขื่อนบางพระ", 117], ["เขื่อนหนองปลาไหล", 164]],
  ["ภาคใต้", ["เขื่อนรัชชประภา", 5639], ["เขื่อนบางลาง", 1454]],
];
const damRaw = (date, drift) => ({
  date,
  data: DAMS.map(([region, ...list]) => ({
    region,
    dam: list.map(([name, st], i) => {
      const pct = Math.min(112, 25 + ((name.length * 13 + i * 17) % 80) + drift);
      return { id: name, name, capacity: st * 1.1, storage: st, active_storage: st * 0.8, dead_storage: st * 0.2, volume: (st * pct) / 100, percent_storage: pct, inflow: st / 400, outflow: st / 500 };
    }),
  })),
});

const wl = normalizeWaterLevels(wlRaw, now);
const rain = normalizeRain(rainRaw, now);
const dams = normalizeDams(damRaw(new Date(now + 7 * 3600e3).toISOString().slice(0, 10), 0));

// ประวัติจำลอง
const wlHist = {};
for (let h = 72; h >= 0; h -= 1) {
  mergeWaterHistory(wlHist, wl.map((s) => ({ ...s, t: s.t - h * 3600e3, msl: s.msl - h * 0.01 + Math.sin(h / 5) * 0.2, pct: s.pct - h * 0.25 + Math.sin(h / 5) * 3 })), now);
}
const damHist = {};
for (let d = 60; d >= 0; d--) {
  const date = new Date(now + 7 * 3600e3 - d * 864e5).toISOString().slice(0, 10);
  mergeDamHistory(damHist, normalizeDams(damRaw(date, -d * 0.25)));
}
const rainHist = {};
for (let d = 20; d >= 0; d--) {
  const bp = Object.fromEntries(Object.entries(rain.byProv).map(([p, s]) => [p, { ...s, avg: +(s.avg * rnd() * 2).toFixed(1), max: +(s.max * rnd() * 1.5).toFixed(1) }]));
  mergeRainHistory(rainHist, bp, Math.floor((now + 7 * 3600e3) / 864e5) * 864e5 + 3600e3 - d * 864e5); // 08:00 เวลาไทย
}

await mkdir(`${OUT}/wl`, { recursive: true });
await writeFile(`${OUT}/latest.json`, JSON.stringify({
  updated: now, status: { wl: { ok: true, at: now }, rain: { ok: true, at: now }, dams: { ok: true, at: now } },
  wl, rain: { top: rain.stations.slice(0, 400), byProv: rain.byProv }, dams,
}));
for (const [p, h] of Object.entries(wlHist)) await writeFile(`${OUT}/wl/${p}.json`, JSON.stringify(h));
await writeFile(`${OUT}/dams-history.json`, JSON.stringify(damHist));
await writeFile(`${OUT}/rain-history.json`, JSON.stringify(rainHist));
// ---- ความเสี่ยงจำลอง: ค่าปกติจาก "ERA5" สังเคราะห์ + สถานการณ์ตัวอย่างบางจังหวัด
const climProv = {};
const riskProv = {};
const todayIso = new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
const scenario = { 50: "onset", 57: "onset", 22: "persist", 21: "persist", 80: "heavy", 34: "ahead", 45: "ahead" };
for (const p of provinces) {
  const south = p.lat < 11, dryish = [30, 31, 32, 40, 41].includes(p.code) || p.code === 50 || p.code === 57;
  const dates = [], pr = [];
  for (let t = Date.UTC(2015, 0, 1); t <= Date.UTC(2024, 11, 31); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10), m = +d.slice(5, 7);
    const wet = south ? m >= 10 || m <= 1 || (m >= 5 && m <= 9 && rnd() < 0.5) : m >= 5 && m <= 10;
    dates.push(d);
    pr.push(wet && rnd() < 0.5 ? -Math.log(rnd() + 1e-9) * (dryish ? 7 : south ? 22 : 14) : rnd() < 0.04 ? 3 : 0);
  }
  climProv[p.code] = buildClimatology(dates, pr);
  const n = 38, today = 30;
  const ds = Array.from({ length: n }, (_, i) => new Date(Date.parse(todayIso) + (i - today) * 864e5).toISOString().slice(0, 10));
  const kind = scenario[p.code];
  const base = Array.from({ length: n }, () => (rnd() < 0.45 ? -Math.log(rnd() + 1e-9) * 6 : 0));
  if (kind === "onset") { for (let i = 23; i < 30; i++) base[i] = rnd() * 2; base[30] = 45; base[31] = 70; base[32] = 40; }
  if (kind === "persist") for (let i = 26; i < 34; i++) base[i] = 35 + rnd() * 40;
  if (kind === "heavy") { base[30] = 95; base[31] = 60; }
  if (kind === "ahead") { base[32] = 55; base[33] = 65; base[34] = 30; }
  const models = { ecmwf_ifs025: base.map((x) => +(x).toFixed(1)), gfs_seamless: base.map((x) => +(x * (0.8 + rnd() * 0.5)).toFixed(1)), icon_seamless: base.map((x, i) => (i > 35 ? null : +(x * (0.7 + rnd() * 0.5)).toFixed(1))) };
  const rv = { n: 0, high: 0, over: 0 };
  for (const s of wl) if (s.p === p.code) { rv.n++; if (s.pct > 100) rv.over++; else if (s.pct > 70) rv.high++; }
  const r = assessRisk({ dates: ds, models, today, clim: climProv[p.code], river: rv, stationMax: rain.byProv[p.code]?.max ?? null });
  r.series = { start: ds[16], today: 14, m: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.slice(16, 38)])) };
  riskProv[p.code] = r;
}
const partial = Object.fromEntries(Object.entries(climProv).slice(0, 60));
await writeFile(`${OUT}/climatology.json`, JSON.stringify({ source: "mock", years: [2015, 2024], prov: partial, done: 60, total: 77 }));
await writeFile(`${OUT}/risk.json`, JSON.stringify({ updated: now, climDone: 60, climTotal: 77, climYears: [2015, 2024], prov: riskProv }));

await cp("site", "out", { recursive: true });
console.log(`ข้อมูลจำลอง: ${wl.length} สถานีระดับน้ำ, ${rain.stations.length} สถานีฝน, ${dams.dams.length} เขื่อน → เปิดโฟลเดอร์ out/`);
