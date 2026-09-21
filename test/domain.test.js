import test from "node:test";
import assert from "node:assert/strict";
import { zonedHourKey, exposureHours, parseInstant, hourKeyToMs } from "../src/domain/time.js";
import { DEFAULT_POLICY, tierFor, effectiveThresholds, classify } from "../src/domain/policy.js";
import { evaluateWeather } from "../src/domain/evaluate.js";

const T = (s) => Date.parse(s);

test("小时桶按俱乐部时区对齐，跨午夜行程天然连续", () => {
  assert.equal(zonedHourKey(T("2026-10-04T00:30:00+08:00")), "2026-10-04T00:00+08:00");
  assert.equal(zonedHourKey(T("2026-10-03T16:30:00Z")), "2026-10-04T00:00+08:00");
  const hours = exposureHours(T("2026-10-04T23:00:00+08:00"), T("2026-10-05T02:00:00+08:00"));
  assert.deepEqual(hours, [
    "2026-10-04T23:00+08:00",
    "2026-10-05T00:00+08:00",
    "2026-10-05T01:00+08:00",
  ]);
  // 桶键可还原为同一时刻
  assert.equal(hourKeyToMs("2026-10-05T00:00+08:00"), T("2026-10-05T00:00:00+08:00"));
});

test("拒绝不带时区偏移的时间", () => {
  assert.throws(() => parseInstant("2026-10-04T00:00:00"), /时区偏移/);
});

test("海拔分级：2680m 走高海拔阈值，1620m 走中海拔阈值", () => {
  assert.equal(tierFor(DEFAULT_POLICY, "windGustKph", 2680).noGoAt, 70);
  assert.equal(tierFor(DEFAULT_POLICY, "windGustKph", 1620).noGoAt, 83);
  assert.equal(tierFor(DEFAULT_POLICY, "windGustKph", 500).noGoAt, 100);
});

test("阵风 72 在高海拔路段达到 NO_GO，低海拔路段仅 CAUTION", () => {
  const spec = DEFAULT_POLICY.measures.windGustKph;
  assert.equal(classify(spec, tierFor(DEFAULT_POLICY, "windGustKph", 2680), 72), "NO_GO");
  assert.equal(classify(spec, tierFor(DEFAULT_POLICY, "windGustKph", 1620), 72), "CAUTION");
});

test("能见度越低越糟；180m 在高海拔为 NO_GO", () => {
  const spec = DEFAULT_POLICY.measures.visibilityM;
  assert.equal(classify(spec, tierFor(DEFAULT_POLICY, "visibilityM", 2680), 180), "NO_GO");
  assert.equal(classify(spec, tierFor(DEFAULT_POLICY, "visibilityM", 2680), 300), "CAUTION");
  assert.equal(classify(spec, tierFor(DEFAULT_POLICY, "visibilityM", 2680), 2000), "GO");
});

test("成员耐受收紧阈值：阵风个人上限 60 则 65 对该队即 NO_GO", () => {
  const th = effectiveThresholds(DEFAULT_POLICY, [{ memberId: "m1", tolerances: { windGustKph: 60 } }], "windGustKph", 2680);
  assert.equal(th.noGoAt, 60);
  assert.deepEqual(th.constrainedBy.map((c) => c.memberId), ["m1"]);
});

test("成员能见度下限更高时同步收紧", () => {
  const th = effectiveThresholds(DEFAULT_POLICY, [{ memberId: "m1", tolerances: { visibilityM: 800 } }], "visibilityM", 2680);
  assert.equal(th.cautionAt, 800);
});

function fixtureTrip() {
  return {
    tripId: "t1",
    members: [],
    itinerary: [
      { segmentId: "low", enterAt: "2026-10-04T02:00:00+08:00", leaveAt: "2026-10-04T04:00:00+08:00" },
      { segmentId: "high", enterAt: "2026-10-04T04:00:00+08:00", leaveAt: "2026-10-04T06:00:00+08:00" },
    ],
  };
}
const route = {
  routeId: "r1",
  segments: [
    { segmentId: "low", name: "低", maxElevM: 1620 },
    { segmentId: "high", name: "高", maxElevM: 2680 },
  ],
};
const hourly = (measure, v, hs = ["02", "03", "04", "05"]) =>
  Object.fromEntries(hs.map((h) => [`2026-10-04T${h}:00:00+08:00`, v]));
const ev = (over = {}) => ({
  eventId: "e1", source: "s1", routeId: "r1", revision: 1,
  issuedAt: "2026-10-03T18:00:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
  values: {}, ...over,
});

test("缺测：覆盖窗口内没有任何值的要素按 NO_GO 并列出 dataGaps", () => {
  const r = evaluateWeather({
    trip: fixtureTrip(), route, events: [ev({ values: { windGustKph: hourly("windGustKph", 40) } })],
    policy: DEFAULT_POLICY, cutoffMs: T("2026-10-03T19:00:00+08:00"),
  });
  assert.equal(r.overallLevel, "NO_GO");
  assert.ok(r.dataGaps.some((g) => g.measure === "visibilityM" && g.segmentId === "high"));
});

test("来源矛盾：差值超容差时记录冲突并采用更危险一侧（风取高、能见度取低）", () => {
  const events = [
    ev({ eventId: "a", source: "s1", values: { windGustKph: hourly("w", 60), visibilityM: hourly("v", 1000) } }),
    ev({ eventId: "b", source: "s2", revision: 2, values: { windGustKph: hourly("w", 80), visibilityM: hourly("v", 150) } }),
  ];
  const r = evaluateWeather({
    trip: fixtureTrip(), route, events, policy: DEFAULT_POLICY,
    cutoffMs: T("2026-10-03T19:00:00+08:00"),
  });
  assert.ok(r.conflicts.some((c) => c.measure === "windGustKph" && c.adopted.source === "s2"));
  assert.ok(r.conflicts.some((c) => c.measure === "visibilityM" && c.adopted.source === "s2"));
  const high = r.segments.find((s) => s.segmentId === "high");
  assert.equal(high.measures.visibilityM.hours[0].adopted.value, 150);
});

test("同来源只取最高 revision：旧版本被新版本取代", () => {
  const events = [
    ev({ eventId: "a1", revision: 1, values: { windGustKph: hourly("w", 90), visibilityM: hourly("v", 2000) } }),
    ev({ eventId: "a2", revision: 2, values: { windGustKph: hourly("w", 30), visibilityM: hourly("v", 2000) } }),
  ];
  const r = evaluateWeather({
    trip: fixtureTrip(), route, events, policy: DEFAULT_POLICY,
    cutoffMs: T("2026-10-03T19:00:00+08:00"),
  });
  const high = r.segments.find((s) => s.segmentId === "high");
  assert.equal(high.measures.windGustKph.hours[0].adopted.eventId, "a2");
});

test("cutoff 之后发布的预报不参与计算（重算可重复）", () => {
  const events = [
    ev({ eventId: "late", issuedAt: "2026-10-04T01:00:00+08:00", values: { windGustKph: hourly("w", 95), visibilityM: hourly("v", 2000) } }),
  ];
  const r = evaluateWeather({
    trip: fixtureTrip(), route, events, policy: DEFAULT_POLICY,
    cutoffMs: T("2026-10-03T19:00:00+08:00"),
  });
  // 95 不可见，风要素整体缺测 -> NO_GO 来自缺测而非阈值
  assert.ok(r.forecastVersions.every((f) => f.adopted === false));
});

test("标量窗口降水按暴露比例分摊为窗口累计量", () => {
  const events = [ev({ values: { windGustKph: hourly("w", 40), visibilityM: hourly("v", 2000), precipitationMm: 12 } })];
  const r = evaluateWeather({
    trip: fixtureTrip(), route, events, policy: DEFAULT_POLICY,
    cutoffMs: T("2026-10-03T19:00:00+08:00"),
  });
  // 窗口 12h，每段暴露 2h -> 每段分摊 2mm，高海拔 2mm 为 GO
  const high = r.segments.find((s) => s.segmentId === "high");
  assert.equal(high.measures.precipitationMm.windowValue, 2);
  assert.equal(r.overallLevel, "GO");
});

test("评估结果对输入确定性：同一输入两次 contentHash 相同；输入变则哈希变", () => {
  const events = [ev({ values: { windGustKph: hourly("w", 40), visibilityM: hourly("v", 2000) } })];
  const args = { trip: fixtureTrip(), route, events, policy: DEFAULT_POLICY, cutoffMs: T("2026-10-03T19:00:00+08:00") };
  assert.equal(evaluateWeather(args).contentHash, evaluateWeather({ ...args }).contentHash);
  const worse = evaluateWeather({ ...args, events: [ev({ eventId: "e2", revision: 2, values: { windGustKph: hourly("w", 90), visibilityM: hourly("v", 2000) } })] });
  assert.notEqual(worse.contentHash, evaluateWeather(args).contentHash);
});
