// เตือนก่อนฝนตก: หาช่วงเวลาที่ฝนจะตกของแต่ละอำเภอจากพยากรณ์รายชั่วโมง
// ใช้ทั้งฝั่งเซิร์ฟเวอร์ (สร้างไฟล์ทั้งประเทศ) และหน้าเว็บ (ดึงสดรายจังหวัด)

const HOUR = 3600e3;

// ความแรงรายชั่วโมง (มม./ชม.): 1 เล็กน้อย ≤2.5 · 2 ปานกลาง ≤7.5 · 3 หนัก ≤20 · 4 หนักมาก >20
export const intensity = (mm) => (mm > 20 ? 4 : mm > 7.5 ? 3 : mm > 2.5 ? 2 : mm >= 0.1 ? 1 : 0);
export const LEVEL_LABEL = ["ไม่มีฝน", "ฝนเล็กน้อย", "ฝนปานกลาง", "ฝนหนัก", "ฝนหนักมาก"];

/**
 * หาช่วงฝนตกจากอนุกรมรายชั่วโมง
 * @param {string[]} time  "YYYY-MM-DDTHH:00" เวลาไทย
 * @param {number[]} mm    ฝนรายชั่วโมง
 * @param {number[]} [prob] โอกาสเกิดฝน %
 * @param {number} nowMs    ตัดช่วงที่จบไปแล้ว
 * @returns {{d:string,s:number,e:number,pk:number,pmm:number,tot:number,pr:number,lv:number}[]}
 *   d = วันที่เริ่ม, s/e/pk = ชั่วโมงเริ่ม/ชั่วโมงสุดท้าย/ชั่วโมงหนักสุด นับจากเที่ยงคืนของวันเริ่ม (e อาจเกิน 23 ถ้าข้ามคืน)
 */
export function findPeriods(time, mm, prob, nowMs = Date.now()) {
  const n = time.length;
  const wet = (i) => (mm[i] ?? 0) >= 0.5;
  const out = [];
  let i = 0;
  while (i < n) {
    if (!wet(i)) { i++; continue; }
    let j = i, gap = 0, last = i;
    while (j + 1 < n) {
      if (wet(j + 1)) { last = j + 1; gap = 0; j++; }
      else if (gap < 1 && j + 2 < n && wet(j + 2)) { gap++; j++; }
      else break;
    }
    const idx = [];
    for (let k = i; k <= last; k++) idx.push(k);
    const endMs = Date.parse(time[last] + ":00+07:00") + HOUR;
    if (endMs > nowMs) {
      const tot = idx.reduce((t, k) => t + (mm[k] ?? 0), 0);
      const pr = prob ? Math.max(...idx.map((k) => prob[k] ?? 0)) : null;
      const pkI = idx.reduce((a, k) => ((mm[k] ?? 0) > (mm[a] ?? 0) ? k : a), i);
      // ตัดช่วงที่อ่อนมากหรือไม่แน่นอน
      if (tot >= 1.5 && (pr === null || pr >= 30)) {
        const d = time[i].slice(0, 10);
        const base = Date.parse(d + "T00:00:00+07:00");
        const hr = (k) => Math.round((Date.parse(time[k] + ":00+07:00") - base) / HOUR);
        out.push({ d, s: hr(i), e: hr(last), pk: hr(pkI), pmm: Math.round(mm[pkI] * 10) / 10, tot: Math.round(tot * 10) / 10, pr, lv: intensity(mm[pkI]) });
      }
    }
    i = last + 1;
  }
  return out;
}

/** เวลา (ms) ของชั่วโมงที่ h ในวัน d */
export const hourMs = (d, h) => Date.parse(d + "T00:00:00+07:00") + h * HOUR;
export const fmtHour = (h) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;

// รูปแบบไฟล์ alerts.json แบบกะทัดรัด: แถวละ [จังหวัด, ลำดับอำเภอ, ลำดับวัน, s, e, pk, pmm, tot, pr]
export function packRows(prov, distIdx, periods, dates) {
  return periods.filter((p) => dates.includes(p.d)).map((p) => [prov, distIdx, dates.indexOf(p.d), p.s, p.e, p.pk, p.pmm, p.tot, p.pr ?? -1]);
}
export function unpackRow(r, dates) {
  return { p: r[0], di: r[1], d: dates[r[2]], s: r[3], e: r[4], pk: r[5], pmm: r[6], tot: r[7], pr: r[8] < 0 ? null : r[8], lv: intensity(r[6]) };
}
