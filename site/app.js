// ติดตามน้ำไทย — หน้าเว็บอ่านไฟล์ JSON ที่ GitHub Actions อัปเดตให้ทุก 30 นาที
// พยากรณ์อากาศและน้ำท่าเรียกจาก Open-Meteo โดยตรง (ฟรี ไม่ต้องใช้ key)

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
  point: null,       // จุดที่ใช้พยากรณ์อากาศ (null = กลางจังหวัด)
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
async function viewSummary() {
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

  let html = `<div class="kpis">
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
  html += `<h2>บทวิเคราะห์</h2><div class="card"><ul class="insights">${notes.join("")}</ul></div>`;

  if (rv.length) html += `<h2>สถานะแม่น้ำ (% ความจุลำน้ำ)</h2><div class="card">${stackBar(counts, RIVER_BANDS)}</div>`;

  if (S.prov) {
    // พยากรณ์สั้นๆ ของจังหวัด
    html += `<h2>ฝนคาดการณ์ 3 วัน</h2><div class="card" id="sum-wx"><div class="loading small">กำลังโหลดพยากรณ์…</div></div>`;
  } else {
    html += `<h2>จังหวัดที่ควรจับตา</h2><div class="card">${provinceRanking()}</div>`;
  }
  html += statusNote();
  $("#view").innerHTML = html;

  if (S.prov) {
    const p = S.provByCode.get(S.prov);
    getForecast(p.lat, p.lon).then((wx) => {
      const el = $("#sum-wx"); if (!el) return;
      const a = analyzeForecast(wx);
      el.innerHTML = `<ul class="insights">${a.lines.slice(0, 3).map((l) => `<li style="--sev:var(--${l.key})">${l.text}</li>`).join("")}</ul>
        <button class="link-btn" data-go="wx">ดูพยากรณ์เต็ม</button>`;
    }).catch(() => { const el = $("#sum-wx"); if (el) el.innerHTML = `<div class="empty small">โหลดพยากรณ์ไม่สำเร็จ</div>`; });
  }
}

function provinceRanking() {
  const rows = new Map();
  const get = (p) => { if (!rows.has(p)) rows.set(p, { p, over: 0, high: 0, n: 0, rain: S.data.rain.byProv[p]?.max ?? 0, dam: null }); return rows.get(p); };
  for (const s of S.data.wl) { if (!s.p) continue; const r = get(s.p); r.n++; if (s.pct > 100) r.over++; else if (s.pct > 70) r.high++; }
  for (const d of S.data.dams.dams) if (d.p) { const r = get(d.p); r.dam = Math.max(r.dam ?? 0, d.pct); }
  for (const p of Object.keys(S.data.rain.byProv)) if (+p) get(+p);
  const score = (r) => r.over * 3 + r.high + (r.rain > 90 ? 4 : r.rain > 35 ? 2 : 0) + (r.dam > 100 ? 3 : r.dam > 80 ? 1 : 0);
  const list = [...rows.values()].map((r) => ({ ...r, sc: score(r) })).filter((r) => r.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 15);
  if (!list.length) return `<div class="empty small">ไม่มีจังหวัดที่เข้าเกณฑ์เฝ้าระวัง</div>`;
  return `<table class="t"><thead><tr><th>จังหวัด</th><th>ล้นตลิ่ง</th><th>น้ำมาก</th><th>ฝนสูงสุด</th><th>เขื่อน</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="click" data-prov="${r.p}"><td>${esc(provName(r.p))}</td><td class="${r.over ? "up" : ""}">${r.over || "–"}</td><td>${r.high || "–"}</td><td>${r.rain ? fmt(r.rain) : "–"}</td><td>${r.dam === null ? "–" : fmt(r.dam) + "%"}</td></tr>`).join("")}
  </tbody></table><div class="note">แตะชื่อจังหวัดเพื่อดูรายละเอียด · เรียงตามคะแนนรวมจากระดับน้ำ ฝน และเขื่อน</div>`;
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
    getJSON(`${base}&daily=precipitation_sum&models=${MODELS.map((m) => m.id).join(",")}&forecast_days=10`, { cache: "default" }),
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

async function viewWx() {
  const p = S.prov ? S.provByCode.get(S.prov) : null;
  const pt = S.point ?? (p ? { lat: p.lat, lon: p.lon, label: `กลางจังหวัด${p.name}` } : null);
  if (!pt) {
    $("#view").innerHTML = `<div class="card empty">เลือกจังหวัดด้านบน เพื่อดูพยากรณ์ฝนจาก 3 โมเดล<br>และคาดการณ์ปริมาณน้ำท่า</div>`;
    return;
  }
  $("#view").innerHTML = `<div class="loading">กำลังโหลดพยากรณ์…</div>`;
  let wx;
  try { wx = await getForecast(pt.lat, pt.lon); } catch {
    $("#view").innerHTML = `<div class="card empty">โหลดพยากรณ์ไม่สำเร็จ ลองใหม่อีกครั้ง</div>`; return;
  }
  const a = analyzeForecast(wx);
  const series = MODELS.map((m, i) => ({ name: m.name, values: a.per[i].slice(0, 10), color: m.color }));
  const b = wx.best;
  const nowIdx = b.hourly.time.findIndex((t) => Date.parse(t + ":00+07:00") >= Date.now() - HOUR);
  const hrs = b.hourly.time.slice(nowIdx, nowIdx + 48);

  let html = `<div class="small muted" style="margin-bottom:8px">จุดพยากรณ์: <b>${esc(pt.label)}</b> (${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)})${S.point ? ` · <button class="link-btn" data-point="reset">กลับไปกลางจังหวัด</button>` : ""}</div>
    <div class="card"><ul class="insights">${a.lines.map((l) => `<li style="--sev:var(--${l.key})">${l.text}</li>`).join("")}</ul></div>
    <h2>ฝนรายวัน เทียบ 3 โมเดล</h2>
    <div class="card">${groupedBars({ labels: a.days.slice(0, 10).map((d) => String(+d.slice(8))), series })}${legend(series)}</div>
    <h2>48 ชั่วโมงข้างหน้า</h2>
    <div class="card">${lineChart({
      series: [{ values: b.hourly.precipitation_probability.slice(nowIdx, nowIdx + 48), color: "var(--m1)" }],
      labels: hrs.map((t) => (t.endsWith("00:00") ? dayLabel(t.slice(0, 10)) : t.endsWith("12:00") ? "12:00" : "")), yMin: 0, unit: "%", fillFirst: true,
    })}<div class="small muted">โอกาสเกิดฝนรายชั่วโมง · ฝนรวม 48 ชม. ≈ ${fmt(sum(b.hourly.precipitation.slice(nowIdx, nowIdx + 48)), 1)} มม.</div></div>
    <h2>อุณหภูมิและลม</h2>
    <div class="card"><table class="t"><thead><tr><th>วัน</th><th>ต่ำ–สูง °C</th><th>ลมสูงสุด กม./ชม.</th><th>โอกาสฝน</th></tr></thead><tbody>
      ${b.daily.time.slice(0, 7).map((d, i) => `<tr><td>${dayLabel(d)}</td><td>${fmt(b.daily.temperature_2m_min[i])}–${fmt(b.daily.temperature_2m_max[i])}</td><td>${fmt(b.daily.wind_speed_10m_max[i])}</td><td>${b.daily.precipitation_probability_max[i] ?? "–"}%</td></tr>`).join("")}
    </tbody></table></div>
    <h2>คาดการณ์ปริมาณน้ำท่า (GloFAS)</h2>
    <div class="card" id="flood"><div class="loading small">กำลังโหลด…</div></div>
    <div class="note">พยากรณ์จาก Open-Meteo (ECMWF IFS, NOAA GFS, DWD ICON) · ความแม่นยำลดลงตามระยะเวลา: 1–3 วันเชื่อถือได้ดี, เกิน 7 วันใช้ดูแนวโน้ม · เป็นการประเมินเบื้องต้น ควรติดตามประกาศทางการจากกรมอุตุนิยมวิทยา</div>`;
  $("#view").innerHTML = html;

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
}

let renderSeq = 0;
async function render() {
  renderHeader();
  if (!S.data) return;
  const seq = ++renderSeq;
  const views = { sum: viewSummary, river: viewRiver, dam: viewDam, rain: viewRain, wx: viewWx };
  try { await views[S.tab](); } catch (e) {
    console.error(e);
    if (seq === renderSeq) $("#view").innerHTML = `<div class="card empty">แสดงผลไม่สำเร็จ: ${esc(e.message)}</div>`;
  }
}

function setProv(p) {
  S.prov = Number(p); S.point = null; S.open = null; S.q = "";
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
  const el = e.target.closest("[data-tab],[data-prov],[data-open],[data-region],[data-point],[data-go]");
  if (!el) return;
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
    S.wlHist = {}; S.damHist = null; S.rainHist = null;
  } catch (e) {
    if (!S.data) $("#view").innerHTML = `<div class="card empty">ยังไม่มีข้อมูล<br><span class="small">ถ้าเพิ่งติดตั้ง รอให้ GitHub Actions รันรอบแรกเสร็จ (ประมาณ 1–2 นาที)</span></div>`;
  }
  render();
}

async function init() {
  S.provinces = await getJSON("provinces.json", { cache: "default" });
  S.provinces.forEach((p) => S.provByCode.set(p.code, p));
  const sorted = [...S.provinces].sort((a, b) => a.name.localeCompare(b.name, "th"));
  $("#province").innerHTML = `<option value="0">ทั้งประเทศ</option>` + sorted.map((p) => `<option value="${p.code}">${esc(p.name)}</option>`).join("");
  if (!S.provByCode.has(S.prov)) S.prov = 0;
  $("#province").value = S.prov;
  $("#province").addEventListener("change", (e) => setProv(e.target.value));
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  await refresh();
  // รีเฟรชอัตโนมัติเมื่อกลับมาเปิดแอปหลังผ่านไป 10 นาที
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - (S.data?.fetchedAt ?? 0) > 10 * 60e3) refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
