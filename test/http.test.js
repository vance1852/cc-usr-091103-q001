import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/http/app.js";
import { ClearanceService } from "../src/service/clearance-service.js";
import { EventStore } from "../src/store/event-store.js";
import { DEFAULT_POLICY } from "../src/domain/policy.js";

const hours = ["02", "03", "04", "05", "06", "07", "08"];
const hourly = (v) => Object.fromEntries(hours.map((h) => [`2026-10-04T${h}:00:00+08:00`, v]));

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "clearance-http-"));
  const file = join(dir, "events.jsonl");
  const store = new EventStore(file, () => "2026-10-03T07:00:00+08:00");
  const service = new ClearanceService(store, {
    policy: DEFAULT_POLICY, clock: () => "2026-10-03T07:00:00+08:00", notifier: () => ({ channel: "test" }),
  });
  await service.load();
  const server = createApp(service);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    stop: async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": "k-1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP 端到端：注册→预报→计划→修订重算→审计查询", async (t) => {
  const { base, stop } = await startServer();
  t.after(stop);

  let r = await api(base, "POST", "/routes", {
    routeId: "r1", name: "脊", segments: [{ segmentId: "s1", name: "高", maxElevM: 2700 }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.attributes, {});
  assert.deepEqual(r.json.segments[0].attributes, {});

  r = await api(base, "POST", "/forecasts", {
    eventId: "f1", source: "obs", routeId: "r1", revision: 1,
    issuedAt: "2026-10-03T06:30:00+08:00",
    validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
    values: { windGustKph: hourly(40), visibilityM: hourly(2000), precipitationMm: hourly(0.2) },
  });
  assert.equal(r.status, 200);

  r = await api(base, "POST", "/trips", {
    tripId: "t1", routeId: "r1", leaderId: "L", itinerary: [
      { segmentId: "s1", enterAt: "2026-10-04T03:00:00+08:00", leaveAt: "2026-10-04T07:00:00+08:00" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.decision.decision, "GO");

  const t1 = await api(base, "GET", "/trips/t1");
  assert.equal(t1.json.currentDecision.decision, "GO");

  // 同幂等键重复投递
  const dup = await api(base, "POST", "/forecasts", {
    eventId: "f1", source: "obs", routeId: "r1", revision: 1,
    issuedAt: "2026-10-03T06:30:00+08:00",
    validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
    values: { windGustKph: hourly(40), visibilityM: hourly(2000), precipitationMm: hourly(0.2) },
  });
  assert.equal(dup.json.deduplicated, true);

  // 修订 -> NO_GO
  r = await fetch(base + "/forecasts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "f2", source: "obs", routeId: "r1", revision: 2,
      issuedAt: "2026-10-03T18:20:00+08:00",
      validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
      values: { windGustKph: hourly(88), visibilityM: hourly(120), precipitationMm: 20 },
    }),
  }).then(async (x) => ({ status: x.status, json: await x.json() }));
  assert.equal(r.status, 200);

  r = await api(base, "GET", "/trips/t1");
  assert.equal(r.json.currentDecision.decision, "NO_GO");
  assert.ok(r.json.currentDecision.triggeredSegments.includes("s1"));
  assert.equal(r.json.decisionVersions.length, 2);

  // 审计：能看到采用的预报版本
  const audit = await api(base, "GET", "/trips/t1/audit");
  assert.equal(audit.status, 200);
  const types = audit.json.entries.map((e) => e.type);
  assert.ok(types.includes("ForecastIngested"));
  assert.ok(types.filter((t) => t === "DecisionIssued").length >= 2);
  const detail = await api(base, "GET", `/decisions/${r.json.currentDecision.decisionId}`);
  assert.equal(detail.json.weather.forecastVersions.find((f) => f.revision === 2).adopted, true);

  // 校验错误返回 400
  const bad = await api(base, "POST", "/forecasts", { eventId: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.includes("缺少字段"), true);

  assert.equal((await api(base, "GET", "/health")).json.ok, true);
});
