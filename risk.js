// การประเมินความเสี่ยงจากฝนสะสมและความผิดปกติของฝน
// ใช้ร่วมกันทั้งฝั่งเซิร์ฟเวอร์ (GitHub Actions) และหน้าเว็บ — เป็นฟังก์ชันล้วน ไม่เรียกเครือข่าย
//
// แนวคิด
// 1) "ค่าปกติ" ของแต่ละจังหวัด: จากข้อมูลย้อนหลังหลายปี (ERA5) คำนวณการกระจายของฝน 1, 3, 7 วัน
//    และดัชนีความชื้นสะสม (API) ในช่วงเดียวกันของปี (±15 วัน) เก็บเป็นเปอร์เซ็นไทล์
// 2) เทียบฝนปัจจุบัน/คาดการณ์กับค่าปกตินั้น → ได้ "เปอร์เซ็นไทล์" = ผิดปกติแค่ไหนสำหรับพื้นที่และฤดูนี้
// 3) รวมหลายปัจจัยเป็นคะแนนความเสี่ยง 0–100 และแยกดูแต่ละปัจจัยได้

export const P_KNOTS = [50, 75, 90, 95, 99, 100]; // เปอร์เซ็นไทล์ที่เก็บในไฟล์ค่าปกติ
export const API_K = 0.9;                          // ค่าคงที่การลดลงของความชื้นสะสมต่อวัน
export const BINS = 24;                            // ครึ่งเดือน × 12

// ค่าปกติสำรองเมื่อยังไม่มีข้อมูลย้อนหลังของจังหวัด (อิงเกณฑ์ฝนของกรมอุตุฯ ช่วงฤดูฝน)
export const FALLBACK_CLIM = {
  d1: [3, 12, 30, 45, 80, 150],
  d3: [10, 28, 60, 85, 140, 250],
  d7: [25, 55, 105, 140, 210, 350],
  api: [25, 45, 75, 95, 140, 230],
};

/** ช่องครึ่งเดือน (0–23) ของวันที่ "YYYY-MM-DD" */
export function binOf(iso) {
  const m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  return (m - 1) * 2 + (d > 15 ? 1 : 0);
}

/** เปอร์เซ็นไทล์ของชุดค่าที่เรียงแล้ว */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (q >= 100) return sorted[sorted.length - 1];
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * แปลงค่าเป็นเปอร์เซ็นไทล์ โดยประมาณจากจุด P50…P100
 * ค่าเกินค่าสูงสุดในอดีต → คืนค่ามากกว่า 100 (ยิ่งมากยิ่งเกินประวัติ)
 */
export function pctRank(v, knots) {
  if (v === null || v === undefined || !knots) return null;
  const k = knots;
  if (v <= k[0]) return k[0] > 0 ? (v / k[0]) * 50 : v > 0 ? 50 : 0;
  for (let i = 1; i < k.length; i++) {
    if (v <= k[i]) {
      const span = k[i] - k[i - 1];
      return P_KNOTS[i - 1] + (span > 0 ? ((v - k[i - 1]) / span) * (P_KNOTS[i] - P_KNOTS[i - 1]) : 0);
    }
  }
  // เกินค่าสูงสุด: 100 + สัดส่วนที่เกิน (เช่น เกิน 50% → 150) จำกัดไว้ที่ 200
  const max = k[k.length - 1];
  return Math.min(200, 100 + (max > 0 ? ((v - max) / max) * 100 : 100));
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const scale = (v, lo, hi) => (v === null || v === undefined ? 0 : clamp01((v - lo) / (hi - lo)));
const median = (arr) => {
  const v = arr.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sumRange = (a, s, e) => {
  let t = 0;
  for (let i = Math.max(0, s); i < Math.min(a.length, e); i++) t += a[i] ?? 0;
  return t;
};
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

// ---------------------------------------------------------------- สร้างค่าปกติจากข้อมูลย้อนหลัง
/**
 * @param {string[]} dates  วันที่ "YYYY-MM-DD" เรียงต่อเนื่อง
 * @param {number[]} precip ฝนรายวัน (มม.)
 * @returns {{d1,d3,d7,api,heavy}} แต่ละตัวเป็นอาร์เรย์ 24 ช่อง × จุดเปอร์เซ็นไทล์
 *          heavy = จำนวนวันเฉลี่ยต่อปีในช่วง ±15 วันที่ฝน ≥ 35 มม.
 */
export function buildClimatology(dates, precip) {
  const n = dates.length;
  const p = precip.map((x) => (x === null || x === undefined ? 0 : x));
  const s3 = new Array(n).fill(null), s7 = new Array(n).fill(null), api = new Array(n).fill(null);
  let a = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 2) s3[i] = p[i] + p[i - 1] + p[i - 2];
    if (i >= 6) s7[i] = sumRange(p, i - 6, i + 1);
    api[i] = i >= 30 ? a : null; // ความชื้นสะสมก่อนวันนี้ (ต้องมีข้อมูลก่อนหน้าพอ)
    a = API_K * a + p[i];
  }
  const doy = dates.map((d) => {
    const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    return Math.floor((t - Date.UTC(+d.slice(0, 4), 0, 1)) / 864e5);
  });
  const years = new Set(dates.map((d) => d.slice(0, 4))).size || 1;
  const out = { d1: [], d3: [], d7: [], api: [], heavy: [] };
  for (let b = 0; b < BINS; b++) {
    const month = Math.floor(b / 2), half = b % 2;
    const center = Math.floor((Date.UTC(2001, month, half ? 23 : 8) - Date.UTC(2001, 0, 1)) / 864e5);
    const sel = [];
    for (let i = 0; i < n; i++) {
      let dd = Math.abs(doy[i] - center);
      dd = Math.min(dd, 365 - dd);
      if (dd <= 15) sel.push(i);
    }
    const pack = (arr) => {
      const v = sel.map((i) => arr[i]).filter((x) => x !== null).sort((x, y) => x - y);
      return P_KNOTS.map((q) => r1(quantile(v, q)));
    };
    out.d1.push(pack(p));
    out.d3.push(pack(s3));
    out.d7.push(pack(s7));
    out.api.push(pack(api));
    out.heavy.push(r1(sel.filter((i) => p[i] >= 35).length / years));
  }
  return out;
}

export function climFor(clim, iso) {
  if (!clim) return { ...FALLBACK_CLIM, heavy: null, fallback: true };
  const b = binOf(iso);
  return { d1: clim.d1[b], d3: clim.d3[b], d7: clim.d7[b], api: clim.api[b], heavy: clim.heavy?.[b] ?? null, fallback: false };
}

// ---------------------------------------------------------------- ประเมินความเสี่ยงของหนึ่งพื้นที่
/**
 * @param {object} o
 * @param {string[]} o.dates   วันที่ของอนุกรม (รวมอดีตและอนาคต)
 * @param {Object<string, number[]>} o.models  ฝนรายวันของแต่ละโมเดล (อาร์เรย์ยาวเท่า dates)
 * @param {number} o.today     ดัชนีของวันนี้ใน dates
 * @param {object|null} o.clim ค่าปกติของจังหวัด (ผลจาก buildClimatology) หรือ null
 * @param {object} [o.river]   { n, high, over, rising } สถานะแม่น้ำในจังหวัด
 * @param {number} [o.stationMax] ฝนสูงสุด 24 ชม. จากสถานีวัดจริง
 */
export function assessRisk({ dates, models, today, clim, river = null, stationMax = null }) {
  const names = Object.keys(models);
  const n = dates.length;
  const med = dates.map((_, i) => median(names.map((m) => models[m][i])) ?? 0);
  const c = climFor(clim, dates[today]);

  // ความชื้นสะสมถึงเมื่อวาน (API)
  let api = 0;
  for (let i = 0; i < today; i++) api = API_K * api + med[i];

  const past3 = sumRange(med, today - 3, today);
  const past7 = sumRange(med, today - 7, today);
  const perModel = names.map((m) => ({
    m,
    f3: models[m].slice(today, today + 3).some((x) => x === null || x === undefined) ? null : sumRange(models[m], today, today + 3),
    f7: sumRange(models[m], today, today + 7),
  }));
  const f3 = median(perModel.map((x) => x.f3)) ?? sumRange(med, today, today + 3);
  const f7 = median(perModel.map((x) => x.f7)) ?? sumRange(med, today, today + 7);
  const event7 = sumRange(med, today - 4, today) + f3; // 4 วันที่ผ่านมา + 3 วันข้างหน้า
  const next3 = med.slice(today, today + 3);
  const maxDay = Math.max(0, ...next3);
  const maxDayIdx = today + next3.indexOf(maxDay);

  // ฝนหนักต่อเนื่อง: วันที่ฝน ≥ เกณฑ์หนักของพื้นที่ (P90 รายวันของฤดูนี้ แต่ไม่ต่ำกว่า 20 มม.)
  const heavyTh = Math.max(20, c.d1[2] ?? 30);
  let run = 0, best = { len: 0, start: null, end: null };
  for (let i = Math.max(0, today - 7); i < Math.min(n, today + 7); i++) {
    if (med[i] >= heavyTh) {
      run++;
      if (run > best.len && i >= today - 1) best = { len: run, start: i - run + 1, end: i };
    } else run = 0;
  }

  // วันแรกข้างหน้าที่คาดว่าฝนหนัก (ใช้เตือนล่วงหน้า)
  let firstHeavy = null;
  for (let i = today; i < Math.min(n, today + 7); i++) if (med[i] >= heavyTh) { firstHeavy = i; break; }

  // ความเห็นตรงกันของโมเดล: จำนวนโมเดลที่ให้ฝน 3 วันข้างหน้าเกินระดับ P90 ของพื้นที่ (และ ≥ 25 มม.)
  const f3Th = Math.max(25, c.d3[2] ?? 60);
  const agree = perModel.filter((x) => x.f3 !== null && x.f3 >= f3Th).length;
  const nModels = perModel.filter((x) => x.f3 !== null).length;

  const pct = {
    event7: pctRank(event7, c.d7),
    f3: pctRank(f3, c.d3),
    past7: pctRank(past7, c.d7),
    api: pctRank(api, c.api),
    maxDay: pctRank(maxDay, c.d1),
  };

  // ---- คะแนนย่อย 0–1
  // ความผิดปกติจะถูกลดน้ำหนักเมื่อปริมาณจริงยังน้อย (กันกรณีหน้าแล้งที่ฝน 15 มม. ก็ "ผิดปกติ" แล้ว)
  const s = {
    event: scale(pct.event7, 75, 99) * scale(event7, 30, 100),
    future: scale(pct.f3, 75, 99) * scale(f3, 20, 70),
    soil: scale(pct.api, 50, 95) * scale(api, 20, 60),
    intensity: Math.max(scale(pct.maxDay, 90, 99.5) * scale(maxDay, 20, 60), scale(stationMax, 35, 120)),
    persist: clamp01(best.len / 4),
    river: river && river.n ? clamp01((river.high + 2 * river.over) / Math.max(3, river.n) * 1.5 + (river.over ? 0.25 : 0)) : 0,
  };
  const W = { event: 0.3, future: 0.2, soil: 0.15, intensity: 0.1, persist: 0.1, river: 0.15 };
  const score = Math.round(100 * Object.entries(W).reduce((t, [k, w]) => t + w * s[k], 0));

  // "เปลี่ยนฉับพลัน": 7 วันที่ผ่านมาปกติหรือแห้ง แต่ 3 วันข้างหน้าผิดปกติมาก
  const onset = (pct.past7 ?? 0) < 75 && (pct.f3 ?? 0) >= 95 && f3 >= 30;

  // ความผิดปกติ (ไม่สนปริมาณ ใช้เรียงอันดับ "ผิดจากปกติของพื้นที่")
  const anomaly = Math.max(pct.event7 ?? 0, pct.f3 ?? 0);

  return {
    score,
    level: riskLevel(score).key,
    anomaly: r1(anomaly),
    anomalyLevel: anomalyLevel(anomaly).key,
    agree, nModels, onset,
    firstHeavy: firstHeavy === null ? null : { date: dates[firstHeavy], inDays: firstHeavy - today, mm: r1(med[firstHeavy]) },
    fallback: c.fallback,
    v: { past3: r1(past3), past7: r1(past7), f3: r1(f3), f7: r1(f7), event7: r1(event7), api: r1(api), maxDay: r1(maxDay), maxDayDate: dates[maxDayIdx], stationMax },
    pct: Object.fromEntries(Object.entries(pct).map(([k, x]) => [k, r1(x)])),
    s: Object.fromEntries(Object.entries(s).map(([k, x]) => [k, Math.round(x * 100) / 100])),
    run: best.len ? { len: best.len, start: dates[best.start], end: dates[best.end], th: r1(heavyTh) } : null,
    norm: { d3p90: c.d3[2], d7p90: c.d7[2], d7p50: c.d7[0], d1p90: c.d1[2], heavyDays: c.heavy },
  };
}

export const RISK_LEVELS = [
  { min: 60, key: "vhigh", label: "เสี่ยงสูงมาก", color: "over" },
  { min: 40, key: "high", label: "เสี่ยงสูง", color: "high" },
  { min: 25, key: "watch", label: "เฝ้าระวัง", color: "low" },
  { min: 0, key: "normal", label: "ปกติ", color: "normal" },
];
export const riskLevel = (score) => RISK_LEVELS.find((l) => score >= l.min);

export const ANOMALY_LEVELS = [
  { min: 100, key: "record", label: "เกินสถิติช่วงเดียวกันในอดีต" },
  { min: 99, key: "extreme", label: "ผิดปกติมาก (สูงสุด 1%)" },
  { min: 95, key: "very", label: "สูงผิดปกติ (สูงสุด 5%)" },
  { min: 90, key: "above", label: "สูงกว่าปกติ (สูงสุด 10%)" },
  { min: 0, key: "normal", label: "ปกติ" },
];
export const anomalyLevel = (p) => ANOMALY_LEVELS.find((l) => (p ?? 0) >= l.min);

/** ข้อความอธิบายความผิดปกติแบบคนอ่านเข้าใจ */
export function anomalyText(p) {
  if (p === null || p === undefined) return "–";
  if (p >= 200) return "มากกว่า 2 เท่าของค่าสูงสุดในช่วงเดียวกันของอดีต";
  if (p > 100) return `เกินค่าสูงสุดในช่วงเดียวกันของอดีต ${Math.round(p - 100)}%`;
  if (p >= 99) return "เกิดขึ้นไม่ถึง 1 ใน 100 ของช่วงนี้ในอดีต";
  if (p >= 95) return `เกิดขึ้นราว 1 ใน ${Math.round(100 / (100 - p))} ของช่วงนี้ในอดีต`;
  if (p >= 75) return `มากกว่าปกติ (สูงกว่า ${Math.round(p)}% ของช่วงนี้ในอดีต)`;
  return "อยู่ในเกณฑ์ปกติของช่วงนี้";
}
