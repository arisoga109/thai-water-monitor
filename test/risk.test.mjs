import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClimatology, assessRisk, pctRank, binOf, anomalyText, FALLBACK_CLIM } from "../site/risk.js";

// อนุกรมฝนจำลอง 10 ปี: ฤดูฝน (พ.ค.–ต.ค.) ฝนตกบ่อย หน้าแล้งแทบไม่มี
function synthYears(dryProvince = false) {
  const dates = [], p = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = Date.UTC(2015, 0, 1); t <= Date.UTC(2024, 11, 31); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10);
    const m = +d.slice(5, 7);
    const wet = m >= 5 && m <= 10;
    const scaleMm = dryProvince ? 6 : 18;
    dates.push(d);
    p.push(wet && rnd() < 0.55 ? Math.round(-Math.log(rnd()) * scaleMm * 10) / 10 : rnd() < 0.05 ? 2 : 0);
  }
  return { dates, p };
}

test("ช่องครึ่งเดือนและเปอร์เซ็นไทล์", () => {
  assert.equal(binOf("2026-01-01"), 0);
  assert.equal(binOf("2026-09-28"), 17);
  const k = [10, 20, 40, 50, 80, 100];
  assert.equal(pctRank(10, k), 50);
  assert.equal(pctRank(30, k), 82.5);
  assert.equal(pctRank(150, k), 150);
  assert.equal(pctRank(0, k), 0);
});

test("ค่าปกติ: ฤดูฝนมากกว่าหน้าแล้ง และเปอร์เซ็นไทล์เรียงจากน้อยไปมาก", () => {
  const { dates, p } = synthYears();
  const c = buildClimatology(dates, p);
  assert.equal(c.d7.length, 24);
  const sep = c.d7[17], jan = c.d7[0];
  assert.ok(sep[2] > jan[2] * 5, `${sep} vs ${jan}`);
  for (const row of c.d3) for (let i = 1; i < row.length; i++) assert.ok(row[i] >= row[i - 1]);
  assert.ok(c.heavy[17] > c.heavy[0]);
});

function series(pastDaily, futureDaily) {
  const n = 30 + 8;
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 8, 28) + (i - 30) * 864e5).toISOString().slice(0, 10));
  const base = [...Array(30).fill(pastDaily), ...futureDaily];
  return { dates, today: 30, models: { a: base, b: base.map((x) => x * 1.1), c: base.map((x) => x * 0.9) } };
}

test("จังหวัดที่ปกติฝนน้อย: ฝนหนักเท่ากันถือว่าผิดปกติกว่าจังหวัดฝนชุก", () => {
  const dry = buildClimatology(...Object.values(synthYears(true)));
  const wet = buildClimatology(...Object.values(synthYears(false)));
  const s = series(2, [60, 70, 50, 10, 0, 0, 0, 0]);
  const rDry = assessRisk({ ...s, clim: dry });
  const rWet = assessRisk({ ...s, clim: wet });
  assert.ok(rDry.anomaly > rWet.anomaly, `${rDry.anomaly} vs ${rWet.anomaly}`);
  assert.ok(rDry.score > rWet.score);
  assert.equal(rDry.onset, true); // แห้งมาก่อน แล้วฝนหนักฉับพลัน
  assert.equal(rDry.firstHeavy.inDays, 0);
  assert.equal(rDry.agree, 3);
});

test("ฝนหนักต่อเนื่องหลายวัน + ดินอิ่มน้ำ ได้คะแนนสูงกว่าฝนวันเดียว", () => {
  const clim = buildClimatology(...Object.values(synthYears()));
  const oneDay = assessRisk({ ...series(3, [80, 0, 0, 0, 0, 0, 0, 0]), clim });
  const s = series(3, [60, 60, 60, 50, 0, 0, 0, 0]);
  s.models = Object.fromEntries(Object.entries(s.models).map(([k, a]) => [k, a.map((x, i) => (i >= 25 && i < 30 ? 55 : x))]));
  const multi = assessRisk({ ...s, clim });
  assert.ok(multi.run.len >= 5, JSON.stringify(multi.run));
  assert.ok(multi.s.soil > oneDay.s.soil);
  assert.ok(multi.score > oneDay.score + 15, `${multi.score} vs ${oneDay.score}`);
  assert.equal(multi.onset, false);
});

test("หน้าแล้ง: ฝนเล็กน้อยอาจผิดปกติ แต่ไม่ถูกจัดว่าเสี่ยง", () => {
  const clim = buildClimatology(...Object.values(synthYears()));
  const s = series(0, [8, 6, 0, 0, 0, 0, 0, 0]);
  s.dates = s.dates.map((d) => d.replace("2026-09", "2026-01").replace("2026-08", "2025-12"));
  const r = assessRisk({ ...s, clim });
  assert.ok(r.score < 25, String(r.score));
});

test("ไม่มีค่าปกติ ใช้เกณฑ์สำรอง และระบุว่าใช้เกณฑ์สำรอง", () => {
  const r = assessRisk({ ...series(5, [40, 40, 40, 0, 0, 0, 0, 0]), clim: null });
  assert.equal(r.fallback, true);
  assert.ok(r.pct.f3 > 90);
  assert.ok(FALLBACK_CLIM.d3.length === 6);
  assert.match(anomalyText(99.5), /1 ใน 100/);
});

test("แม่น้ำล้นตลิ่งช่วยเพิ่มคะแนน", () => {
  const clim = buildClimatology(...Object.values(synthYears()));
  const s = series(5, [20, 20, 10, 0, 0, 0, 0, 0]);
  const a = assessRisk({ ...s, clim });
  const b = assessRisk({ ...s, clim, river: { n: 6, high: 2, over: 2, rising: 3 } });
  assert.ok(b.score > a.score);
});
