import { createClearanceService } from "./create-service.js";
import { createApp } from "./http/app.js";

const port = Number(process.env.PORT ?? 3000);
const logFile = process.env.LOG_FILE ?? "data/events.jsonl";

const service = await createClearanceService({ logFile });
const server = createApp(service);

server.listen(port, () => {
  console.log(`山径放行服务已启动: http://localhost:${port}（事件日志 ${logFile}）`);
});

// 优雅关停：仅附加写入本身是同步落盘的，这里只需停止接收新请求。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
