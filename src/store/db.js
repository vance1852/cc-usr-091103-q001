import { JsonCollection, ensureDir } from "./json-collection.js";
import { AuditLog } from "./audit.js";

/** 全部持久化句柄；数据目录默认 ./data，可经环境变量 DATA_DIR 覆盖。 */
export async function openDb(dir = process.env.DATA_DIR ?? "data") {
  await ensureDir(dir);
  const routes = new JsonCollection(dir, "routes.json");
  const roster = new JsonCollection(dir, "roster.json");
  const forecasts = new JsonCollection(dir, "forecasts.json");
  const decisions = new JsonCollection(dir, "decisions.json");
  const idempotency = new JsonCollection(dir, "idempotency.json");
  await Promise.all([
    routes.load({}),
    roster.load({}),
    forecasts.load([]),
    decisions.load({ trips: {}, versions: {} }),
    idempotency.load({}),
  ]);
  const audit = new AuditLog(dir);
  await audit.load();
  return { dir, routes, roster, forecasts, decisions, idempotency, audit };
}
