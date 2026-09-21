import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.js";
import { createDecisionService } from "../src/service/decision-service.js";

const ROUTE = {
  routeId: "ridge-1",
  segments: [{
    segmentId: "seg-high",
    plannedStart: "2026-10-04T06:00:00+08:00",
    plannedEnd: "2026-10-04T10:00:00+08:00",
    limits: { windGustKph: 60, visibilityM: 200, precipitationMm: 10 },
  }],
};

function forecast(revision, values, extra = {}) {
  return {
    eventId: `wx-${revision}`,
    source: extra.source ?? "regional-observatory",
    routeId: "ridge-1",
    revision,
    issuedAt: `2026-10-03T1${revision}:00:00+08:00`,
    validFrom: "2026-10-04T00:00:00+08:00",
    validTo: "2026-10-04T12:00:00+08:00",
    values,
    bulletinCode: `CW-${revision}`,
    ...extra,
  };
}

const SAFE = { windGustKph: 40, visibilityM: 5000, precipitationMm: 1 };

async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "trail-decision-"));
  let t = 1_759_000_000_000;
  const db = await openDb(dir);
  const svc = createDecisionService(db, () => (t += 1000));
  await svc.putRoute(ROUTE);
  await svc.putMember({ memberId: "m1", name: "林领队", tolerance: { windGustKph: { max: 70 } } });
  return {
    dir,
    svc,
    async reopen() {
      const db2 = await openDb(dir);
      return createDecisionService(db2, () => (t += 1000));
    },
    async cleanup() { await rm(dir, { recursive: true, force: true }); },
  };
}

test("更正预报到达：未出发行程自动重算并保留完整版本链与依据", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    const trip = await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    assert.equal(trip.automatedStatus, "GO");

    // 第二来源与第一来源矛盾且保守包络超限 → 人工复核
    await h.svc.ingestForecast(forecast(2, { ...SAFE, windGustKph: 72 }, { source: "alpine-post", eventId: "wx-alt-2" }));
    const v2 = await h.svc.getTrip(trip.tripId);
    assert.equal(v2.sequence, 2);
    assert.equal(v2.automatedStatus, "MANUAL_REVIEW");
    assert.equal(v2.supersedes, trip.versionId);
    assert.equal(v2.forecastBasis.usedEventIds.includes("wx-alt-2"), true);
    assert.deepEqual(v2.triggeredSegmentIds, ["seg-high"]);

    // 同来源的更正版本也确认超限 → HOLD
    await h.svc.ingestForecast(forecast(3, { ...SAFE, windGustKph: 75 }, { eventId: "wx-3" }));
    const v3 = await h.svc.getTrip(trip.tripId);
    assert.equal(v3.automatedStatus, "HOLD");
    assert.equal(v3.sequence, 3);

    // 旧版本仍可查，且标记被谁取代；旧结论内容未被改写
    const oldV1 = await h.svc.getVersion(trip.versionId);
    assert.equal(oldV1.automatedStatus, "GO");
    assert.equal(oldV1.superseded, true);
    assert.equal(oldV1.supersededBy, v2.versionId);

    // 采用了哪个预报版本可逐格核对
    const versions = await h.svc.listVersions(trip.tripId);
    assert.deepEqual(versions.map((v) => v.versionId), [trip.versionId, v2.versionId, v3.versionId]);
    assert.ok(v3.forecastBasis.bySlot.every((s) => s.eventId === "wx-3" || s.source === "alpine-post"));

    // 重放校验
    const verify = await h.svc.verifyVersion(v3.versionId);
    assert.equal(verify.replayMatchesStored, true);
    assert.equal(verify.fingerprintMatches, true);
  } finally { await h.cleanup(); }
});

test("重复投递同一修订不产生新版本；幂等键重放同一响应，异体冲突 409", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    const trip = await h.svc.createTrip({ tripId: "t-fixed", routeId: "ridge-1", memberIds: ["m1"] });

    const again = await h.svc.ingestForecast(forecast(1, SAFE));
    assert.equal(again.duplicate, true);
    const stillV1 = await h.svc.getTrip("t-fixed");
    assert.equal(stillV1.versionId, trip.versionId);

    const r1 = await h.svc.createTrip({ tripId: "idem-1", routeId: "ridge-1", memberIds: ["m1"] }, { idempotencyKey: "k-1" });
    const r2 = await h.svc.createTrip({ tripId: "idem-1", routeId: "ridge-1", memberIds: ["m1"] }, { idempotencyKey: "k-1" });
    assert.equal(r1.versionId, r2.versionId);

    await assert.rejects(
      h.svc.createTrip({ tripId: "idem-2", routeId: "ridge-1", memberIds: ["m1"] }, { idempotencyKey: "k-1" }),
      (err) => err.status === 409 && err.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally { await h.cleanup(); }
});

test("出发后：更差预报只追加风险升级和领队通知，原结论保持不变", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, { ...SAFE, windGustKph: 45 }));
    const trip = await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    assert.equal(trip.automatedStatus, "GO");
    await h.svc.checkIn(trip.tripId, { by: "林领队", at: "2026-10-04T05:30:00+08:00" });

    // 出发后冷锋确认：先矛盾（HIGH），后两来源一致严重超限（CRITICAL）
    await h.svc.ingestForecast(forecast(2, { ...SAFE, windGustKph: 95 }, { source: "alpine-post", eventId: "wx-alt-2" }));
    let current = await h.svc.getTrip(trip.tripId);
    assert.equal(current.sequence, 1, "不新增结论版本");
    assert.equal(current.automatedStatus, "GO", "原自动结论不被改写");
    assert.equal(current.departed, true);
    assert.equal(current.escalations.length, 1);
    assert.equal(current.escalations[0].level, "HIGH");

    await h.svc.ingestForecast(forecast(3, { ...SAFE, windGustKph: 95 }, { eventId: "wx-3" }));
    current = await h.svc.getTrip(trip.tripId);
    assert.equal(current.escalations.length, 2);
    assert.equal(current.escalations[1].level, "CRITICAL");
    assert.deepEqual(current.escalations[1].triggeredSegmentIds, ["seg-high"]);
    assert.equal(current.escalations[1].forecastBasis.usedEventIds.includes("wx-3"), true);
    assert.equal(current.notifications[1].target, "LEADER");
    assert.match(current.notifications[1].message, /风险升级/);

    // 再来一条安全预报也不能降级
    await h.svc.ingestForecast(forecast(4, SAFE, { eventId: "wx-4" }));
    const afterSafe = await h.svc.getTrip(trip.tripId);
    assert.equal(afterSafe.escalations.length, 2, "安全修订不得撤销升级");

    // 已出发不能重算
    await assert.rejects(h.svc.recompute(trip.tripId), (err) => err.code === "ALREADY_DEPARTED");

    // 历史版本仍是原结论，升级记录追加在同一版本上
    const v1 = await h.svc.getVersion(trip.versionId);
    assert.equal(v1.automatedStatus, "GO");
    assert.equal(v1.escalations[0].level, "HIGH");
    assert.equal(v1.escalations[1].level, "CRITICAL");
  } finally { await h.cleanup(); }
});

test("人工复核：申请后生效状态为 MANUAL_REVIEW，值班员裁决 GO/HOLD 覆盖自动结论", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    const trip = await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    await h.svc.requestReview(trip.tripId, { by: "领队-周", reason: "队员出现高原反应，申请值班员复核" });
    const pending = await h.svc.getTrip(trip.tripId);
    assert.equal(pending.effectiveStatus, "MANUAL_REVIEW");
    assert.equal(pending.manualReview.status, "PENDING");

    await h.svc.resolveReview(trip.tripId, { by: "值班员-吴", decision: "hold", note: "就近扎营" });
    const resolved = await h.svc.getTrip(trip.tripId);
    assert.equal(resolved.effectiveStatus, "HOLD");
    assert.equal(resolved.automatedStatus, "GO", "自动结论原样保留");
    assert.equal(resolved.manualReview.resolution.decision, "HOLD");

    // 预报修订重算后未决复核会被携带；已裁决的不携带
    await h.svc.ingestForecast(forecast(2, { ...SAFE, windGustKph: 72 }, { source: "alpine-post", eventId: "wx-alt-2" }));
    const v2 = await h.svc.getTrip(trip.tripId);
    assert.equal(v2.manualReview, null);
    assert.equal(v2.automatedStatus, "MANUAL_REVIEW");
  } finally { await h.cleanup(); }
});

test("服务重启后状态完整恢复，重放结果与指纹一致，审计链校验通过", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    const trip = await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    await h.svc.ingestForecast(forecast(2, { ...SAFE, windGustKph: 72 }, { source: "alpine-post", eventId: "wx-alt-2" }));

    const svc2 = await h.reopen();
    const restored = await svc2.getTrip(trip.tripId);
    assert.equal(restored.automatedStatus, "MANUAL_REVIEW");
    assert.equal(restored.forecastBasis.usedEventIds.includes("wx-alt-2"), true);
    const verify = await svc2.verifyVersion(restored.versionId);
    assert.equal(verify.replayMatchesStored, true);
    assert.equal(verify.fingerprintMatches, true);
    const chain = await svc2.auditVerify();
    assert.equal(chain.ok, true);
    assert.ok(chain.entries >= 4);
  } finally { await h.cleanup(); }
});

test("审计日志被篡改时哈希链校验失败", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    const logPath = join(h.dir, "audit.log");
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.payload.status = "GO";
    lines[1] = JSON.stringify(tampered);
    await writeFile(logPath, lines.join("\n") + "\n");
    await assert.rejects(h.reopen(), /哈希链/);
    const verify = await h.svc.auditVerify();
    assert.equal(verify.ok, false);
    assert.equal(verify.brokenAt, 2);
  } finally { await h.cleanup(); }
});

test("无关时段或不改变结论的修订不制造新版本，但仍可在依据中追溯", async () => {
  const h = await makeHarness();
  try {
    await h.svc.ingestForecast(forecast(1, SAFE));
    const trip = await h.svc.createTrip({ routeId: "ridge-1", memberIds: ["m1"] });
    const out = await h.svc.ingestForecast({
      eventId: "wx-later", source: "regional-observatory", routeId: "ridge-1", revision: 9,
      issuedAt: "2026-10-03T20:00:00+08:00",
      validFrom: "2026-10-05T00:00:00+08:00",
      validTo: "2026-10-05T12:00:00+08:00",
      values: { windGustKph: 120, visibilityM: 10, precipitationMm: 50 },
    });
    assert.equal(out.affectedTrips[0].action, "UNCHANGED");
    const same = await h.svc.getTrip(trip.tripId);
    assert.equal(same.versionId, trip.versionId);
  } finally { await h.cleanup(); }
});
