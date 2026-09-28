// ติดตามน้ำไทย — หน้าเว็บอ่านไฟล์ JSON ที่ GitHub Actions อัปเดตให้ทุก 30 นาที
// พยากรณ์อากาศและน้ำท่าเรียกจาก Open-Meteo โดยตรง (ฟรี ไม่ต้องใช้ key)

import { REPORT_CSS, reportToPng, reportToPdf, deliverFile } from "./report.js";
import { assessRisk, riskLevel, anomalyLevel, anomalyText, RISK_LEVELS } from "./risk.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? "–" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: d, maximumFractionDigits: d }));
const sum = (a) => a.reduce((s, x) => s + (x ?? 0), 0);
const HOUR = 3600e3;

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* โหมดส่วนตัว */ } },
};

const S = {
  prov: store.get("prov", 0),
  tab: store.get("tab", "sum"),
  provinces: [],
  provByCode: new Map(),
  data: null,
  wlHist: {},        // ประวัติระดับน้ำรายจังหวัด (โหลดเมื่อจำเป็น)
  damHist: null,
  rainHist: null,
  wxCache: {},
  point: null,       // จุดที่ใช้พยากรณ์อากาศ (null = อำเภอที่เลือก / กลางจังหวัด)
  districts: {},     // { รหัสจังหวัด: [[ชื่ออำเภอ, lat, lon], ...] }
  dist: store.get("dist", {}), // อำเภอที่เลือกไว้ของแต่ละจังหวัด
  hsel: null,        // ชั่วโมงที่แตะดูในตารางฝนรายชั่วโมง
  distWx: {},
  open: null,        // แถวที่กางรายละเอียดอยู่
  q: "", sort: "pct", region: "ทั้งหมด",
};

// ---------------------------------------------------------------- เกณฑ์ระดับ (ThaiWater)
const RIVER_BANDS = [
  { max: 10, key: "crit-low", label: "น้อยวิกฤต" },
  { max: 30, key: "low", label: "น้อย" },
  { max: 70, key: "normal", label: "ปกติ" },
  { max: 100, key: "high", label: "น้ำมาก" },
  { max: Infinity, key: "over", label: "ล้นตลิ่ง" },
];
const DAM_BANDS = [
  { max: 30, key: "crit-low", label: "น้อยวิกฤต" },
  { max: 50, key: "low", label: "น้อย" },
  { max: 80, key: "normal", label: "ปกติ" },
  { max: 100, key: "high", label: "มาก" },
  { max: Infinity, key: "over", label: "เกินความจุ" },
];
const band = (bands, v) => (v === null || v === undefined ? null : bands.find((b) => v <= b.max));
const pill = (b) => (b ? `<span class="pill" style="--c:var(--${b.key})">${b.label}</span>` : `<span class="pill">ไม่มีข้อมูล</span>`);

// ฝนรายวันตามเกณฑ์กรมอุตุนิยมวิทยา (มม./24 ชม.)
function rainClass(mm) {
  if (mm === null || mm === undefined) return null;
  if (mm < 0.1) return { label: "ไม่มีฝน", key: "normal" };
  if (mm <= 10) return { label: "ฝนเล็กน้อย", key: "normal" };
  if (mm <= 35) return { label: "ฝนปานกลาง", key: "low" };
  if (mm <= 90) return { label: "ฝนหนัก", key: "high" };
  return { label: "ฝนหนักมาก", key: "over" };
}

function ago(ms) {
  if (!ms) return "–";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ชม.ที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}
const thTime = (ms) => new Date(ms).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const dayLabel = (iso) => new Date(iso + "T00:00:00+07:00").toLocaleDateString("th-TH", { weekday: "short", day: "numeric", timeZone: "Asia/Bangkok" });
const provName = (c) => (c ? S.provByCode.get(Number(c))?.name ?? "ไม่ระบุจังหวัด" : "ทั้งประเทศ");

// ---------------------------------------------------------------- โหลดข้อมูล
async function getJSON(url, opts = {}) {
  const r = await fetch(url, { cache: "no-cache", ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function loadWlHist(p) {
  if (!p) return null;
  if (!(p in S.wlHist)) {
    S.wlHist[p] = await getJSON(`data/wl/${p}.json`).catch(() => ({}));
  }
  return S.wlHist[p];
}
async function loadDamHist() {
  S.damHist ??= await getJSON("data/dams-history.json").catch(() => ({}));
  return S.damHist;
}
async function loadRainHist() {
  S.rainHist ??= await getJSON("data/rain-history.json").catch(() => ({}));
  return S.rainHist;
}

// ---------------------------------------------------------------- ตัวกรองตามจังหวัด
const inProv = (x) => !S.prov || x.p === S.prov;
const rivers = () => (S.data?.wl ?? []).filter(inProv);
const dams = () => (S.data?.dams?.dams ?? []).filter(inProv);

/** การเปลี่ยนแปลงระดับน้ำ (ม.) เทียบ n ชั่วโมงก่อน จากไฟล์ประวัติ */
function wlChange(hist, s, hours) {
  const arr = hist?.[s.id];
  if (!arr?.length) return null;
  const target = Math.floor(s.t / HOUR) - hours;
  let best = null;
  for (const row of arr) if (row[0] <= target && row[1] !== null) best = row; // จุดล่าสุดที่เก่ากว่าเป้าหมาย
  if (!best || target - best[0] > 3 || s.msl === null) return null;
  return s.msl - best[1];
}

// ---------------------------------------------------------------- กราฟ SVG
function lineChart({ series, labels = [], height = 150, unit = "", yMin, fillFirst = false }) {
  const W = 340, H = height, L = 34, R = 6, T = 18, B = 20;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (!all.length) return `<div class="empty small">ยังไม่มีข้อมูลพอสำหรับกราฟ</div>`;
  let lo = yMin ?? Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= yMin === undefined ? 1 : 0; }
  const pad = (hi - lo) * 0.08; hi += pad; if (yMin === undefined) lo -= pad;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmt(v, Math.abs(hi - lo) < 5 ? 1 : 0)}</text>`;
  }
  const step = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((lb, i) => { if (lb && i % step === 0) g += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${esc(lb)}</text>`; });
  series.forEach((s, si) => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    });
    if (fillFirst && si === 0 && d) {
      const first = s.values.findIndex((v) => v !== null), last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
      g += `<path d="${d}L${x(last)},${y(lo)}L${x(first)},${y(lo)}Z" fill="${s.color}" opacity=".12"/>`;
    }
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  if (unit) g += `<text x="${L - 4}" y="9" text-anchor="end">${esc(unit)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function groupedBars({ labels, series, height = 170, unit = "มม." }) {
  const W = 340, H = height, L = 30, R = 4, T = 18, B = 20;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (!all.length) return `<div class="empty small">ไม่มีข้อมูล</div>`;
  const hi = Math.max(10, ...all) * 1.1;
  const n = labels.length, gw = (W - L - R) / n, bw = Math.max(2, (gw - 4) / series.length);
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  let g = "";
  for (const v of [0, hi / 3, (2 * hi) / 3]) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
  // เส้นเกณฑ์ฝนหนัก 35 มม.
  if (hi > 35) g += `<line x1="${L}" x2="${W - R}" y1="${y(35)}" y2="${y(35)}" stroke="var(--over)" stroke-dasharray="3 3" opacity=".6"/><text x="${W - R}" y="${y(35) - 3}" text-anchor="end" style="fill:var(--over)">ฝนหนัก 35</text>`;
  labels.forEach((lb, i) => {
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      const h = Math.max(v > 0 ? 1.5 : 0, y(0) - y(v));
      g += `<rect x="${L + i * gw + 2 + si * bw}" y="${y(0) - h}" width="${bw - 1}" height="${h}" rx="1.5" fill="${s.color}"><title>${esc(s.name)} ${fmt(v, 1)} ${unit}</title></rect>`;
    });
    g += `<text x="${L + i * gw + gw / 2}" y="${H - 5}" text-anchor="middle">${esc(lb)}</text>`;
  });
  g += `<text x="${L - 4}" y="9" text-anchor="end">${unit}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}
const legend = (series) => `<div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;

function stackBar(counts, bands) {
  const total = sum(counts);
  if (!total) return "";
  return `<div class="stack">${counts.map((c, i) => (c ? `<span style="width:${(c / total) * 100}%;background:var(--${bands[i].key})" title="${bands[i].label} ${c}"></span>` : "")).join("")}</div>
  <div class="legend">${bands.map((b, i) => `<span><i style="background:var(--${b.key})"></i>${b.label} ${counts[i]}</span>`).join("")}</div>`;
}

// ---------------------------------------------------------------- แท็บ: สรุป
/** คำนวณตัวเลขหลักและบทวิเคราะห์ ใช้ร่วมกันระหว่างหน้าสรุปและรายงาน */
async function summaryData() {
  const rv = rivers(), dm = dams();
  const rain = S.data.rain;
  const counts = RIVER_BANDS.map(() => 0);
  for (const s of rv) { const b = band(RIVER_BANDS, s.pct); if (b) counts[RIVER_BANDS.indexOf(b)]++; }
  const over = rv.filter((s) => s.pct > 100).sort((a, b) => b.pct - a.pct);
  const high = rv.filter((s) => s.pct > 70 && s.pct <= 100);

  const damSt = sum(dm.map((d) => d.st)), damV = sum(dm.map((d) => d.v));
  const damPct = damSt ? (damV / damSt) * 100 : null;

  const rp = S.prov ? rain.byProv[S.prov] : null;
  const maxRain = S.prov ? rp?.max ?? null : Math.max(0, ...Object.values(rain.byProv).map((x) => x.max));
  const topRain = rain.top.filter(inProv)[0];

  const kpis = `<div class="kpis">
    <div class="kpi ${over.length ? "alert" : ""}"><div class="v">${fmt(over.length)}</div><div class="l">สถานีน้ำล้นตลิ่ง</div></div>
    <div class="kpi"><div class="v">${fmt(high.length)}</div><div class="l">สถานีน้ำมาก (70–100%)</div></div>
    <div class="kpi"><div class="v">${damPct === null ? "–" : fmt(damPct) + "%"}</div><div class="l">น้ำในเขื่อนใหญ่ ${dm.length ? `(${dm.length} แห่ง)` : ""}</div></div>
    <div class="kpi"><div class="v">${fmt(maxRain, 1)}</div><div class="l">ฝนสูงสุด 24 ชม. (มม.)</div></div>
  </div>`;

  // ---- บทวิเคราะห์อัตโนมัติ
  const notes = [];
  const push = (text, key) => notes.push(`<li style="--sev:var(--${key || "accent"})">${text}</li>`);
  if (!rv.length) push("ไม่มีสถานีวัดระดับน้ำที่รายงานข้อมูลในพื้นที่นี้ภายใน 24 ชม.", "low");
  else {
    const pctOver = (over.length / rv.length) * 100;
    if (over.length) push(`<b>${fmt(over.length)}</b> จาก ${fmt(rv.length)} สถานี (${fmt(pctOver)}%) ระดับน้ำสูงเกินตลิ่ง สูงสุดที่ <b>${esc(over[0].n)}</b> ${esc(over[0].a || provName(over[0].p))} (${fmt(over[0].pct)}%)`, "over");
    else if (high.length) push(`ยังไม่มีสถานีล้นตลิ่ง แต่ ${fmt(high.length)} สถานีอยู่ในเกณฑ์น้ำมาก (70–100% ของความจุลำน้ำ)`, "high");
    else push(`ระดับน้ำในแม่น้ำทุกสถานี (${fmt(rv.length)}) ต่ำกว่า 70% ของความจุลำน้ำ`, "normal");

    // แนวโน้ม: ถ้าเลือกจังหวัด ใช้ประวัติ 24 ชม. ไม่งั้นเทียบค่าก่อนหน้า
    const hist = S.prov ? await loadWlHist(S.prov) : null;
    const ch = rv.map((s) => ({ s, d: hist ? wlChange(hist, s, 24) : s.msl !== null && s.prev !== null ? s.msl - s.prev : null })).filter((x) => x.d !== null);
    if (ch.length) {
      const up = ch.filter((x) => x.d > 0.05), dn = ch.filter((x) => x.d < -0.05);
      const span = hist ? "ใน 24 ชม." : "เทียบค่าวัดครั้งก่อน";
      const lead = up.sort((a, b) => b.d - a.d)[0];
      push(`แนวโน้ม${span}: ระดับน้ำ<b class="up">เพิ่มขึ้น ${fmt(up.length)}</b> สถานี · <b class="down">ลดลง ${fmt(dn.length)}</b> สถานี${lead ? ` · เพิ่มมากสุดที่ ${esc(lead.s.n)} (+${fmt(lead.d, 2)} ม.)` : ""}`, up.length > dn.length ? "high" : "normal");
    }
  }
  if (dm.length) {
    const hi = dm.filter((d) => d.pct >= 80), lo = dm.filter((d) => d.pct <= 30);
    const dh = await loadDamHist();
    const wk = dm.map((d) => ({ d, ch: damChange(dh, d, 7) })).filter((x) => x.ch !== null);
    const wkTxt = wk.length ? ` · 7 วันที่ผ่านมาเปลี่ยนแปลง ${sign(sum(wk.map((x) => x.ch)), 0)} ล้าน ลบ.ม.` : "";
    push(`เขื่อนใหญ่${S.prov ? "ในจังหวัด" : "ทั้งประเทศ"} มีน้ำ ${fmt(damV)} ล้าน ลบ.ม. (${fmt(damPct)}% ของระดับเก็บกักปกติ)${wkTxt}${hi.length ? ` · <b>${hi.length}</b> แห่งเกิน 80%` : ""}${lo.length ? ` · ${lo.length} แห่งต่ำกว่า 30%` : ""}`, hi.length ? "high" : lo.length ? "low" : "normal");
  }
  if (S.prov && rp) {
    const rc = rainClass(rp.max);
    push(`ฝน 24 ชม.: ตก ${rp.wet} จาก ${rp.n} สถานี เฉลี่ย ${fmt(rp.avg, 1)} มม. สูงสุด ${fmt(rp.max, 1)} มม. (${rc?.label})${topRain ? ` ที่ ${esc(topRain.n)}` : ""}`, rc?.key);
  } else if (!S.prov) {
    const heavy = Object.entries(rain.byProv).filter(([p, x]) => x.max > 35 && +p);
    if (heavy.length) push(`มีฝนหนัก (>35 มม.) ใน <b>${heavy.length}</b> จังหวัด เช่น ${heavy.sort((a, b) => b[1].max - a[1].max).slice(0, 4).map(([p, x]) => `${provName(p)} ${fmt(x.max)} มม.`).join(", ")}`, "high");
    else push("ไม่มีจังหวัดที่ฝนหนักเกิน 35 มม. ใน 24 ชม. ที่ผ่านมา", "normal");
  }
  if (S.risk?.prov) {
    if (S.prov) {
      const r = S.risk.prov[S.prov];
      if (r) { const l = riskLevel(r.score); push(`ความเสี่ยงจากฝนสะสม: <b>${r.score}/100 (${l.label})</b> — ${riskReason(r)}`, l.color); }
    } else {
      const all = Object.entries(S.risk.prov).map(([p, r]) => ({ p, ...r }));
      const hi = all.filter((r) => r.score >= 40).sort((a, b) => b.score - a.score);
      const onset = all.filter((r) => r.onset);
      push(hi.length ? `ความเสี่ยงจากฝนสะสมสูง <b>${hi.length}</b> จังหวัด: ${hi.slice(0, 4).map((r) => `${provName(r.p)} (${r.score})`).join(", ")}${onset.length ? ` · ฝนหนักฉับพลันในพื้นที่ที่ปกติไม่หนัก: ${onset.slice(0, 3).map((r) => provName(r.p)).join(", ")}` : ""}` : `ไม่มีจังหวัดที่ความเสี่ยงจากฝนสะสมถึงระดับสูง${onset.length ? ` · แต่จับตาฝนหนักฉับพลัน: ${onset.slice(0, 3).map((r) => provName(r.p)).join(", ")}` : ""}`, hi.length ? "high" : onset.length ? "low" : "normal");
    }
  }
  return { rv, dm, counts, kpis, notes };
}

async function viewSummary() {
  const { rv, counts, kpis, notes } = await summaryData();
  let html = kpis;
  html += `<h2>บทวิเคราะห์</h2><div class="card"><ul class="insights">${notes.join("")}</ul></div>`;

  if (rv.length) html += `<h2>สถานะแม่น้ำ (% ความจุลำน้ำ)</h2><div class="card">${stackBar(counts, RIVER_BANDS)}</div>`;

  if (S.prov) {
    // พยากรณ์สั้นๆ ของจังหวัด
    html += `<h2>ฝนคาดการณ์ 3 วัน · ${esc(wxPoint().label)}</h2><div class="card" id="sum-wx"><div class="loading small">กำลังโหลดพยากรณ์…</div></div>`;
  } else {
    html += `<h2>จังหวัดที่ควรจับตา</h2><div class="card">${provinceRanking()}</div>`;
  }
  html += statusNote();
  $("#view").innerHTML = html;

  if (S.prov) {
    const pt = wxPoint();
    getForecast(pt.lat, pt.lon).then((wx) => {
      const el = $("#sum-wx"); if (!el) return;
      const a = analyzeForecast(wx);
      el.innerHTML = `<ul class="insights">${a.lines.slice(0, 3).map((l) => `<li style="--sev:var(--${l.key})">${l.text}</li>`).join("")}</ul>
        <button class="link-btn" data-go="wx">ดูพยากรณ์เต็ม</button>`;
    }).catch(() => { const el = $("#sum-wx"); if (el) el.innerHTML = `<div class="empty small">โหลดพยากรณ์ไม่สำเร็จ</div>`; });
  }
}

function provinceRanking(limit = 15, clickable = true) {
  const rows = new Map();
  const get = (p) => { if (!rows.has(p)) rows.set(p, { p, over: 0, high: 0, n: 0, rain: S.data.rain.byProv[p]?.max ?? 0, dam: null }); return rows.get(p); };
  for (const s of S.data.wl) { if (!s.p) continue; const r = get(s.p); r.n++; if (s.pct > 100) r.over++; else if (s.pct > 70) r.high++; }
  for (const d of S.data.dams.dams) if (d.p) { const r = get(d.p); r.dam = Math.max(r.dam ?? 0, d.pct); }
  for (const p of Object.keys(S.data.rain.byProv)) if (+p) get(+p);
  const score = (r) => r.over * 3 + r.high + (r.rain > 90 ? 4 : r.rain > 35 ? 2 : 0) + (r.dam > 100 ? 3 : r.dam > 80 ? 1 : 0);
  const list = [...rows.values()].map((r) => ({ ...r, sc: score(r) })).filter((r) => r.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, limit);
  if (!list.length) return `<div class="empty small">ไม่มีจังหวัดที่เข้าเกณฑ์เฝ้าระวัง</div>`;
  return `<table class="t"><thead><tr><th>จังหวัด</th><th>ล้นตลิ่ง</th><th>น้ำมาก</th><th>ฝนสูงสุด</th><th>เขื่อน</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="click" data-prov="${r.p}"><td>${esc(provName(r.p))}</td><td class="${r.over ? "up" : ""}">${r.over || "–"}</td><td>${r.high || "–"}</td><td>${r.rain ? fmt(r.rain) : "–"}</td><td>${r.dam === null ? "–" : fmt(r.dam) + "%"}</td></tr>`).join("")}
  </tbody></table><div class="note">${clickable ? "แตะชื่อจังหวัดเพื่อดูรายละเอียด · " : ""}เรียงตามคะแนนรวมจากระดับน้ำ ฝน และเขื่อน</div>`;
}

// ---------------------------------------------------------------- แท็บ: ความเสี่ยงจากฝนสะสม
const FACTORS = [
  { k: "event", w: 30, label: "ฝนสะสม 7 วัน (ผ่านมา 4 + ข้างหน้า 3) เทียบค่าปกติ" },
  { k: "future", w: 20, label: "ฝนคาดการณ์ 3 วันข้างหน้า เทียบค่าปกติ" },
  { k: "soil", w: 15, label: "ดินชุ่มน้ำจากฝนสะสมก่อนหน้า (API)" },
  { k: "intensity", w: 10, label: "ความแรงของฝนรายวัน (พยากรณ์/สถานีวัดจริง)" },
  { k: "persist", w: 10, label: "ฝนหนักต่อเนื่องหลายวัน" },
  { k: "river", w: 15, label: "ระดับน้ำในแม่น้ำของจังหวัด" },
];
const RISK_SORTS = [
  { k: "score", label: "ความเสี่ยงรวม" },
  { k: "anomaly", label: "ผิดปกติที่สุด" },
  { k: "ahead", label: "เตือนล่วงหน้า" },
  { k: "persist", label: "ฝนต่อเนื่อง" },
];
S.riskSort = "score";
S.clim = null;
S.distRisk = {};

const riskPill = (r) => { const l = riskLevel(r.score); return `<span class="pill" style="--c:var(--${l.color})">${l.label}</span>`; };
const anomPill = (p) => { const a = anomalyLevel(p); return a.key === "normal" ? "" : `<span class="pill" style="--c:var(--${a.key === "above" ? "low" : a.key === "very" ? "high" : "over"})">${a.label}</span>`; };
const inDaysText = (n) => (n === 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : `อีก ${n} วัน`);

function riskReason(r) {
  const parts = [];
  if (r.onset) parts.push("⚠ เปลี่ยนจากแห้งเป็นฝนหนักฉับพลัน");
  parts.push(`ฝน 7 วัน ${fmt(r.v.event7)} มม.`);
  if ((r.pct.event7 ?? 0) >= 90 || (r.pct.f3 ?? 0) >= 90) parts.push(anomalyText(r.anomaly));
  if (r.run?.len >= 2) parts.push(`ฝนหนักต่อเนื่อง ${r.run.len} วัน`);
  if (r.firstHeavy && r.firstHeavy.inDays > 0) parts.push(`ฝนหนัก${inDaysText(r.firstHeavy.inDays)}`);
  if (r.nModels) parts.push(`โมเดลตรงกัน ${r.agree}/${r.nModels}`);
  return parts.join(" · ");
}

function riskBanner() {
  const R = S.risk;
  if (!R) return `<div class="card empty">ยังไม่มีผลประเมินความเสี่ยง<br><span class="small">ระบบจะคำนวณในการอัปเดตรอบถัดไป (ทุก ~3 ชม.)</span></div>`;
  let h = `<div class="small muted" style="margin-bottom:8px">ประเมินเมื่อ ${thTime(R.updated)} น. (${ago(R.updated)})${R.stale ? " · ⚠ รอบล่าสุดคำนวณไม่สำเร็จ ใช้ผลเดิม" : ""}</div>`;
  if (R.climDone < R.climTotal) h += `<div class="banner">กำลังสร้างค่าปกติย้อนหลัง ${R.climDone}/${R.climTotal} จังหวัด (ทยอยดึงเพื่อไม่ให้เกินโควตาฟรี ครบใน 2–3 วัน) · จังหวัดที่ยังไม่มีค่าปกติใช้เกณฑ์ทั่วไปแทน การจัดอันดับ "ผิดปกติ" จะแม่นขึ้นเมื่อครบ</div>`;
  return h;
}

async function viewRisk() {
  if (!S.risk) { $("#view").innerHTML = riskBanner(); return; }
  if (S.prov) return viewRiskProvince();
  const all = Object.entries(S.risk.prov).map(([p, r]) => ({ p: +p, ...r }));
  const cnt = (k) => all.filter((r) => r.level === k).length;
  let list;
  if (S.riskSort === "anomaly") list = all.filter((r) => (r.anomaly ?? 0) >= 75).sort((a, b) => b.anomaly - a.anomaly);
  else if (S.riskSort === "ahead") list = all.filter((r) => r.onset || (r.firstHeavy && r.firstHeavy.inDays >= 1) || (r.pct.f3 ?? 0) >= 90).sort((a, b) => (b.onset - a.onset) || (b.pct.f3 ?? 0) - (a.pct.f3 ?? 0));
  else if (S.riskSort === "persist") list = all.filter((r) => r.run?.len >= 2).sort((a, b) => b.run.len - a.run.len || b.score - a.score);
  else list = all.filter((r) => r.score >= 10).sort((a, b) => b.score - a.score);

  const desc = {
    score: "รวมทุกปัจจัย: ฝนสะสม ฝนข้างหน้า ดินชุ่มน้ำ ความแรง ความต่อเนื่อง และระดับน้ำ",
    anomaly: "เรียงตาม \"ผิดจากปกติของพื้นที่นั้นในช่วงเดียวกันของปี\" — จังหวัดที่ปกติฝนน้อยแต่ตอนนี้ฝนมากจะขึ้นมาก่อน แม้ปริมาณไม่สูงที่สุดในประเทศ",
    ahead: "จังหวัดที่ยังไม่มีฝนหนักหรือเพิ่งเริ่ม แต่พยากรณ์ 1–7 วันข้างหน้าสูงผิดปกติ — ใช้เตรียมการล่วงหน้า",
    persist: "จังหวัดที่ฝนหนักเกินเกณฑ์ของพื้นที่ติดต่อกันตั้งแต่ 2 วันขึ้นไป (รวมที่ตกแล้วและคาดการณ์)",
  }[S.riskSort];

  let h = riskBanner() + `<div class="kpis">
    <div class="kpi ${cnt("vhigh") ? "alert" : ""}"><div class="v">${cnt("vhigh")}</div><div class="l">จังหวัดเสี่ยงสูงมาก</div></div>
    <div class="kpi"><div class="v">${cnt("high")}</div><div class="l">จังหวัดเสี่ยงสูง</div></div>
    <div class="kpi"><div class="v">${cnt("watch")}</div><div class="l">จังหวัดเฝ้าระวัง</div></div>
    <div class="kpi"><div class="v">${all.filter((r) => (r.anomaly ?? 0) >= 95).length}</div><div class="l">จังหวัดฝนผิดปกติ (สูงสุด 5%)</div></div>
  </div>
  <div class="chips" style="margin-top:12px">${RISK_SORTS.map((x) => `<button class="chip" data-rsort="${x.k}" aria-pressed="${S.riskSort === x.k}">${x.label}</button>`).join("")}</div>
  <div class="small muted" style="margin-bottom:8px">${desc}</div>
  <div class="card">`;
  if (!list.length) h += `<div class="empty">ไม่มีจังหวัดที่เข้าเกณฑ์</div>`;
  list.slice(0, 40).forEach((r, i) => {
    const l = riskLevel(r.score);
    const val = S.riskSort === "anomaly" ? `<b>${r.anomaly > 100 ? "เกินสถิติ" : `P${fmt(r.anomaly)}`}</b>` : S.riskSort === "persist" ? `<b>${r.run.len} วัน</b>` : S.riskSort === "ahead" ? `<b>${r.firstHeavy ? inDaysText(r.firstHeavy.inDays) : `P${fmt(r.pct.f3)}`}</b>` : `<b>${r.score}</b>`;
    h += `<div class="row" data-prov="${r.p}">
      <div class="rank">${i + 1}</div>
      <div class="main"><div class="name">${esc(provName(r.p))} ${riskPill(r)}</div>
        <div class="sub wrap">${riskReason(r)}</div>
        <div class="bar" style="--c:var(--${l.color})"><span style="width:${r.score}%"></span></div></div>
      <div class="val">${val}</div>
    </div>`;
  });
  h += `</div>` + riskMethod();
  $("#view").innerHTML = h;
}

function riskMethod() {
  const yrs = S.risk?.climYears ? `${S.risk.climYears[0]}–${S.risk.climYears[1]}` : "10 ปี";
  return `<details class="card method"><summary><b>วิธีคิดความเสี่ยงและความผิดปกติ</b></summary>
    <p><b>1. ค่าปกติของแต่ละพื้นที่</b> — ใช้ข้อมูลฝนรายวันย้อนหลัง (ERA5 ปี ${yrs}) ของจุดกลางแต่ละจังหวัด คำนวณว่า "ช่วงเดียวกันของปี" (±15 วัน) ฝน 1, 3, 7 วันมักอยู่ที่เท่าไร เก็บเป็นเปอร์เซ็นไทล์ P50/P75/P90/P95/P99/สูงสุด</p>
    <p><b>2. ความผิดปกติ</b> — เทียบฝนปัจจุบัน+คาดการณ์กับค่าปกตินั้น เช่น P97 = มากกว่า 97% ของช่วงเดียวกันในอดีต จึงจับได้ว่า "จังหวัดที่ปกติฝนไม่หนักในช่วงนี้ แต่กำลังมีฝนหนัก" แม้ปริมาณจะน้อยกว่าภาคใต้หรือภาคตะวันออก</p>
    <p><b>3. ดินชุ่มน้ำ (API)</b> — ดัชนีฝนสะสม = ฝนวันนี้ + 0.9 × ค่าของเมื่อวาน ฝนที่ตกต่อเนื่องหลายวันทำให้ดินอุ้มน้ำไม่ไหว ฝนก้อนถัดไปจะกลายเป็นน้ำท่า/น้ำป่าได้เร็ว</p>
    <p><b>4. ความต่อเนื่อง</b> — นับวันที่ฝนเกิน P90 รายวันของพื้นที่ (ไม่ต่ำกว่า 20 มม.) ติดต่อกัน ทั้งที่ตกแล้วและคาดการณ์</p>
    <p><b>5. เตือนล่วงหน้า</b> — ใช้พยากรณ์ 3 โมเดล (ECMWF, GFS, ICON) ถ้าหลายโมเดลให้ฝน 3 วันข้างหน้าเกิน P90 ของพื้นที่พร้อมกัน ความเชื่อมั่นสูงขึ้น และถ้า 7 วันที่ผ่านมาปกติแต่ข้างหน้าผิดปกติมาก จะติดธง "เปลี่ยนฉับพลัน"</p>
    <p><b>6. คะแนนรวม 0–100</b> — ${FACTORS.map((f) => `${f.label} ${f.w}%`).join(" · ")} · ความผิดปกติจะถูกลดน้ำหนักเมื่อปริมาณฝนจริงยังน้อย (กันหน้าแล้งที่ฝน 10 มม. ก็ผิดปกติแล้ว) · ระดับ: ≥60 เสี่ยงสูงมาก, ≥40 เสี่ยงสูง, ≥25 เฝ้าระวัง</p>
    <p class="muted"><b>ข้อจำกัด</b> — ใช้จุดกลางจังหวัดเป็นตัวแทน ฝนเฉพาะจุดบางอำเภออาจไม่สะท้อน (ดูรายอำเภอในหน้าจังหวัด) · ข้อมูลย้อนหลัง ERA5 มักต่ำกว่าฝนสุดขั้วจริง จึงดูเป็น "อันดับเทียบกัน" ได้ดีกว่าเป็นตัวเลขแน่นอน · คะแนนเป็นดัชนีช่วยจัดลำดับความสนใจ ไม่ใช่ประกาศเตือนภัยทางการ ควรดูประกาศกรมอุตุนิยมวิทยาและ ปภ. ประกอบ</p>
  </details>`;
}

function riskChart(r) {
  const se = r.series;
  if (!se) return "";
  const names = Object.keys(se.m);
  const n = se.m[names[0]].length;
  const med = Array.from({ length: n }, (_, i) => {
    const v = names.map((m) => se.m[m][i]).filter((x) => x !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  });
  const hi = Array.from({ length: n }, (_, i) => Math.max(0, ...names.map((m) => se.m[m][i] ?? 0)));
  const W = 340, H = 170, L = 30, R = 4, T = 18, B = 20;
  const top = Math.max(r.run?.th ?? 30, ...hi, 20) * 1.1;
  const gw = (W - L - R) / n, bw = Math.max(3, gw - 3);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  let g = "";
  for (const v of [0, top / 3, (2 * top) / 3]) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
  const x0 = L + se.today * gw;
  g += `<rect x="${x0}" y="${T - 12}" width="${W - R - x0}" height="${H - B - T + 12}" fill="var(--accent)" opacity=".06"/>`;
  g += `<text x="${x0 + 3}" y="${T - 3}" style="fill:var(--accent)">พยากรณ์ →</text>`;
  const start = Date.parse(se.start + "T00:00:00+07:00");
  med.forEach((v, i) => {
    const future = i >= se.today;
    if (future && hi[i] > (v ?? 0)) g += `<rect x="${L + i * gw + 1.5}" y="${y(hi[i])}" width="${bw}" height="${y(0) - y(hi[i])}" rx="1.5" fill="var(--accent)" opacity=".22"><title>สูงสุดของ 3 โมเดล ${fmt(hi[i], 1)} มม.</title></rect>`;
    if (v !== null) g += `<rect x="${L + i * gw + 1.5}" y="${y(v)}" width="${bw}" height="${Math.max(v > 0 ? 1.5 : 0, y(0) - y(v))}" rx="1.5" fill="${v >= (r.run?.th ?? r.norm.d1p90 ?? 30) ? "var(--over)" : future ? "var(--accent)" : "var(--muted)"}"><title>${fmt(v, 1)} มม.</title></rect>`;
    const d = new Date(start + i * 864e5 + 7 * HOUR);
    if (i % 3 === se.today % 3) g += `<text x="${L + i * gw + gw / 2}" y="${H - 5}" text-anchor="middle">${i === se.today ? "วันนี้" : d.getUTCDate()}</text>`;
  });
  const th = Math.max(20, r.norm.d1p90 ?? 30);
  g += `<line x1="${L}" x2="${W - R}" y1="${y(th)}" y2="${y(th)}" stroke="var(--over)" stroke-dasharray="3 3" opacity=".7"/><text x="${L + 2}" y="${y(th) - 3}" style="fill:var(--over)">เกณฑ์ฝนหนักของพื้นที่ ${fmt(th)} มม.</text>`;
  g += `<text x="${L - 4}" y="9" text-anchor="end">มม.</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>
    <div class="chart-legend"><span><i style="background:var(--muted)"></i>ที่ตกแล้ว (ค่ากลางโมเดล)</span><span><i style="background:var(--accent)"></i>คาดการณ์</span><span><i style="background:var(--accent);opacity:.3"></i>กรณีสูงสุดของ 3 โมเดล</span><span><i style="background:var(--over)"></i>เกินเกณฑ์ฝนหนัก</span></div>`;
}

function riskFindings(r) {
  const L = [];
  const add = (text, key) => L.push(`<li style="--sev:var(--${key})">${text}</li>`);
  if (r.onset) add(`<b>เปลี่ยนจากแห้งเป็นฝนหนักฉับพลัน</b> — 7 วันที่ผ่านมาฝน ${fmt(r.v.past7)} มม. (ปกติ) แต่ 3 วันข้างหน้าคาด ${fmt(r.v.f3)} มม. ซึ่ง${anomalyText(r.pct.f3)}`, "over");
  add(`ฝนสะสม 7 วัน (4 วันที่ผ่านมา + 3 วันข้างหน้า) <b>${fmt(r.v.event7)} มม.</b> — ${anomalyText(r.pct.event7)}`, (r.pct.event7 ?? 0) >= 95 ? "over" : (r.pct.event7 ?? 0) >= 90 ? "high" : "normal");
  if (r.firstHeavy) add(`ฝนหนักเกินเกณฑ์ของพื้นที่ครั้งถัดไป: <b>${inDaysText(r.firstHeavy.inDays)}</b> (${dayLabel(r.firstHeavy.date)} ~${fmt(r.firstHeavy.mm)} มม.)`, r.firstHeavy.inDays <= 1 ? "high" : "low");
  if (r.run?.len >= 2) add(`<b>ฝนหนักต่อเนื่อง ${r.run.len} วัน</b> (${dayLabel(r.run.start)}–${dayLabel(r.run.end)}) เกณฑ์ ≥ ${fmt(r.run.th)} มม./วัน`, r.run.len >= 3 ? "over" : "high");
  add(`ดินชุ่มน้ำ (ฝนสะสมถ่วงน้ำหนัก) ${fmt(r.v.api)} — ${(r.pct.api ?? 0) >= 90 ? "<b>ชุ่มกว่าปกติมาก</b> ฝนที่ตกเพิ่มจะไหลบ่าเร็ว" : (r.pct.api ?? 0) >= 75 ? "ชุ่มกว่าปกติ" : "ใกล้เคียงหรือต่ำกว่าปกติ"}`, (r.pct.api ?? 0) >= 90 ? "high" : "normal");
  add(`ความเชื่อมั่นของพยากรณ์: โมเดลที่ให้ฝน 3 วันเกินระดับ P90 ของพื้นที่ <b>${r.agree}/${r.nModels}</b>${r.agree >= 2 ? " — ค่อนข้างแน่นอน" : r.agree === 1 ? " — มีโมเดลเดียว ติดตามรอบถัดไป" : ""}`, r.agree >= 2 ? "high" : "accent");
  if (r.v.stationMax !== null && r.v.stationMax !== undefined) add(`สถานีวัดจริงในจังหวัด: ฝนสูงสุด 24 ชม. ${fmt(r.v.stationMax, 1)} มม.`, r.v.stationMax > 90 ? "over" : r.v.stationMax > 35 ? "high" : "normal");
  if (!r.fallback) add(`<span class="muted">บริบทของพื้นที่: ช่วงนี้ของปีฝน 3 วันเกิน ${fmt(r.norm.d3p90)} มม. มีเพียง 10% ของเวลา · ฝน 7 วันโดยทั่วไป ~${fmt(r.norm.d7p50)} มม.${r.norm.heavyDays !== null ? ` · วันที่ฝน ≥35 มม. ปกติมีเพียง ${fmt(r.norm.heavyDays, 1)} วันในช่วงนี้ของแต่ละปี` : ""}</span>`, "accent");
  else add(`<span class="muted">ยังไม่มีค่าปกติของจังหวัดนี้ ใช้เกณฑ์ทั่วไปของฤดูฝนแทน (ความผิดปกติจะแม่นขึ้นเมื่อสร้างค่าปกติเสร็จ)</span>`, "low");
  return `<ul class="insights">${L.join("")}</ul>`;
}

async function viewRiskProvince() {
  const r = S.risk.prov[S.prov];
  if (!r) { $("#view").innerHTML = riskBanner() + `<div class="card empty">ไม่มีผลประเมินของจังหวัดนี้</div>`; return; }
  const l = riskLevel(r.score);
  const all = Object.values(S.risk.prov).map((x) => x.score).sort((a, b) => b - a);
  const rank = all.indexOf(r.score) + 1;
  let h = riskBanner() + `<div class="card risk-hero" style="--c:var(--${l.color})">
      <div class="score"><b>${r.score}</b><span>/100</span></div>
      <div><div class="lvl">${l.label}</div>
        <div class="small muted">อันดับ ${rank} จาก ${all.length} จังหวัด · ${anomPill(r.anomaly) || "ฝนอยู่ในเกณฑ์ปกติของพื้นที่"}</div></div>
    </div>
    <h2>สิ่งที่พบ</h2><div class="card">${riskFindings(r)}</div>
    <h2>ฝนรายวัน 14 วันที่ผ่านมา + 7 วันข้างหน้า</h2><div class="card">${riskChart(r)}</div>
    <h2>ที่มาของคะแนน</h2><div class="card">${FACTORS.map((f) => `<div class="factor"><div class="fl"><span>${f.label}</span><b>${Math.round(r.s[f.k] * f.w)}/${f.w}</b></div><div class="bar" style="--c:var(--${r.s[f.k] >= 0.66 ? "over" : r.s[f.k] >= 0.33 ? "high" : "accent"})"><span style="width:${r.s[f.k] * 100}%"></span></div></div>`).join("")}</div>
    <h2>รายอำเภอ</h2><div class="card" id="dist-risk"><div class="loading small">กำลังประเมินรายอำเภอ…</div></div>
    ${riskMethod()}`;
  $("#view").innerHTML = h;
  districtRisk(S.prov).then((rows) => {
    const el = $("#dist-risk"); if (!el) return;
    el.innerHTML = rows.length ? `<table class="t nowrap"><thead><tr><th>${S.prov === 10 ? "เขต" : "อำเภอ"}</th><th>คะแนน</th><th>ฝน 3 วันข้างหน้า</th><th>ผิดปกติ</th><th>ฝนหนักครั้งถัดไป</th></tr></thead><tbody>
      ${rows.map((d) => `<tr class="click" data-dist="${esc(d.name)}"><td>${esc(d.name)}</td><td><span class="dotc" style="background:var(--${riskLevel(d.r.score).color})"></span>${d.r.score}</td><td>${fmt(d.r.v.f3)} มม.</td><td>${d.r.anomaly > 100 ? "เกินสถิติ" : `P${fmt(d.r.anomaly)}`}</td><td>${d.r.firstHeavy ? inDaysText(d.r.firstHeavy.inDays) : "–"}</td></tr>`).join("")}
      </tbody></table><div class="note">เทียบกับค่าปกติของจังหวัด · ไม่รวมปัจจัยแม่น้ำ · แตะชื่อเพื่อดูพยากรณ์รายชั่วโมงของอำเภอนั้น</div>` : `<div class="empty small">ไม่มีข้อมูลรายอำเภอ</div>`;
  }).catch(() => { const el = $("#dist-risk"); if (el) el.innerHTML = `<div class="empty small">ประเมินรายอำเภอไม่สำเร็จ</div>`; });
}

async function districtRisk(prov) {
  const c = S.distRisk[prov];
  if (c && Date.now() - c.at < 60 * 60e3) return c.rows;
  const list = S.districts[prov] || [];
  if (!list.length) return [];
  S.clim ??= await getJSON("data/climatology.json").catch(() => ({ prov: {} }));
  const clim = S.clim.prov?.[prov] ?? null;
  const ids = MODELS.map((m) => m.id);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${list.map((d) => d[1]).join(",")}&longitude=${list.map((d) => d[2]).join(",")}&daily=precipitation_sum&models=${ids.join(",")}&past_days=21&forecast_days=8&timezone=Asia%2FBangkok`;
  const res = await getJSON(url, { cache: "default" });
  const arr = Array.isArray(res) ? res : [res];
  const todayIso = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
  const rows = list.map((d, i) => {
    const dd = arr[i]?.daily;
    if (!dd) return null;
    const models = Object.fromEntries(ids.map((m) => [m, dd[`precipitation_sum_${m}`] ?? dd.time.map(() => null)]));
    let today = dd.time.indexOf(todayIso); if (today < 0) today = 21;
    return { name: d[0], r: assessRisk({ dates: dd.time, models, today, clim }) };
  }).filter(Boolean).sort((a, b) => b.r.score - a.r.score || b.r.anomaly - a.r.anomaly);
  S.distRisk[prov] = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------- แท็บ: แม่น้ำ
async function viewRiver() {
  const hist = S.prov ? await loadWlHist(S.prov) : null;
  let list = rivers().map((s) => ({ ...s, d24: hist ? wlChange(hist, s, 24) : null, dPrev: s.msl !== null && s.prev !== null ? s.msl - s.prev : null }));
  const q = S.q.trim();
  if (q) list = list.filter((s) => `${s.n} ${s.a} ${s.b} ${provName(s.p)}`.includes(q));
  const key = { pct: (s) => -(s.pct ?? -1e9), rise: (s) => -((s.d24 ?? s.dPrev) ?? -1e9), name: null }[S.sort];
  list.sort(key ? (a, b) => key(a) - key(b) : (a, b) => a.n.localeCompare(b.n, "th"));

  const shown = list.slice(0, 150);
  let html = `<div class="tools">
      <input id="q" type="search" placeholder="ค้นหาสถานี อำเภอ ลุ่มน้ำ" value="${esc(S.q)}" />
      <select id="sort"><option value="pct">ระดับน้ำสูงสุด</option><option value="rise">เพิ่มขึ้นเร็วสุด</option><option value="name">ชื่อสถานี</option></select>
    </div>
    <div class="small muted" style="margin-bottom:8px">${fmt(list.length)} สถานี${list.length > shown.length ? ` (แสดง ${shown.length} อันดับแรก)` : ""}${S.prov ? "" : " · เลือกจังหวัดเพื่อดูแนวโน้ม 24 ชม."}</div>
    <div class="card">`;
  if (!shown.length) html += `<div class="empty">ไม่พบสถานี</div>`;
  for (const s of shown) {
    const b = band(RIVER_BANDS, s.pct);
    const d = s.d24 ?? s.dPrev;
    const trend = d === null ? "" : `<span class="${d > 0.01 ? "up" : d < -0.01 ? "down" : "muted"}">${d > 0.01 ? "▲" : d < -0.01 ? "▼" : "•"} ${fmt(Math.abs(d), 2)} ม.${s.d24 !== null ? "/24ชม." : ""}</span>`;
    html += `<div class="row" data-open="wl-${esc(s.id)}">
      <div class="main"><div class="name">${esc(s.n)}</div>
        <div class="sub">${esc([s.a, S.prov ? null : provName(s.p), s.b].filter(Boolean).join(" · "))}</div>
        <div class="bar" style="--c:var(--${b?.key || "muted"})"><span style="width:${Math.min(100, s.pct ?? 0)}%"></span></div></div>
      <div class="val"><b>${s.pct === null ? "–" : fmt(s.pct) + "%"}</b><div class="small">${trend}</div></div>
    </div>`;
    if (S.open === `wl-${s.id}`) html += riverDetail(s, hist);
  }
  html += `</div><div class="note">% ความจุลำน้ำ = ระดับน้ำเทียบกับระดับตลิ่ง (เกณฑ์ ThaiWater: >100% ล้นตลิ่ง, 70–100% น้ำมาก, 30–70% ปกติ)</div>`;
  $("#view").innerHTML = html;
  $("#sort").value = S.sort;
  const qEl = $("#q");
  qEl.addEventListener("input", debounce(() => { S.q = qEl.value; viewRiver().then(() => { const e = $("#q"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); }); }, 250));
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; viewRiver(); });
}

function riverDetail(s, hist) {
  const arr = hist?.[s.id] ?? [];
  const labels = arr.map((r) => ((r[0] + 7) % 24 === 0 ? new Date(r[0] * HOUR).toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }) : ""));
  const chart = arr.length > 2
    ? lineChart({ series: [{ values: arr.map((r) => r[2]), color: "var(--accent)" }], labels, unit: "%", fillFirst: true })
      + `<div class="small muted">ระดับน้ำ (% ความจุลำน้ำ) ย้อนหลัง ${Math.round((arr.at(-1)[0] - arr[0][0]) / 24)} วัน</div>`
    : `<div class="small muted">${S.prov ? "ประวัติจะเริ่มสะสมหลังระบบทำงานไปสักระยะ" : "เลือกจังหวัดเพื่อดูกราฟย้อนหลัง"}</div>`;
  return `<div class="detail">
    <div class="grid">
      <div>ระดับน้ำ<b>${fmt(s.msl, 2)}</b>ม.รทก.</div>
      <div>${s.bank !== null && s.bank < 0 ? "ต่ำกว่าตลิ่ง" : "ห่างตลิ่ง"}<b>${fmt(s.bank === null ? null : Math.abs(s.bank), 2)}</b>ม.</div>
      <div>น้ำไหลผ่าน<b>${fmt(s.q, 1)}</b>ลบ.ม./วิ</div>
    </div>
    ${chart}
    <div class="small muted" style="margin:8px 0">อัปเดตจากสถานี ${thTime(s.t)} · ${esc(s.ag || "")}</div>
    <button class="link-btn" data-point="${s.lat},${s.lon}" data-label="${esc(s.n)}">พยากรณ์ฝน & น้ำท่า ณ จุดนี้</button>
  </div>`;
}

// ---------------------------------------------------------------- แท็บ: เขื่อน
function sign(v, d = 1) { return v === null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d); }
function damChange(hist, d, days) {
  const arr = hist?.[d.id];
  if (!arr?.length) return null;
  const last = arr.at(-1);
  const target = new Date(Date.parse(last[0]) - days * 864e5).toISOString().slice(0, 10);
  const old = [...arr].reverse().find((r) => r[0] <= target);
  return old && old[1] !== null && last[1] !== null ? last[1] - old[1] : null;
}

async function viewDam() {
  const hist = await loadDamHist();
  let list = dams();
  const regions = ["ทั้งหมด", ...new Set((S.data.dams.dams).map((d) => d.rg))];
  if (!S.prov && S.region !== "ทั้งหมด") list = list.filter((d) => d.rg === S.region);
  list.sort((a, b) => b.pct - a.pct);

  let html = "";
  if (!S.prov) html += `<div class="chips">${regions.map((r) => `<button class="chip" data-region="${esc(r)}" aria-pressed="${r === S.region}">${esc(r)}</button>`).join("")}</div>`;
  if (!list.length) {
    html += `<div class="card empty">ไม่มีเขื่อนขนาดใหญ่ของกรมชลประทานใน${esc(provName(S.prov))}<br><span class="small">(ข้อมูลครอบคลุมเขื่อนขนาดใหญ่ 35 แห่ง)</span></div>`;
  } else {
    const st = sum(list.map((d) => d.st)), v = sum(list.map((d) => d.v));
    const usable = sum(list.map((d) => Math.max(0, (d.v ?? 0) - (d.dead ?? 0)))), act = sum(list.map((d) => d.act));
    const ins = sum(list.map((d) => d.in)), outs = sum(list.map((d) => d.out));
    const counts = DAM_BANDS.map(() => 0);
    for (const d of list) { const b = band(DAM_BANDS, d.pct); if (b) counts[DAM_BANDS.indexOf(b)]++; }
    html += `<div class="kpis">
      <div class="kpi"><div class="v">${fmt((v / st) * 100)}%</div><div class="l">ปริมาตรน้ำรวม ${fmt(v)} / ${fmt(st)} ล้าน ลบ.ม.</div></div>
      <div class="kpi"><div class="v">${fmt(act ? (usable / act) * 100 : null)}%</div><div class="l">น้ำใช้การได้ ${fmt(usable)} ล้าน ลบ.ม.</div></div>
      <div class="kpi"><div class="v">${fmt(ins, 1)}</div><div class="l">น้ำไหลเข้า (ล้าน ลบ.ม./วัน)</div></div>
      <div class="kpi"><div class="v">${fmt(outs, 1)}</div><div class="l">น้ำระบาย (ล้าน ลบ.ม./วัน)</div></div>
    </div>
    <div class="card" style="margin-top:10px">${stackBar(counts, DAM_BANDS)}</div>
    <div class="small muted" style="margin:4px 0 8px">ข้อมูลกรมชลประทาน ณ วันที่ ${esc(S.data.dams.date || "–")}</div>
    <div class="card">`;
    for (const d of list) {
      const b = band(DAM_BANDS, d.pct);
      const c7 = damChange(hist, d, 7);
      html += `<div class="row" data-open="dam-${esc(d.id)}">
        <div class="main"><div class="name">${esc(d.n)}</div>
          <div class="sub">${esc(d.p ? provName(d.p) : d.rg)} · ${fmt(d.v)} / ${fmt(d.st)} ล้าน ลบ.ม.</div>
          <div class="bar" style="--c:var(--${b?.key})"><span style="width:${Math.min(100, d.pct)}%"></span></div></div>
        <div class="val"><b>${fmt(d.pct)}%</b><div class="small">${c7 === null ? pill(b) : `<span class="${c7 > 0 ? "up" : c7 < 0 ? "down" : "muted"}">${sign(c7)} /7วัน</span>`}</div></div>
      </div>`;
      if (S.open === `dam-${d.id}`) html += damDetail(d, hist);
    }
    html += `</div>`;
  }
  html += `<div class="note">% คิดจากปริมาตรน้ำเทียบความจุที่ระดับเก็บกักปกติ · น้ำใช้การได้ = ปริมาตรน้ำ − ปริมาตรน้ำใช้การไม่ได้ (dead storage)</div>`;
  $("#view").innerHTML = html;
}

function damDetail(d, hist) {
  const arr = (hist?.[d.id] ?? []).slice(-120);
  const net = d.in !== null && d.out !== null ? d.in - d.out : null;
  const room = d.st - d.v;
  const c30 = damChange(hist, d, 30);
  let proj = "";
  if (net !== null && net > 0.05 && room > 0) proj = `ถ้าน้ำไหลเข้าสุทธิคงที่ จะถึงระดับเก็บกักปกติในราว <b>${fmt(room / net)}</b> วัน`;
  else if (room <= 0) proj = `<b class="up">ปริมาตรน้ำเกินระดับเก็บกักปกติ ${fmt(-room, 1)} ล้าน ลบ.ม.</b>`;
  const labels = arr.map((r, i) => (i % Math.ceil(arr.length / 5) === 0 ? new Date(r[0]).toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : ""));
  return `<div class="detail">
    <div class="grid">
      <div>ไหลเข้า<b>${fmt(d.in, 2)}</b>ล้าน ลบ.ม./วัน</div>
      <div>ระบาย<b>${fmt(d.out, 2)}</b>ล้าน ลบ.ม./วัน</div>
      <div>สุทธิ<b class="${net > 0 ? "up" : net < 0 ? "down" : ""}">${sign(net, 2)}</b>ล้าน ลบ.ม./วัน</div>
      <div>รับน้ำได้อีก<b>${fmt(Math.max(0, room))}</b>ล้าน ลบ.ม.</div>
      <div>ความจุสูงสุด<b>${fmt(d.cap)}</b>ล้าน ลบ.ม.</div>
      <div>30 วัน<b>${sign(c30)}</b>ล้าน ลบ.ม.</div>
    </div>
    ${proj ? `<div class="small" style="margin-bottom:8px">${proj}</div>` : ""}
    ${arr.length > 2 ? lineChart({ series: [{ values: arr.map((r) => r[2]), color: "var(--accent)" }], labels, unit: "%", fillFirst: true }) + `<div class="small muted">% ความจุย้อนหลัง ${arr.length} วัน</div>` : `<div class="small muted">กราฟย้อนหลังจะแสดงเมื่อสะสมข้อมูลได้หลายวัน</div>`}
  </div>`;
}

// ---------------------------------------------------------------- แท็บ: ฝน
async function viewRain() {
  const rain = S.data.rain;
  const hist = await loadRainHist();
  let html = "";
  if (S.prov) {
    const rp = rain.byProv[S.prov];
    html += `<div class="kpis">
      <div class="kpi"><div class="v">${fmt(rp?.max, 1)}</div><div class="l">ฝนสูงสุด 24 ชม. (มม.)</div></div>
      <div class="kpi"><div class="v">${fmt(rp?.avg, 1)}</div><div class="l">เฉลี่ยทุกสถานี (มม.)</div></div>
      <div class="kpi"><div class="v">${rp ? `${rp.wet}/${rp.n}` : "–"}</div><div class="l">สถานีที่มีฝน</div></div>
      <div class="kpi"><div class="v">${esc(rainClass(rp?.max)?.label ?? "–")}</div><div class="l">ระดับฝน (เกณฑ์กรมอุตุฯ)</div></div>
    </div>`;
    const dates = Object.keys(hist).sort().slice(-30);
    const vals = dates.map((d) => hist[d][S.prov] ?? null);
    if (dates.length > 1) {
      const series = [
        { name: "สูงสุด", values: vals.map((v) => v?.[1] ?? null), color: "var(--m2)" },
        { name: "เฉลี่ย", values: vals.map((v) => v?.[0] ?? null), color: "var(--accent)" },
      ];
      html += `<h2>ฝนรายวันย้อนหลัง (07:00–07:00)</h2><div class="card">${groupedBars({ labels: dates.map((d) => (dates.length > 10 ? +d.slice(8) : dayLabel(d))), series })}${legend(series)}</div>`;
    }
    const top = rain.top.filter(inProv).slice(0, 30);
    html += `<h2>สถานีที่มีฝน</h2><div class="card">${top.length ? top.map((s) => { const c = rainClass(s.mm); return `<div class="row" style="cursor:default"><div class="main"><div class="name">${esc(s.n)}</div><div class="sub">${esc(s.a || "")} · ${thTime(s.t)}</div></div><div class="val"><b>${fmt(s.mm, 1)}</b> มม.<div class="small"><span class="pill" style="--c:var(--${c.key})">${c.label}</span></div></div></div>`; }).join("") : `<div class="empty small">ไม่มีฝนใน 24 ชม. ที่ผ่านมา</div>`}</div>`;
  } else {
    const list = Object.entries(rain.byProv).filter(([p]) => +p).map(([p, x]) => ({ p: +p, ...x })).sort((a, b) => b.max - a.max);
    const wetProv = list.filter((x) => x.max >= 0.1).length;
    html += `<div class="kpis">
      <div class="kpi"><div class="v">${wetProv}</div><div class="l">จังหวัดที่มีฝน</div></div>
      <div class="kpi"><div class="v">${list.filter((x) => x.max > 35).length}</div><div class="l">จังหวัดฝนหนัก (>35 มม.)</div></div>
      <div class="kpi"><div class="v">${fmt(list[0]?.max, 1)}</div><div class="l">สูงสุด (${esc(provName(list[0]?.p))})</div></div>
      <div class="kpi"><div class="v">${fmt(sum(list.map((x) => x.n)))}</div><div class="l">สถานีที่รายงาน</div></div>
    </div>
    <h2>อันดับจังหวัดตามฝนสูงสุด 24 ชม.</h2><div class="card"><table class="t"><thead><tr><th>จังหวัด</th><th>สูงสุด</th><th>เฉลี่ย</th><th>สถานีมีฝน</th></tr></thead><tbody>
    ${list.slice(0, 30).map((x) => `<tr class="click" data-prov="${x.p}"><td>${esc(provName(x.p))}</td><td>${fmt(x.max, 1)}</td><td>${fmt(x.avg, 1)}</td><td>${x.wet}/${x.n}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  html += `<div class="note">ฝนสะสม 24 ชม. จากสถานีโทรมาตรในคลังข้อมูลน้ำแห่งชาติ · เกณฑ์: 0.1–10 เล็กน้อย, 10.1–35 ปานกลาง, 35.1–90 หนัก, >90 มม. หนักมาก</div>`;
  $("#view").innerHTML = html;
}

// ---------------------------------------------------------------- แท็บ: พยากรณ์อากาศ (Open-Meteo)
const MODELS = [
  { id: "ecmwf_ifs025", name: "ECMWF (ยุโรป)", color: "var(--m1)" },
  { id: "gfs_seamless", name: "GFS (สหรัฐฯ)", color: "var(--m2)" },
  { id: "icon_seamless", name: "ICON (เยอรมนี)", color: "var(--m3)" },
];

async function getForecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const c = S.wxCache[key];
  if (c && Date.now() - c.at < 30 * 60e3) return c.data;
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=Asia%2FBangkok`;
  const [multi, best] = await Promise.all([
    getJSON(`${base}&daily=precipitation_sum&hourly=precipitation&models=${MODELS.map((m) => m.id).join(",")}&forecast_days=10`, { cache: "default" }),
    getJSON(`${base}&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max&hourly=precipitation,precipitation_probability&forecast_days=10`, { cache: "default" }),
  ]);
  const data = { multi, best };
  S.wxCache[key] = { at: Date.now(), data };
  return data;
}

async function getFlood(lat, lon) {
  return getJSON(`https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lon}&daily=river_discharge,river_discharge_max,river_discharge_min&past_days=30&forecast_days=30`, { cache: "default" });
}

function analyzeForecast({ multi, best }) {
  const days = multi.daily.time;
  const per = MODELS.map((m) => multi.daily[`precipitation_sum_${m.id}`] ?? days.map(() => null));
  const median = days.map((_, i) => {
    const v = per.map((a) => a[i]).filter((x) => x !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] + (v.length % 2 ? 0 : (v[v.length / 2] - v[v.length / 2 - 1]) / 2) : null;
  });
  const tot = (a, n) => { const s = a.slice(0, n); return s.some((x) => x === null) ? null : sum(s); };
  const t3 = per.map((a) => tot(a, 3)).filter((x) => x !== null);
  const t7 = per.map((a) => tot(a, 7)).filter((x) => x !== null);
  const lines = [];
  const L = (text, key = "accent") => lines.push({ text, key });

  const med3 = tot(median, 3), med7 = tot(median, 7);
  if (t3.length) {
    const lo = Math.min(...t3), hi = Math.max(...t3), spread = hi - lo;
    const rel = spread / Math.max(10, (lo + hi) / 2);
    const conf = hi < 10 ? "สูง" : rel < 0.5 ? "สูง" : rel < 1 ? "ปานกลาง" : "ต่ำ";
    L(`ฝนรวม 3 วันข้างหน้า ประมาณ <b>${fmt(med3)} มม.</b> (โมเดลให้ช่วง ${fmt(lo)}–${fmt(hi)} มม.) · ความสอดคล้องของโมเดล: <b>${conf}</b>`, med3 > 90 ? "over" : med3 > 35 ? "high" : "normal");
  }
  const heavy = days.map((d, i) => ({ d, v: median[i] })).filter((x) => x.v !== null && x.v > 35);
  if (heavy.length) {
    const vh = heavy.filter((x) => x.v > 90);
    L(`วันที่คาดว่าฝนหนัก (ค่ากลางของโมเดล >35 มม.): ${heavy.map((x) => `${dayLabel(x.d)} (${fmt(x.v)})`).join(", ")}${vh.length ? " · มีวันที่อาจถึงฝนหนักมาก" : ""}`, vh.length ? "over" : "high");
  } else if (med7 !== null) {
    L(`7 วันข้างหน้าไม่มีวันที่ค่ากลางของโมเดลเกินเกณฑ์ฝนหนัก · ฝนรวม 7 วันราว ${fmt(med7)} มม.`, "normal");
  }
  const agreeDays = days.slice(0, 7).filter((_, i) => per.every((a) => a[i] !== null && a[i] > 10)).length;
  if (agreeDays) L(`ทั้ง 3 โมเดลตรงกันว่าจะมีฝนเกิน 10 มม. จำนวน ${agreeDays} วันในสัปดาห์นี้`, agreeDays >= 3 ? "high" : "accent");
  if (t7.length) {
    const hi7 = Math.max(...t7), who = MODELS[per.findIndex((a) => tot(a, 7) === hi7)];
    if (hi7 > 1.8 * Math.max(med7 ?? 0, 5)) L(`${who?.name} ให้ฝนสูงกว่าโมเดลอื่นชัดเจน (${fmt(hi7)} มม./7 วัน) ควรติดตามการอัปเดตรอบถัดไป`, "low");
  }
  const pmax = best.daily.precipitation_probability_max?.slice(0, 3);
  if (pmax?.every((x) => x !== null)) L(`โอกาสเกิดฝน 3 วันแรก: ${pmax.map((p, i) => `${dayLabel(days[i])} ${p}%`).join(" · ")}`, "accent");
  return { days, per, median, lines };
}

function analyzeFlood(fl) {
  const t = fl.daily.time, q = fl.daily.river_discharge;
  const today = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
  const idx = t.indexOf(today);
  if (idx < 0) return null;
  const past = q.slice(0, idx).filter((x) => x !== null);
  const fut = q.slice(idx, idx + 14).filter((x) => x !== null);
  if (!past.length || !fut.length) return null;
  const pastAvg = sum(past) / past.length, peak = Math.max(...fut);
  const peakDay = t[idx + q.slice(idx, idx + 14).indexOf(peak)];
  const ratio = pastAvg ? peak / pastAvg : null;
  return { idx, pastAvg, now: q[idx], peak, peakDay, ratio };
}

// ---------------------------------------------------------------- ฝนรายชั่วโมง
// เกณฑ์ความแรงของฝนรายชั่วโมง (มม./ชม.) อิงเกณฑ์สากล (WMO/AMS)
const HOUR_CLASSES = [
  { max: 0.1, label: "ไม่มีฝน", key: "r0" },
  { max: 2.5, label: "ฝนเล็กน้อย", key: "r1" },
  { max: 7.5, label: "ฝนปานกลาง", key: "r2" },
  { max: 20, label: "ฝนหนัก", key: "r3" },
  { max: Infinity, label: "ฝนหนักมาก", key: "r4" },
];
const hourClass = (mm) => HOUR_CLASSES.findIndex((c) => (mm ?? 0) < c.max || c.max === Infinity);
const hh = (t) => t.slice(11, 16);

/** รวมข้อมูลรายชั่วโมง: ปริมาณฝน (best match), โอกาส, และจำนวนโมเดลที่เห็นว่าฝนตก */
function hourlyRows({ multi, best }) {
  const t = best.hourly.time;
  const mh = multi.hourly || {};
  return t.map((time, i) => {
    let agree = 0, n = 0;
    for (const m of MODELS) {
      const arr = mh[`precipitation_${m.id}`];
      if (!arr) continue;
      // ดูช่วง ±1 ชม. เพราะบางโมเดลให้ข้อมูลทุก 3 ชม. และเวลาฝนเคลื่อนได้
      const win = [arr[i - 1], arr[i], arr[i + 1]].filter((v) => v !== null && v !== undefined);
      if (!win.length) continue;
      n++;
      if (Math.max(...win) >= 0.5) agree++;
    }
    const mm = best.hourly.precipitation[i];
    return { t: time, ms: Date.parse(time + ":00+07:00"), mm, prob: best.hourly.precipitation_probability?.[i] ?? null, agree, n, cls: hourClass(mm) };
  });
}

/** หาช่วงเวลาที่คาดว่าฝนตก (รวมชั่วโมงติดกัน เว้นได้ 1 ชม.) */
function rainPeriods(rows) {
  const wet = (r) => r.mm >= 0.5 || (r.agree >= 2 && (r.prob ?? 0) >= 50);
  const periods = [];
  let cur = null, gap = 0;
  for (const r of rows) {
    if (wet(r)) {
      if (!cur) cur = { rows: [] };
      cur.rows.push(r); gap = 0;
    } else if (cur) {
      gap++;
      if (gap > 1) { periods.push(cur); cur = null; gap = 0; }
    }
  }
  if (cur) periods.push(cur);
  return periods.map((p) => {
    const rs = p.rows;
    const peak = rs.reduce((a, b) => ((b.mm ?? 0) > (a.mm ?? 0) ? b : a));
    return {
      start: rs[0], end: rs.at(-1), peak,
      total: sum(rs.map((r) => r.mm)),
      prob: Math.max(...rs.map((r) => r.prob ?? 0)),
      agree: Math.max(...rs.map((r) => r.agree)), n: Math.max(...rs.map((r) => r.n)),
    };
  }).filter((p) => p.total >= 1 || p.prob >= 50);
}

function periodText(p) {
  const endH = String((+p.end.t.slice(11, 13) + 1) % 24).padStart(2, "0") + ":00";
  const c = HOUR_CLASSES[p.peak.cls];
  const sure = p.agree >= 2 && p.prob >= 60 ? "ค่อนข้างแน่นอน" : p.agree >= 2 || p.prob >= 50 ? "มีโอกาส" : "ไม่แน่นอน";
  return {
    key: ["normal", "accent", "high", "over", "over"][p.peak.cls],
    html: `<b>${dayLabel(p.start.t.slice(0, 10))} ${hh(p.start.t)}–${endH}</b> · ${c.label}
      <div class="small muted">หนักสุดราว ${hh(p.peak.t)} น. (~${fmt(p.peak.mm, 1)} มม./ชม.) · รวม ~${fmt(p.total, 1)} มม. · โอกาส ${fmt(p.prob)}% · โมเดลเห็นตรงกัน ${p.agree}/${p.n} → <b>${sure}</b></div>`,
  };
}

function hourGrid(rows, days) {
  const now = Date.now();
  let html = `<div class="hgrid"><span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hh">${h % 6 === 0 ? h : ""}</span>`).join("")}`;
  for (const d of days) {
    html += `<span class="hd">${dayLabel(d)}</span>`;
    for (let h = 0; h < 24; h++) {
      const r = rows.find((x) => x.t === `${d}T${String(h).padStart(2, "0")}:00`);
      if (!r) { html += `<span class="hc"></span>`; continue; }
      const past = r.ms + HOUR <= now, curr = r.ms <= now && now < r.ms + HOUR;
      const unsure = r.cls > 0 && r.agree < 2 && (r.prob ?? 0) < 50;
      html += `<button class="hc ${past ? "past" : ""} ${curr ? "now" : ""} ${unsure ? "unsure" : ""} ${S.hsel === r.t ? "sel" : ""}" style="--c:var(--${HOUR_CLASSES[r.cls].key})" data-hour="${r.t}" aria-label="${r.t}"></button>`;
    }
  }
  html += `</div><div class="legend">${HOUR_CLASSES.map((c) => `<span><i style="background:var(--${c.key})"></i>${c.label}</span>`).join("")}<span><i class="unsure-sw"></i>โมเดลไม่ตรงกัน</span></div>`;
  return html;
}

function hourInfo(rows) {
  const r = rows.find((x) => x.t === S.hsel);
  if (!r) return `<span class="muted">แตะช่องในตารางเพื่อดูรายละเอียดแต่ละชั่วโมง</span>`;
  return `<b>${dayLabel(r.t.slice(0, 10))} ${hh(r.t)} น.</b> · ${HOUR_CLASSES[r.cls].label} ~${fmt(r.mm, 1)} มม. · โอกาส ${r.prob ?? "–"}% · โมเดลเห็นว่าฝนตก ${r.agree}/${r.n}`;
}

// ---------------------------------------------------------------- เทียบทุกอำเภอ
async function getDistrictForecast(prov) {
  const c = S.distWx[prov];
  if (c && Date.now() - c.at < 30 * 60e3) return c.data;
  const list = S.districts[prov] || [];
  if (!list.length) return [];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${list.map((d) => d[1]).join(",")}&longitude=${list.map((d) => d[2]).join(",")}&hourly=precipitation,precipitation_probability&forecast_days=2&timezone=Asia%2FBangkok`;
  const res = await getJSON(url, { cache: "default" });
  const arr = Array.isArray(res) ? res : [res];
  const data = list.map((d, i) => {
    const h = arr[i]?.hourly;
    if (!h) return { name: d[0], total: null };
    const start = h.time.findIndex((t) => Date.parse(t + ":00+07:00") + HOUR > Date.now());
    const idx = Array.from({ length: 24 }, (_, k) => start + k).filter((k) => k < h.time.length);
    const mm = idx.map((k) => h.precipitation[k] ?? 0);
    const peakK = idx[mm.indexOf(Math.max(...mm))];
    const firstK = idx.find((k) => (h.precipitation[k] ?? 0) >= 0.5);
    return {
      name: d[0], total: sum(mm), peak: Math.max(...mm), peakT: h.time[peakK],
      first: firstK !== undefined ? h.time[firstK] : null,
      prob: Math.max(...idx.map((k) => h.precipitation_probability?.[k] ?? 0)),
    };
  });
  S.distWx[prov] = { at: Date.now(), data };
  return data;
}

function districtTable(data, clickable = true) {
  const rows = [...data].filter((d) => d.total !== null).sort((a, b) => b.total - a.total);
  if (!rows.length) return `<div class="empty small">ไม่มีข้อมูล</div>`;
  return `<table class="t"><thead><tr><th>${S.prov === 10 ? "เขต" : "อำเภอ"}</th><th>ฝนรวม</th><th>เริ่มตก</th><th>หนักสุด</th><th>โอกาส</th></tr></thead><tbody>
    ${rows.map((d) => {
      const c = HOUR_CLASSES[hourClass(d.peak)];
      return `<tr class="click ${d.name === S.dist[S.prov] ? "cur" : ""}" data-dist="${esc(d.name)}"><td>${esc(d.name)}</td><td>${fmt(d.total, 1)}</td><td>${d.first ? `${d.first.slice(0, 10) !== new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10) ? "พรุ่งนี้ " : ""}${hh(d.first)}` : "–"}</td><td><span class="dotc" style="background:var(--${c.key})"></span>${d.peak >= 0.1 ? hh(d.peakT) : "–"}</td><td>${fmt(d.prob)}%</td></tr>`;
    }).join("")}
  </tbody></table><div class="note">24 ชม. ข้างหน้า (มม.) จากโมเดลที่ดีที่สุดของแต่ละพื้นที่${clickable ? " · แตะชื่อเพื่อดูรายชั่วโมง" : ""}</div>`;
}

function bindDist() {
  const el = $("#dist");
  if (el) el.addEventListener("change", () => selectDist(el.value));
}
function selectDist(name) {
  if (name) S.dist[S.prov] = name; else delete S.dist[S.prov];
  store.set("dist", S.dist);
  S.point = null; S.hsel = null;
  window.scrollTo(0, 0);
  render();
}
function useMyLocation() {
  if (!navigator.geolocation) return alert("อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      // หาอำเภอที่ใกล้ที่สุด เพื่อตั้งจังหวัดให้ตรงด้วย
      let best = null;
      for (const [pc, list] of Object.entries(S.districts)) for (const d of list) {
        const dd = (d[1] - lat) ** 2 + ((d[2] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
        if (!best || dd < best.dd) best = { pc: +pc, d, dd };
      }
      if (best && best.dd < 0.5) {
        S.prov = best.pc; store.set("prov", S.prov); $("#province").value = S.prov;
        const pre = best.pc === 10 ? "เขต" : "อ.";
        S.point = { lat, lon, label: `ตำแหน่งของฉัน (ใกล้${pre}${best.d[0]} ${provName(best.pc)})` };
      } else S.point = { lat, lon, label: "ตำแหน่งของฉัน" };
      S.hsel = null; setTab("wx");
    },
    () => alert("ไม่สามารถระบุตำแหน่งได้ กรุณาอนุญาตการเข้าถึงตำแหน่งในเบราว์เซอร์"),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
}

function wxPoint() {
  if (S.point) return S.point;
  const p = S.prov ? S.provByCode.get(S.prov) : null;
  if (!p) return null;
  const dn = S.dist[S.prov];
  const d = dn && (S.districts[S.prov] || []).find((x) => x[0] === dn);
  const pre = S.prov === 10 ? "เขต" : "อ.";
  return d ? { lat: d[1], lon: d[2], label: `${pre}${d[0]} ${p.name}` } : { lat: p.lat, lon: p.lon, label: `กลางจังหวัด${p.name}` };
}

async function viewWx() {
  const p = S.prov ? S.provByCode.get(S.prov) : null;
  const pt = wxPoint();
  if (!pt) {
    $("#view").innerHTML = `<div class="card empty">เลือกจังหวัดด้านบน เพื่อดูพยากรณ์ฝนรายชั่วโมง รายอำเภอ<br>จาก 3 โมเดล และคาดการณ์ปริมาณน้ำท่า</div>
      <div style="text-align:center"><button class="link-btn" data-geo="1">ใช้ตำแหน่งปัจจุบันของฉัน</button></div>`;
    return;
  }
  const dists = S.districts[S.prov] || [];
  const controls = `<div class="tools">
      <select id="dist" ${S.point ? "disabled" : ""}>
        <option value="">${p ? `กลางจังหวัด${esc(p.name)}` : "—"}</option>
        ${dists.map((d) => `<option value="${esc(d[0])}" ${d[0] === S.dist[S.prov] ? "selected" : ""}>${S.prov === 10 ? "เขต" : "อ."}${esc(d[0])}</option>`).join("")}
      </select>
      <button class="link-btn" data-geo="1" title="ใช้ตำแหน่งปัจจุบัน">📍 ตำแหน่งฉัน</button>
    </div>
    ${S.point ? `<div class="small muted" style="margin-bottom:8px">จุดพยากรณ์: <b>${esc(pt.label)}</b> (${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)}) · <button class="link-btn" data-point="reset">กลับไปเลือกอำเภอ</button></div>` : ""}`;
  $("#view").innerHTML = controls + `<div class="loading">กำลังโหลดพยากรณ์…</div>`;
  bindDist();
  let wx;
  try { wx = await getForecast(pt.lat, pt.lon); } catch {
    $("#view").innerHTML = controls + `<div class="card empty">โหลดพยากรณ์ไม่สำเร็จ ลองใหม่อีกครั้ง</div>`; bindDist(); return;
  }
  const a = analyzeForecast(wx);
  const series = MODELS.map((m, i) => ({ name: m.name, values: a.per[i].slice(0, 10), color: m.color }));
  const b = wx.best;
  const rows = hourlyRows(wx);
  const nowMs = Date.now();
  const upcoming = rows.filter((r) => r.ms + HOUR > nowMs).slice(0, 72);
  const periods = rainPeriods(upcoming);
  const days = [...new Set(upcoming.map((r) => r.t.slice(0, 10)))].slice(0, 3);
  const next6 = upcoming.slice(0, 6);
  const n6 = sum(next6.map((r) => r.mm));
  const nowLine = n6 >= 0.5
    ? `6 ชม. ข้างหน้า: คาดว่ามีฝน ~${fmt(n6, 1)} มม. หนักสุด${HOUR_CLASSES[Math.max(...next6.map((r) => r.cls))].label.replace("ฝน", "")}`
    : `6 ชม. ข้างหน้า: ไม่คาดว่าจะมีฝนนัยสำคัญ (โอกาสสูงสุด ${fmt(Math.max(...next6.map((r) => r.prob ?? 0)))}%)`;

  let html = controls + `
    <h2>ช่วงเวลาที่คาดว่าฝนตก (3 วัน)</h2>
    <div class="card"><ul class="insights">
      <li style="--sev:var(--${n6 >= 0.5 ? "high" : "normal"})"><b>${nowLine}</b></li>
      ${periods.length ? periods.slice(0, 8).map((p) => { const t = periodText(p); return `<li style="--sev:var(--${t.key})">${t.html}</li>`; }).join("") : `<li style="--sev:var(--normal)">ไม่คาดว่าจะมีฝนนัยสำคัญใน 3 วันข้างหน้า</li>`}
    </ul></div>
    <h2>ฝนรายชั่วโมง</h2>
    <div class="card">${hourGrid(rows, days)}<div id="hinfo" class="small" style="margin-top:8px">${hourInfo(rows)}</div></div>
    <h2>ภาพรวม 10 วัน</h2>
    <div class="card"><ul class="insights">${a.lines.map((l) => `<li style="--sev:var(--${l.key})">${l.text}</li>`).join("")}</ul></div>
    <div class="card">${groupedBars({ labels: a.days.slice(0, 10).map((d) => String(+d.slice(8))), series })}${legend(series)}</div>
    ${p ? `<h2>เทียบทุก${S.prov === 10 ? "เขต" : "อำเภอ"}ใน${esc(p.name)}</h2><div class="card" id="dist-table"><div class="loading small">กำลังโหลด…</div></div>` : ""}
    <h2>อุณหภูมิและลม</h2>
    <div class="card"><table class="t"><thead><tr><th>วัน</th><th>ต่ำ–สูง °C</th><th>ลมสูงสุด กม./ชม.</th><th>โอกาสฝน</th></tr></thead><tbody>
      ${b.daily.time.slice(0, 7).map((d, i) => `<tr><td>${dayLabel(d)}</td><td>${fmt(b.daily.temperature_2m_min[i])}–${fmt(b.daily.temperature_2m_max[i])}</td><td>${fmt(b.daily.wind_speed_10m_max[i])}</td><td>${b.daily.precipitation_probability_max[i] ?? "–"}%</td></tr>`).join("")}
    </tbody></table></div>
    <h2>คาดการณ์ปริมาณน้ำท่า (GloFAS)</h2>
    <div class="card" id="flood"><div class="loading small">กำลังโหลด…</div></div>
    <div class="note">พยากรณ์จาก Open-Meteo (ECMWF IFS, NOAA GFS, DWD ICON) · ฝนรายชั่วโมงในเขตร้อนเกิดจากพายุฝนฟ้าคะนองเฉพาะที่ เวลาอาจคลาดได้ 2–3 ชม. และตกไม่ทั่วทั้งอำเภอ ใช้ดูแนวโน้มว่า "ช่วงไหนเสี่ยง" มากกว่าเวลาที่แน่นอน · เกณฑ์ความแรง (มม./ชม.): เล็กน้อย ≤2.5, ปานกลาง ≤7.5, หนัก ≤20, หนักมาก >20 · ควรติดตามประกาศกรมอุตุนิยมวิทยาประกอบ</div>`;
  $("#view").innerHTML = html;
  bindDist();
  S._rows = rows;

  if (p) getDistrictForecast(S.prov).then((data) => { const el = $("#dist-table"); if (el) el.innerHTML = districtTable(data); })
    .catch(() => { const el = $("#dist-table"); if (el) el.innerHTML = `<div class="empty small">โหลดข้อมูลรายอำเภอไม่สำเร็จ</div>`; });
  getFlood(pt.lat, pt.lon).then((fl) => {
    const el = $("#flood"); if (!el) return;
    const f = analyzeFlood(fl);
    if (!f) { el.innerHTML = `<div class="empty small">ไม่มีข้อมูลน้ำท่าสำหรับจุดนี้</div>`; return; }
    const t = fl.daily.time;
    const labels = t.map((d, i) => (i === f.idx ? "วันนี้" : i % 10 === 0 ? new Date(d).toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : ""));
    const past = fl.daily.river_discharge.map((v, i) => (i <= f.idx ? v : null));
    const fut = fl.daily.river_discharge.map((v, i) => (i >= f.idx ? v : null));
    const mx = fl.daily.river_discharge_max.map((v, i) => (i >= f.idx ? v : null));
    const trend = f.ratio > 1.5 ? ["over", "สูงกว่าค่าเฉลี่ย 30 วันที่ผ่านมาอย่างชัดเจน"] : f.ratio > 1.15 ? ["high", "มีแนวโน้มเพิ่มขึ้น"] : f.ratio < 0.85 ? ["normal", "มีแนวโน้มลดลง"] : ["normal", "ใกล้เคียงช่วงที่ผ่านมา"];
    el.innerHTML = `<ul class="insights"><li style="--sev:var(--${trend[0]})">น้ำท่าสูงสุดใน 14 วันข้างหน้า ≈ <b>${fmt(f.peak)}</b> ลบ.ม./วิ ราววัน${dayLabel(f.peakDay)} (${fmt(f.ratio * 100)}% ของค่าเฉลี่ย 30 วัน) — ${trend[1]}</li></ul>
      ${lineChart({ series: [{ values: mx, color: "var(--m2)", dash: "3 3", width: 1.5 }, { values: past, color: "var(--muted)" }, { values: fut, color: "var(--accent)" }], labels, unit: "ลบ.ม./วิ", yMin: 0 })}
      ${legend([{ name: "ย้อนหลัง", color: "var(--muted)" }, { name: "คาดการณ์", color: "var(--accent)" }, { name: "กรณีสูงสุดของ ensemble", color: "var(--m2)" }])}
      <div class="small muted" style="margin-top:6px">แบบจำลองความละเอียด ~5 กม. แสดงแม่น้ำสายหลักที่ใกล้จุดนี้ ใช้ดูแนวโน้ม ไม่ใช่ค่าวัดจริง</div>`;
  }).catch(() => { const el = $("#flood"); if (el) el.innerHTML = `<div class="empty small">โหลดข้อมูลน้ำท่าไม่สำเร็จ</div>`; });
}

// ---------------------------------------------------------------- รายงานสรุป (PDF / รูปภาพ / พิมพ์)
const RSECS = [
  { id: "kpi", label: "ตัวเลขสำคัญ" },
  { id: "insight", label: "บทวิเคราะห์" },
  { id: "river", label: "แม่น้ำ: สถานีที่ระดับน้ำสูง" },
  { id: "dam", label: "เขื่อนขนาดใหญ่" },
  { id: "rain", label: "ฝน 24 ชม. ที่ผ่านมา" },
  { id: "risk", label: "ความเสี่ยงจากฝนสะสม / ความผิดปกติ" },
  { id: "watch", label: "จังหวัดที่ควรจับตา", scope: "nat" },
  { id: "fc", label: "พยากรณ์: ช่วงเวลาที่ฝนจะตก 3 วัน", scope: "prov" },
  { id: "fc10", label: "พยากรณ์: กราฟฝน 10 วัน (3 โมเดล)", scope: "prov" },
  { id: "dist", label: "พยากรณ์: ฝน 24 ชม. ข้างหน้า รายอำเภอ", scope: "prov" },
  { id: "note", label: "หมายเหตุ / ข้อความของฉัน" },
];
S.rpt = Object.assign(
  { title: "", author: "", note: "", rows: 15, sec: { kpi: 1, insight: 1, risk: 1, river: 1, dam: 1, rain: 1, watch: 1, fc: 1, fc10: 0, dist: 1, note: 0 } },
  store.get("rpt", {}),
);
const saveRpt = () => store.set("rpt", S.rpt);
const secOn = (id) => {
  const d = RSECS.find((x) => x.id === id);
  if (d.scope === "nat" && S.prov) return false;
  if (d.scope === "prov" && !S.prov) return false;
  return !!S.rpt.sec[id];
};
const rptScope = () => (S.prov ? `จังหวัด${provName(S.prov)}` : "ทั้งประเทศ");
const rptTitle = () => S.rpt.title.trim() || `รายงานสรุปสถานการณ์น้ำ ${rptScope()}`;

async function viewReport() {
  const r = S.rpt;
  $("#view").innerHTML = `
    <div class="card builder">
      <h2 style="margin-top:0">สร้างรายงานสรุป</h2>
      <div class="small muted" style="margin-bottom:10px">ขอบเขต: <b>${esc(rptScope())}</b> — เปลี่ยนจังหวัดได้จากเมนูด้านบน${S.prov ? " · จุดพยากรณ์ใช้อำเภอที่เลือกในแท็บอากาศ" : ""}</div>
      <label class="fld">ชื่อรายงาน<input id="r-title" type="text" placeholder="${esc(`รายงานสรุปสถานการณ์น้ำ ${rptScope()}`)}" value="${esc(r.title)}"></label>
      <label class="fld">ผู้จัดทำ / หน่วยงาน (ไม่บังคับ)<input id="r-author" type="text" value="${esc(r.author)}"></label>
      <div class="fld">หัวข้อที่จะใส่</div>
      <div class="checks">${RSECS.map((d) => {
        const off = (d.scope === "nat" && S.prov) || (d.scope === "prov" && !S.prov);
        return `<label class="chk ${off ? "off" : ""}"><input type="checkbox" data-sec="${d.id}" ${r.sec[d.id] && !off ? "checked" : ""} ${off ? "disabled" : ""}><span>${esc(d.label)}${off ? `<br><span class="small muted">${d.scope === "nat" ? "ใช้ได้เมื่อเลือกทั้งประเทศ" : "ใช้ได้เมื่อเลือกจังหวัด"}</span>` : ""}</span></label>`;
      }).join("")}</div>
      <label class="fld" id="r-note-wrap" ${r.sec.note ? "" : "hidden"}>ข้อความของฉัน<textarea id="r-note" rows="3" placeholder="เช่น ข้อสังเกตจากพื้นที่ แผนรับมือ">${esc(r.note)}</textarea></label>
      <label class="fld">จำนวนแถวในตาราง
        <select id="r-rows">${[10, 15, 25, 50].map((n) => `<option value="${n}" ${+r.rows === n ? "selected" : ""}>${n} แถว</option>`).join("")}</select></label>
      <div class="actions">
        <button class="btn primary" data-export="png">🖼️ รูปภาพ</button>
        <button class="btn primary" data-export="pdf">📄 PDF</button>
        <button class="btn" data-export="print">🖨️ พิมพ์</button>
      </div>
      <div id="r-status" class="small muted" style="margin-top:6px">รูปภาพเหมาะสำหรับส่ง LINE · PDF แบ่งหน้า A4 อัตโนมัติ</div>
    </div>
    <h2>ตัวอย่าง</h2>
    <div class="paper-wrap"><div id="report-paper" class="report"><div class="loading">กำลังสร้างรายงาน…</div></div></div>`;

  const upd = debounce(() => { saveRpt(); renderPaper(); }, 350);
  $("#r-title").addEventListener("input", (e) => { r.title = e.target.value; upd(); });
  $("#r-author").addEventListener("input", (e) => { r.author = e.target.value; upd(); });
  $("#r-note").addEventListener("input", (e) => { r.note = e.target.value; upd(); });
  $("#r-rows").addEventListener("change", (e) => { r.rows = +e.target.value; saveRpt(); renderPaper(); });
  document.querySelectorAll("[data-sec]").forEach((c) => c.addEventListener("change", () => {
    r.sec[c.dataset.sec] = c.checked ? 1 : 0;
    $("#r-note-wrap").hidden = !r.sec.note;
    saveRpt(); renderPaper();
  }));
  document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => exportReport(b.dataset.export)));
  await renderPaper();
}

let paperSeq = 0;
async function renderPaper() {
  const el = $("#report-paper");
  if (!el) return;
  const seq = ++paperSeq;
  const html = await buildReportHtml();
  if (seq === paperSeq && $("#report-paper")) $("#report-paper").innerHTML = html;
}

async function buildReportHtml() {
  const N = +S.rpt.rows || 15;
  const sec = (title, body) => `<div class="rsec"><h3>${title}</h3>${body}</div>`;
  const now = Date.now();
  let h = `<div class="r-head"><div>
      <div class="r-title">${esc(rptTitle())}</div>
      <div class="r-sub">${esc(rptScope())} · ข้อมูล ณ ${thTime(S.data.updated)} น.</div>
      ${S.rpt.author.trim() ? `<div class="r-sub">จัดทำโดย ${esc(S.rpt.author.trim())}</div>` : ""}
    </div>
    <svg class="r-logo" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ffffff" fill-opacity=".14"/><path d="M256 92c-62 86-118 158-118 222a118 118 0 0 0 236 0c0-64-56-136-118-222z" fill="#e8f6fc"/><path d="M168 318c30 0 30-18 58-18s28 18 58 18 30-18 58-18v34c-28 0-28 18-58 18s-30-18-58-18-28 18-58 18z" fill="#0b7fab"/></svg>
  </div>`;

  const sd = await summaryData();
  if (secOn("kpi")) h += sec("ตัวเลขสำคัญ", sd.kpis);
  if (secOn("insight")) h += sec("บทวิเคราะห์", `<ul class="insights">${sd.notes.join("")}</ul>`);

  if (S.rpt.sec.risk === undefined) S.rpt.sec.risk = 1;
  if (secOn("risk") && S.risk?.prov) {
    const when = `<div class="note">ประเมินเมื่อ ${thTime(S.risk.updated)} น. · คะแนน 0–100 จากฝนสะสมเทียบค่าปกติของพื้นที่ ดินชุ่มน้ำ ความแรง ความต่อเนื่อง และระดับน้ำ${S.risk.climDone < S.risk.climTotal ? ` · ค่าปกติพร้อม ${S.risk.climDone}/${S.risk.climTotal} จังหวัด` : ""}</div>`;
    if (S.prov && S.risk.prov[S.prov]) {
      const r = S.risk.prov[S.prov], l = riskLevel(r.score);
      h += sec(`ความเสี่ยงจากฝนสะสม: ${r.score}/100 · ${l.label}`, riskFindings(r) + riskChart(r) + when);
    } else {
      const list = Object.entries(S.risk.prov).map(([p, r]) => ({ p: +p, ...r })).filter((r) => r.score >= 10).sort((a, b) => b.score - a.score).slice(0, N);
      h += sec("ความเสี่ยงจากฝนสะสม (เรียงตามคะแนน)", list.length ? `<table class="t"><thead><tr><th>จังหวัด</th><th>คะแนน</th><th>ระดับ</th><th>ฝน 7 วัน</th><th>ความผิดปกติ</th><th style="text-align:left">สังเกต</th></tr></thead><tbody>
        ${list.map((r) => `<tr><td>${esc(provName(r.p))}</td><td><b>${r.score}</b></td><td>${riskPill(r)}</td><td>${fmt(r.v.event7)}</td><td>${r.anomaly > 100 ? "เกินสถิติ" : `P${fmt(r.anomaly)}`}</td><td class="l small">${[r.onset ? "ฉับพลัน" : "", r.run?.len >= 2 ? `ต่อเนื่อง ${r.run.len} วัน` : "", r.firstHeavy && r.firstHeavy.inDays > 0 ? `หนัก${inDaysText(r.firstHeavy.inDays)}` : ""].filter(Boolean).join(" · ") || "–"}</td></tr>`).join("")}
        </tbody></table>${when}` : `<div class="empty">ไม่มีจังหวัดที่มีความเสี่ยงนัยสำคัญ</div>${when}`);
    }
  }

  if (secOn("river")) {
    const hist = S.prov ? await loadWlHist(S.prov) : null;
    const list = sd.rv.filter((s) => s.pct !== null).map((s) => ({ ...s, d: hist ? wlChange(hist, s, 24) : s.msl !== null && s.prev !== null ? s.msl - s.prev : null }))
      .sort((a, b) => b.pct - a.pct).slice(0, N);
    const body = list.length ? `${stackBar(sd.counts, RIVER_BANDS)}
      <table class="t"><thead><tr><th>สถานี</th><th style="text-align:left">พื้นที่</th><th>% ตลิ่ง</th><th>สถานะ</th><th>เปลี่ยนแปลง${hist ? " 24 ชม." : ""}</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td>${esc(s.n)}</td><td class="l">${esc([s.a, S.prov ? null : provName(s.p)].filter(Boolean).join(", "))}</td><td>${fmt(s.pct)}%</td><td>${pill(band(RIVER_BANDS, s.pct))}</td><td class="${s.d > 0.01 ? "up" : s.d < -0.01 ? "down" : ""}">${s.d === null ? "–" : `${sign(s.d, 2)} ม.`}</td></tr>`).join("")}
      </tbody></table><div class="note">เรียงตามระดับน้ำเทียบตลิ่งจากมากไปน้อย ${fmt(list.length)} จาก ${fmt(sd.rv.length)} สถานี</div>` : `<div class="empty">ไม่มีสถานีที่รายงานข้อมูล</div>`;
    h += sec("แม่น้ำ: สถานีที่ระดับน้ำสูง", body);
  }

  if (secOn("dam")) {
    const dh = await loadDamHist();
    const list = [...sd.dm].sort((a, b) => b.pct - a.pct);
    const shown = list.slice(0, N);
    const body = list.length ? `<table class="t"><thead><tr><th>เขื่อน</th><th>% ความจุ</th><th>ปริมาตร</th><th>ไหลเข้า</th><th>ระบาย</th><th>7 วัน</th></tr></thead><tbody>
      ${shown.map((d) => { const c7 = damChange(dh, d, 7); return `<tr><td>${esc(d.n)}<span class="muted small"> ${esc(d.p ? provName(d.p) : "")}</span></td><td>${fmt(d.pct)}%</td><td>${fmt(d.v)}</td><td>${fmt(d.in, 2)}</td><td>${fmt(d.out, 2)}</td><td class="${c7 > 0 ? "up" : c7 < 0 ? "down" : ""}">${sign(c7)}</td></tr>`; }).join("")}
      <tr><td><b>รวม ${list.length} แห่ง</b></td><td><b>${fmt((sum(list.map((d) => d.v)) / sum(list.map((d) => d.st))) * 100)}%</b></td><td><b>${fmt(sum(list.map((d) => d.v)))}</b></td><td>${fmt(sum(list.map((d) => d.in)), 1)}</td><td>${fmt(sum(list.map((d) => d.out)), 1)}</td><td></td></tr>
      </tbody></table><div class="note">หน่วย: ล้าน ลบ.ม. (ไหลเข้า/ระบาย ต่อวัน) · % เทียบระดับเก็บกักปกติ · ข้อมูลกรมชลประทาน ณ ${esc(S.data.dams.date || "–")}</div>`
      : `<div class="empty">ไม่มีเขื่อนขนาดใหญ่ของกรมชลประทานในพื้นที่นี้</div>`;
    h += sec("เขื่อนขนาดใหญ่", body);
  }

  if (secOn("rain")) {
    const rain = S.data.rain;
    let body;
    if (S.prov) {
      const top = rain.top.filter(inProv).slice(0, N);
      body = top.length ? `<table class="t"><thead><tr><th>สถานี</th><th style="text-align:left">อำเภอ</th><th>ฝน 24 ชม. (มม.)</th><th>ระดับ</th></tr></thead><tbody>
        ${top.map((s) => { const c = rainClass(s.mm); return `<tr><td>${esc(s.n)}</td><td class="l">${esc(s.a || "")}</td><td>${fmt(s.mm, 1)}</td><td><span class="pill" style="--c:var(--${c.key})">${c.label}</span></td></tr>`; }).join("")}
        </tbody></table>` : `<div class="empty">ไม่มีฝนใน 24 ชม. ที่ผ่านมา</div>`;
    } else {
      const list = Object.entries(rain.byProv).filter(([p]) => +p).map(([p, x]) => ({ p: +p, ...x })).sort((a, b) => b.max - a.max).slice(0, N);
      body = `<table class="t"><thead><tr><th>จังหวัด</th><th>สูงสุด (มม.)</th><th>เฉลี่ย (มม.)</th><th>สถานีมีฝน</th><th>ระดับ</th></tr></thead><tbody>
        ${list.map((x) => { const c = rainClass(x.max); return `<tr><td>${esc(provName(x.p))}</td><td>${fmt(x.max, 1)}</td><td>${fmt(x.avg, 1)}</td><td>${x.wet}/${x.n}</td><td><span class="pill" style="--c:var(--${c.key})">${c.label}</span></td></tr>`; }).join("")}
        </tbody></table>`;
    }
    h += sec("ฝน 24 ชม. ที่ผ่านมา", body + `<div class="note">เกณฑ์กรมอุตุฯ: 0.1–10 เล็กน้อย · 10.1–35 ปานกลาง · 35.1–90 หนัก · >90 มม. หนักมาก</div>`);
  }

  if (secOn("watch")) h += sec("จังหวัดที่ควรจับตา", provinceRanking(N, false));

  if (secOn("fc") || secOn("fc10")) {
    const pt = wxPoint();
    try {
      const wx = await getForecast(pt.lat, pt.lon);
      if (secOn("fc")) {
        const upcoming = hourlyRows(wx).filter((r) => r.ms + HOUR > now).slice(0, 72);
        const ps = rainPeriods(upcoming);
        h += sec(`พยากรณ์ช่วงเวลาที่ฝนจะตก 3 วัน · ${esc(pt.label)}`, `<ul class="insights">${ps.length ? ps.slice(0, 8).map((p) => { const t = periodText(p); return `<li style="--sev:var(--${t.key})">${t.html}</li>`; }).join("") : `<li style="--sev:var(--normal)">ไม่คาดว่าจะมีฝนนัยสำคัญใน 3 วันข้างหน้า</li>`}</ul>
          <div class="note">เวลาอาจคลาดได้ 2–3 ชม. · ความแรงต่อชั่วโมง: เล็กน้อย ≤2.5 · ปานกลาง ≤7.5 · หนัก ≤20 · หนักมาก >20 มม.</div>`);
      }
      if (secOn("fc10")) {
        const a = analyzeForecast(wx);
        const series = MODELS.map((m, i) => ({ name: m.name, values: a.per[i].slice(0, 10), color: m.color }));
        h += sec(`พยากรณ์ฝน 10 วัน เทียบ 3 โมเดล · ${esc(pt.label)}`, `<ul class="insights">${a.lines.map((l) => `<li style="--sev:var(--${l.key})">${l.text}</li>`).join("")}</ul>
          ${groupedBars({ labels: a.days.slice(0, 10).map(dayLabel), series })}${legend(series)}`);
      }
    } catch {
      h += sec("พยากรณ์ฝน", `<div class="empty">โหลดพยากรณ์ไม่สำเร็จ</div>`);
    }
  }

  if (secOn("dist")) {
    try { h += sec(`ฝน 24 ชม. ข้างหน้า ราย${S.prov === 10 ? "เขต" : "อำเภอ"}`, districtTable(await getDistrictForecast(S.prov), false)); }
    catch { h += sec("ฝนรายอำเภอ", `<div class="empty">โหลดข้อมูลไม่สำเร็จ</div>`); }
  }

  if (secOn("note") && S.rpt.note.trim()) h += sec("หมายเหตุ", `<div class="r-usernote">${esc(S.rpt.note.trim())}</div>`);

  h += `<div class="r-foot">ที่มา: คลังข้อมูลน้ำแห่งชาติ (สสน.), กรมชลประทาน, Open-Meteo (ECMWF/GFS/ICON) · สร้างรายงานเมื่อ ${thTime(now)} น.<br>
    บทวิเคราะห์และพยากรณ์เป็นการประเมินเบื้องต้นจากข้อมูลอัตโนมัติ ไม่ใช่ประกาศทางการ โปรดติดตามประกาศของกรมอุตุนิยมวิทยา กรมชลประทาน และ ปภ. ประกอบ</div>`;
  return h;
}

async function exportReport(kind) {
  const status = $("#r-status");
  const paper = $("#report-paper");
  if (!paper) return;
  if (kind === "print") { window.print(); return; }
  const stamp = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const base = `รายงานน้ำ_${rptScope().replace(/\s+/g, "")}_${stamp}`;
  document.querySelectorAll("[data-export]").forEach((b) => (b.disabled = true));
  status.textContent = "กำลังสร้างไฟล์… (ครั้งแรกอาจใช้เวลาหลายวินาทีเพื่อโหลดฟอนต์)";
  try {
    const blob = kind === "png" ? await reportToPng(paper) : await reportToPdf(paper, rptScope());
    const res = await deliverFile(blob, `${base}.${kind}`, rptTitle());
    status.textContent = res === "shared" ? "ส่งไฟล์เรียบร้อย" : res === "cancelled" ? "ยกเลิกแล้ว" : `ดาวน์โหลด ${base}.${kind} แล้ว`;
  } catch (e) {
    console.error(e);
    status.innerHTML = `สร้างไฟล์ไม่สำเร็จในเบราว์เซอร์นี้ — ลองกด <b>พิมพ์</b> แล้วเลือก "บันทึกเป็น PDF" แทน`;
  } finally {
    document.querySelectorAll("[data-export]").forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------- โครงหน้า
function statusNote() {
  const st = S.data?.status ?? {};
  const names = { wl: "ระดับน้ำ", rain: "ฝน", dams: "เขื่อน" };
  const bad = Object.entries(st).filter(([, v]) => !v.ok);
  return `<div class="note">${bad.length ? `⚠︎ รอบล่าสุดดึงข้อมูล${bad.map(([k, v]) => `${names[k]} (ข้อมูลเมื่อ ${ago(v.at)})`).join(", ")}ไม่สำเร็จ ใช้ข้อมูลรอบก่อนแทน · ` : ""}ที่มา: คลังข้อมูลน้ำแห่งชาติ (สสน.), กรมชลประทาน, Open-Meteo</div>`;
}

function renderHeader() {
  const st = S.data?.status ?? {};
  const warn = Object.values(st).some((v) => !v.ok) || Date.now() - (S.data?.updated ?? 0) > 3 * HOUR;
  $("#updated").innerHTML = S.data ? `<span class="dot ${warn ? "warn" : ""}"></span>อัปเดต ${ago(S.data.updated)}` : "ไม่มีข้อมูล";
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
  $("#rptBtn")?.setAttribute("aria-pressed", S.tab === "report");
}

let renderSeq = 0;
async function render() {
  renderHeader();
  if (!S.data) return;
  const seq = ++renderSeq;
  const views = { sum: viewSummary, risk: viewRisk, river: viewRiver, dam: viewDam, rain: viewRain, wx: viewWx, report: viewReport };
  try { await views[S.tab](); } catch (e) {
    console.error(e);
    if (seq === renderSeq) $("#view").innerHTML = `<div class="card empty">แสดงผลไม่สำเร็จ: ${esc(e.message)}</div>`;
  }
}

function setProv(p) {
  S.prov = Number(p); S.point = null; S.open = null; S.q = ""; S.hsel = null;
  store.set("prov", S.prov);
  $("#province").value = S.prov;
  window.scrollTo(0, 0);
  render();
}
function setTab(t) {
  S.tab = t; S.open = null; store.set("tab", t);
  window.scrollTo(0, 0);
  render();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-tab],[data-prov],[data-open],[data-region],[data-point],[data-go],[data-geo],[data-dist],[data-hour],[data-rsort]");
  if (!el) return;
  if (el.dataset.rsort) { S.riskSort = el.dataset.rsort; return render(); }
  if (el.dataset.hour) {
    S.hsel = el.dataset.hour;
    document.querySelectorAll(".hc.sel").forEach((c) => c.classList.remove("sel"));
    el.classList.add("sel");
    const info = $("#hinfo"); if (info && S._rows) info.innerHTML = hourInfo(S._rows);
    return;
  }
  if (el.dataset.geo) return useMyLocation();
  if (el.dataset.dist) { if (S.tab !== "wx") { S.dist[S.prov] = el.dataset.dist; store.set("dist", S.dist); S.point = null; return setTab("wx"); } return selectDist(el.dataset.dist); }
  if (el.dataset.tab) return setTab(el.dataset.tab);
  if (el.dataset.go) return setTab(el.dataset.go);
  if (el.dataset.prov) return setProv(el.dataset.prov);
  if (el.dataset.region) { S.region = el.dataset.region; return render(); }
  if (el.dataset.point) {
    if (el.dataset.point === "reset") S.point = null;
    else { const [lat, lon] = el.dataset.point.split(",").map(Number); S.point = { lat, lon, label: el.dataset.label }; }
    return setTab("wx");
  }
  if (el.dataset.open) { S.open = S.open === el.dataset.open ? null : el.dataset.open; const y = window.scrollY; render().then(() => window.scrollTo(0, y)); }
});
$("#updated").addEventListener("click", () => refresh());

async function refresh() {
  try {
    S.data = await getJSON("data/latest.json");
    S.data.fetchedAt = Date.now();
    S.risk = await getJSON("data/risk.json").catch(() => null);
    S.wlHist = {}; S.damHist = null; S.rainHist = null;
  } catch (e) {
    if (!S.data) $("#view").innerHTML = `<div class="card empty">ยังไม่มีข้อมูล<br><span class="small">ถ้าเพิ่งติดตั้ง รอให้ GitHub Actions รันรอบแรกเสร็จ (ประมาณ 1–2 นาที)</span></div>`;
  }
  render();
}

async function init() {
  S.provinces = await getJSON("provinces.json", { cache: "default" });
  S.provinces.forEach((p) => S.provByCode.set(p.code, p));
  S.districts = await getJSON("districts.json", { cache: "default" }).catch(() => ({}));
  const sorted = [...S.provinces].sort((a, b) => a.name.localeCompare(b.name, "th"));
  $("#province").innerHTML = `<option value="0">ทั้งประเทศ</option>` + sorted.map((p) => `<option value="${p.code}">${esc(p.name)}</option>`).join("");
  if (!S.provByCode.has(S.prov)) S.prov = 0;
  $("#province").value = S.prov;
  $("#province").addEventListener("change", (e) => setProv(e.target.value));
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#rptBtn").addEventListener("click", () => setTab("report"));
  const st = document.createElement("style"); st.textContent = REPORT_CSS; document.head.appendChild(st);
  await refresh();
  // รีเฟรชอัตโนมัติเมื่อกลับมาเปิดแอปหลังผ่านไป 10 นาที
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - (S.data?.fetchedAt ?? 0) > 10 * 60e3) refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
