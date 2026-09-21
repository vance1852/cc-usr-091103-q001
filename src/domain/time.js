export const HOUR_MS = 60 * 60 * 1000;

/** 严格解析带时区偏移的 ISO 8601 时间，返回 epoch 毫秒；非法时间抛 TypeError。 */
export function parseTime(value, field = "时间") {
  if (typeof value !== "string") throw new TypeError(`${field} 必须是 ISO 8601 字符串`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`${field} 不是合法时间: ${value}`);
  return ms;
}

/** 向下取整到 UTC 整点（+08:00 等整时区偏移下与当地整点重合）。 */
export function hourFloor(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function isoUtc(ms) {
  return new Date(ms).toISOString();
}

/** 两个区间是否相交（端点语义：预报按 [validFrom, validTo) 覆盖小时槽）。 */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
