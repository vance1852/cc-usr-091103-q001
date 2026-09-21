import { createHash } from "node:crypto";
import { evaluateTrip } from "../domain/evaluator.js";
import { ingestRevision } from "../domain/forecast.js";
import { validateRoute, validateMember, requireId, requireString } from "../domain/validate.js";
import { stableStringify } from "../domain/canonical.js";
import { isoUtc, hourFloor, HOUR_MS } from "../domain/time.js";
import { POLICY_VERSION, postDepartureLevel, riskRank } from "../domain/policy.js";
import { badRequest, notFound, conflict } from "../errors.js";

/**
 * 应用服务：编排评估、持久化与审计。
 * - 所有写操作走单条全局链，保证“修订入库 → 受影响行程重算 → 审计落盘”顺序确定；
 * - 结论由纯函数 evaluateTrip 产生，服务层只负责版本链、幂等、升级与通知；
 * - 已出发结论的原始 status/restrictions 永不被修改。
 */
export function createDecisionService(db, clock = () => Date.now()) {
  const { routes, roster, forecasts, decisions, idempotency, audit } = db;
  let chain = Promise.resolve();
  const write = (fn) => {
    const run = chain.then(() => fn());
    chain = run.then(() => {}, () => {});
    return run;
  };

  /** 幂等键与业务写操作在同一把锁内检查，避免并发首投穿透。 */
  function withWrite(idempotencyKey, body, fn) {
    if (!idempotencyKey) return write(fn);
    return write(async () => {
      const payloadHash = sha256(stableStringify(body ?? {}));
      const existing = idempotency.data[idempotencyKey];
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw conflict("IDEMPOTENCY_CONFLICT", "同一幂等键携带了不同请求体");
        return clone(existing.response);
      }
      const response = await fn();
      idempotency.data[idempotencyKey] = { payloadHash, at: isoUtc(clock()), response: clone(response) };
      await idempotency.persist();
      return response;
    });
  }

  // ---------- 路线与成员 ----------

  function putRoute(raw, opts = {}) {
    return withWrite(opts.idempotencyKey, raw, async () => {
      const route = validateRoute(raw);
      const created = !routes.data[route.routeId];
      routes.data[route.routeId] = route;
      await routes.persist();
      await audit.append(created ? "ROUTE_REGISTERED" : "ROUTE_UPDATED", { routeId: route.routeId, segments: route.segments.map((s) => s.segmentId) });
      return { route: publicRoute(route), created };
    });
  }

  function putMember(raw, opts = {}) {
    return withWrite(opts.idempotencyKey, raw, async () => {
      const member = validateMember(raw);
      const created = !roster.data[member.memberId];
      roster.data[member.memberId] = member;
      await roster.persist();
      await audit.append(created ? "MEMBER_REGISTERED" : "MEMBER_UPDATED", { memberId: member.memberId });
      return { member: publicMember(member), created };
    });
  }

  // ---------- 预报修订 ----------

  function ingestForecast(raw, opts = {}) {
    return withWrite(opts.idempotencyKey, raw, async () => {
      const rev = ingestRevision(raw);
      const idx = forecasts.data.findIndex((r) => r.eventId === rev.eventId);
      if (idx >= 0 && stableStringify(forecasts.data[idx]) === stableStringify(rev)) {
        // 完全相同的重复投递：不重算、不产生新版本、不写审计，返回同一份结果
        return { duplicate: true, changed: false, eventId: rev.eventId, affectedTrips: [] };
      }
      const replaced = idx >= 0;
      if (idx >= 0) forecasts.data[idx] = rev;
      else forecasts.data.push(rev);
      await forecasts.persist();
      await audit.append("FORECAST_INGEST", {
        eventId: rev.eventId, source: rev.source, routeId: rev.routeId,
        revision: rev.revision, replaced, attributes: rev.attributes,
      });
      const affected = await reactToForecastChange(rev);
      // 联动结果补记在同一条入库事件之后，便于按时间顺序阅读
      await audit.append("FORECAST_FANOUT", { eventId: rev.eventId, affectedTrips: affected });
      return { duplicate: false, changed: replaced, eventId: rev.eventId, affectedTrips: affected };
    });
  }

  /**
   * 修订生效后：
   * - 未出发：仅当规范化输入指纹变化时才生成新版本（无关字段变化不重算）；
   * - 已签到出发：只评估风险升级并通知领队，原结论保持不变；无升级则什么都不写。
   */
  async function reactToForecastChange(rev) {
    const affected = [];
    for (const trip of Object.values(decisions.data.trips)) {
      if (trip.routeId !== rev.routeId) continue;
      const version = decisions.data.versions[trip.currentVersionId];
      if (version.departed) {
        const esc = buildEscalation(version);
        if (esc) {
          await decisions.persist();
          await audit.append("POST_DEPARTURE_ESCALATION", {
            tripId: trip.tripId, versionId: version.versionId, level: esc.level,
            triggeredSegmentIds: esc.triggeredSegmentIds, usedForecastEvents: esc.forecastBasis.usedEventIds,
            notification: esc.notification.target,
          });
          affected.push({ tripId: trip.tripId, action: "ESCALATED", level: esc.level });
        } else {
          affected.push({ tripId: trip.tripId, action: "NO_ESCALATION" });
        }
      } else {
        // 未出发：无论修订窗口是否与行程相交都重算；只有结论实质变化才新增版本
        const resultSig = currentResultSignature(trip);
        if (resultSig.changed) {
          const next = produceVersion(trip, { reason: "FORECAST_REVISION", triggerEventId: rev.eventId, result: resultSig.result });
          await decisions.persist();
          await audit.append("DECISION_VERSION", decisionAudit(next));
          affected.push({ tripId: trip.tripId, action: "RECOMPUTED", version: next.versionId, status: next.status });
        } else {
          affected.push({ tripId: trip.tripId, action: "UNCHANGED" });
        }
      }
    }
    return affected;
  }

  // ---------- 行程与放行结论 ----------

  function createTrip(body, opts = {}) {
    return withWrite(opts.idempotencyKey, body, async () => {
      const tripId = body.tripId ? requireId(body.tripId, "tripId") : `trip-${clock().toString(36)}-${createHash("sha1").update(stableStringify(body)).digest("hex").slice(0, 8)}`;
      requireId(body.routeId, "routeId");
      if (!Array.isArray(body.memberIds) || body.memberIds.length === 0) throw badRequest("INVALID_TRIP", "memberIds 必须是非空数组");
      const memberIds = body.memberIds.map((id) => requireId(id, "memberId"));
      if (decisions.data.trips[tripId]) throw conflict("TRIP_EXISTS", `行程 ${tripId} 已存在`);
      const trip = { tripId, routeId: body.routeId, currentVersionId: null };
      decisions.data.trips[tripId] = trip;
      const version = produceVersion(trip, { reason: "INITIAL", memberIds });
      await decisions.persist();
      await audit.append("TRIP_CREATED", { tripId, routeId: body.routeId, memberIds });
      await audit.append("DECISION_VERSION", decisionAudit(version));
      return publicVersion(version, trip);
    });
  }

  /** 基于当前全部输入生成一个结论版本（调用方已持锁并负责持久化）。 */
  function produceVersion(trip, opts) {
    const store = decisions.data;
    const route = routes.data[trip.routeId];
    if (!route) throw badRequest("ROUTE_NOT_FOUND", `路线 ${trip.routeId} 尚未登记`);
    const prev = trip.currentVersionId ? store.versions[trip.currentVersionId] : null;
    const memberIds = opts.memberIds ?? prev.memberIds;
    const members = [];
    for (const id of memberIds) {
      const member = roster.data[id];
      if (!member) throw badRequest("MEMBER_NOT_FOUND", `成员 ${id} 尚未登记`);
      members.push(member);
    }
    const revs = forecasts.data.filter((r) => r.routeId === trip.routeId);
    const result = opts.result ?? evaluateTrip({ route, members, revisions: revs });
    const now = clock();
    const sequence = prev ? prev.sequence + 1 : 1;
    const versionId = `${trip.tripId}-v${sequence}`;

    const carriedReview = prev?.manualReview && prev.manualReview.status === "PENDING"
      ? { ...prev.manualReview, carriedFromVersion: prev.versionId, note: "预报修订触发重算，未决人工复核随新版本继续挂起" }
      : null;

    const version = {
      versionId,
      tripId: trip.tripId,
      routeId: trip.routeId,
      sequence,
      status: result.status,
      reason: opts.reason,
      triggerEventId: opts.triggerEventId ?? null,
      supersedes: prev?.versionId ?? null,
      supersededBy: null,
      policyVersion: result.policyVersion,
      createdAtMs: now,
      createdAtIso: isoUtc(now),
      memberIds,
      restrictions: result.restrictions,
      advisories: result.advisories,
      triggeredSegmentIds: result.triggeredSegmentIds,
      forecastBasis: buildBasis(route, revs),
      inputFingerprint: fingerprint(route, members, revs, result.policyVersion),
      departed: false,
      departedAtMs: null,
      departedAtIso: null,
      escalations: [],
      notifications: [],
      manualReview: carriedReview,
      snapshot: { route: clone(route), members: clone(members), revisions: clone(revs) },
    };
    store.versions[versionId] = version;
    trip.currentVersionId = versionId;
    if (prev) prev.supersededBy = versionId;
    return version;
  }

  function recompute(tripId, body = {}, opts = {}) {
    return withWrite(opts.idempotencyKey, { tripId, body }, async () => {
      const trip = mustTrip(tripId);
      const current = decisions.data.versions[trip.currentVersionId];
      if (current.departed) throw conflict("ALREADY_DEPARTED", "队伍已签到出发，不能改写结论；新信息只触发风险升级");
      const next = produceVersion(trip, { reason: "MANUAL_RECOMPUTE" });
      await decisions.persist();
      await audit.append("DECISION_RECOMPUTE", { tripId, versionId: next.versionId, requestedBy: body.by ?? null });
      await audit.append("DECISION_VERSION", decisionAudit(next));
      return publicVersion(next, trip);
    });
  }

  // ---------- 签到出发 ----------

  function checkIn(tripId, body = {}, opts = {}) {
    return withWrite(opts.idempotencyKey, { tripId, body }, async () => {
      const trip = mustTrip(tripId);
      const version = decisions.data.versions[trip.currentVersionId];
      if (!version.departed) {
        const at = body.at ? Date.parse(body.at) : clock();
        if (Number.isNaN(at)) throw badRequest("INVALID_TIME", "at 必须是 ISO 8601 时间");
        version.departed = true;
        version.departedAtMs = at;
        version.departedAtIso = isoUtc(at);
        await decisions.persist();
        await audit.append("TEAM_DEPARTED", {
          tripId, versionId: version.versionId, statusAtDeparture: version.status,
          effectiveStatusAtDeparture: effectiveStatus(version),
          triggeredSegmentIds: version.triggeredSegmentIds, at: isoUtc(at),
          acknowledgedBy: body.by ?? null,
          departedUnderRisk: effectiveStatus(version) !== "GO",
        });
      }
      return publicVersion(version, trip);
    });
  }

  /**
   * 出发后的升级评估：用当前预报全集重算（仅取证），与既有最高等级比较，只升不降；
   * 原版本 status/restrictions 永不修改，升级与领队通知作为追加记录保存。
   */
  function buildEscalation(departedVersion) {
    const { route, members } = departedVersion.snapshot;
    const fresh = forecasts.data.filter((r) => r.routeId === departedVersion.routeId);
    const result = evaluateTrip({ route, members, revisions: fresh });
    const level = postDepartureLevel(result);
    const currentMax = departedVersion.escalations.reduce(
      (acc, e) => (riskRank(e.level) > riskRank(acc) ? e.level : acc), "NORMAL");
    if (riskRank(level) <= riskRank(currentMax)) return null;

    const now = clock();
    const esc = {
      seq: departedVersion.escalations.length + 1,
      atMs: now,
      atIso: isoUtc(now),
      level,
      status: result.status,
      restrictions: result.restrictions,
      advisories: result.advisories,
      triggeredSegmentIds: result.triggeredSegmentIds,
      forecastBasis: buildBasis(route, fresh),
      inputFingerprint: fingerprint(route, members, fresh, result.policyVersion),
      notification: {
        target: "LEADER",
        channel: "LEADER_BULLETIN",
        urgent: riskRank(level) >= 3,
        message: escalationMessage(level, departedVersion, result),
      },
    };
    departedVersion.escalations.push(esc);
    departedVersion.notifications.push({
      atMs: now, atIso: esc.atIso, escalationSeq: esc.seq,
      target: esc.notification.target, channel: esc.notification.channel,
      urgent: esc.notification.urgent, message: esc.notification.message,
    });
    return esc;
  }

  // ---------- 人工复核 ----------

  function requestReview(tripId, body = {}, opts = {}) {
    return withWrite(opts.idempotencyKey, { tripId, body }, async () => {
      requireString(body.reason ?? "", "reason");
      const trip = mustTrip(tripId);
      const version = decisions.data.versions[trip.currentVersionId];
      version.manualReview = {
        status: "PENDING",
        requestedBy: body.by ?? "LEADER",
        reason: body.reason,
        requestedAt: isoUtc(clock()),
        resolution: null,
      };
      await decisions.persist();
      await audit.append("MANUAL_REVIEW_REQUESTED", {
        tripId, versionId: version.versionId, reason: body.reason,
        by: body.by ?? "LEADER", departed: version.departed,
      });
      return publicVersion(version, trip);
    });
  }

  function resolveReview(tripId, body = {}, opts = {}) {
    return withWrite(opts.idempotencyKey, { tripId, body }, async () => {
      const decision = String(body.decision ?? "").toUpperCase();
      if (!["GO", "HOLD"].includes(decision)) throw badRequest("INVALID_REVIEW", "decision 必须是 GO 或 HOLD");
      requireString(body.by ?? "", "by");
      const trip = mustTrip(tripId);
      const version = decisions.data.versions[trip.currentVersionId];
      if (!version.manualReview || version.manualReview.status !== "PENDING") {
        throw conflict("NO_PENDING_REVIEW", "当前版本没有待处理的人工复核");
      }
      version.manualReview = {
        ...version.manualReview,
        status: "RESOLVED",
        resolution: { decision, by: body.by, note: body.note ?? "", resolvedAt: isoUtc(clock()) },
      };
      await decisions.persist();
      await audit.append("MANUAL_REVIEW_RESOLVED", {
        tripId, versionId: version.versionId, decision, by: body.by, note: body.note ?? "",
        previousAutomatedStatus: version.status,
      });
      return publicVersion(version, trip);
    });
  }

  // ---------- 查询 ----------

  function getRoute(routeId) {
    const route = routes.data[routeId];
    if (!route) throw notFound("ROUTE_NOT_FOUND", `路线 ${routeId} 不存在`);
    return publicRoute(route);
  }

  function listRoutes() {
    return Object.values(routes.data).map(publicRoute);
  }

  function getMember(memberId) {
    const member = roster.data[memberId];
    if (!member) throw notFound("MEMBER_NOT_FOUND", `成员 ${memberId} 不存在`);
    return publicMember(member);
  }

  function listMembers() {
    return Object.values(roster.data).map(publicMember);
  }

  function getTrip(tripId) {
    const trip = decisions.data.trips[tripId];
    if (!trip) throw notFound("TRIP_NOT_FOUND", `行程 ${tripId} 不存在`);
    return publicVersion(decisions.data.versions[trip.currentVersionId], trip);
  }

  function listTrips() {
    return Object.values(decisions.data.trips).map((trip) => {
      const v = decisions.data.versions[trip.currentVersionId];
      return {
        tripId: trip.tripId, routeId: trip.routeId, currentVersionId: v.versionId,
        automatedStatus: v.status, effectiveStatus: effectiveStatus(v),
        departed: v.departed, sequence: v.sequence,
        escalation: v.escalations.length ? v.escalations[v.escalations.length - 1].level : null,
      };
    });
  }

  function getVersion(versionId) {
    const version = decisions.data.versions[versionId];
    if (!version) throw notFound("VERSION_NOT_FOUND", `结论版本 ${versionId} 不存在`);
    return publicVersion(version, decisions.data.trips[version.tripId]);
  }

  function listVersions(tripId) {
    if (!decisions.data.trips[tripId]) throw notFound("TRIP_NOT_FOUND", `行程 ${tripId} 不存在`);
    return Object.values(decisions.data.versions)
      .filter((v) => v.tripId === tripId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((v) => publicVersion(v, decisions.data.trips[tripId]));
  }

  /** 用版本保存的输入快照重放纯函数，核对结果与指纹是否仍然一致。 */
  function verifyVersion(versionId) {
    const version = decisions.data.versions[versionId];
    if (!version) throw notFound("VERSION_NOT_FOUND", `结论版本 ${versionId} 不存在`);
    const { route, members, revisions } = version.snapshot;
    const result = evaluateTrip({ route, members, revisions });
    const fp = fingerprint(route, members, revisions, version.policyVersion);
    const strip = (r) => ({
      status: r.status, restrictions: r.restrictions,
      advisories: r.advisories, triggeredSegmentIds: r.triggeredSegmentIds,
    });
    return {
      versionId,
      storedStatus: version.status,
      replayStatus: result.status,
      replayMatchesStored: stableStringify(strip(result)) === stableStringify(strip(version)),
      fingerprintMatches: fp === version.inputFingerprint,
      fingerprint: fp,
    };
  }

  function auditEntries() {
    return audit.readAll();
  }

  function auditVerify() {
    return audit.verify();
  }

  // ---------- 辅助 ----------

  function mustTrip(tripId) {
    const trip = decisions.data.trips[tripId];
    if (!trip) throw notFound("TRIP_NOT_FOUND", `行程 ${tripId} 不存在`);
    return trip;
  }

  /** 用当前输入重算，比较与现行版本的结论本体是否发生实质变化。 */
  function currentResultSignature(trip) {
    const route = routes.data[trip.routeId];
    const prev = decisions.data.versions[trip.currentVersionId];
    // 沿用版本既定成员顺序，避免数组排列差异造成假性变化
    const members = prev.memberIds.map((id) => roster.data[id]).filter(Boolean);
    const revs = forecasts.data.filter((r) => r.routeId === trip.routeId);
    const result = evaluateTrip({ route, members, revisions: revs });
    const signatureNow = stableStringify({
      status: result.status, restrictions: result.restrictions,
      advisories: result.advisories, triggeredSegmentIds: result.triggeredSegmentIds,
    });
    const signaturePrev = stableStringify({
      status: prev.status, restrictions: prev.restrictions,
      advisories: prev.advisories, triggeredSegmentIds: prev.triggeredSegmentIds,
    });
    return { result, changed: signatureNow !== signaturePrev };
  }

  function buildBasis(route, revs) {
    // 每个计划小时槽、每个来源实际采用的事件版本，值班员可逐格核对“用了哪版预报”
    const usedEventIds = new Set();
    const bySlot = [];
    for (const seg of route.segments) {
      const bySource = new Map();
      for (const rev of revs) bySource.set(rev.source, [...(bySource.get(rev.source) ?? []), rev]);
      for (let t = hourFloor(seg.startMs); t < seg.endMs; t += HOUR_MS) {
        for (const [source, list] of bySource) {
          const picked = pickEffective(list, t);
          if (!picked) continue;
          usedEventIds.add(picked.eventId);
          bySlot.push({ segmentId: seg.segmentId, hour: isoUtc(t), source, eventId: picked.eventId, revision: picked.revision });
        }
      }
    }
    return {
      usedEventIds: [...usedEventIds].sort(),
      consideredEvents: revs.map((r) => ({
        eventId: r.eventId, source: r.source, revision: r.revision,
        issuedAt: r.raw.issuedAt, validFrom: r.raw.validFrom, validTo: r.raw.validTo,
      })).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
      bySlot: bySlot.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    };
  }

  return {
    putRoute, putMember, ingestForecast, createTrip, recompute, checkIn,
    requestReview, resolveReview, getTrip, listTrips, getVersion, listVersions,
    verifyVersion, auditEntries, auditVerify,
    getRoute, listRoutes, getMember, listMembers,
  };
}

/** 同 effectiveRevision 的确定性规则：最高 revision，平局依次取 issuedAt、eventId 最大者。 */
function pickEffective(list, hourMs) {
  let picked = null;
  for (const rev of list) {
    if (hourMs < rev.validFrom || hourMs >= rev.validTo) continue;
    if (picked === null
      || rev.revision > picked.revision
      || (rev.revision === picked.revision && rev.issuedAt > picked.issuedAt)
      || (rev.revision === picked.revision && rev.issuedAt === picked.issuedAt && rev.eventId > picked.eventId)) {
      picked = rev;
    }
  }
  return picked;
}

function fingerprint(route, members, revisions, policyVersion) {
  // 只纳入决定计算结果的规范化输入；未知扩展字段保留在版本快照中，但不影响指纹
  const canonical = {
    p: policyVersion,
    route: {
      routeId: route.routeId,
      segments: route.segments.map((s) => ({
        segmentId: s.segmentId, startMs: s.startMs, endMs: s.endMs, limits: s.limits,
      })),
    },
    members: members
      .map((m) => ({ memberId: m.memberId, tolerance: m.tolerance }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId)),
    forecasts: revisions.map((r) => ({
      eventId: r.eventId, source: r.source, routeId: r.routeId, revision: r.revision,
      issuedAt: r.issuedAt, validFrom: r.validFrom, validTo: r.validTo, values: r.values,
    })).sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
  return sha256(stableStringify(canonical));
}

function decisionAudit(v) {
  return {
    tripId: v.tripId, versionId: v.versionId, sequence: v.sequence,
    status: v.status, reason: v.reason, triggerEventId: v.triggerEventId,
    supersedes: v.supersedes, inputFingerprint: v.inputFingerprint,
    usedForecastEvents: v.forecastBasis.usedEventIds,
    triggeredSegmentIds: v.triggeredSegmentIds, policyVersion: v.policyVersion,
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function effectiveStatus(v) {
  if (v.manualReview?.status === "PENDING") return "MANUAL_REVIEW";
  if (v.manualReview?.status === "RESOLVED") return v.manualReview.resolution.decision;
  return v.status;
}

function escalationMessage(level, version, result) {
  const segs = result.triggeredSegmentIds.join("、") || "无具体路段";
  return `【风险升级 ${level}】${version.tripId} 已出发，原结论 ${version.status} 保持不变；最新预报使 ${segs} 触发限制，请领队立即评估避险。`;
}

function publicRoute(route) {
  return {
    routeId: route.routeId, name: route.name, attributes: route.attributes,
    segments: route.segments.map((s) => ({
      segmentId: s.segmentId, name: s.name, fromWaypoint: s.fromWaypoint, toWaypoint: s.toWaypoint,
      elevationM: s.elevationM, plannedStart: s.plannedStart, plannedEnd: s.plannedEnd,
      limits: s.limits, attributes: s.attributes,
    })),
  };
}

function publicMember(member) {
  return { memberId: member.memberId, name: member.name, tolerance: member.tolerance, attributes: member.attributes };
}

function publicVersion(v) {
  return {
    versionId: v.versionId,
    tripId: v.tripId,
    routeId: v.routeId,
    sequence: v.sequence,
    automatedStatus: v.status,
    effectiveStatus: effectiveStatus(v),
    reason: v.reason,
    triggerEventId: v.triggerEventId,
    supersedes: v.supersedes,
    superseded: v.supersededBy !== null,
    supersededBy: v.supersededBy,
    policyVersion: v.policyVersion,
    createdAt: v.createdAtIso,
    memberIds: v.memberIds,
    departed: v.departed,
    departedAt: v.departedAtIso,
    triggeredSegmentIds: v.triggeredSegmentIds,
    restrictions: v.restrictions,
    advisories: v.advisories,
    forecastBasis: v.forecastBasis,
    inputFingerprint: v.inputFingerprint,
    manualReview: v.manualReview,
    escalations: v.escalations.map((e) => ({
      seq: e.seq, at: e.atIso, level: e.level, status: e.status,
      triggeredSegmentIds: e.triggeredSegmentIds, restrictions: e.restrictions,
      advisories: e.advisories, forecastBasis: e.forecastBasis,
      inputFingerprint: e.inputFingerprint, notification: e.notification,
    })),
    notifications: v.notifications.map((n) => ({
      at: n.atIso, escalationSeq: n.escalationSeq, target: n.target,
      channel: n.channel, urgent: n.urgent, message: n.message,
    })),
  };
}

export { POLICY_VERSION };
