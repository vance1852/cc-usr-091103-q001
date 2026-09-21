import { FACTORS, POLICY_VERSION, severityForRatio } from "./policy.js";
import { hourFloor, HOUR_MS, isoUtc, parseTime } from "./time.js";
import { effectiveRevision, valueAt } from "./forecast.js";

/**
 * 纯函数评估：给定路线、成员与各来源预报修订，输出带完整依据的结论。
 * 不读取系统时间、不做 I/O；同样的输入永远得到同样的输出。
 *
 * 状态优先级：HOLD（所有来源一致超限）> MANUAL_REVIEW（矛盾最坏包络超限 / 缺测）> GO。
 */
export function evaluateTrip({ route, members, revisions, policyVersion = POLICY_VERSION }) {
  const restrictions = [];
  const advisories = [];

  for (const rawSeg of route.segments) {
    const seg = normalizeSegment(rawSeg);
    const hours = segmentHours(seg.startMs, seg.endMs);
    for (const factor of Object.keys(FACTORS)) {
      const meta = FACTORS[factor];
      const boundInfo = resolveBound(seg, members, factor);
      const slotResults = hours.map((hourMs) => evaluateSlot(revisions, route.routeId, factor, hourMs, meta));

      if (!boundInfo.governed) {
        // 没有任何路段限制或成员耐受约束该因子：矛盾只作提示，缺测不影响结论
        const conflictSlots = slotResults.filter((s) => s.conflict);
        if (conflictSlots.length > 0) {
          advisories.push({
            type: "SOURCE_CONFLICT",
            segmentId: seg.segmentId,
            factor,
            delta: maxConflictDelta(slotResults),
            threshold: meta.conflictDelta,
            hours: conflictSlots.map(describeSlot),
            note: `${seg.segmentId} 的${meta.label}存在来源分歧，但该因子无适用限制，不改变放行结论`,
          });
        }
        continue;
      }

      const gapSlots = slotResults.filter((s) => s.observed.length === 0);
      const observedSlots = slotResults.filter((s) => s.observed.length > 0);

      if (gapSlots.length > 0) {
        restrictions.push({
          segmentId: seg.segmentId,
          factor,
          bound: boundInfo.effective,
          boundSources: boundInfo.sources,
          memberConstraints: boundInfo.memberConstraints,
          breach: "DATA_GAP",
          severity: "ELEVATED",
          conflict: observedSlots.some((s) => s.conflict),
          hours: gapSlots.map(describeSlot),
          reason: `${seg.segmentId} 计划窗口内有 ${gapSlots.length} 个小时槽的${meta.label}缺测（含无来源覆盖），无法确认满足 ${formatBound(meta, boundInfo.effective)}`,
        });
      }

      const violating = [];
      let worstRatio = 0;
      for (const slot of observedSlots) {
        const worstR = ratio(meta, slot.worst, boundInfo.effective);
        if (violates(meta, slot.worst, boundInfo.effective)) {
          violating.push(slot);
          worstRatio = Math.max(worstRatio, worstR);
        }
      }

      if (violating.length > 0) {
        // 一致性只看“越界槽”：每个越界槽连最安全来源都越界，才算来源一致超限
        const breach = violating.every((s) => violates(meta, s.best, boundInfo.effective))
          ? "CONSISTENT_BREACH"
          : "MIXED_BREACH";
        const worstValue = pickByMeta(meta, violating.map((s) => s.worst), true);
        const bestValue = pickByMeta(meta, violating.map((s) => s.best), false);
        restrictions.push({
          segmentId: seg.segmentId,
          factor,
          bound: boundInfo.effective,
          boundSources: boundInfo.sources,
          memberConstraints: boundInfo.memberConstraints,
          breach,
          severity: severityForRatio(worstRatio),
          ratio: Number(worstRatio.toFixed(3)),
          worstValue,
          bestValue,
          conflict: violating.some((s) => s.conflict) || observedSlots.some((s) => s.conflict),
          hours: violating.map(describeSlot),
          reason: breach === "CONSISTENT_BREACH"
            ? `${seg.segmentId} 的${meta.label}所有来源一致超出限制（阈值 ${boundInfo.effective}，最坏 ${worstValue}）`
            : `${seg.segmentId} 的${meta.label}来源相互矛盾：保守包络 ${worstValue} 超出限制 ${boundInfo.effective}，但存在更安全读数 ${bestValue}，需人工复核`,
        });
      } else {
        const conflictSlots = observedSlots.filter((s) => s.conflict);
        if (conflictSlots.length > 0) {
          advisories.push({
            type: "SOURCE_CONFLICT",
            segmentId: seg.segmentId,
            factor,
            delta: maxConflictDelta(observedSlots),
            threshold: meta.conflictDelta,
            hours: conflictSlots.map(describeSlot),
            note: `${seg.segmentId} 的${meta.label}存在来源分歧，但各来源读数均在限制 ${formatBound(meta, boundInfo.effective)} 内`,
          });
        }
      }
    }
  }

  const triggeredSegmentIds = [...new Set(restrictions.map((r) => r.segmentId))].sort();
  let status = "GO";
  if (restrictions.some((r) => r.breach === "CONSISTENT_BREACH")) status = "HOLD";
  else if (restrictions.length > 0) status = "MANUAL_REVIEW";

  return {
    policyVersion,
    status,
    restrictions,
    advisories,
    triggeredSegmentIds,
  };
}

function normalizeSegment(raw) {
  // 同时接受仓储层表示（startMs/endMs）与原始契约表示（plannedStart/plannedEnd 字符串）
  if (Number.isFinite(raw.startMs) && Number.isFinite(raw.endMs)) return raw;
  return {
    ...raw,
    limits: raw.limits ?? {},
    startMs: parseTime(raw.plannedStart, "segment.plannedStart"),
    endMs: parseTime(raw.plannedEnd, "segment.plannedEnd"),
  };
}

function segmentHours(startMs, endMs) {
  const hours = [];
  for (let t = hourFloor(startMs); t < endMs; t += HOUR_MS) hours.push(t);
  return hours;
}

/** 汇总某小时槽各来源“生效修订”（同来源取最高 revision）的观测值。 */
function evaluateSlot(revisions, filterRouteId, factor, hourMs, meta) {
  const bySource = new Map();
  for (const rev of revisions) {
    if (rev.routeId !== filterRouteId) continue;
    const list = bySource.get(rev.source) ?? [];
    list.push(rev);
    bySource.set(rev.source, list);
  }
  const observed = [];
  const sources = [];
  for (const [source, list] of bySource) {
    const rev = effectiveRevision(list, hourMs);
    if (!rev) continue;
    const value = valueAt(rev, factor, hourMs);
    sources.push({ source, eventId: rev.eventId, revision: rev.revision, value: value ?? null });
    if (value !== null && value !== undefined) {
      observed.push({ source, eventId: rev.eventId, revision: rev.revision, value });
    }
  }
  let worst = null;
  let best = null;
  let conflict = false;
  if (observed.length > 0) {
    const values = observed.map((o) => o.value);
    worst = pickByMeta(meta, values, true);
    best = pickByMeta(meta, values, false);
    conflict = Math.max(...values) - Math.min(...values) > meta.conflictDelta;
  }
  return { hour: hourMs, observed, sourcesAll: sources, worst, best, conflict };
}

function describeSlot(slot) {
  return {
    hour: isoUtc(slot.hour),
    observed: slot.observed.map((o) => ({ source: o.source, eventId: o.eventId, revision: o.revision, value: o.value })),
    sources: slot.sourcesAll,
    worst: slot.worst,
    best: slot.best,
    conflict: slot.conflict,
  };
}

function maxConflictDelta(slots) {
  let delta = 0;
  for (const slot of slots) {
    if (slot.observed.length > 1) {
      const values = slot.observed.map((o) => o.value);
      delta = Math.max(delta, Math.max(...values) - Math.min(...values));
    }
  }
  return Number(delta.toFixed(3));
}

function resolveBound(seg, members, factor) {
  const meta = FACTORS[factor];
  const candidates = [];
  if (seg.limits[factor] !== undefined) candidates.push({ source: "segment", bound: seg.limits[factor] });
  const memberConstraints = [];
  for (const member of members) {
    const tolerance = member.tolerance[factor];
    if (!tolerance) continue;
    const bound = meta.dir === "max" ? tolerance.max : tolerance.min;
    candidates.push({ source: member.memberId, bound });
    if (seg.limits[factor] === undefined || tighter(meta, bound, seg.limits[factor])) {
      memberConstraints.push({ memberId: member.memberId, bound });
    }
  }
  if (candidates.length === 0) return { governed: false };
  let effective = candidates[0].bound;
  for (const c of candidates.slice(1)) if (tighter(meta, c.bound, effective)) effective = c.bound;
  const sources = candidates.filter((c) => c.bound === effective).map((c) => c.source);
  return { governed: true, effective, sources, memberConstraints };
}

function tighter(meta, a, b) {
  return meta.dir === "max" ? a < b : a > b;
}

function violates(meta, value, bound) {
  if (value === null || value === undefined) return false;
  return meta.dir === "max" ? value > bound : value < bound;
}

function ratio(meta, value, bound) {
  if (value === null || value === undefined) return 0;
  return meta.dir === "max" ? value / bound : bound / value;
}

function pickByMeta(meta, values, worst) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  if (nums.length === 0) return null;
  if (meta.dir === "max") return worst ? Math.max(...nums) : Math.min(...nums);
  return worst ? Math.min(...nums) : Math.max(...nums);
}

function formatBound(meta, bound) {
  return `${bound}`;
}
