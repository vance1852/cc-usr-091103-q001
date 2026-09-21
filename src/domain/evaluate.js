import { parseInstant, zonedHourKey, hourKeyToMs, exposureHours } from "./time.js";
import { effectiveThresholds, classify, worstLevel, tierFor } from "./policy.js";
import { sha256, stableStringify } from "./hash.js";

const HOUR_MS = 3_600_000;

/**
 * 把预报信封的 values 规范化为 measure -> Map<hourKey, {value, kind}>
 * kind: "hourly"（逐时）或 "scalar"（整段窗口标量，按交集比例分摊累计量）。
 */
export function normalizeValues(events, offsetMin) {
  const perMeasure = new Map();
  for (const ev of events) {
    const from = parseInstant(ev.validFrom, "validFrom");
    const to = parseInstant(ev.validTo, "validTo");
    for (const [measure, raw] of Object.entries(ev.values ?? {})) {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        for (const hour of exposureHours(from, Math.max(to, from + 1), offsetMin)) {
          add(perMeasure, measure, hour, { event: ev, kind: "scalar", raw: raw, windowFrom: from, windowTo: to });
        }
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [hour, v] of Object.entries(raw)) {
          if (typeof v !== "number" || !Number.isFinite(v)) continue;
          const hMs = hourKeyToMs(hour);
          if (hMs < from || hMs + HOUR_MS > to) continue; // 逐时值必须落在适用区间内
          add(perMeasure, measure, zonedHourKey(hMs, offsetMin), { event: ev, kind: "hourly", raw: v });
        }
      }
    }
  }
  return perMeasure;
}

function add(map, measure, hour, rec) {
  if (!map.has(measure)) map.set(measure, new Map());
  const m = map.get(measure);
  if (!m.has(hour)) m.set(hour, []);
  m.get(hour).push(rec);
}

function pickLatestPerSource(records) {
  const bySource = new Map();
  for (const r of records) {
    const cur = bySource.get(r.event.source);
    if (!cur || r.event.revision > cur.event.revision ||
      (r.event.revision === cur.event.revision && parseInstant(r.event.issuedAt) > parseInstant(cur.event.issuedAt))) {
      bySource.set(r.event.source, r);
    }
  }
  return [...bySource.values()];
}

function effectiveValue(rec, hourMs, cumulative) {
  if (rec.kind === "hourly" || !cumulative) return rec.raw;
  const lo = Math.max(rec.windowFrom, hourMs);
  const hi = Math.min(rec.windowTo, hourMs + HOUR_MS);
  const overlap = Math.max(0, hi - lo);
  return rec.raw * (overlap / (rec.windowTo - rec.windowFrom));
}

function conservativePick(spec, candidates) {
  return spec.lowerIsWorse
    ? candidates.reduce((a, b) => (a.value <= b.value ? a : b))
    : candidates.reduce((a, b) => (a.value >= b.value ? a : b));
}

/**
 * 纯函数：依据行程、路线、截至某时刻已知的预报事件计算气象评估。
 * 不读系统时间；cutoffMs 由调用方显式给定，保证可重复。
 *
 * @returns 每路段、每小时、每要素的判定与所采用的预报版本，外加缺测/矛盾清单。
 */
export function evaluateWeather({ trip, route, events, policy, cutoffMs, offsetMin, asOfMs }) {
  const segments = new Map(route.segments.map((s) => [s.segmentId, s]));
  const admissible = events
    .filter((e) => e.routeId === route.routeId && parseInstant(e.issuedAt) <= cutoffMs)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  const normalized = normalizeValues(admissible, offsetMin);

  const dataGaps = [];
  const conflicts = [];
  const seenConflict = new Map();
  const adoptedEventIds = new Set();
  const segmentResults = [];

  // 已出发队伍只评估尚未走完的路段。
  const pendingItinerary = asOfMs === undefined
    ? trip.itinerary
    : trip.itinerary.filter((item) => parseInstant(item.leaveAt, `${item.segmentId}.leaveAt`) > asOfMs);

  for (const item of pendingItinerary) {
    const seg = segments.get(item.segmentId);
    if (!seg) throw new TypeError(`行程引用了路线中不存在的路段 ${item.segmentId}`);
    const enterMs = parseInstant(item.enterAt, `${item.segmentId}.enterAt`);
    const leaveMs = parseInstant(item.leaveAt, `${item.segmentId}.leaveAt`);
    const clipFromMs = asOfMs === undefined ? enterMs : Math.max(enterMs, asOfMs);
    const hours = exposureHours(clipFromMs, leaveMs, offsetMin);

    const measures = {};
    let segmentLevel = "GO";
    const restrictions = [];

    for (const measure of Object.keys(policy.measures)) {
      const spec = policy.measures[measure];
      const thresholds = effectiveThresholds(policy, trip.members, measure, seg.maxElevM);
      const hourRecords = [];
      let measureLevel = "GO";
      let precipTotal = 0;

      for (const hour of hours) {
        const hourMs = hourKeyToMs(hour);
        const raw = normalized.get(measure)?.get(hour) ?? [];
        const latest = pickLatestPerSource(raw);
        const candidates = latest.map((r) => ({
          value: effectiveValue(r, hourMs, spec.cumulative === true),
          source: r.event.source,
          revision: r.event.revision,
          eventId: r.event.eventId,
          issuedAt: r.event.issuedAt,
          kind: r.kind,
        }));

        if (candidates.length === 0) {
          measureLevel = worstLevel(measureLevel, "NO_GO");
          segmentLevel = worstLevel(segmentLevel, "NO_GO");
          dataGaps.push({ segmentId: seg.segmentId, hour, measure, elevationM: seg.maxElevM });
          hourRecords.push({ hour, status: "MISSING", level: "NO_GO" });
          restrictions.push({ measure, reason: "MISSING_FORECAST", hour });
          continue;
        }

        const adopted = conservativePick(spec, candidates);
        adoptedEventIds.add(adopted.eventId);

        // 来源矛盾：同一小时任意两来源差值超过策略容差。
        // 同 (measure,hour) 的冲突会在多个路段评估中重复出现，只记录一次并汇总路段。
        const delta = Math.max(...candidates.map((c) => c.value)) - Math.min(...candidates.map((c) => c.value));
        const tolerance = policy.conflicts[measure]?.delta;
        const isConflict = candidates.length > 1 && typeof tolerance === "number" && delta > tolerance;
        let conflict = false;
        if (isConflict) {
          const key = `${measure}|${hour}`;
          let rec = seenConflict.get(key);
          if (!rec) {
            rec = {
              measure,
              hour,
              segmentIds: [seg.segmentId],
              valuesBySource: Object.fromEntries(candidates.map((c) => [c.source, { value: round(c.value), revision: c.revision, eventId: c.eventId }])),
              delta: round(delta),
              tolerance,
              adopted: { source: adopted.source, value: round(adopted.value) },
              resolution: "采用更危险一侧",
            };
            conflicts.push(rec);
            seenConflict.set(key, rec);
          } else if (!rec.segmentIds.includes(seg.segmentId)) {
            rec.segmentIds.push(seg.segmentId);
          }
          conflict = true;
        }

        if (spec.cumulative) {
          precipTotal += adopted.value;
          hourRecords.push({ hour, status: conflict ? "CONFLICT" : "OK", adopted: { ...adopted, value: round(adopted.value) }, candidates: candidates.map((c) => ({ ...c, value: round(c.value) })) });
        } else {
          const level = classify(spec, thresholds, adopted.value);
          measureLevel = worstLevel(measureLevel, level);
          if (level !== "GO") {
            restrictions.push({
              measure,
              reason: level === "NO_GO" ? "THRESHOLD_EXCEEDED" : "CAUTION_THRESHOLD",
              hour,
              value: round(adopted.value),
              thresholds,
              adoptedFrom: { source: adopted.source, revision: adopted.revision, eventId: adopted.eventId },
            });
          }
          hourRecords.push({ hour, status: conflict ? "CONFLICT" : "OK", level, adopted: { ...adopted, value: round(adopted.value) }, candidates: candidates.map((c) => ({ ...c, value: round(c.value) })) });
        }
      }

      if (spec.cumulative) {
        const level = classify(spec, thresholds, precipTotal);
        measureLevel = level;
        if (level !== "GO") {
          restrictions.push({
            measure,
            reason: level === "NO_GO" ? "THRESHOLD_EXCEEDED" : "CAUTION_THRESHOLD",
            windowValue: round(precipTotal),
            thresholds,
          });
        }
      }

      segmentLevel = worstLevel(segmentLevel, measureLevel);
      measures[measure] = {
        elevationTier: tierFor(policy, measure, seg.maxElevM),
        effectiveThresholds: { cautionAt: thresholds.cautionAt, noGoAt: thresholds.noGoAt },
        constrainedBy: thresholds.constrainedBy,
        level: measureLevel,
        hours: hourRecords,
        ...(spec.cumulative ? { windowValue: round(precipTotal) } : {}),
      };
    }

    segmentResults.push({
      segmentId: seg.segmentId,
      name: seg.name,
      maxElevM: seg.maxElevM,
      enterAt: item.enterAt,
      leaveAt: item.leaveAt,
      level: segmentLevel,
      measures,
      restrictions,
    });
  }

  const overallLevel = segmentResults.reduce((w, s) => worstLevel(w, s.level), "GO");
  const triggeredSegments = segmentResults.filter((s) => s.level !== "GO").map((s) => s.segmentId);

  const forecastVersions = admissible.map((e) => ({
    eventId: e.eventId,
    source: e.source,
    revision: e.revision,
    issuedAt: e.issuedAt,
    validFrom: e.validFrom,
    validTo: e.validTo,
    adopted: adoptedEventIds.has(e.eventId),
  }));

  const result = {
    policyId: policy.policyId,
    cutoffMs,
    routeId: route.routeId,
    tripId: trip.tripId,
    overallLevel,
    segments: segmentResults,
    triggeredSegments,
    dataGaps,
    conflicts,
    forecastVersions,
  };
  result.contentHash = hashEvaluation(result, { trip, policy });
  return result;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export function hashEvaluation(result, { trip, policy }) {
  const basis = {
    policy,
    trip: {
      tripId: trip.tripId,
      itinerary: trip.itinerary,
      members: (trip.members ?? []).map((m) => ({ memberId: m.memberId, tolerances: m.tolerances ?? {} })),
    },
    cutoffMs: result.cutoffMs,
    forecastVersions: result.forecastVersions.map((v) => [v.eventId, v.source, v.revision, v.issuedAt]),
    segments: result.segments.map((s) => [
      s.segmentId,
      s.maxElevM,
      s.enterAt,
      s.leaveAt,
      Object.values(s.measures).flatMap((mm) => mm.hours.map((h) => [h.hour, h.status, h.level, h.adopted ? [h.adopted.eventId, h.adopted.value] : null])),
    ]),
    dataGaps: result.dataGaps,
    conflicts: result.conflicts,
  };
  return sha256(stableStringify(basis));
}
