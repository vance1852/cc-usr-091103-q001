import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventStore } from "./store/event-store.js";
import { ClearanceService } from "./service/clearance-service.js";
import { DEFAULT_POLICY } from "./domain/policy.js";

// 组装根：事件日志路径与策略在此注入；策略内容也是结论哈希输入，
// 修改阈值即产生与历史不同的 contentHash。
export async function createClearanceService({
  logFile = process.env.LOG_FILE ?? "data/events.jsonl",
  policy = DEFAULT_POLICY,
  clock,
  notifier,
} = {}) {
  mkdirSync(dirname(logFile), { recursive: true });
  const store = new EventStore(logFile, clock);
  const service = new ClearanceService(store, { policy, clock, notifier });
  await service.load();
  return service;
}
