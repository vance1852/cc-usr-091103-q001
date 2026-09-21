import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrip } from "../src/domain/evaluator.js";
import { ingestRevision } from "../src/domain/forecast.js";

const ROUTE = {
  routeId: "r1",
  segments: [
    {
      segmentId: "seg-low",
      plannedStart: "2026-10-04T02:00:00+08:00",
      plannedEnd: "2026-10-04T06:00:00+08:00",
      limits: { windGustKph: 70, visibilityM: 100 },
    },
    {
      segmentId: "seg-high",
      plannedStart: "2026-10-04T06:00:00+08:00",
      plannedEnd: "2026-10-04T10:00:00+08:00",
      limits: { windGustKph: 60, visibilityM: 200, precipitationMm: 10 },
    },
  ],
};

function rev(source, revision, values, extra = {}) {
  return ingestRevision({
    eventId: `${source}-${revision}`,
    source,
    routeId: "r1",
    revision,
    issuedAt: `2026-10-03T1${revision}:00:00+08:00`,
    validFrom: "2026-10-04T00:00:00+08:00",
    validTo: "2026-10-04T12:00:00+08:00",
    values,
    ...extra,
  });
}

const SAFE = { windGustKph: 40, visibilityM: 5000, precipitationMm: 1 };

test("全部来源在限制内时放行 GO", () => {
  const result = evaluateTrip({ route: ROUTE, members: [], revisions: [rev("obs", 1, SAFE)] });
  assert.equal(result.status, "GO");
  assert.deepEqual(result.triggeredSegmentIds, []);
});

test("所有来源一致超限 → HOLD，并给出触发路段与最坏值", () => {
  const result = evaluateTrip({
    route: ROUTE, members: [],
    revisions: [
      rev("obs", 1, { ...SAFE, windGustKph: 62 }),
      rev("post", 1, { ...SAFE, windGustKph: 63 }),
    ],
  });
  assert.equal(result.status, "HOLD");
  assert.deepEqual(result.triggeredSegmentIds, ["seg-high"]);
  const r = result.restrictions.find((x) => x.factor === "windGustKph");
  assert.equal(r.breach, "CONSISTENT_BREACH");
  assert.equal(r.bound, 60);
  assert.equal(r.worstValue, 63);
});

test("来源相互矛盾且保守包络超限 → MANUAL_REVIEW / MIXED_BREACH", () => {
  const result = evaluateTrip({
    route: ROUTE, members: [],
    revisions: [
      rev("obs", 1, { ...SAFE, windGustKph: 50 }),
      rev("post", 1, { ...SAFE, windGustKph: 72 }),
    ],
  });
  assert.equal(result.status, "MANUAL_REVIEW");
  const r = result.restrictions.find((x) => x.factor === "windGustKph");
  assert.equal(r.breach, "MIXED_BREACH");
  assert.equal(r.worstValue, 72);
});

test("来源分歧但均在限制内 → 仍是 GO，仅保留矛盾提示", () => {
  const result = evaluateTrip({
    route: ROUTE, members: [],
    revisions: [
      rev("obs", 1, { ...SAFE, windGustKph: 30 }),
      rev("post", 1, { ...SAFE, windGustKph: 50 }),
    ],
  });
  assert.equal(result.status, "GO");
  assert.equal(result.advisories.some((a) => a.type === "SOURCE_CONFLICT" && a.factor === "windGustKph"), true);
});

test("受约束因子缺测（含整窗无来源覆盖）→ MANUAL_REVIEW / DATA_GAP", () => {
  const result = evaluateTrip({
    route: ROUTE, members: [],
    revisions: [rev("obs", 1, { windGustKph: 40, visibilityM: null, precipitationMm: 1 })],
  });
  assert.equal(result.status, "MANUAL_REVIEW");
  const gaps = result.restrictions.filter((r) => r.breach === "DATA_GAP" && r.factor === "visibilityM");
  assert.equal(gaps.length, 2); // 两个路段的能见度都缺测
  assert.ok(gaps.every((g) => g.hours.length > 0));
});

test("逐时值：只在某个越界小时槽触发，跨午夜窗口正常按小时展开", () => {
  const midnightRoute = {
    routeId: "r2",
    segments: [{
      segmentId: "seg-night",
      plannedStart: "2026-10-04T22:00:00+08:00",
      plannedEnd: "2026-10-05T02:00:00+08:00",
      limits: { windGustKph: 60 },
    }],
  };
  const r = ingestRevision({
    eventId: "obs-h", source: "obs", routeId: "r2", revision: 1,
    issuedAt: "2026-10-04T20:00:00+08:00",
    validFrom: "2026-10-04T20:00:00+08:00",
    validTo: "2026-10-05T04:00:00+08:00",
    values: {
      windGustKph: {
        "2026-10-04T22:00:00+08:00": 40,
        "2026-10-04T23:00:00+08:00": 55,
        "2026-10-05T00:00:00+08:00": 70,
        "2026-10-05T01:00:00+08:00": 50,
      },
    },
  });
  const result = evaluateTrip({ route: midnightRoute, members: [], revisions: [r] });
  assert.equal(result.status, "HOLD");
  assert.equal(result.restrictions[0].hours.length, 1);
  assert.equal(result.restrictions[0].hours[0].hour, "2026-10-04T16:00:00.000Z"); // 05 日 00:00 +08
});

test("成员耐受比路段更严格时按成员阈值约束", () => {
  const members = [{ memberId: "m1", tolerance: { windGustKph: { max: 50 } } }];
  const result = evaluateTrip({
    route: ROUTE, members,
    revisions: [rev("obs", 1, { ...SAFE, windGustKph: 55 })],
  });
  assert.equal(result.status, "HOLD");
  assert.equal(result.restrictions[0].bound, 50);
  assert.deepEqual(result.restrictions[0].boundSources, ["m1"]);
});

test("同一来源高版本修订覆盖低版本", () => {
  const r1 = rev("obs", 1, { ...SAFE, windGustKph: 40 });
  const r2 = rev("obs", 2, { ...SAFE, windGustKph: 72 });
  const result = evaluateTrip({ route: ROUTE, members: [], revisions: [r1, r2] });
  assert.equal(result.status, "HOLD");
  const slot = result.restrictions[0].hours[0];
  assert.deepEqual(slot.observed.map((o) => o.revision), [2]);
});

test("评估是纯函数：相同输入两次计算逐字节一致", () => {
  const input = {
    route: ROUTE, members: [{ memberId: "m1", tolerance: { visibilityM: { min: 300 } } }],
    revisions: [rev("obs", 1, SAFE), rev("post", 1, { ...SAFE, visibilityM: 250 })],
  };
  const a = evaluateTrip(structuredClone(input));
  const b = evaluateTrip(structuredClone(input));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
