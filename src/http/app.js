import { AppError } from "../errors.js";
import { POLICY_VERSION } from "../domain/policy.js";

const MAX_BODY = 1024 * 1024;

/**
 * 零依赖 HTTP 路由层。写接口支持 Idempotency-Key 头：
 * 同键同体重放首次响应，同键异体返回 409。
 */
export function createApp(service) {
  return async function app(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = match(req.method, url.pathname);
      if (!route) return send(res, 404, { error: { code: "NOT_FOUND", message: "路径不存在" } });

      if (req.method !== "GET") {
        req.body = await readJson(req);
      }
      const ctx = { params: route.params, query: url.searchParams, idempotencyKey: req.headers["idempotency-key"] };
      const body = await route.handler(ctx, req, service);
      return send(res, body.status ?? 200, body.data);
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
        return send(res, 400, { error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } });
      }
      const errorId = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      console.error(`[${errorId}]`, err);
      return send(res, 500, { error: { code: "INTERNAL", message: "服务内部错误", errorId } });
    }
  };
}

function match(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = pathname.match(route.pattern);
    if (m) {
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params };
    }
  }
  return null;
}

const ROUTES = [
  { method: "GET", pattern: /^\/health$/, keys: [], handler: async () => ({
    status: 200, data: { ok: true, policyVersion: POLICY_VERSION },
  }) },

  { method: "POST", pattern: /^\/routes$/, keys: [], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.putRoute(req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "GET", pattern: /^\/routes$/, keys: [], handler: async (_ctx, _req, svc) => ({ status: 200, data: await svc.listRoutes() }) },
  { method: "GET", pattern: /^\/routes\/([^/]+)$/, keys: ["routeId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.getRoute(ctx.params.routeId) }) },

  { method: "POST", pattern: /^\/members$/, keys: [], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.putMember(req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "GET", pattern: /^\/members$/, keys: [], handler: async (_ctx, _req, svc) => ({ status: 200, data: await svc.listMembers() }) },
  { method: "GET", pattern: /^\/members\/([^/]+)$/, keys: ["memberId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.getMember(ctx.params.memberId) }) },

  { method: "POST", pattern: /^\/forecasts$/, keys: [], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.ingestForecast(req.body, { idempotencyKey: ctx.idempotencyKey }) }) },

  { method: "POST", pattern: /^\/trips$/, keys: [], handler: async (ctx, req, svc) => ({ status: 201, data: await svc.createTrip(req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "GET", pattern: /^\/trips$/, keys: [], handler: async (_ctx, _req, svc) => ({ status: 200, data: await svc.listTrips() }) },
  { method: "GET", pattern: /^\/trips\/([^/]+)$/, keys: ["tripId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.getTrip(ctx.params.tripId) }) },
  { method: "POST", pattern: /^\/trips\/([^/]+)\/recompute$/, keys: ["tripId"], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.recompute(ctx.params.tripId, req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "POST", pattern: /^\/trips\/([^/]+)\/check-in$/, keys: ["tripId"], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.checkIn(ctx.params.tripId, req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "POST", pattern: /^\/trips\/([^/]+)\/reviews$/, keys: ["tripId"], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.requestReview(ctx.params.tripId, req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "POST", pattern: /^\/trips\/([^/]+)\/reviews\/resolve$/, keys: ["tripId"], handler: async (ctx, req, svc) => ({ status: 200, data: await svc.resolveReview(ctx.params.tripId, req.body, { idempotencyKey: ctx.idempotencyKey }) }) },
  { method: "GET", pattern: /^\/trips\/([^/]+)\/versions$/, keys: ["tripId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.listVersions(ctx.params.tripId) }) },

  { method: "GET", pattern: /^\/versions\/([^/]+)$/, keys: ["versionId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.getVersion(ctx.params.versionId) }) },
  { method: "GET", pattern: /^\/versions\/([^/]+)\/verify$/, keys: ["versionId"], handler: async (ctx, _req, svc) => ({ status: 200, data: await svc.verifyVersion(ctx.params.versionId) }) },

  { method: "GET", pattern: /^\/audit$/, keys: [], handler: async (_ctx, _req, svc) => ({ status: 200, data: await svc.auditEntries() }) },
  { method: "GET", pattern: /^\/audit\/verify$/, keys: [], handler: async (_ctx, _req, svc) => ({ status: 200, data: await svc.auditVerify() }) },
];

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, "PAYLOAD_TOO_LARGE", "请求体超过 1MB 限制");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
