// 放行策略：气象要素按海拔分级阈值，成员耐受能力只会让阈值更严。
// 等级：GO（可通行）< CAUTION（谨慎通行/附加条件）< NO_GO（禁止进山）。

export const LEVELS = Object.freeze({
  GO: 0,
  CAUTION: 1,
  NO_GO: 2,
});

export const LEVEL_NAMES = ["GO", "CAUTION", "NO_GO"];

export function worstLevel(a, b) {
  return LEVELS[a] >= LEVELS[b] ? a : b;
}

// 每个要素按 minElevM 从高到低匹配；lowerBetter 的要素（能见度）阈值表示下限。
export const DEFAULT_POLICY = Object.freeze({
  policyId: "standard-ridge-policy-2026",
  measures: {
    windGustKph: {
      label: "阵风风速",
      unit: "km/h",
      tiers: [
        { minElevM: 2500, cautionAt: 50, noGoAt: 70 },
        { minElevM: 1500, cautionAt: 62, noGoAt: 83 },
        { minElevM: 0, cautionAt: 75, noGoAt: 100 },
      ],
    },
    visibilityM: {
      label: "能见度",
      unit: "m",
      lowerIsWorse: true, // 能见度越高越好，阈值是"低于即触发"
      tiers: [
        { minElevM: 2500, cautionAt: 500, noGoAt: 200 },
        { minElevM: 1500, cautionAt: 300, noGoAt: 100 },
        { minElevM: 0, cautionAt: 200, noGoAt: 50 },
      ],
    },
    precipitationMm: {
      label: "累计降水",
      unit: "mm",
      cumulative: true, // 窗口累计量：按暴露时长占比分摊
      tiers: [
        { minElevM: 2500, cautionAt: 8, noGoAt: 15 },
        { minElevM: 1500, cautionAt: 10, noGoAt: 20 },
        { minElevM: 0, cautionAt: 15, noGoAt: 30 },
      ],
    },
  },
  // 同一小时不同来源差值超过该幅度即记为"来源矛盾"，取值采用更危险一侧。
  conflicts: {
    windGustKph: { delta: 10 },
    visibilityM: { delta: 200 },
    precipitationMm: { delta: 5 },
  },
});

export function tierFor(policy, measure, elevationM) {
  const spec = policy.measures[measure];
  if (!spec) throw new TypeError(`策略未定义要素 ${measure}`);
  return spec.tiers.find((t) => elevationM >= t.minElevM) ?? spec.tiers[spec.tiers.length - 1];
}

/**
 * 成员耐受（members[].tolerances，单位与策略一致）与策略分级取交集：
 * - 越高越糟的要素（阵风、降水）：耐受值是个人硬上限，达到即按 NO_GO；
 * - 越低越糟的要素（能见度）：耐受值是个人所需下限，低于即按 NO_GO。
 * 未声明的成员沿用策略阈值。
 */
export function effectiveThresholds(policy, members, measure, elevationM) {
  const tier = tierFor(policy, measure, elevationM);
  const spec = policy.measures[measure];
  let cautionAt = tier.cautionAt;
  let noGoAt = tier.noGoAt;
  const constrainedBy = [];
  for (const m of members ?? []) {
    const limit = m?.tolerances?.[measure];
    if (typeof limit !== "number") continue;
    constrainedBy.push({ memberId: m.memberId, limit });
    if (spec.lowerIsWorse) {
      // 个人下限更高时收紧（阈值整体上移）
      if (limit > noGoAt) noGoAt = limit;
      if (limit > cautionAt) cautionAt = limit;
    } else {
      // 个人上限更低时收紧；硬上限处即 NO_GO
      if (limit < noGoAt) noGoAt = limit;
      if (limit < cautionAt) cautionAt = limit;
    }
  }
  return { cautionAt, noGoAt, constrainedBy };
}

export function classify(spec, thresholds, value) {
  if (spec.lowerIsWorse) {
    // 越高越好：低于阈值触发
    if (value <= thresholds.noGoAt) return "NO_GO";
    if (value <= thresholds.cautionAt) return "CAUTION";
    return "GO";
  }
  // 越高越糟：达到阈值触发
  if (value >= thresholds.noGoAt) return "NO_GO";
  if (value >= thresholds.cautionAt) return "CAUTION";
  return "GO";
}
