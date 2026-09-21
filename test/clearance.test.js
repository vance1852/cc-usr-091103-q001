import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClearanceService } from "../src/service/clearance-service.js";
import { EventStore } from "../src/store/event-store.js";
import { DEFAULT_POLICY } from "../src/domain/policy.js";

const hours = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];
const hourly = (v) => Object.fromEntries(hours.map((h) => [`2026-10-04T${h}:00:00+08:00`, v]));

const ROUTE = {
  routeId: "r1",
  name: "测试脊线",
  rangerStation: "测试站", // 扩展字段
  segments: [
    { segmentId: "low", name: "低", maxElevM: 1620, terrainClass: "B2" },
    { segmentId: "high", name: "高", maxElevM: 2680, exposedRidge: true },
  ],
};
const itinerary = () => [
  { segmentId: "low", enterAt: "2026-10-04T03:00:00+08:00", leaveAt: "2026-10-04T05:00:00+08:00" },
  { segmentId: "high", enterAt: "2026-10-04T05:00:00+08:00", leaveAt: "2026-10-04T08:00:00+08:00" },
];
const mild = (id, rev = 1, over = {}) => ({
  eventId: id, source: "regional-observatory", routeId: "r1", revision: rev,
  issuedAt: over.issuedAt ?? "2026-10-03T06:30:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
  values: { windGustKph: hourly(40), visibilityM: hourly(2200), precipitationMm: hourly(0.2) },
  bulletinCode: "CW-TEST", // 扩展字段
  ...over,
});
const severe = (id, rev, issuedAt = "2026-10-03T18:20:00+08:00") =>
  mild(id, rev, { issuedAt, values: { windGustKph: hourly(72), visibilityM: hourly(180), precipitationMm: 16 } });

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "clearance-"));
  const file = join(dir, "events.jsonl");
  let clock = "2026-10-03T06:00:00+08:00";
  const notifications = [];
  const make = async () => {
    const store = new EventStore(file, () => clock);
    const svc = new ClearanceService(store, {
      policy: DEFAULT_POLICY,
      clock: () => clock,
      notifier: (n) => { notifications.push(n); return { channel: "test", at: clock }; },
    });
    await svc.load();
    return svc;
  };
  let svc = await make();
  const tick = (t) => { clock = t; };
  const reopen = async () => { svc = await make(); return svc; };
  const lineCount = () => readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  return {
    dir, svc: () => svc, tick, reopen, notifications, file, lineCount,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("路线/行程/成员/预报的未知扩展字段全部保留", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({
    tripId: "trip1", routeId: "r1", leaderId: "L1", plannedStartAt: "2026-10-04T03:00:00+08:00",
    members: [{ memberId: "m1", name: "甲", tolerances: {}, emergencyContact: "110" }],
    itinerary: itinerary(), transport: "包车",
  });
  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.attributes.transport, "包车");
  assert.equal(trip.members[0].attributes.emergencyContact, "110");
  const audit = h.svc().auditTrail("trip1");
  const routeRec = audit.find((e) => e.type === "RouteRegistered").payload;
  assert.equal(routeRec.attributes.rangerStation, "测试站");
  assert.equal(routeRec.segments[0].attributes.terrainClass, "B2");
  const fcRec = JSON.parse(readFileSync(h.file, "utf8").split("\n").filter(Boolean).find((l) => l.includes("ForecastIngested")));
  assert.equal(fcRec.payload.envelope.attributes.bulletinCode, "CW-TEST");
});

test("更正预报到达：未出发队伍产生新版本 NO_GO，旧结论不可变且可追溯", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  const v1 = h.svc().getTrip("trip1").currentDecision;
  assert.equal(v1.decision, "GO");

  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3));
  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.currentDecision.version, 2);
  assert.equal(trip.currentDecision.decision, "NO_GO");
  assert.ok(trip.currentDecision.triggeredSegments.includes("high"));
  assert.equal(trip.decisionVersions.length, 2);
  // v1 仍可取回，内容不变，supersedes 指向 v1
  const old = h.svc().getDecision(v1.decisionId);
  assert.equal(old.decision.decision, "GO");
  const v2 = h.svc().getDecision(trip.currentDecision.decisionId);
  assert.equal(v2.supersedes, v1.decisionId);
  // 采用预报版本明确：v2 采用 r3
  assert.deepEqual(v2.weather.forecastVersions.map((f) => [f.source, f.revision, f.adopted]), [
    ["regional-observatory", 1, false],
    ["regional-observatory", 3, true],
  ]);
});

test("已出发队伍：更正预报只追加风险升级与通知，原结论冻结不改写", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  const v1Id = h.svc().getTrip("trip1").currentDecision.decisionId;

  h.tick("2026-10-04T03:05:00+08:00");
  h.svc().checkIn("trip1");
  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3));

  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.frozenDepartureDecision.decisionId, v1Id);
  assert.equal(trip.frozenDepartureDecision.decision, "GO");
  assert.equal(trip.decisionVersions.length, 1, "已出发队伍不产生新结论版本");
  assert.equal(trip.escalations.length, 1);
  assert.equal(trip.escalations[0].newLevel, "NO_GO");
  assert.equal(trip.escalations[0].originalDecisionId, v1Id);
  assert.ok(trip.notifications.some((n) => n.content.kind === "RISK_ESCALATION"));
  // 不允许再重算已出发队伍
  assert.throws(() => h.svc().computeClearance("trip1"), /不可改写/);
});

test("风险没有变糟时不产生升级（只能升级，不能降级或改写）", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-04T03:05:00+08:00");
  h.svc().checkIn("trip1");
  h.tick("2026-10-03T19:00:00+08:00");
  h.svc().ingestForecast(mild("e2", 2, { issuedAt: "2026-10-03T18:55:00+08:00" }));
  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.escalations.length, 0);
});

test("重复投递幂等：结论 ID、版本号、contentHash 与事件数全部不变", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3));
  const before = h.svc().getTrip("trip1");
  const id = before.currentDecision.decisionId;
  const hash = before.currentDecision.contentHash;
  const eventsBefore = h.lineCount();

  const dup = h.svc().ingestForecast(severe("e3", 3)); // 同 eventId 再投
  assert.equal(dup.deduplicated, true);
  const after = h.svc().getTrip("trip1");
  assert.equal(after.currentDecision.decisionId, id);
  assert.equal(after.currentDecision.contentHash, hash);
  assert.equal(after.decisionVersions.length, 2);
  assert.equal(h.lineCount(), eventsBefore);
});

test("服务重启重放后：版本号、决策 ID、contentHash 完全一致", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-04T03:05:00+08:00");
  h.svc().checkIn("trip1");
  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3));
  const before = h.svc().getTrip("trip1");
  const snapshot = {
    versions: before.decisionVersions,
    frozen: before.frozenDepartureDecision.decisionId,
    escalations: before.escalations.map((e) => e.escalationId),
  };
  const eventsBefore = h.lineCount();

  await h.reopen(); // 模拟重启
  assert.equal(h.lineCount(), eventsBefore, "重放不产生任何新事件");
  const after = h.svc().getTrip("trip1");
  assert.deepEqual(after.decisionVersions, snapshot.versions);
  assert.equal(after.frozenDepartureDecision.decisionId, snapshot.frozen);
  assert.deepEqual(after.escalations.map((e) => e.escalationId), snapshot.escalations);
  // 重启后再来更正预报，版本号继续为 3（对另一支未出发队伍）
  h.svc().planTrip({ tripId: "trip2", routeId: "r1", leaderId: "L2", itinerary: itinerary() });
  const t2 = h.svc().getTrip("trip2");
  assert.equal(t2.currentDecision.version, 1);
  assert.equal(t2.currentDecision.decision, "NO_GO", "新队伍直接基于全部已知预报（含 r3）计算");
});

test("NO_GO / PENDING_REVIEW 下禁止签到出发", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3));
  assert.equal(h.svc().getTrip("trip1").currentDecision.decision, "NO_GO");
  assert.throws(() => h.svc().checkIn("trip1"), /NO_GO/);

  h.svc().planTrip({ tripId: "trip2", routeId: "r1", leaderId: "L2", itinerary: itinerary() });
  h.svc().requestReview("trip2", { reason: "有异议" });
  assert.equal(h.svc().getTrip("trip2").currentDecision.decision, "PENDING_REVIEW");
  assert.throws(() => h.svc().checkIn("trip2"), /人工复核/);
});

test("人工复核闭环（未出发）：挂起 -> 值班员裁定产生 MANUAL_OVERRIDE 版本", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-03T18:25:00+08:00");
  h.svc().ingestForecast(severe("e3", 3)); // v2 NO_GO
  h.svc().requestReview("trip1", { by: "L1", reason: "申请研判" }); // v3 PENDING
  assert.equal(h.svc().getTrip("trip1").currentDecision.decision, "PENDING_REVIEW");
  h.tick("2026-10-03T19:00:00+08:00");
  const res = h.svc().resolveReview("trip1", { verdict: "CONDITIONAL_GO", by: "officer", note: "走低海拔线" });
  assert.equal(res.decision.basis, "MANUAL_OVERRIDE");
  assert.equal(res.decision.decision.decision, "CONDITIONAL_GO");
  assert.equal(res.decision.version, 4);
  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.reviews[0].status, "RESOLVED");
  assert.equal(trip.currentDecision.decision, "CONDITIONAL_GO");
  // 自动结论 v2 仍留档，可追溯当时的气象证据哈希
  const v2 = h.svc().getDecision(trip.decisionVersions[1].decisionId);
  assert.ok(v2.weather.contentHash);
});

test("已出发队伍申请人工复核：不改结论，只记录与通知", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  h.svc().ingestForecast(mild("e1"));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  h.tick("2026-10-04T03:05:00+08:00");
  h.svc().checkIn("trip1");
  h.svc().requestReview("trip1", { reason: "途中天气转差，请求指令" });
  const trip = h.svc().getTrip("trip1");
  assert.equal(trip.decisionVersions.length, 1);
  assert.equal(trip.reviews[0].status, "OPEN");
  assert.ok(trip.notifications.some((n) => n.content.kind === "REVIEW_REQUESTED_DEPARTED"));
  h.svc().resolveReview("trip1", { verdict: "NO_GO", note: "立即折返" });
  const after = h.svc().getTrip("trip1");
  assert.equal(after.decisionVersions.length, 1, "裁定不产生放行版本");
  assert.equal(after.reviews[0].status, "RESOLVED");
});

test("缺测即 NO_GO 且列出具体路段/小时/要素", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  // 只给 03-05 时，high 路段 05-08 时缺测
  const partial = ["03", "04", "05"];
  h.svc().ingestForecast(mild("e1", 1, {
    values: {
      windGustKph: Object.fromEntries(partial.map((x) => [`2026-10-04T${x}:00:00+08:00`, 40])),
      visibilityM: Object.fromEntries(partial.map((x) => [`2026-10-04T${x}:00:00+08:00`, 2200])),
    },
  }));
  h.svc().planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: itinerary() });
  const d = h.svc().getTrip("trip1").currentDecision;
  assert.equal(d.decision, "NO_GO");
  const full = h.svc().getDecision(d.decisionId);
  assert.ok(full.weather.dataGaps.some((g) => g.segmentId === "high" && g.hour === "2026-10-04T07:00+08:00"));
});

test("逐时键拒绝不带时区偏移的写法（避免按服务器本地时区解析）", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  h.svc().registerRoute(ROUTE);
  assert.throws(
    () => h.svc().ingestForecast(mild("e1", 1, {
      values: { windGustKph: { "2026-10-04T03:00:00": 40 }, visibilityM: hourly(2200) },
    })),
    /时区偏移/,
  );
});
