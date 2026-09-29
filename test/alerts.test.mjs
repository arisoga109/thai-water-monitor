import { test } from "node:test";
import assert from "node:assert/strict";
import { findPeriods, packRows, unpackRow, intensity } from "../site/alerts.js";

const day = "2026-10-01";
const time = Array.from({ length: 48 }, (_, h) => `${h < 24 ? day : "2026-10-02"}T${String(h % 24).padStart(2, "0")}:00`);
const early = Date.parse("2026-10-01T00:00:00+07:00");

test("แยกช่วงฝน: เว้น 1 ชม.ยังนับเป็นช่วงเดียว เว้น 2 ชม.แยกช่วง", () => {
  const mm = new Array(48).fill(0);
  mm[13] = 1; mm[14] = 3; mm[15] = 0; mm[16] = 2;   // 13–16 (เว้น 15)
  mm[19] = 1; mm[20] = 1;                           // 19–20 แยก
  const prob = new Array(48).fill(80);
  const ps = findPeriods(time, mm, prob, early);
  assert.equal(ps.length, 2);
  assert.deepEqual([ps[0].s, ps[0].e, ps[0].pk, ps[0].lv], [13, 16, 14, 2]);
  assert.deepEqual([ps[1].s, ps[1].e], [19, 20]);
});

test("ตัดช่วงที่จบไปแล้ว และช่วงอ่อน/โอกาสต่ำ", () => {
  const mm = new Array(48).fill(0);
  mm[2] = 5; mm[3] = 5;          // จบไปแล้ว
  mm[10] = 0.6;                  // รวม < 1.5
  mm[30] = 4; mm[31] = 4;        // ข้ามไปวันถัดไป
  const prob = new Array(48).fill(60); prob[30] = prob[31] = 20; // โอกาสต่ำ → ตัด
  const now = Date.parse("2026-10-01T08:00:00+07:00");
  assert.equal(findPeriods(time, mm, prob, now).length, 0);
  prob[30] = 70;
  const ps = findPeriods(time, mm, prob, now);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].d, "2026-10-02");
  assert.equal(ps[0].s, 6);
});

test("ช่วงข้ามเที่ยงคืนนับชั่วโมงต่อเนื่อง และแพ็ก/แกะไฟล์ได้ตรง", () => {
  const mm = new Array(48).fill(0);
  mm[22] = 3; mm[23] = 9; mm[24] = 2;
  const [p] = findPeriods(time, mm, null, early);
  assert.deepEqual([p.d, p.s, p.e, p.pk, p.lv], [day, 22, 24, 23, 3]);
  const rows = packRows(50, 7, [p], [day, "2026-10-02"]);
  const u = unpackRow(rows[0], [day, "2026-10-02"]);
  assert.equal(u.p, 50); assert.equal(u.di, 7); assert.equal(u.e, 24); assert.equal(u.pr, null);
  assert.equal(intensity(25), 4);
});
