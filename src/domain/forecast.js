import { parseForecastRevision } from "../forecast-contract.js";
import { FACTORS } from "./policy.js";
import { parseTime, hourFloor, HOUR_MS } from "./time.js";
import { badRequest } from "../errors.js";

/**
 * 把契约解析出的预报修订信封规范化：
 * - 时间转 epoch 毫秒（保留原字符串用于回显与审计）
 * - values 中每个已知因子支持：数字（整个有效区间恒定）、null（缺测）、
 *   或 { "ISO整点": number|null } 形式的逐时值
 * - 未知因子与未知顶层字段原样保留
 */
export function ingestRevision(raw) {
  let envelope;
  try {
    envelope = parseForecastRevision(raw);
  } catch (err) {
    throw badRequest("INVALID_FORECAST", err.message);
  }
  const issuedAt = parseTime(envelope.issuedAt, "issuedAt");
  const validFrom = parseTime(envelope.validFrom, "validFrom");
  const validTo = parseTime(envelope.validTo, "validTo");
  if (!(validTo > validFrom)) throw badRequest("INVALID_FORECAST", "validTo 必须晚于 validFrom");
  if (validFrom !== hourFloor(validFrom) || validTo !== hourFloor(validTo)) {
    throw badRequest("INVALID_FORECAST", "validFrom/validTo 必须对齐整点");
  }

  const values = {};
  const extraMetrics = {};
  for (const [key, entry] of Object.entries(envelope.values)) {
    if (!FACTORS[key]) {
      extraMetrics[key] = entry;
      continue;
    }
    values[key] = normalizeValueEntry(entry, key, validFrom, validTo);
  }

  return {
    eventId: envelope.eventId,
    source: envelope.source,
    routeId: envelope.routeId,
    revision: envelope.revision,
    issuedAt,
    validFrom,
    validTo,
    values,
    extraMetrics,
    attributes: envelope.attributes ?? {},
    raw: {
      issuedAt: envelope.issuedAt,
      validFrom: envelope.validFrom,
      validTo: envelope.validTo,
    },
  };
}

function normalizeValueEntry(entry, factor, validFrom, validTo) {
  if (entry === null) return { kind: "scalar", value: null };
  if (typeof entry === "number") {
    if (!Number.isFinite(entry)) throw badRequest("INVALID_FORECAST", `values.${factor} 必须是有限数`);
    return { kind: "scalar", value: entry };
  }
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const hourly = {};
    for (const [hourKey, v] of Object.entries(entry)) {
      const hourMs = parseTime(hourKey, `values.${factor} 时间槽`);
      if (hourMs !== hourFloor(hourMs)) throw badRequest("INVALID_FORECAST", `values.${factor}.${hourKey} 必须对齐整点`);
      if (hourMs < validFrom || hourMs >= validTo) {
        throw badRequest("INVALID_FORECAST", `values.${factor}.${hourKey} 超出有效区间`);
      }
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        throw badRequest("INVALID_FORECAST", `values.${factor}.${hourKey} 必须是数字或 null`);
      }
      hourly[hourMs] = v;
    }
    return { kind: "hourly", hourly };
  }
  throw badRequest("INVALID_FORECAST", `values.${factor} 必须是数字、null 或逐时对象`);
}

export function valueAt(revision, factor, hourMs) {
  const entry = revision.values[factor];
  if (!entry) return undefined; // 该来源完全没有报告这个因子
  if (entry.kind === "scalar") return entry.value;
  return Object.hasOwn(entry.hourly, hourMs) ? entry.hourly[hourMs] : undefined; // 逐时中缺槽 = 缺测
}

export function covers(revision, hourMs) {
  return hourMs >= revision.validFrom && hourMs < revision.validTo;
}

/**
 * 同一来源在某个小时槽的生效版本：覆盖该槽的最大 revision；
 * 同号修订（重发替换）依次以 issuedAt、eventId 最大者为准，保证无随机性。
 * 调用方只传入该来源的修订；返回 null 表示该来源对此槽无覆盖。
 */
export function effectiveRevision(revisionsOfSource, hourMs) {
  let picked = null;
  for (const rev of revisionsOfSource) {
    if (!covers(rev, hourMs)) continue;
    if (picked === null
      || rev.revision > picked.revision
      || (rev.revision === picked.revision && rev.issuedAt > picked.issuedAt)
      || (rev.revision === picked.revision && rev.issuedAt === picked.issuedAt && rev.eventId > picked.eventId)) {
      picked = rev;
    }
  }
  return picked;
}

export function revisionHours(rev) {
  const hours = [];
  for (let t = rev.validFrom; t < rev.validTo; t += HOUR_MS) hours.push(t);
  return hours;
}
