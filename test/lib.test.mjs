import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWaterLevels, normalizeRain, normalizeDams, damProvince, provinceCode,
  mergeWaterHistory, mergeDamHistory, mergeRainHistory, parseThaiTime,
} from "../scripts/lib.mjs";

const NOW = Date.UTC(2026, 8, 27, 8, 0); // 15:00 เวลาไทย

test("แปลงเวลาไทยเป็น UTC", () => {
  assert.equal(parseThaiTime("2026-09-27 14:00"), Date.UTC(2026, 8, 27, 7, 0));
  assert.equal(parseThaiTime("0001-01-01 00:00"), null);
});

test("ระดับน้ำ: รูปแบบ waterlevel_data.data และตัดสถานีเก่า/พิกัดผิด", () => {
  const payload = {
    waterlevel_data: {
      data: [
        {
          id: 1, waterlevel_datetime: "2026-09-27 14:00", waterlevel_msl: "352.21",
          waterlevel_msl_previous: "352.18", storage_percent: "104.46", situation_level: 5,
          diff_wl_bank: "0.3", station: { id: 77, tele_station_name: { th: "สะพานนวรัฐ" },
            tele_station_lat: "18.79", tele_station_long: "99.00" },
          geocode: { province_name: { th: "เชียงใหม่" }, amphoe_name: { th: "เมือง" } },
          basin: { basin_name: { th: "ลุ่มน้ำปิง" } },
        },
        { id: 2, waterlevel_datetime: "2026-09-20 14:00", station: { tele_station_lat: 15, tele_station_long: 100 } },
        { id: 3, waterlevel_datetime: "2026-09-27 14:00", station: { tele_station_lat: 0, tele_station_long: 0 } },
      ],
    },
  };
  const out = normalizeWaterLevels(payload, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].p, 50);
  assert.equal(out[0].pct, 104.5);
  assert.equal(out[0].n, "สะพานนวรัฐ");
});

test("ฝน: สรุปรายจังหวัดและเก็บเฉพาะสถานีที่มีฝน", () => {
  const mk = (mm, prov) => ({
    rain_24h: mm, rainfall_datetime: "2026-09-27 14:00",
    station: { id: Math.random(), tele_station_lat: 14, tele_station_long: 100.5 },
    geocode: { province_name: { th: prov } },
  });
  const { stations, byProv } = normalizeRain({ data: [mk(0, "ลพบุรี"), mk(40, "ลพบุรี"), mk(12, "ลพบุรี")] }, NOW);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].mm, 40);
  assert.deepEqual(byProv[16], { n: 3, avg: 17.3, max: 40, wet: 2 });
});

test("เขื่อน: โครงสร้างของกรมชลประทาน", () => {
  const r = normalizeDams({
    date: "2026-09-27",
    data: [{ region: "ภาคเหนือ", dam: [{ id: "100105", name: "เขื่อนกี่วลม", capacity: 106.22, storage: 106.22,
      active_storage: 102.67, dead_storage: 3.55, volume: 90.45, percent_storage: 85.15, inflow: 2.282, outflow: 1.97 }] }],
  });
  assert.equal(r.dams[0].p, 52);
  assert.equal(r.dams[0].pct, 85.2);
  assert.equal(damProvince("เขื่อนภูมิพล"), 63);
});

test("ทุกเขื่อนในรายการจับคู่จังหวัดได้", () => {
  for (const n of ["เขื่อนสิริกิติ์", "เขื่อนป่าสักชลสิทธิ์", "เขื่อนวชิราลงกรณ", "เขื่อนบางลาง", "เขื่อนรัชชประภา"]) {
    assert.ok(damProvince(n) > 0, n);
  }
  assert.equal(provinceCode("จังหวัดขอนแก่น"), 40);
});

test("ประวัติระดับน้ำ: ไม่ซ้ำชั่วโมงเดิมและตัดของเก่า", () => {
  const h = { 50: { old: [[1, 1, 1]] } };
  const s = { id: "77", p: 50, t: NOW - 3600e3, msl: 10, pct: 50 };
  mergeWaterHistory(h, [s], NOW);
  mergeWaterHistory(h, [s], NOW);
  assert.equal(h[50]["77"].length, 1);
  assert.equal(h[50].old, undefined);
});

test("ประวัติเขื่อนและฝน", () => {
  const dh = mergeDamHistory({}, { date: "2026-09-27", dams: [{ id: "1", v: 5, pct: 50, in: 1, out: 2 }] });
  mergeDamHistory(dh, { date: "2026-09-27", dams: [{ id: "1", v: 6, pct: 60, in: 1, out: 2 }] });
  assert.deepEqual(dh["1"], [["2026-09-27", 6, 60, 1, 2]]);

  const early = Date.UTC(2026, 8, 26, 23, 0); // 06:00 ไทย → ยังไม่บันทึก
  assert.deepEqual(mergeRainHistory({}, { 10: { avg: 1, max: 2, wet: 1, n: 3 } }, early), {});
  const rh = mergeRainHistory({}, { 10: { avg: 1, max: 2, wet: 1, n: 3 } }, NOW);
  assert.deepEqual(rh["2026-09-27"], { 10: [1, 2, 1, 3] });
});
