/**
 * 放行策略常量。规则版本号进入每次结论的输入指纹，
 * 策略调整后新旧结论可区分、可追溯。
 */
export const POLICY_VERSION = "p-2026-09-v1";

/**
 * 气象因子：
 * - dir = "max" 表示越大越危险（不超过上限），"min" 表示越小越危险（不低于下限）
 * - conflictDelta：多源观测差值超过该阈值即记为来源矛盾
 */
export const FACTORS = {
  windGustKph: { label: "阵风", dir: "max", conflictDelta: 15 },
  visibilityM: { label: "能见度", dir: "min", conflictDelta: 400 },
  precipitationMm: { label: "小时降水量", dir: "max", conflictDelta: 5 },
};

export const RISK_LEVELS = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];

export function riskRank(level) {
  const i = RISK_LEVELS.indexOf(level);
  return i === -1 ? -1 : i;
}

/** 按最危险值与限制之比给出风险等级；仅在已经触发限制时使用。 */
export function severityForRatio(ratio) {
  if (ratio >= 1.5) return "CRITICAL";
  if (ratio >= 1.25) return "HIGH";
  return "ELEVATED";
}

/**
 * 出发后的风险升级映射（只升不降）：
 * - 所有来源一致超限：按超限幅度定级
 * - 矛盾且最坏包络超限（有无更安全来源）：HIGH
 * - 仅缺测：ELEVATED 提醒领队
 */
export function postDepartureLevel(result) {
  if (result.status === "HOLD") {
    let level = "ELEVATED";
    for (const restriction of result.restrictions) {
      if (riskRank(restriction.severity) > riskRank(level)) level = restriction.severity;
    }
    return level;
  }
  if (result.status === "MANUAL_REVIEW") {
    return result.restrictions.some((r) => r.breach === "MIXED_BREACH") ? "HIGH" : "ELEVATED";
  }
  return "NORMAL";
}
