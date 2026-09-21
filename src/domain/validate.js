import { FACTORS } from "./policy.js";
import { parseTime } from "./time.js";
import { badRequest } from "../errors.js";

const ISO_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function requireId(value, field) {
  if (typeof value !== "string" || !ISO_ID.test(value)) throw badRequest("INVALID_ID", `${field} 必须是非空标识`);
  return value;
}

export function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("INVALID_FIELD", `${field} 必须是非空字符串`);
  return value;
}

export function validateRoute(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("INVALID_ROUTE", "路线必须是对象");
  requireId(raw.routeId, "routeId");
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) throw badRequest("INVALID_ROUTE", "路线至少包含一个路段");
  const known = new Set(["routeId", "name", "segments"]);
  const segments = raw.segments.map((seg, i) => {
    const where = `segments[${i}]`;
    if (!seg || typeof seg !== "object") throw badRequest("INVALID_SEGMENT", `${where} 必须是对象`);
    requireId(seg.segmentId, `${where}.segmentId`);
    const start = parseTime(seg.plannedStart, `${where}.plannedStart`);
    const end = parseTime(seg.plannedEnd, `${where}.plannedEnd`);
    if (!(end > start)) throw badRequest("INVALID_SEGMENT", `${where}.plannedEnd 必须晚于 plannedStart`);
    const limits = {};
    for (const factor of Object.keys(FACTORS)) {
      if (seg.limits && seg.limits[factor] !== undefined) {
        const limit = seg.limits[factor];
        if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
          throw badRequest("INVALID_LIMIT", `${where}.limits.${factor} 必须是正数`);
        }
        limits[factor] = limit;
      }
    }
    const segKnown = new Set(["segmentId", "name", "fromWaypoint", "toWaypoint", "elevationM", "plannedStart", "plannedEnd", "limits"]);
    return {
      segmentId: seg.segmentId,
      name: seg.name,
      fromWaypoint: seg.fromWaypoint,
      toWaypoint: seg.toWaypoint,
      elevationM: seg.elevationM,
      plannedStart: seg.plannedStart,
      plannedEnd: seg.plannedEnd,
      startMs: start,
      endMs: end,
      limits,
      attributes: Object.fromEntries(Object.entries(seg).filter(([key]) => !segKnown.has(key))),
    };
  });
  const ids = new Set();
  for (const seg of segments) {
    if (ids.has(seg.segmentId)) throw badRequest("INVALID_SEGMENT", `路段标识重复: ${seg.segmentId}`);
    ids.add(seg.segmentId);
  }
  return {
    routeId: raw.routeId,
    name: raw.name,
    segments,
    attributes: Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key))),
  };
}

export function validateMember(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("INVALID_MEMBER", "成员必须是对象");
  requireId(raw.memberId, "memberId");
  const tolerance = {};
  if (raw.tolerance !== undefined) {
    if (typeof raw.tolerance !== "object" || Array.isArray(raw.tolerance)) throw badRequest("INVALID_TOLERANCE", "tolerance 必须是对象");
    for (const [factor, bound] of Object.entries(raw.tolerance)) {
      if (!FACTORS[factor]) throw badRequest("INVALID_TOLERANCE", `未知气象因子 ${factor}`);
      if (!bound || typeof bound !== "object") throw badRequest("INVALID_TOLERANCE", `${factor} 耐受必须是 {max} 或 {min}`);
      if (FACTORS[factor].dir === "max") {
        if (typeof bound.max !== "number" || !Number.isFinite(bound.max) || bound.max <= 0) {
          throw badRequest("INVALID_TOLERANCE", `${factor}.max 必须是正数`);
        }
        tolerance[factor] = { max: bound.max };
      } else {
        if (typeof bound.min !== "number" || !Number.isFinite(bound.min) || bound.min < 0) {
          throw badRequest("INVALID_TOLERANCE", `${factor}.min 必须是非负数`);
        }
        tolerance[factor] = { min: bound.min };
      }
    }
  }
  const known = new Set(["memberId", "name", "tolerance"]);
  return {
    memberId: raw.memberId,
    name: raw.name,
    tolerance,
    attributes: Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key))),
  };
}
