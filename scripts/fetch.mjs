// ดึงข้อมูลน้ำทั้งประเทศ แล้วเขียนเป็นไฟล์ JSON ให้หน้าเว็บอ่าน
// ใช้: node scripts/fetch.mjs --prev <โฟลเดอร์ data เดิม> --out <โฟลเดอร์ data ใหม่>
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeWaterLevels, normalizeRain, normalizeDams, normalizeDpmRiver, validate,
  mergeWaterHistory, mergeDamHistory, mergeRainHistory,
} from "./lib.mjs";

const TW = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public";
const SOURCES = {
  wl: `${TW}/waterlevel_load`,
  rain: `${TW}/rain_24h`,
  dams: "https://app.rid.go.th/reservoir/api/dam/public",
};
// แหล่งสำรองของระดับน้ำ: สถานีกรมชลประทาน (รายวัน) ผ่าน GIS ของกรมป้องกันและบรรเทาสาธารณภัย
const DPM_RIVER = "https://gis-portal.disaster.go.th/arcgis/rest/services/Map115_Dynamic/DPM_RUNOFF_STATION_RID_DSS/FeatureServer/0/query";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PREV = arg("--prev", "prev/data");
const OUT = arg("--out", "out/data");

async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "thai-water-monitor (personal dashboard)", Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, (process.env.RETRY_MS ?? 3000) * (i + 1)));
    }
  }
  throw new Error(`${url}: ${err?.message || err}`);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data));
}

const now = Date.now();
const prevLatest = await readJson(join(PREV, "latest.json"), {});
const status = {};

async function load(key, normalize) {
  try {
    const data = normalize(await getJson(SOURCES[key]));
    const bad = validate(key, data);
    if (bad) throw new Error(`ข้อมูลผิดปกติ: ${bad}`);
    status[key] = { ok: true, at: now, n: key === "dams" ? data.dams.length : key === "rain" ? Object.keys(data.byProv).length : data.length };
    return data;
  } catch (e) {
    console.error(`[${key}] ล้มเหลว:`, e.message);
    // ใช้ข้อมูลรอบก่อนแทน และบอกหน้าเว็บว่าเป็นข้อมูลเก่า (เก็บเวลาที่ได้ข้อมูลดีครั้งล่าสุดไว้)
    status[key] = { ok: false, at: prevLatest.status?.[key]?.at ?? null, error: e.message };
    return null;
  }
}

async function loadDpmRiver() {
  const features = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const q = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "true", outSR: "4326", f: "geojson", resultOffset: String(offset), resultRecordCount: "1000" });
    const page = await getJson(`${DPM_RIVER}?${q}`);
    const batch = page.features || [];
    features.push(...batch);
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!batch.length || !more) break;
  }
  return normalizeDpmRiver(features, now);
}

const [wlMain, rain, dams] = await Promise.all([
  load("wl", (p) => normalizeWaterLevels(p, now)),
  load("rain", (p) => normalizeRain(p, now)),
  load("dams", normalizeDams),
]);

// ระดับน้ำ: ถ้า ThaiWater ใช้ไม่ได้ ลองแหล่งสำรองก่อนใช้ข้อมูลรอบก่อน
let wl = wlMain;
if (!wl) {
  try {
    const backup = await loadDpmRiver();
    if (backup.length >= 100) {
      wl = backup;
      status.wl = { ...status.wl, backup: "สถานีกรมชลประทาน (รายวัน)", backupAt: now, n: backup.length };
      console.log(`[wl] ใช้แหล่งสำรอง: ${backup.length} สถานี`);
    } else console.error(`[wl] แหล่งสำรองมีเพียง ${backup.length} สถานี`);
  } catch (e) { console.error("[wl] แหล่งสำรองล้มเหลว:", e.message); }
}

const latest = {
  updated: now,
  status,
  wl: wl ?? prevLatest.wl ?? [],
  rain: rain ? { top: rain.stations.slice(0, 400), byProv: rain.byProv } : prevLatest.rain ?? { top: [], byProv: {} },
  dams: dams ?? prevLatest.dams ?? { date: null, dams: [] },
};

// ---------- ประวัติ
await mkdir(join(OUT, "wl"), { recursive: true });

const wlHist = {};
try {
  for (const f of await readdir(join(PREV, "wl"))) {
    if (f.endsWith(".json")) wlHist[f.slice(0, -5)] = await readJson(join(PREV, "wl", f), {});
  }
} catch { /* รอบแรกยังไม่มีประวัติ */ }
if (wlMain) mergeWaterHistory(wlHist, wlMain, now); // ไม่ปนข้อมูลสำรองลงประวัติ (คนละชุดสถานี)

const damHist = await readJson(join(PREV, "dams-history.json"), {});
if (dams) mergeDamHistory(damHist, dams);

const rainHist = await readJson(join(PREV, "rain-history.json"), {});
if (rain) mergeRainHistory(rainHist, rain.byProv, now);

await writeJson(join(OUT, "latest.json"), latest);
for (const [p, h] of Object.entries(wlHist)) await writeJson(join(OUT, "wl", `${p}.json`), h);
await writeJson(join(OUT, "dams-history.json"), damHist);
await writeJson(join(OUT, "rain-history.json"), rainHist);

console.log(
  `สถานีระดับน้ำ ${latest.wl.length} | สถานีมีฝน ${latest.rain.top.length} | เขื่อน ${latest.dams.dams.length}`,
  JSON.stringify(status),
);
// ถ้าทุกแหล่งล้มเหลวพร้อมกัน ให้ workflow แสดงสถานะเป็นสีแดง แต่ยังเผยแพร่ข้อมูลรอบก่อน
if (!wl && !rain && !dams) process.exitCode = 2;
