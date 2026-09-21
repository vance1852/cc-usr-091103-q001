/**
 * 播种脚本：把 fixtures 中的山脊路线、成员与两条预报写入数据目录。
 * 可重复运行：相同内容不会产生重复版本或重复审计。
 * 用法：node scripts/seed.mjs
 */
import { readFile } from "node:fs/promises";
import { openDb } from "../src/store/db.js";
import { createDecisionService } from "../src/service/decision-service.js";

const here = new URL("../fixtures/", import.meta.url);
const load = (name) => readFile(new URL(name, here), "utf8").then((t) => JSON.parse(t));

const db = await openDb(process.env.DATA_DIR ?? "data");
const svc = createDecisionService(db);

const route = await load("ridge-route.json");
await svc.putRoute(route, { idempotencyKey: "seed-route-ridge-west-17" });

for (const member of await load("members.json")) {
  await svc.putMember(member, { idempotencyKey: `seed-member-${member.memberId}` });
}

await svc.ingestForecast(await load("forecast-r1.json"), { idempotencyKey: "seed-wx-r1" });
await svc.ingestForecast(await load("forecast-alt-r2.json"), { idempotencyKey: "seed-wx-alt-r2" });

console.log("播种完成：路线 ridge-west-17、2 名成员、2 条预报已就绪。");
console.log("可 POST /trips 创建行程，随后再投递 fixtures/forecast-revision.json（regional r3）观察重算/升级。");
process.exit(0);
