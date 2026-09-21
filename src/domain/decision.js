// 把气象评估映射为放行结论（纯函数，不含版本编排与副作用）。

export const DECISIONS = Object.freeze({
  GO: "GO", // 可按计划进山
  CONDITIONAL_GO: "CONDITIONAL_GO", // 附加条件放行
  NO_GO: "NO_GO", // 暂缓进山 / 改线
  PENDING_REVIEW: "PENDING_REVIEW", // 等待人工复核
});

export function decideFromWeather(evaluation) {
  const blocking = evaluation.segments
    .filter((s) => s.restrictions.length > 0)
    .map((s) => ({
      segmentId: s.segmentId,
      level: s.level,
      reasons: s.restrictions.map((r) => ({
        measure: r.measure,
        reason: r.reason,
        ...(r.hour ? { hour: r.hour } : {}),
        ...(r.value !== undefined ? { value: r.value } : {}),
        ...(r.windowValue !== undefined ? { windowValue: r.windowValue } : {}),
        ...(r.adoptedFrom ? { adoptedFrom: r.adoptedFrom } : {}),
      })),
    }));

  const missingSegments = new Set(evaluation.dataGaps.map((g) => g.segmentId));

  if (evaluation.dataGaps.length > 0) {
    return {
      decision: DECISIONS.NO_GO,
      rationale: "关键时段缺测，无法证明高海拔路段满足通行条件，按缺测从严暂缓",
      blocking,
      missingSegments: [...missingSegments],
      conflictCount: evaluation.conflicts.length,
      notifyLeader: true,
    };
  }

  if (evaluation.overallLevel === "NO_GO") {
    return {
      decision: DECISIONS.NO_GO,
      rationale: "一个或多个路段的预报值达到禁止通行阈值",
      blocking,
      conflictCount: evaluation.conflicts.length,
      notifyLeader: true,
    };
  }

  if (evaluation.overallLevel === "CAUTION") {
    return {
      decision: DECISIONS.CONDITIONAL_GO,
      rationale: "部分路段处于谨慎区间，需领队确认附加条件并保持通联",
      conditions: buildConditions(evaluation),
      blocking,
      conflictCount: evaluation.conflicts.length,
      notifyLeader: true,
    };
  }

  return {
    decision: DECISIONS.GO,
    rationale: "全部暴露路段在已知预报下满足通行条件",
    blocking: [],
    conflictCount: evaluation.conflicts.length,
    notifyLeader: evaluation.conflicts.length > 0,
  };
}

function buildConditions(evaluation) {
  const out = [];
  for (const seg of evaluation.segments) {
    for (const r of seg.restrictions) {
      if (r.reason !== "CAUTION_THRESHOLD") continue;
      out.push({
        segmentId: seg.segmentId,
        measure: r.measure,
        until: r.hour,
        requirement:
          r.measure === "visibilityM"
            ? "该路段保持结组、开启定位回报，能见度继续下降即折返"
            : r.measure === "windGustKph"
              ? "通过该路段前向值班员复述阵风实况，超过禁止阈值立即放弃"
              : "关注降水累积，路面积水或打滑时中止该路段",
      });
    }
  }
  return out;
}
