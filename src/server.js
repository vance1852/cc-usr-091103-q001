import { createServer } from "node:http";
import { openDb } from "./store/db.js";
import { createDecisionService } from "./service/decision-service.js";
import { createApp } from "./http/app.js";

const PORT = Number(process.env.PORT ?? 3000);

const db = await openDb(process.env.DATA_DIR ?? "data");
const service = createDecisionService(db);
const app = createApp(service);
const server = createServer(app);

server.listen(PORT, () => {
  console.log(`山径放行服务已启动: http://localhost:${PORT}（数据目录 ${db.dir}）`);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，关闭 HTTP 监听`);
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
