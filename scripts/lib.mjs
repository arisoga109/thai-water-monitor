// ฟังก์ชันแปลงข้อมูลจากต้นทางให้อยู่ในรูปแบบกะทัดรัด (pure functions ทดสอบได้)
import { readFileSync } from "node:fs";

const PROVINCES = JSON.parse(
  readFileSync(new URL("../site/provinces.json", import.meta.url), "utf8"),
);
const PROV_BY_NAME = new Map(PROVINCES.map((p) => [p.name, p.code]));
// ชื่อที่ต้นทางมักเขียนต่างออกไป
PROV_BY_NAME.set("กรุงเทพฯ", 10);
PROV_BY_NAME.set("กรุงเทพ", 10);

export function provinceCode(name) {
  if (!name) return 0;
  const clean = String(name).replace(/^จังหวัด|^จ\./, "").trim();
  return PROV_BY_NAME.get(clean) ?? 0;
}

export function records(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  for (const v of Object.values(payload)) {
    if (v && typeof v === "object" && Array.isArray(v.data)) return v.data;
  }
  return [];
}

export const th = (v) =>
  v && typeof v === "object" ? (v.th || v.en || "").trim() || null : typeof v === "string" ? v.trim() || null : null;

export function num(v, digits = 2) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function coords(lat, lon) {
  const a = num(lat, 4), b = num(lon, 4);
  if (a === null || b === null || (a === 0 && b === 0)) return null;
  if (a < 4 || a > 22 || b < 96 || b > 107) return null; // นอกประเทศไทย = พิกัดผิด
  return [a, b];
}

/** เวลาของ ThaiWater เป็นเวลาไทย เช่น "2026-09-27 14:20" → epoch ms */
export function parseThaiTime(s) {
  if (typeof s !== "string" || !s || s.startsWith("0001-")) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0) - 7, +(m[5] ?? 0));
}

const HOUR = 3600e3;

/** ระดับน้ำในแม่น้ำ (waterlevel_load) */
export function normalizeWaterLevels(payload, now = Date.now(), maxAgeH = 24) {
  const out = [];
  for (const r of records(payload)) {
    const st = r.station || {};
    const c = coords(st.tele_station_lat ?? r.tele_station_lat, st.tele_station_long ?? r.tele_station_long);
    const t = parseThaiTime(r.waterlevel_datetime);
    if (!c || !t || now - t > maxAgeH * HOUR) continue;
    const g = r.geocode || {};
    const prov = th(g.province_name);
    out.push({
      id: String(st.id ?? r.id),
      n: th(st.tele_station_name) || "สถานีระดับน้ำ",
      p: provinceCode(prov) || Number(g.province_code) || 0,
      a: th(g.amphoe_name),
      b: th((r.basin || {}).basin_name),
      ag: th((r.agency || {}).agency_shortname),
      lat: c[0], lon: c[1],
      msl: num(r.waterlevel_msl),
      prev: num(r.waterlevel_msl_previous),
      pct: num(r.storage_percent, 1),
      bank: num(r.diff_wl_bank),
      q: num(r.discharge, 1),
      lv: r.situation_level ?? null,
      t,
    });
  }
  return out;
}

/** ฝนสะสม 24 ชม. (rain_24h) → สถานีที่มีฝน + สรุปรายจังหวัด */
export function normalizeRain(payload, now = Date.now(), maxAgeH = 26) {
  const stations = [];
  const prov = {};
  for (const r of records(payload)) {
    const st = r.station || {};
    const c = coords(st.tele_station_lat, st.tele_station_long);
    const t = parseThaiTime(r.rainfall_datetime);
    const mm = num(r.rain_24h, 1);
    if (!c || !t || mm === null || mm < 0 || mm > 800 || now - t > maxAgeH * HOUR) continue;
    const g = r.geocode || {};
    const p = provinceCode(th(g.province_name)) || Number(g.province_code) || 0;
    const s = (prov[p] ||= { n: 0, sum: 0, max: 0, wet: 0 });
    s.n++; s.sum += mm; s.max = Math.max(s.max, mm); if (mm > 0) s.wet++;
    if (mm > 0) {
      stations.push({
        id: String(st.id ?? r.id),
        n: th(st.tele_station_name) || "สถานีวัดฝน",
        p, a: th(g.amphoe_name), lat: c[0], lon: c[1],
        mm, h1: num(r.rain_1h, 1), t,
      });
    }
  }
  const byProv = {};
  for (const [p, s] of Object.entries(prov)) {
    byProv[p] = { n: s.n, avg: num(s.sum / s.n, 1), max: s.max, wet: s.wet };
  }
  stations.sort((a, b) => b.mm - a.mm);
  return { stations, byProv };
}

// เขื่อนขนาดใหญ่ของกรมชลประทาน → จังหวัดที่ตั้ง (จับคู่ด้วยคำสำคัญในชื่อ)
const DAM_PROVINCE = [
  ["ภูมิพล", "ตาก"], ["สิริกิติ์", "อุตรดิตถ์"], ["แม่งัด", "เชียงใหม่"], ["แม่กวง", "เชียงใหม่"],
  ["กิ่วลม", "ลำปาง"], ["กี่วลม", "ลำปาง"], ["กิ่วคอหมา", "ลำปาง"], ["แม่มอก", "ลำปาง"],
  ["แควน้อย", "พิษณุโลก"], ["อุบลรัตน์", "ขอนแก่น"], ["จุฬาภรณ์", "ชัยภูมิ"], ["ห้วยกุ่ม", "ชัยภูมิ"],
  ["ห้วยหลวง", "อุดรธานี"], ["น้ำอูน", "สกลนคร"], ["น้ำพุง", "สกลนคร"], ["ลำปาว", "กาฬสินธุ์"],
  ["ลำตะคอง", "นครราชสีมา"], ["ลำพระเพลิง", "นครราชสีมา"], ["มูลบน", "นครราชสีมา"], ["ลำแซะ", "นครราชสีมา"],
  ["ลำนางรอง", "บุรีรัมย์"], ["สิรินธร", "อุบลราชธานี"], ["ปากมูล", "อุบลราชธานี"],
  ["ป่าสัก", "ลพบุรี"], ["ทับเสลา", "อุทัยธานี"], ["กระเสียว", "สุพรรณบุรี"],
  ["ศรีนครินทร์", "กาญจนบุรี"], ["วชิราลงกรณ", "กาญจนบุรี"], ["ท่าทุ่งนา", "กาญจนบุรี"],
  ["แก่งกระจาน", "เพชรบุรี"], ["ปราณบุรี", "ประจวบคีรีขันธ์"], ["ขุนด่าน", "นครนายก"],
  ["คลองสียัด", "ฉะเชิงเทรา"], ["บางพระ", "ชลบุรี"], ["หนองปลาไหล", "ระยอง"], ["ประแสร์", "ระยอง"],
  ["นฤบดินทร", "ปราจีนบุรี"], ["รัชชประภา", "สุราษฎร์ธานี"], ["บางลาง", "ยะลา"],
];

export function damProvince(name) {
  for (const [key, prov] of DAM_PROVINCE) if (name && name.includes(key)) return provinceCode(prov);
  return 0;
}

/** เขื่อนขนาดใหญ่ของกรมชลประทาน (หน่วย ล้าน ลบ.ม.) */
export function normalizeDams(payload) {
  const dams = [];
  for (const group of payload?.data || []) {
    for (const d of group.dam || []) {
      dams.push({
        id: String(d.id),
        n: d.name,
        rg: group.region,
        p: damProvince(d.name),
        cap: num(d.capacity),        // ความจุที่ระดับน้ำสูงสุด
        st: num(d.storage),          // ความจุที่ระดับเก็บกักปกติ
        act: num(d.active_storage),  // ความจุใช้การ
        dead: num(d.dead_storage),   // ปริมาตรน้ำใช้การไม่ได้
        v: num(d.volume),            // ปริมาตรน้ำปัจจุบัน
        pct: num(d.percent_storage, 1),
        in: num(d.inflow, 3),
        out: num(d.outflow, 3),
      });
    }
  }
  return { date: payload?.date || null, dams };
}

// ---------------------------------------------------------------- ประวัติ

/** เพิ่มจุดระดับน้ำรายชั่วโมงลงประวัติ แยกไฟล์รายจังหวัด เก็บย้อนหลัง keepDays วัน */
export function mergeWaterHistory(histByProv, stations, now = Date.now(), keepDays = 14) {
  const cutoff = now - keepDays * 24 * HOUR;
  for (const s of stations) {
    const h = (histByProv[s.p] ||= {});
    const arr = (h[s.id] ||= []);
    const hourT = Math.floor(s.t / HOUR); // เก็บเป็น "ชั่วโมงนับจาก epoch" ให้ไฟล์เล็ก
    if (!arr.length || arr[arr.length - 1][0] < hourT) arr.push([hourT, s.msl, s.pct]);
  }
  for (const h of Object.values(histByProv)) {
    for (const [id, arr] of Object.entries(h)) {
      const kept = arr.filter((x) => x[0] * HOUR >= cutoff);
      if (kept.length) h[id] = kept; else delete h[id];
    }
  }
  return histByProv;
}

/** ประวัติเขื่อนรายวัน: { [id]: [[date, volume, pct, in, out], ...] } */
export function mergeDamHistory(hist, damResult, keepDays = 400) {
  if (!damResult.date) return hist;
  for (const d of damResult.dams) {
    const arr = (hist[d.id] ||= []);
    const row = [damResult.date, d.v, d.pct, d.in, d.out];
    const i = arr.findIndex((x) => x[0] === damResult.date);
    if (i >= 0) arr[i] = row; else arr.push(row);
    arr.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (arr.length > keepDays) arr.splice(0, arr.length - keepDays);
  }
  return hist;
}

/** ฝนรายวันรายจังหวัด (บันทึกรอบแรกหลัง 07:00 ตามรอบวัดของกรมอุตุฯ) */
export function mergeRainHistory(hist, byProv, now = Date.now(), keepDays = 120) {
  const local = new Date(now + 7 * HOUR);
  const hour = local.getUTCHours();
  const date = local.toISOString().slice(0, 10);
  if (hour < 7 || hist[date]) return hist;
  hist[date] = Object.fromEntries(Object.entries(byProv).map(([p, s]) => [p, [s.avg, s.max, s.wet, s.n]]));
  const dates = Object.keys(hist).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - keepDays))) delete hist[d];
  return hist;
}

// ---------------------------------------------------------------- แหล่งสำรอง: สถานีวัดน้ำของกรมชลประทาน (ผ่าน GIS ของ ปภ.)
/** แปลง GeoJSON จาก DPM_RUNOFF_STATION_RID_DSS ให้อยู่ในรูปแบบเดียวกับ ThaiWater (ข้อมูลรายวัน) */
export function normalizeDpmRiver(features, now = Date.now(), maxAgeH = 60) {
  const out = [];
  for (const f of features || []) {
    const pr = f.properties || {};
    const g = f.geometry?.coordinates;
    const c = coords(g?.[1] ?? pr.LAT, g?.[0] ?? pr.LNG);
    const dt = typeof pr.DATA_DT === "number" ? pr.DATA_DT : parseThaiTime(String(pr.DATA_DT ?? "").replace(" 00:00:00", ""));
    if (!c || !dt || now - dt > maxAgeH * HOUR) continue;
    const msl = num(pr.WATER_LEVEL_MSL), bankLv = num(pr.BANK_LEVEL);
    out.push({
      id: `rid-${pr.STATION_CODE ?? pr.STATION_ID}`,
      n: (pr.STATION_DISPLAY_NAME || pr.STATION_CODE || "สถานีกรมชลประทาน").trim(),
      p: provinceCode(pr.PROV_NAM_T),
      a: pr.AMP_NAM_T ? String(pr.AMP_NAM_T).trim() : null,
      b: null,
      ag: "ชป.",
      lat: c[0], lon: c[1],
      msl, prev: null,
      pct: num(pr.PERCENT_CAPACITY, 1),
      bank: msl !== null && bankLv !== null ? Math.round((msl - bankLv) * 100) / 100 : null,
      q: num(pr.CAPACITY_TODAY, 1),
      lv: pr.WATER_STORAGE_LEVEL_ID ?? null,
      t: dt,
      src: "rid",
    });
  }
  return out;
}

// ---------------------------------------------------------------- ตรวจความสมเหตุสมผลของข้อมูล
// ต้นทางบางครั้งตอบ 200 แต่ข้อมูลว่าง/ไม่ครบ (เช่น ช่วงเช้าก่อนกรมชลประทานอัปเดต) — ห้ามเอาไปทับข้อมูลดี
export function validate(key, data) {
  if (key === "wl") {
    if (!data || data.length < 100) return `สถานีระดับน้ำน้อยผิดปกติ (${data?.length ?? 0})`;
    if (data.filter((s) => s.pct !== null).length < 50) return "สถานีส่วนใหญ่ไม่มีค่าระดับน้ำ";
  }
  if (key === "rain") {
    if (!data || Object.keys(data.byProv || {}).length < 30) return `มีข้อมูลฝนเพียง ${Object.keys(data?.byProv || {}).length} จังหวัด`;
  }
  if (key === "dams") {
    const n = data?.dams?.length ?? 0;
    if (n < 20) return `เขื่อนน้อยผิดปกติ (${n})`;
    if (data.dams.filter((d) => d.pct !== null && d.v !== null).length < 20) return "เขื่อนส่วนใหญ่ยังไม่มีค่าของวันนี้";
  }
  return null;
}
