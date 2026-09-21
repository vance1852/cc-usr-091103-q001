// 带时区偏移的时间工具：内部一律用 epoch 毫秒比较，
// 小时桶按俱乐部时区（默认 +08:00）对齐，跨午夜自然成立。

export const CLUB_OFFSET_MINUTES = 8 * 60;

const OFFSET_RE = /([zZ]|[+-]\d{2}:\d{2})$/;

export function parseInstant(iso, field = "时间") {
  if (typeof iso !== "string") throw new TypeError(`${field} 必须是 ISO 8601 字符串`);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`${field} 无法解析: ${iso}`);
  if (!OFFSET_RE.test(iso)) throw new TypeError(`${field} 必须带时区偏移: ${iso}`);
  return ms;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function formatOffset(offsetMin = CLUB_OFFSET_MINUTES) {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * 把 epoch 毫秒映射为俱乐部时区的整点小时键，
 * 结果本身仍是合法 ISO（如 2026-10-04T00:00+08:00），可直接 Date.parse 还原。
 */
export function zonedHourKey(ms, offsetMin = CLUB_OFFSET_MINUTES) {
  const shifted = ms + offsetMin * 60_000;
  const hourWall = Math.floor(shifted / 3_600_000) * 3_600_000;
  const d = new Date(hourWall);
  const wall =
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:00`;
  return `${wall}${formatOffset(offsetMin)}`;
}

export function hourKeyToMs(key) {
  const ms = Date.parse(key);
  if (Number.isNaN(ms)) throw new TypeError(`非法小时键: ${key}`);
  return ms;
}

/**
 * 与区间 [fromMs, toMs) 有交集的所有俱乐部时区整点（含首尾所在小时，保守取整）。
 */
export function exposureHours(fromMs, toMs, offsetMin = CLUB_OFFSET_MINUTES) {
  if (toMs <= fromMs) return [];
  const firstMs = hourKeyToMs(zonedHourKey(fromMs, offsetMin));
  const lastMs = hourKeyToMs(zonedHourKey(toMs - 1, offsetMin));
  const out = [];
  for (let ms = firstMs; ms <= lastMs; ms += 3_600_000) {
    out.push(zonedHourKey(ms, offsetMin));
  }
  return out;
}
