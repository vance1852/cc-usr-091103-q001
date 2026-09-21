import { createServer } from "node:http";

// 极简路由层：把 HTTP 映射到 ClearanceService，错误统一转状态码。
export function createApp(service) {
  const routes = [
    ["POST", /^\/routes$/, (b) => service.registerRoute(b)],
    ["POST", /^\/trips$/, (b) => service.planTrip(b)],
    ["POST", /^\/forecasts$/, (b, _m, req) => service.ingestForecast(b, { idempotencyKey: req.headers["idempotency-key"] })],
    ["GET", /^\/trips$/, () => service.listTrips()],
    ["GET", /^\/trips\/([^/]+)$/, (_b, m) => service.getTrip(m[1])],
    ["POST", /^\/trips\/([^/]+)\/check-in$/, (b, m) => service.checkIn(m[1], b)],
    ["POST", /^\/trips\/([^/]+)\/complete$/, (_b, m) => service.completeTrip(m[1])],
    ["POST", /^\/trips\/([^/]+)\/recalculate$/, (_b, m) => service.computeClearance(m[1])],
    ["POST", /^\/trips\/([^/]+)\/reviews$/, (b, m) => service.requestReview(m[1], b)],
    ["POST", /^\/trips\/([^/]+)\/reviews\/resolve$/, (b, m) => service.resolveReview(m[1], b)],
    ["GET", /^\/trips\/([^/]+)\/audit$/, (_b, m) => ({ tripId: m[1], entries: service.auditTrail(m[1]) })],
    ["GET", /^\/decisions\/([^/]+)$/, (_b, m) => service.getDecision(m[1])],
  ];

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      const url = new URL(req.url, "http://localhost");
      const body = await readBody(req);
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (!m) continue;
        const out = await handler(body, m, req);
        return json(res, 200, out);
      }
      return json(res, 404, { error: "未找到接口" });
    } catch (err) {
      const status = err.status
        ?? (err.code === "DEDUPE_CONFLICT" ? 409 : null)
        ?? (err instanceof SyntaxError || err instanceof TypeError ? 400 : 500);
      if (status >= 500) console.error(err);
      return json(res, status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const data = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}
