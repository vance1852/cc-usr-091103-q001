import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClearanceService } from "../src/service/clearance-service.js";
import { EventStore } from "../src/store/event-store.js";
import { DEFAULT_POLICY } from "../src/domain/policy.js";

const hours = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];
const hourly = (v) => Object.fromEntries(hours.map((h) => [`2026-10-04T${h}:00:00+08:00`, v]));
const ROUTE = {
  routeId: "r1", name: "脊",
  segments: [
    { segmentId: "low", name: "低", maxElevM: 1620 },
    { segmentId: "high", name: "高", maxElevM: 2680 },
  ],
};
const IT = () => [
  { segmentId: "low", enterAt: "2026-10-04T03:00:00+08:00", leaveAt: "2026-10-04T05:00:00+08:00" },
  { segmentId: "high", enterAt: "2026-10-04T05:00:00+08:00", leaveAt: "2026-10-04T08:00:00+08:00" },
];
const mild = {
  eventId: "e1", source: "regional-observatory", routeId: "r1", revision: 1,
  issuedAt: "2026-10-03T06:30:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
  values: { windGustKph: hourly(40), visibilityM: hourly(2200), precipitationMm: hourly(0.2) },
};
const severe = {
  eventId: "e3", source: "regional-observatory", routeId: "r1", revision: 3,
  issuedAt: "2026-10-03T18:20:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00", validTo: "2026-10-04T12:00:00+08:00",
  values: { windGustKph: hourly(72), visibilityM: hourly(180), precipitationMm: 16 },
};

async function setup(file, clock) {
  const store = new EventStore(file, () => clock.value);
  const svc = new ClearanceService(store, {
    policy: DEFAULT_POLICY, clock: () => clock.value, notifier: () => ({ channel: "test" }),
  });
  await svc.load();
  return svc;
}

test("崩溃在 RiskEscalated 与 LeaderNotified 之间：重启补发且只补发一次", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clearance-recover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "events.jsonl");
  const clock = { value: "2026-10-03T07:00:00+08:00" };

  let svc = await setup(file, clock);
  svc.registerRoute(ROUTE);
  svc.ingestForecast(mild);
  svc.planTrip({ tripId: "trip1", routeId: "r1", leaderId: "L1", itinerary: IT() });
  clock.value = "2026-10-04T03:05:00+08:00";
  svc.checkIn("trip1");
  clock.value = "2026-10-03T18:25:00+08:00";
  svc.ingestForecast(severe);

  // 模拟崩溃：删掉最后两条（LeaderNotified + ForecastCascadeCompleted），
  // 只保留到 RiskEscalated，与"升级落盘后、通知落盘前崩溃"等价。
  let lines = readFileSync(file, "utf8").trim().split("\n");
  while (JSON.parse(lines.at(-1)).type !== "RiskEscalated") lines.pop();
  writeFileSync(file, `${lines.join("\n")}\n`);

  const before = lines.length;
  svc = await setup(file, clock);
  let trip = svc.getTrip("trip1");
  assert.equal(trip.escalations.length, 1);
  assert.equal(trip.notifications.filter((n) => n.content.kind === "RISK_ESCALATION").length, 1);
  assert.ok(trip.notifications.find((n) => n.content.kind === "RISK_ESCALATION").content.recovered);

  // 再次重启不重复补发
  const afterFirst = readFileSync(file, "utf8").trim().split("\n").length;
  svc = await setup(file, clock);
  trip = svc.getTrip("trip1");
  assert.equal(trip.notifications.filter((n) => n.content.kind === "RISK_ESCALATION").length, 1);
  assert.ok(afterFirst > before, "首次恢复补齐了缺失事件");
});
