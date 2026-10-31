// รายงานสรุป: สร้างรายงานจากข้อมูลปัจจุบัน แล้วบันทึกเป็นรูปภาพ (PNG) / PDF / พิมพ์
// ไม่ใช้ไลบรารีภายนอก — วาดหน้ารายงานผ่าน SVG foreignObject ลง canvas และเขียนไฟล์ PDF เอง

export const A4_W = 794;             // ความกว้าง A4 ที่ 96 dpi (px)
export const A4_H = 1123;            // ความสูง A4 (px)
const PAGE_MARGIN = 38;              // ขอบบน/ล่างของแต่ละหน้าใน PDF (px)

// สไตล์ของรายงาน — ใช้ทั้งตอนแสดงตัวอย่าง พิมพ์ และส่งออกเป็นภาพ
// (ตั้งสีโหมดสว่างเสมอ เพราะเป็นกระดาษ)
export const REPORT_CSS = `
.report { --ink:#14222b; --muted:#5b6b75; --line:#dde5ea; --card:#fff; --accent:#0b7fab; --brand:#0f5c7a;
  --crit-low:#b7791f; --low:#d69e2e; --normal:#2f855a; --high:#2b6cb0; --over:#c53030;
  --m1:#0b7fab; --m2:#d97706; --m3:#7c3aed;
  --r0:#e7edf1; --r1:#b3dcef; --r2:#4fa8d6; --r3:#1c5fa8; --r4:#6b21a8;
  background:#fff; color:var(--ink); font:13px/1.55 "IBM Plex Sans Thai", "Noto Sans Thai", "Thonburi", "Leelawadee UI", sans-serif;
  padding:0 36px 28px; box-sizing:border-box; width:100%; }
.report * { box-sizing:border-box; }
.report .r-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; background:var(--brand); color:#fff;
  margin:0 -36px 18px; padding:26px 36px 20px; }
.report .r-title { font-size:22px; font-weight:700; line-height:1.3; }
.report .r-sub { font-size:12.5px; opacity:.9; margin-top:3px; }
.report .r-logo { width:44px; height:44px; flex:none; }
.report .rsec { margin-bottom:16px; }
.report h3 { font-size:15px; margin:0 0 8px; padding-bottom:5px; border-bottom:2px solid var(--brand); color:var(--brand); }
.report .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.report .kpi { border:1px solid var(--line); border-radius:10px; padding:9px 11px; }
.report .kpi .v { font-size:22px; font-weight:700; line-height:1.15; }
.report .kpi .l { font-size:11px; color:var(--muted); }
.report .kpi.alert .v { color:var(--over); }
.report .insights { margin:0; padding:0; list-style:none; }
.report .insights li { padding:6px 0 6px 18px; border-top:1px solid var(--line); position:relative; }
.report .insights li:first-child { border-top:0; }
.report .insights li::before { content:""; position:absolute; left:2px; top:13px; width:8px; height:8px; border-radius:50%; background:var(--sev, var(--accent)); }
.report .small { font-size:11.5px; } .report .muted { color:var(--muted); }
.report .up { color:var(--over); } .report .down { color:var(--normal); }
.report .stack { display:flex; height:10px; border-radius:5px; overflow:hidden; background:var(--line); }
.report .stack span { display:block; height:100%; }
.report .legend { display:flex; flex-wrap:wrap; gap:3px 12px; margin:6px 0 8px; font-size:11px; color:var(--muted); }
.report .legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:-1px; }
.report table.t { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric:tabular-nums; }
.report table.t th, .report table.t td { padding:4px 5px; border-top:1px solid var(--line); text-align:right; }
.report table.t th:first-child, .report table.t td:first-child { text-align:left; }
.report table.t th { font-weight:600; color:var(--muted); font-size:11px; border-top:0; background:#f3f6f8; }
.report table.t td.l { text-align:left; }
.report table.t tr.cur td { font-weight:700; color:var(--accent); }
.report .pill { display:inline-block; font-size:10.5px; font-weight:600; padding:0 7px; border-radius:99px; color:#fff; background:var(--c, var(--muted)); white-space:nowrap; }
.report .dotc { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:0; }
.report svg.chart { width:100%; height:auto; display:block; max-height:220px; }
.report svg.chart text { fill:var(--muted); font-size:10px; font-family:inherit; }
.report svg.chart .grid { stroke:var(--line); stroke-width:1; }
.report .chart-legend { display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:var(--muted); margin-top:4px; }
.report .chart-legend i { display:inline-block; width:12px; height:3px; border-radius:2px; margin-right:5px; vertical-align:3px; }
.report .note, .report .r-note { font-size:11px; color:var(--muted); margin-top:6px; }
.report .insights .pline { margin-top:4px; padding-left:8px; border-left:2px solid var(--line); }
.report .r-usernote { white-space:pre-wrap; border-left:3px solid var(--accent); background:#f3f8fb; padding:8px 12px; border-radius:0 8px 8px 0; }
.report .empty { color:var(--muted); padding:8px 0; }
.report .r-foot { border-top:1px solid var(--line); padding-top:8px; font-size:10.5px; color:var(--muted); }
.report .r-cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
`;

// ---------------------------------------------------------------- ฟอนต์ (ฝังลงในภาพ เพื่อให้ตัวอักษรไทยแสดงถูกต้อง)
let fontCssPromise = null;
function blobToDataURL(blob) {
  return new Promise((ok, err) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = err; r.readAsDataURL(blob); });
}
async function embeddedFontCss() {
  fontCssPromise ??= (async () => {
    const css = await (await fetch("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap")).text();
    // เก็บเฉพาะชุดอักษรไทยและละติน
    const blocks = css.split(/(?=\/\* )/).filter((b) => /^\/\* (thai|latin) \*\//.test(b));
    const out = [];
    for (const b of blocks) {
      const m = b.match(/url\((https:[^)]+)\)/);
      if (!m) continue;
      const data = await blobToDataURL(await (await fetch(m[1])).blob());
      out.push(b.replace(m[1], data));
    }
    return out.join("\n");
  })().catch(() => "");
  return fontCssPromise;
}

// ---------------------------------------------------------------- วาดรายงานลง canvas
/** สร้างสำเนารายงานกว้าง A4 ไว้นอกจอ เพื่อวัดขนาดและจุดตัดหน้า */
async function stage(reportEl) {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${A4_W * 3}px;top:0;width:${A4_W}px;background:#fff;`;
  const wrap = document.createElement("div");
  wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrap.style.cssText = `width:${A4_W}px;background:#fff;`;
  const style = document.createElement("style");
  style.textContent = (await embeddedFontCss()) + REPORT_CSS;
  wrap.appendChild(style);
  const clone = reportEl.cloneNode(true);
  clone.removeAttribute("id");
  wrap.appendChild(clone);
  host.appendChild(wrap);
  document.body.appendChild(host);
  try { await document.fonts?.ready; } catch { /* ไม่เป็นไร */ }
  const top = clone.getBoundingClientRect().top;
  const height = Math.ceil(clone.getBoundingClientRect().height);
  // จุดที่ตัดหน้าได้: ท้ายหัวข้อ แถวตาราง และรายการ
  const breaks = [...clone.querySelectorAll(".rsec, .rsec tr, .rsec li, .rsec .chart-legend, .r-head")]
    .map((el) => Math.round(el.getBoundingClientRect().bottom - top))
    .filter((y) => y > 0 && y < height).sort((a, b) => a - b);
  return { host, wrap, height, breaks };
}

async function renderCanvas(reportEl) {
  const { host, wrap, height, breaks } = await stage(reportEl);
  try {
    const xml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${A4_W}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = "sync";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    // จำกัดขนาด canvas ไม่ให้เกินที่มือถือรองรับ (~16 ล้านพิกเซล)
    const scale = Math.min(2, Math.sqrt(15e6 / (A4_W * height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(A4_W * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    const paint = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
    paint();
    await new Promise((r) => setTimeout(r, 120)); // Safari บางรุ่นวาดฟอนต์ไม่ทันในรอบแรก
    paint();
    return { canvas, scale, height, breaks };
  } finally {
    host.remove();
  }
}

const toBlob = (canvas, type, q) => new Promise((ok, err) => {
  try { canvas.toBlob((b) => (b ? ok(b) : err(new Error("toBlob failed"))), type, q); } catch (e) { err(e); }
});

export async function reportToPng(reportEl) {
  const { canvas } = await renderCanvas(reportEl);
  return toBlob(canvas, "image/png");
}

// ---------------------------------------------------------------- PDF (เขียนไฟล์เอง: หนึ่งหน้า = หนึ่งภาพ JPEG)
function planPages(height, breaks) {
  const usable = A4_H - PAGE_MARGIN * 2;
  const pages = [];
  let start = 0;
  while (start < height - 2) {
    let end = Math.min(height, start + usable);
    if (end < height) {
      const cands = breaks.filter((b) => b > start + usable * 0.35 && b <= end);
      if (cands.length) end = cands.at(-1);
    }
    pages.push([start, end]);
    start = end;
  }
  return pages;
}

function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offs = [];
  const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const W = 595.28, H = 841.89;
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`));
  pages.forEach((p, i) => {
    const pid = 3 + 3 * i, iid = pid + 1, cid = pid + 2;
    obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`));
    obj(iid, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push("\nendstream");
    });
    const c = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(cid, () => push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`));
  });
  const total = 3 + 3 * pages.length;
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) push(`${String(offs[k]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

export async function reportToPdf(reportEl, footerText = "") {
  const { canvas, scale, height, breaks } = await renderCanvas(reportEl);
  const plan = planPages(height, breaks);
  const pw = Math.round(A4_W * scale), ph = Math.round(A4_H * scale);
  const page = document.createElement("canvas");
  page.width = pw; page.height = ph;
  const ctx = page.getContext("2d");
  const out = [];
  for (let i = 0; i < plan.length; i++) {
    const [s, e] = plan[i];
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pw, ph);
    const top = i === 0 ? 0 : PAGE_MARGIN; // หน้าแรกให้แถบหัวรายงานชิดขอบบน
    ctx.drawImage(canvas, 0, s * scale, pw, (e - s) * scale, 0, top * scale, pw, (e - s) * scale);
    // เลขหน้า
    ctx.fillStyle = "#8a99a3";
    ctx.font = `${11 * scale}px "IBM Plex Sans Thai", sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(`หน้า ${i + 1}/${plan.length}`, pw - 36 * scale, ph - 16 * scale);
    if (footerText) { ctx.textAlign = "left"; ctx.fillText(footerText, 36 * scale, ph - 16 * scale); }
    const jpeg = new Uint8Array(await (await toBlob(page, "image/jpeg", 0.9)).arrayBuffer());
    out.push({ jpeg, w: pw, h: ph });
  }
  return buildPdf(out);
}

// ---------------------------------------------------------------- ส่งไฟล์ให้ผู้ใช้
export async function deliverFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  // มือถือ: เปิดเมนูแชร์ (บันทึกลงรูปภาพ/ไฟล์ หรือส่ง LINE ได้ทันที)
  if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ files: [file], title }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return "downloaded";
}
