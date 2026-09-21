#!/usr/bin/env node
// 端到端演示：
// 1) 注册西脊路线、接入早晨预报后排两支周末队伍
// 2) 冷锋预报修订到达后，未出发队伍重算出 NO_GO（新版本，旧结论留档）
// 3) 第二来源与主管属矛盾 -> 采用更危险一侧并记录冲突
// 4) 重复投递 -> 幂等，结论哈希不变
// 5) 已出发队伍 -> 只追加风险升级与领队通知，原结论冻结
// 6) 领队申请人工复核 -> 值班员裁定闭环
import { rmSync, readFileSync } from "node:fs";
import { ClearanceService } from "../src/service/clearance-service.js";
import { EventStore } from "../src/store/event-store.js";
import { DEFAULT_POLICY } from "../src/domain/policy.js";

const LOG = "data/demo-events.jsonl";
rmSync(LOG, { force: true });

let now = "2026-10-03T06:00:00+08:00";
const notifications = [];
const store = new EventStore(LOG, () => now);
const service = new ClearanceService(store, {
  policy: DEFAULT_POLICY,
  clock: () => now,
  notifier: (n) => {
    notifications.push(n);
    return { channel: "radio-log", deliveredAt: now };
  },
});
await service.load();

const line = (s) => console.log(`\n${"=".repeat(72)}\n${s}\n${"=".repeat(72)}`);

// ---- 1. 注册路线（未知扩展字段 terrainClass/exposedRidge 原样保留）----
const route = JSON.parse(readFileSync(new URL("../fixtures/routes/ridge-west-17.json", import.meta.url), "utf8"));
service.registerRoute(route);
line("① 注册路线 ridge-west-17（扩展字段 terrainClass/exposedRidge 已保留）");

// ---- 2. 早晨版本 rev1：温和 ----
now = "2026-10-03T07:00:00+08:00";
const hours = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];
const hourly = (v) => Object.fromEntries(hours.map((h) => [`2026-10-04T${h}:00:00+08:00`, v]));
service.ingestForecast({
  eventId: "wx-ridge-17-r1",
  source: "regional-observatory",
  routeId: "ridge-west-17",
  revision: 1,
  issuedAt: "2026-10-03T06:30:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00",
  validTo: "2026-10-04T12:00:00+08:00",
  values: { windGustKph: hourly(41), visibilityM: hourly(2200), precipitationMm: hourly(0.4) },
  bulletinCode: "CW-2026-408",
});

// ---- 3. 排两支周末队伍（未知扩展字段 transport 原样保留）----
const itinerary = () => [
  { segmentId: "seg-approach", enterAt: "2026-10-04T02:00:00+08:00", leaveAt: "2026-10-04T04:00:00+08:00" },
  { segmentId: "seg-scree", enterAt: "2026-10-04T04:00:00+08:00", leaveAt: "2026-10-04T07:00:00+08:00" },
  { segmentId: "seg-ridge", enterAt: "2026-10-04T07:00:00+08:00", leaveAt: "2026-10-04T09:00:00+08:00" },
  { segmentId: "seg-saddle", enterAt: "2026-10-04T09:00:00+08:00", leaveAt: "2026-10-04T10:00:00+08:00" },
  { segmentId: "seg-descent", enterAt: "2026-10-04T10:00:00+08:00", leaveAt: "2026-10-04T11:00:00+08:00" },
];
service.planTrip({
  tripId: "trip-a",
  routeId: "ridge-west-17",
  leaderId: "leader-chen",
  plannedStartAt: "2026-10-04T02:00:00+08:00",
  members: [{ memberId: "m1", name: "小陈", tolerances: { windGustKph: 78 } }],
  itinerary: itinerary(),
  transport: "包车-京P12345",
});
service.planTrip({
  tripId: "trip-b",
  routeId: "ridge-west-17",
  leaderId: "leader-lin",
  plannedStartAt: "2026-10-04T02:00:00+08:00",
  members: [],
  itinerary: itinerary(),
});
const d1 = service.getTrip("trip-a").currentDecision;
line(`② 早晨预报 rev1 后排行程：trip-a 初始结论 ${d1.decision}（${d1.decisionId}），扩展字段已保留`);

// ---- 4. trip-b 持早晨结论签到出发，结论随即冻结 ----
now = "2026-10-04T02:05:00+08:00";
const checkin = service.checkIn("trip-b");
line(`③ trip-b 签到出发，冻结结论 ${checkin.frozenDecisionId}`);

// ---- 5. 冷锋提前：rev3（仓库样例）到达，trip-a 未出发，自动重算 ----
now = "2026-10-03T18:25:00+08:00";
const revision = JSON.parse(readFileSync(new URL("../fixtures/forecast-revision.json", import.meta.url), "utf8"));
service.ingestForecast(revision);
const d3 = service.getTrip("trip-a").currentDecision;
line(`④ 冷锋修订 rev3 到达：trip-a 重算为 ${d3.decision}，触发路段 ${d3.triggeredSegments.join("、")}
   新版本 ${d3.decisionId}，旧版本仍在版本链中；采用预报 ${d3.adoptedForecast.map((f) => `${f.source} r${f.revision}`).join("、")}`);

// ---- 6. 管护站来源与观象台矛盾（阵风 85 vs 72，差 13 > 容差 10）----
now = "2026-10-03T18:40:00+08:00";
service.ingestForecast({
  eventId: "wx-ridge-17-local-r1",
  source: "local-ranger",
  routeId: "ridge-west-17",
  revision: 1,
  issuedAt: "2026-10-03T18:35:00+08:00",
  validFrom: "2026-10-04T00:00:00+08:00",
  validTo: "2026-10-04T12:00:00+08:00",
  values: { windGustKph: hourly(85), visibilityM: hourly(150) },
  station: "西脊管护站",
});
const withConflict = service.getTrip("trip-a").currentDecision;
const conflicts = service.getDecision(withConflict.decisionId).weather.conflicts;
line(`⑤ 管护站来源与观象台矛盾：记录冲突 ${conflicts.length} 个要素-小时，按规则"采用更危险一侧"
   例：${conflicts[0] ? `${conflicts[0].measure}@${conflicts[0].hour} -> ${JSON.stringify(conflicts[0].valuesBySource)}` : ""}`);

// ---- 7. 重复投递 rev3：幂等去重，哈希不变 ----
const before = service.getTrip("trip-a").currentDecision.contentHash;
const dup = service.ingestForecast(revision, { idempotencyKey: `forecast:${revision.eventId}` });
const after = service.getTrip("trip-a").currentDecision.contentHash;
line(`⑥ 重复投递 rev3：deduplicated=${dup.deduplicated}，结论哈希 ${before === after ? "保持一致 ✓" : "发生变化 ✗"}`);

// ---- 8. trip-b 已出发：只升级风险 + 通知领队，原结论不改写 ----
const bAfter = service.getTrip("trip-b");
line(`⑦ trip-b 已出发，新预报下原结论仍冻结为 ${bAfter.frozenDepartureDecision.decision}（${bAfter.frozenDepartureDecision.decisionId}）
   追加风险升级 ${bAfter.escalations.length} 条：${bAfter.escalations.map((e) => `${e.fromLevel}→${e.newLevel}@${e.triggeredSegments.join("/")}`).join("；")}
   RISK_ESCALATION 领队通知 ${bAfter.notifications.filter((n) => n.content.kind === "RISK_ESCALATION").length} 条，已写入 LeaderNotified 审计事件`);

// ---- 9. 人工复核闭环 ----
now = "2026-10-03T19:00:00+08:00";
service.requestReview("trip-a", { by: "leader-chen", reason: "队员时间窗口有限，申请研判是否可改走低海拔支线" });
const pending = service.getTrip("trip-a").currentDecision;
line(`⑧ 领队申请人工复核：当前结论变为 ${pending.decision}（版本 v${pending.version}，自动结论被挂起而非删除）`);
now = "2026-10-03T19:20:00+08:00";
const resolved = service.resolveReview("trip-a", { verdict: "NO_GO", by: "duty-wang", note: "刃脊段阵风与能见度均超禁止线，全线暂缓；协调下周改期。" });
line(`⑨ 值班员裁定 ${resolved.decision.decision.decision}（${resolved.decision.basis}），复核闭环；通知领队：
   ${notifications.filter((n) => n.kind === "REVIEW_RESOLVED").at(-1)?.message}`);

line("审计要点：GET /trips/trip-a/audit 可看到每条结论采用的预报版本、触发路段与完整事件序列；");
console.log("事件日志已写入", LOG, "（重启服务后重放该文件将得到完全相同的版本号与 contentHash）。");
