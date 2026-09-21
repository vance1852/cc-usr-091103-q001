import { parseInstant, CLUB_OFFSET_MINUTES } from "../domain/time.js";import { evaluateWeather } from "../domain/evaluate.js";
import { decideFromWeather, DECISIONS } from "../domain/decision.js";
import { LEVELS } from "../domain/policy.js";
import { parseForecastRevision } from "../forecast-contract.js";
import { sha256 } from "../domain/hash.js";

const KNOWN_ROUTE_FIELDS = new Set(["routeId", "name", "segments"]);
const KNOWN_TRIP_FIELDS = new Set(["tripId", "routeId", "leaderId", "plannedStartAt", "members", "itinerary"]);
const KNOWN_SEG_FIELDS = new Set(["segmentId", "name", "maxElevM"]);
const KNOWN_MEMBER_FIELDS = new Set(["memberId", "name", "tolerances"]);

/**
 * 仅附加事件溯源的放行服务。
 * 所有状态变更都是事件；重放只重建读模型，不重放副作用——
 * 副作用（新结论版本、风险升级、领队通知）本身也以事件落盘。
 */
export class ClearanceService {
  #store;
  #policy;
  #offsetMin;
  #clock;
  #notifier;

  constructor(store, { policy, clock = () => new Date().toISOString(), notifier = defaultNotifier, offsetMin = CLUB_OFFSET_MINUTES } = {}) {
    this.#store = store;
    this.#policy = policy;
    this.#clock = clock;
    this.#notifier = notifier;
    this.#offsetMin = offsetMin;
  }

  // ---------- 读模型 ----------

  #routes = new Map();
  #trips = new Map();
  #forecasts = new Map(); // eventId -> envelope
  #decisions = new Map(); // decisionId -> version record
  #tripDecisionIds = new Map(); // tripId -> [decisionId]
  #escalations = new Map();
  #reviews = new Map();
  #notifications = new Map();
  #processedForecastCascade = new Set(); // forecast eventId 已完成级联

  async load() {
    await this.#store.load();
    for (const ev of this.#store.events) this.#apply(ev);
    // 崩溃恢复：级联可能只写了一半，按确定性规则补齐，结果与首次处理一致。
    this.#recoverPendingCascades();
    // 崩溃若发生在"结论/升级落盘后、通知落盘前"，在此补发，保证领队不被漏掉。
    this.#recoverMissingNotifications();
  }

  #apply(rec) {
    const p = rec.payload;
    switch (rec.type) {
      case "RouteRegistered":
        this.#routes.set(p.routeId, p);
        break;
      case "TripPlanned":
        this.#trips.set(p.tripId, p);
        break;
      case "ForecastIngested":
        this.#forecasts.set(p.envelope.eventId, p.envelope);
        break;
      case "ForecastCascadeCompleted":
        this.#processedForecastCascade.add(p.eventId);
        break;
      case "DecisionIssued":
        this.#decisions.set(p.decisionId, p);
        if (!this.#tripDecisionIds.has(p.tripId)) this.#tripDecisionIds.set(p.tripId, []);
        this.#tripDecisionIds.get(p.tripId).push(p.decisionId);
        break;
      case "RiskEscalated":
        this.#escalations.set(p.escalationId, p);
        break;
      case "LeaderNotified":
        this.#notifications.set(p.notificationId, p);
        break;
      case "TripCheckedIn": {
        const t = this.#trips.get(p.tripId);
        if (t) this.#trips.set(p.tripId, { ...t, status: "DEPARTED", checkedInAt: p.at, checkedInDecisionId: p.decisionId });
        break;
      }
      case "TripCompleted": {
        const t = this.#trips.get(p.tripId);
        if (t) this.#trips.set(p.tripId, { ...t, status: "COMPLETED" });
        break;
      }
      case "ReviewRequested":
        this.#reviews.set(p.reviewId, p);
        break;
      case "ReviewResolved": {
        const r = this.#reviews.get(p.reviewId);
        if (r) this.#reviews.set(p.reviewId, { ...r, status: "RESOLVED", resolution: p.resolution, resolvedAt: p.at });
        break;
      }
    }
  }

  // ---------- 注册与计划 ----------

  registerRoute(raw) {
    validateRoute(raw, this.#policy);
    const route = {
      routeId: raw.routeId,
      name: raw.name,
      segments: raw.segments.map((s) => ({
        segmentId: s.segmentId,
        name: s.name,
        maxElevM: s.maxElevM,
        attributes: stripKnown(s, KNOWN_SEG_FIELDS),
      })),
      attributes: stripKnown(raw, KNOWN_ROUTE_FIELDS),
    };
    if (this.#routes.has(route.routeId)) throw badRequest("路线已存在", 409);
    this.#store.append("RouteRegistered", route);
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    return route;
  }

  planTrip(raw) {
    validateTrip(raw, this.#routes, this.#policy);
    const trip = {
      tripId: raw.tripId,
      routeId: raw.routeId,
      leaderId: raw.leaderId,
      plannedStartAt: raw.plannedStartAt,
      status: "PLANNED",
      members: (raw.members ?? []).map((m) => ({
        memberId: m.memberId,
        name: m.name,
        tolerances: m.tolerances ?? {},
        attributes: stripKnown(m, KNOWN_MEMBER_FIELDS),
      })),
      itinerary: raw.itinerary.map((i) => ({ ...i })),
      attributes: stripKnown(raw, KNOWN_TRIP_FIELDS),
    };
    if (this.#trips.has(trip.tripId)) throw badRequest("行程已存在", 409);
    this.#store.append("TripPlanned", trip);
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    return this.computeClearance(trip.tripId);
  }

  // ---------- 预报接入 ----------

  ingestForecast(raw, { idempotencyKey } = {}) {
    const envelope = parseForecastRevision(raw); // 复用既有契约，未知字段进入 attributes
    validateEnvelope(envelope, this.#policy);
    const from = parseInstant(envelope.validFrom, "validFrom");
    const to = parseInstant(envelope.validTo, "validTo");
    if (to <= from) throw badRequest("validTo 必须晚于 validFrom");

    const dedupeKey = idempotencyKey ?? `forecast:${envelope.eventId}`;
    const stored = { envelope: normalizeEnvelope(envelope), receivedAt: this.#clock() };
    const { deduplicated } = this.#store.append("ForecastIngested", stored, {
      dedupeKey,
      identity: stored.envelope, // 同一信封重投即幂等，接收时间不影响身份
    });
    if (!deduplicated) this.#apply(this.#store.events[this.#store.events.length - 1]);
    this.#runCascade(envelope.eventId);
    return { eventId: envelope.eventId, revision: envelope.revision, deduplicated };
  }

  // 一条更正预报到达后：未出发行程重算新版本；已出发只升级风险并通知领队。
  #runCascade(eventId) {
    if (this.#processedForecastCascade.has(eventId)) return;
    const envelope = this.#forecasts.get(eventId);

    for (const trip of this.#trips.values()) {
      if (!tripWindowOverlaps(trip, envelope)) continue;
      if (trip.status === "PLANNED") {
        this.computeClearance(trip.tripId, { reason: "FORECAST_REVISION", triggerEventId: eventId });
      } else if (trip.status === "DEPARTED") {
        this.#escalateIfWorse(trip, envelope);
      }
    }

    this.#store.append("ForecastCascadeCompleted", { eventId });
    this.#apply(this.#store.events[this.#store.events.length - 1]);
  }

  #recoverPendingCascades() {
    for (const envelope of this.#forecasts.values()) {
      if (!this.#processedForecastCascade.has(envelope.eventId)) this.#runCascade(envelope.eventId);
    }
  }

  // 崩溃若发生在"结论/升级/裁定落盘"与"LeaderNotified 落盘"之间，在此补发。
  #recoverMissingNotifications() {
    // 预备：若 MANUAL_OVERRIDE 结论已落盘但 ReviewResolved 丢失（裁定中途崩溃），
    // 依据结论内容把复核闭环，避免出现"裁定生效、复核却永远 OPEN"。
    for (const rec of [...this.#store.events]) {
      if (rec.type !== "DecisionIssued" || rec.payload.basis !== "MANUAL_OVERRIDE") continue;
      const reviewId = rec.payload.trigger?.reviewId;
      const review = reviewId && this.#reviews.get(reviewId);
      if (review && review.status === "OPEN") {
        this.#store.append("ReviewResolved", {
          reviewId,
          recovered: true,
          resolution: {
            verdict: rec.payload.decision.decision,
            by: "duty-officer",
            note: `崩溃恢复：依据已落盘的人工裁定补记。${rec.payload.decision.rationale}`,
            at: rec.payload.issuedAt,
          },
        });
        this.#apply(this.#store.events[this.#store.events.length - 1]);
      }
    }

    const evs = this.#store.events;
    const has = (kind, refId) =>
      evs.some((e) => e.type === "LeaderNotified" && e.payload.content.kind === kind && refIdOf(kind, e.payload.content) === refId);
    const departedBefore = (tripId, seq) =>
      evs.some((e) => e.seq < seq && e.type === "TripCheckedIn" && e.payload.tripId === tripId);

    for (const rec of evs) {
      const p = rec.payload;
      if (rec.type === "DecisionIssued" && p.trigger?.reason && p.trigger.reason !== "INITIAL" && p.basis !== "MANUAL_OVERRIDE") {
        if (!has("CLEARANCE_REVISED", p.decisionId)) {
          const trip = this.#trips.get(p.tripId);
          if (trip) this.#notifyLeader(trip, {
            kind: "CLEARANCE_REVISED",
            decisionId: p.decisionId,
            version: p.version,
            verdict: p.decision.decision,
            trigger: p.trigger,
            recovered: true,
            message: `【补发】放行结论已更新至 v${p.version}（${p.decision.decision}）：${p.decision.rationale}`,
          });
        }
      } else if (rec.type === "RiskEscalated") {
        if (!has("RISK_ESCALATION", p.escalationId)) {
          const trip = this.#trips.get(p.tripId);
          if (trip) this.#notifyLeader(trip, {
            kind: "RISK_ESCALATION",
            escalationId: p.escalationId,
            level: p.newLevel,
            segments: p.triggeredSegments,
            forecast: p.basedOnForecast,
            recovered: true,
            message:
              `【补发·风险升级】预报 ${p.basedOnForecast.source} rev${p.basedOnForecast.revision} 显示风险升至 ${p.newLevel}` +
              `，触发路段：${p.triggeredSegments.join("、")}。原结论未改写，请就地避险或折返。`,
          });
        }
      } else if (rec.type === "ReviewRequested") {
        if (departedBefore(p.tripId, rec.seq) && !has("REVIEW_REQUESTED_DEPARTED", p.reviewId)) {
          const trip = this.#trips.get(p.tripId);
          if (trip) this.#notifyLeader(trip, {
            kind: "REVIEW_REQUESTED_DEPARTED",
            reviewId: p.reviewId,
            reason: p.reason,
            recovered: true,
            message: `【补发】队伍已出发，领队申请人工复核：${p.reason}。原结论不可改写，请值班员直接与领队联络处置。`,
          });
        }
      } else if (rec.type === "ReviewResolved") {
        const reviewId = p.reviewId;
        const departed = evs.some(
          (e) => e.type === "ReviewRequested" && e.payload.reviewId === reviewId && departedBefore(e.payload.tripId, e.seq),
        );
        const kind = departed ? "REVIEW_RESOLVED_DEPARTED" : "REVIEW_RESOLVED";
        if (!has(kind, reviewId)) {
          const req = evs.find((e) => e.type === "ReviewRequested" && e.payload.reviewId === reviewId)?.payload;
          const trip = req && this.#trips.get(req.tripId);
          if (trip) this.#notifyLeader(trip, {
            kind,
            reviewId,
            verdict: p.resolution.verdict,
            recovered: true,
            message: `【补发】值班员裁定：${p.resolution.verdict}。${p.resolution.note ?? ""}`.trim(),
          });
        }
      }
    }
  }

  // ---------- 放行结论（确定性重算） ----------

  computeClearance(tripId, opts = {}) {
    const trip = this.#requireTrip(tripId);
    if (trip.status !== "PLANNED") throw badRequest("队伍已签到出发，原结论不可改写；如情况恶化只记录风险升级", 409);

    // 幂等：初始结论只建一次；同一更正事件触发的重算也只产生一个版本
    // （崩溃恢复重放半截级联时据此收敛到同一份结果）。
    const priorIds0 = this.#tripDecisionIds.get(tripId) ?? [];
    const latest0 = this.#decisions.get(priorIds0[priorIds0.length - 1]);
    if (latest0) {
      if (!opts.reason) return latest0; // 初始结论已存在
      if (opts.triggerEventId && latest0.trigger?.forecastEventId === opts.triggerEventId) return latest0;
    }

    const route = this.#routes.get(trip.routeId);
    const events = [...this.#forecasts.values()]
      .filter((e) => e.routeId === route.routeId)
      .sort((a, b) => parseInstant(a.issuedAt) - parseInstant(b.issuedAt) || a.eventId.localeCompare(b.eventId));
    const cutoffMs = events.length ? Math.max(...events.map((e) => parseInstant(e.issuedAt))) : parseInstant(this.#clock());

    const openReview = [...this.#reviews.values()].find(
      (r) => r.tripId === tripId && r.status === "OPEN",
    );

    const weather = evaluateWeather({ trip, route, events, policy: this.#policy, cutoffMs, offsetMin: this.#offsetMin });
    const auto = decideFromWeather(weather);
    const priorIds = this.#tripDecisionIds.get(tripId) ?? [];
    const version = priorIds.length + 1;

    let basis = "WEATHER";
    let body = auto;
    if (openReview) {
      basis = "MANUAL_REVIEW_PENDING";
      body = {
        decision: DECISIONS.PENDING_REVIEW,
        rationale: `领队已申请人工复核（${openReview.reason}），在值班员裁定前不放行`,
        reviewId: openReview.reviewId,
        supersededAuto: auto.decision,
        notifyLeader: true,
      };
    }

    const decisionId = deterministicDecisionId(tripId, version, basis, weather.contentHash, body);
    if (this.#decisions.has(decisionId)) return this.#decisions.get(decisionId);

    const record = {
      decisionId,
      tripId,
      version,
      basis,
      immutable: true,
      issuedAt: this.#clock(),
      cutoffAt: new Date(cutoffMs).toISOString(),
      trigger: opts.reason ? { reason: opts.reason, forecastEventId: opts.triggerEventId ?? null } : { reason: "INITIAL" },
      tripStatusAtIssue: "PLANNED",
      weather,
      decision: body,
      supersedes: priorIds[priorIds.length - 1] ?? null,
    };
    this.#store.append("DecisionIssued", record);
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    if (opts.reason) {
      this.#notifyLeader(trip, {
        kind: "CLEARANCE_REVISED",
        decisionId: record.decisionId,
        version: record.version,
        verdict: record.decision.decision,
        trigger: record.trigger,
        message: `放行结论已更新至 v${record.version}（${record.decision.decision}）：${record.decision.rationale}`,
      });
    }
    return record;
  }

  // ---------- 签到出发（原决定冻结） ----------

  checkIn(tripId, { at } = {}) {
    const trip = this.#requireTrip(tripId);
    if (trip.status !== "PLANNED") throw badRequest("队伍已出发", 409);
    const ids = this.#tripDecisionIds.get(tripId) ?? [];
    const decisionId = ids[ids.length - 1];
    const latest = this.#decisions.get(decisionId);
    if (!latest) throw badRequest("尚无放行结论，无法签到");
    if (latest.decision.decision === DECISIONS.NO_GO) throw badRequest("当前结论为 NO_GO，禁止带队出发；如有异议请申请人工复核", 409);
    if (latest.decision.decision === DECISIONS.PENDING_REVIEW) throw badRequest("人工复核尚未裁定，不能出发", 409);

    const when = at ?? this.#clock();
    this.#store.append("TripCheckedIn", { tripId, at: when, decisionId });
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    return { tripId, checkedInAt: when, frozenDecisionId: decisionId, decision: latest.decision.decision };
  }

  completeTrip(tripId) {
    const trip = this.#requireTrip(tripId);
    if (trip.status !== "DEPARTED") throw badRequest("只有已出发的行程可以结束", 409);
    this.#store.append("TripCompleted", { tripId, at: this.#clock() });
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    return this.getTrip(tripId);
  }

  // ---------- 出发后的风险升级（唯一允许的变更通道） ----------

  #escalateIfWorse(trip, envelope) {
    const route = this.#routes.get(trip.routeId);
    const events = [...this.#forecasts.values()]
      .filter((e) => e.routeId === route.routeId)
      .sort((a, b) => parseInstant(a.issuedAt) - parseInstant(b.issuedAt) || a.eventId.localeCompare(b.eventId));
    const cutoffMs = parseInstant(envelope.issuedAt);
    const weather = evaluateWeather({
      trip,
      route,
      events,
      policy: this.#policy,
      cutoffMs,
      offsetMin: this.#offsetMin,
      asOfMs: parseInstant(trip.checkedInAt),
    });

    // 出发时冻结结论的等级，叠加此前所有升级，取最严作为已告知领队的基线。
    const frozen = this.#decisions.get(trip.checkedInDecisionId);
    const frozenLevel = mapDecisionLevel(frozen?.decision?.decision ?? "GO");
    const priorEscalations = [...this.#escalations.values()].filter((e) => e.tripId === trip.tripId);
    const baselineLevel = priorEscalations.reduce(
      (worst, e) => (LEVELS[e.newLevel] > LEVELS[worst] ? e.newLevel : worst),
      frozenLevel,
    );

    // 只能升级：没有变糟就什么都不写，绝不改写原结论。
    if (LEVELS[weather.overallLevel] <= LEVELS[baselineLevel]) return;

    const escalationId = `esc_${trip.tripId}_${priorEscalations.length + 1}`;
    const record = {
      escalationId,
      tripId: trip.tripId,
      at: this.#clock(),
      fromLevel: baselineLevel,
      newLevel: weather.overallLevel,
      triggeredSegments: weather.triggeredSegments,
      dataGaps: weather.dataGaps,
      conflicts: weather.conflicts,
      basedOnForecast: { eventId: envelope.eventId, source: envelope.source, revision: envelope.revision },
      adoptedForecastEventIds: weather.forecastVersions.filter((v) => v.adopted).map((v) => v.eventId),
      originalDecisionId: trip.checkedInDecisionId,
      weatherContentHash: weather.contentHash,
      note: "原放行结论保持不变并永久留档；本记录仅为出发后的风险升级",
    };
    this.#store.append("RiskEscalated", record);
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    this.#notifyLeader(trip, {
      kind: "RISK_ESCALATION",
      escalationId,
      level: weather.overallLevel,
      segments: weather.triggeredSegments,
      forecast: { source: envelope.source, revision: envelope.revision, eventId: envelope.eventId },
      message: buildEscalationMessage(trip, weather, envelope),
    });
  }

  // ---------- 人工复核 ----------

  requestReview(tripId, { by, reason }) {
    const trip = this.#requireTrip(tripId);
    if (!reason) throw badRequest("复核必须写明理由");
    const open = [...this.#reviews.values()].find((r) => r.tripId === tripId && r.status === "OPEN");
    if (open) return open;

    const reviewId = `rev_${tripId}_${this.#reviews.size + 1}`;
    const rec = {
      reviewId,
      tripId,
      requestedAt: this.#clock(),
      requestedBy: by ?? trip.leaderId,
      reason,
      status: "OPEN",
    };
    this.#store.append("ReviewRequested", rec);
    this.#apply(this.#store.events[this.#store.events.length - 1]);

    if (trip.status === "PLANNED") {
      // 未出发：结论转为 PENDING_REVIEW 的新版本，等待值班员裁定
      this.computeClearance(tripId, { reason: "REVIEW_REQUESTED" });
    } else {
      // 已出发：不能改写结论，只通知值班员与领队
      this.#notifyLeader(trip, {
        kind: "REVIEW_REQUESTED_DEPARTED",
        reviewId,
        reason,
        message: `队伍已出发，领队申请人工复核：${reason}。原结论不可改写，请值班员直接与领队联络处置。`,
      });
    }
    return rec;
  }

  resolveReview(tripId, { reviewId, by, verdict, note }) {
    const trip = this.#requireTrip(tripId);
    const review = reviewId
      ? this.#reviews.get(reviewId)
      : [...this.#reviews.values()].find((r) => r.tripId === tripId && r.status === "OPEN");
    if (!review || review.tripId !== tripId) throw badRequest("没有待裁定的复核申请");
    if (review.status === "RESOLVED") {
      // 幂等：重复裁定请求返回既有结果，不产生新结论
      const ids = this.#tripDecisionIds.get(tripId) ?? [];
      const override = [...ids.map((id) => this.#decisions.get(id))]
        .find((d) => d?.basis === "MANUAL_OVERRIDE" && d.trigger?.reviewId === review.reviewId);
      return { review, decision: trip.status === "PLANNED" ? override ?? null : null };
    }
    if (![DECISIONS.GO, DECISIONS.CONDITIONAL_GO, DECISIONS.NO_GO].includes(verdict)) {
      throw badRequest("裁定必须是 GO / CONDITIONAL_GO / NO_GO");
    }

    const ids = this.#tripDecisionIds.get(tripId) ?? [];
    const latest = this.#decisions.get(ids[ids.length - 1]);
    const resolution = { verdict, by: by ?? "duty-officer", note: note ?? "", at: this.#clock() };

    if (trip.status === "PLANNED") {
      const version = ids.length + 1;
      const basis = "MANUAL_OVERRIDE";
      const body = {
        decision: verdict,
        rationale: `值班员人工裁定，覆盖自动结论（${latest?.decision?.decision ?? "无"}）：${note ?? "无补充说明"}`,
        reviewId: review.reviewId,
        overriddenDecisionId: latest?.decisionId ?? null,
        weatherContentHash: latest?.weather?.contentHash ?? null,
        notifyLeader: true,
      };
      const decisionId = deterministicDecisionId(tripId, version, basis, latest?.weather?.contentHash ?? "none", body);
      const record = {
        decisionId,
        tripId,
        version,
        basis,
        immutable: true,
        issuedAt: this.#clock(),
        cutoffAt: latest?.cutoffAt ?? null,
        trigger: { reason: "REVIEW_RESOLVED", reviewId: review.reviewId },
        tripStatusAtIssue: "PLANNED",
        weather: latest?.weather ?? null,
        decision: body,
        supersedes: latest?.decisionId ?? null,
      };
      this.#store.append("DecisionIssued", record);
      this.#apply(this.#store.events[this.#store.events.length - 1]);
      this.#store.append("ReviewResolved", { reviewId: review.reviewId, resolution });
      this.#apply(this.#store.events[this.#store.events.length - 1]);
      this.#notifyLeader(trip, {
        kind: "REVIEW_RESOLVED",
        reviewId: review.reviewId,
        verdict,
        message: `人工复核裁定结果：${verdict}。${note ?? ""}`.trim(),
      });
      return { review: { ...review, status: "RESOLVED", resolution }, decision: record };
    }

    // 已出发：裁定只作为处置指令记录，不产生也不修改放行结论
    this.#store.append("ReviewResolved", { reviewId: review.reviewId, resolution });
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    this.#notifyLeader(trip, {
      kind: "REVIEW_RESOLVED_DEPARTED",
      reviewId: review.reviewId,
      verdict,
      message: `值班员对已出发队伍的处置指令：${verdict}。${note ?? ""}`.trim(),
    });
    return { review: { ...review, status: "RESOLVED", resolution }, decision: null };
  }

  #notifyLeader(trip, content) {
    const notificationId = `ntf_${this.#notifications.size + 1}`;
    const delivery = this.#notifier({
      notificationId,
      tripId: trip.tripId,
      leaderId: trip.leaderId,
      ...content,
    });
    const rec = {
      notificationId,
      tripId: trip.tripId,
      leaderId: trip.leaderId,
      at: this.#clock(),
      content,
      delivery,
    };
    this.#store.append("LeaderNotified", rec);
    this.#apply(this.#store.events[this.#store.events.length - 1]);
    return rec;
  }

  // ---------- 辅助 ----------

  #requireTrip(tripId) {
    const trip = this.#trips.get(tripId);
    if (!trip) throw notFound(`行程 ${tripId} 不存在`);
    return trip;
  }

  // ---------- 查询 ----------

  listTrips() {
    return [...this.#trips.values()].map((t) => this.getTrip(t.tripId));
  }

  getTrip(tripId) {
    const trip = this.#requireTrip(tripId);
    const ids = this.#tripDecisionIds.get(tripId) ?? [];
    const versions = ids.map((id) => this.#decisions.get(id));
    const latest = versions.at(-1) ?? null;
    return {
      ...trip,
      route: this.#routes.get(trip.routeId) ? { routeId: trip.routeId, name: this.#routes.get(trip.routeId).name } : null,
      currentDecision: latest && trip.status === "PLANNED" ? summarize(latest) : null,
      frozenDepartureDecision: trip.status === "DEPARTED" || trip.status === "COMPLETED"
        ? summarize(this.#decisions.get(trip.checkedInDecisionId))
        : null,
      decisionVersions: versions.map((v) => ({
        decisionId: v.decisionId,
        version: v.version,
        basis: v.basis,
        issuedAt: v.issuedAt,
        decision: v.decision.decision,
        trigger: v.trigger,
        contentHash: v.weather?.contentHash ?? null,
      })),
      escalations: [...this.#escalations.values()].filter((e) => e.tripId === tripId),
      reviews: [...this.#reviews.values()].filter((r) => r.tripId === tripId),
      notifications: [...this.#notifications.values()].filter((n) => n.tripId === tripId),
    };
  }

  getDecision(decisionId) {
    const d = this.#decisions.get(decisionId);
    if (!d) throw notFound(`结论 ${decisionId} 不存在`);
    return d;
  }

  /**
   * 值班员审计视图：按时间排列的全部相关记录，
   * 可直接回答"采用了哪个预报版本、哪些路段触发限制、原结论是否被改写"。
   */
  auditTrail(tripId) {
    const trip = this.#requireTrip(tripId);
    const routeId = trip.routeId;
    const ids = new Set(this.#tripDecisionIds.get(tripId) ?? []);
    const entries = this.#store.events
      .filter((rec) => {
        const p = rec.payload;
        return (
          p.tripId === tripId ||
          ids.has(p.decisionId) ||
          p.routeId === routeId || // RouteRegistered
          (p.envelope && p.envelope.routeId === routeId) // 该路线全部预报版本（含未采用）
        );
      })
      .map((rec) => ({ seq: rec.seq, at: rec.at, type: rec.type, payload: rec.payload }));
    return entries;
  }
}

// ---------- 辅助 ----------

function refIdOf(kind, content) {
  if (kind === "CLEARANCE_REVISED") return content.decisionId;
  if (kind === "RISK_ESCALATION") return content.escalationId;
  return content.reviewId; // REVIEW_REQUESTED_DEPARTED / REVIEW_RESOLVED(_DEPARTED)
}

function summarize(v) {
  if (!v) return null;
  return {
    decisionId: v.decisionId,
    version: v.version,
    basis: v.basis,
    issuedAt: v.issuedAt,
    cutoffAt: v.cutoffAt,
    decision: v.decision.decision,
    rationale: v.decision.rationale,
    triggeredSegments: v.weather?.triggeredSegments ?? null,
    adoptedForecast: v.weather?.forecastVersions?.filter((f) => f.adopted) ?? null,
    contentHash: v.weather?.contentHash ?? null,
  };
}

function mapDecisionLevel(level) {
  if (level === "CONDITIONAL_GO") return "CAUTION";
  if (level === "CAUTION" || level === "NO_GO" || level === "GO") return level;
  return "GO";
}

function buildEscalationMessage(trip, weather, envelope) {
  const parts = [];
  parts.push(`【风险升级】预报 ${envelope.source} rev${envelope.revision}（${envelope.eventId}）显示风险升至 ${weather.overallLevel}。`);
  if (weather.triggeredSegments.length) parts.push(`触发路段：${weather.triggeredSegments.join("、")}。`);
  if (weather.dataGaps.length) parts.push(`存在缺测时段 ${weather.dataGaps.length} 处，按缺测从严。`);
  parts.push("原放行结论未被改写，请按升级后风险就地评估避险或折返，并保持通联。");
  return parts.join("");
}

function deterministicDecisionId(tripId, version, basis, weatherHash, body) {
  const h = sha256(JSON.stringify([tripId, version, basis, weatherHash, body.decision, body.rationale])).slice(0, 12);
  return `dec_${tripId}_v${version}_${h}`;
}

function tripWindowOverlaps(trip, envelope) {
  const from = parseInstant(envelope.validFrom);
  const to = parseInstant(envelope.validTo);
  return trip.itinerary.some((i) => {
    const e = parseInstant(i.enterAt);
    const l = parseInstant(i.leaveAt);
    return l > from && e < to;
  });
}

function normalizeEnvelope(envelope) {
  const values = {};
  for (const [k, v] of Object.entries(envelope.values)) {
    values[k] = v && typeof v === "object" ? { ...v } : v;
  }
  return {
    eventId: envelope.eventId,
    source: envelope.source,
    routeId: envelope.routeId,
    revision: envelope.revision,
    issuedAt: envelope.issuedAt,
    validFrom: envelope.validFrom,
    validTo: envelope.validTo,
    values,
    attributes: envelope.attributes ?? {},
  };
}

function stripKnown(obj, known) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !known.has(k)));
}

function validateEnvelope(envelope, policy) {
  for (const [measure, v] of Object.entries(envelope.values)) {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw badRequest(`values.${measure} 非法`);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [hour, x] of Object.entries(v)) {
        parseInstant(hour, `values.${measure} 的小时键`); // 强制带时区偏移，避免按服务器本地时区解析
        if (typeof x !== "number" || !Number.isFinite(x)) throw badRequest(`values.${measure}.${hour} 必须是数字（缺测请省略该小时）`);
      }
    } else {
      throw badRequest(`values.${measure} 必须是数字或逐时对象`);
    }
  }
  parseInstant(envelope.issuedAt, "issuedAt");
  return envelope;
}

function validateRoute(raw, policy) {
  if (!raw || typeof raw !== "object") throw badRequest("路线必须是对象");
  for (const f of ["routeId", "name", "segments"]) if (raw[f] === undefined || raw[f] === null) throw badRequest(`缺少字段 ${f}`);
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) throw badRequest("路线至少包含一个路段");
  const ids = new Set();
  for (const s of raw.segments) {
    for (const f of ["segmentId", "name", "maxElevM"]) if (s[f] === undefined || s[f] === null) throw badRequest(`路段缺少字段 ${f}`);
    if (typeof s.maxElevM !== "number" || s.maxElevM < 0) throw badRequest(`${s.segmentId}.maxElevM 非法`);
    if (ids.has(s.segmentId)) throw badRequest(`路段编号重复 ${s.segmentId}`);
    ids.add(s.segmentId);
  }
}

function validateTrip(raw, routes, policy) {
  if (!raw || typeof raw !== "object") throw badRequest("行程必须是对象");
  for (const f of ["tripId", "routeId", "leaderId", "itinerary"]) if (raw[f] === undefined || raw[f] === null) throw badRequest(`缺少字段 ${f}`);
  const route = routes.get(raw.routeId);
  if (!route) throw badRequest(`路线 ${raw.routeId} 未注册`);
  const segIds = new Set(route.segments.map((s) => s.segmentId));
  if (!Array.isArray(raw.itinerary) || raw.itinerary.length === 0) throw badRequest("行程至少包含一个路段计划");
  let prevLeave;
  for (const i of raw.itinerary) {
    if (!segIds.has(i.segmentId)) throw badRequest(`行程引用了路线中不存在的路段 ${i.segmentId}`);
    const e = parseInstant(i.enterAt, `${i.segmentId}.enterAt`);
    const l = parseInstant(i.leaveAt, `${i.segmentId}.leaveAt`);
    if (l <= e) throw badRequest(`${i.segmentId} 的 leaveAt 必须晚于 enterAt`);
    if (prevLeave !== undefined && e < prevLeave) throw badRequest(`${i.segmentId} 的进入时间早于上一路段离开时间`);
    prevLeave = l;
  }
  for (const m of raw.members ?? []) {
    if (!m.memberId) throw badRequest("成员缺少 memberId");
    for (const [measure, limit] of Object.entries(m.tolerances ?? {})) {
      if (!policy.measures[measure]) throw badRequest(`成员 ${m.memberId} 声明了未知要素耐受 ${measure}`);
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) throw badRequest(`成员 ${m.memberId} 的 ${measure} 耐受值非法`);
    }
  }
}

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

const defaultNotifier = ({ notificationId, leaderId, message }) => {
  // 生产环境在此替换为短信/电台网关；返回值会一并写入审计日志。
  console.error(`[notify→${leaderId}] ${message} (${notificationId})`);
  return { channel: "log", deliveredAt: new Date().toISOString() };
};
