import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { openDb } from "../src/store/db.js";
import { createDecisionService } from "../src/service/decision-service.js";
import { createApp } from "../src/http/app.js";

async function startHarness() {
  const dir = await mkdtemp(join(tmpdir(), "trail-http-"));
  const db = await openDb(dir);
  const svc = createDecisionService(db);
  const server = createServer(createApp(svc));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    stop: async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); },
  };
}

async function req(base, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

const ROUTE = {
  routeId: "ridge-9",
  segments: [{
    segmentId: "seg-ridge",
    plannedStart: "2026-10-04T06:00:00+08:00",
    plannedEnd: "2026-10-04T10:00:00+08:00",
    limits: { windGustKph: 60, visibilityM: 200 },
  }],
  terrainClass: "ALPINE",
};

test("HTTP 全链路：建路线/成员 → 预报 → 行程结论 → 修订重算 → 出发后升级 → 复核 → 审计查询", async () => {
  const h = await startHarness();
  try {
    let r = await req(h.base, "GET", "/health");
    assert.equal(r.status, 200);
    assert.ok(r.data.policyVersion);

    r = await req(h.base, "POST", "/routes", ROUTE);
    assert.equal(r.status, 200);
    assert.equal(r.data.route.attributes.terrainClass, "ALPINE", "路线未知扩展字段保留");
    r = await req(h.base, "POST", "/members", { memberId: "m1", tolerance: { windGustKph: { max: 65 } }, firstSeason: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.member.attributes.firstSeason, true, "成员未知扩展字段保留");

    const fx1 = {
      eventId: "wx-1", source: "obs", routeId: "ridge-9", revision: 1,
      issuedAt: "2026-10-03T16:00:00+08:00",
      validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
      values: { windGustKph: 40, visibilityM: 5000 }, bulletinCode: "CW-1",
    };
    r = await req(h.base, "POST", "/forecasts", fx1);
    assert.equal(r.status, 200);

    r = await req(h.base, "POST", "/trips", { tripId: "t-http", routeId: "ridge-9", memberIds: ["m1"] }, { "Idempotency-Key": "k-trip" });
    assert.equal(r.status, 201);
    assert.equal(r.data.automatedStatus, "GO");
    const firstVersion = r.data.versionId;
    const tripId = r.data.tripId;

    // 同键重放返回同一份结论
    r = await req(h.base, "POST", "/trips", { tripId: "t-http", routeId: "ridge-9", memberIds: ["m1"] }, { "Idempotency-Key": "k-trip" });
    assert.equal(r.status, 201);
    assert.equal(r.data.versionId, firstVersion);

    // 更正预报：一致超限 → 自动重算为 HOLD
    const fx2 = {
      ...fx1, eventId: "wx-2", revision: 2, issuedAt: "2026-10-03T18:20:00+08:00",
      values: { windGustKph: 80, visibilityM: 180 },
    };
    r = await req(h.base, "POST", "/forecasts", fx2);
    assert.deepEqual(r.data.affectedTrips.map((a) => a.action), ["RECOMPUTED"]);
    r = await req(h.base, "GET", `/trips/${tripId}`);
    assert.equal(r.data.automatedStatus, "HOLD");
    assert.deepEqual(r.data.triggeredSegmentIds, ["seg-ridge"]);

    // 版本依据可查
    r = await req(h.base, "GET", `/versions/${r.data.versionId}/verify`);
    assert.equal(r.status, 200);
    assert.equal(r.data.replayMatchesStored, true);

    // 值班员仍裁决 GO 并放队伍出发
    r = await req(h.base, "POST", `/trips/${tripId}/reviews`, { by: "领队", reason: "窗口提前，抢在锋面前进山" });
    assert.equal(r.status, 200);
    r = await req(h.base, "POST", `/trips/${tripId}/reviews/resolve`, { by: "值班员", decision: "GO", note: "限 10 点前下撤" });
    assert.equal(r.status, 200);
    assert.equal(r.data.effectiveStatus, "GO");

    r = await req(h.base, "POST", `/trips/${tripId}/check-in`, { by: "领队", at: "2026-10-04T05:40:00+08:00" });
    assert.equal(r.status, 200);
    assert.equal(r.data.departed, true);

    // 出发后再坏的预报只能升级、通知，不能改写
    const fx3 = {
      ...fx1, eventId: "wx-3", revision: 3, issuedAt: "2026-10-03T19:00:00+08:00",
      values: { windGustKph: 95, visibilityM: 120 },
    };
    r = await req(h.base, "POST", "/forecasts", fx3);
    assert.deepEqual(r.data.affectedTrips.map((a) => a.action), ["ESCALATED"]);
    r = await req(h.base, "GET", `/trips/${tripId}`);
    assert.equal(r.data.sequence, 2, "出发后不新增版本号之外的结论版本");
    assert.equal(r.data.automatedStatus, "HOLD", "原结论保留（人工裁决 GO 体现在 manualReview）");
    assert.equal(r.data.effectiveStatus, "GO");
    assert.ok(r.data.escalations.length >= 1);
    assert.equal(r.data.notifications.at(-1).target, "LEADER");

    // 已出发重算被拒
    r = await req(h.base, "POST", `/trips/${tripId}/recompute`, {});
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, "ALREADY_DEPARTED");

    // 审计链与列表
    r = await req(h.base, "GET", "/audit/verify");
    assert.equal(r.data.ok, true);
    r = await req(h.base, "GET", "/audit");
    assert.equal(Array.isArray(r.data), true);
    assert.ok(r.data.some((e) => e.type === "POST_DEPARTURE_ESCALATION"));
    assert.ok(r.data.some((e) => e.type === "DECISION_VERSION"));
  } finally {
    await h.stop();
  }
});

test("HTTP 错误处理：非法 JSON 400、未知行程 404、校验失败 400", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.base}/forecasts`, { method: "POST", body: "{not-json", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_JSON");

    let r = await req(h.base, "GET", "/trips/nope");
    assert.equal(r.status, 404);

    r = await req(h.base, "POST", "/forecasts", { eventId: "x", source: "s", routeId: "r", revision: 0, issuedAt: "t", validFrom: "t", validTo: "t", values: {} });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, "INVALID_FORECAST");
  } finally {
    await h.stop();
  }
});
