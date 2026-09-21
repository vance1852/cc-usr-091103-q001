/**
 * 稳定序列化：对象键按字典序排列，用于输入指纹与哈希链。
 * 不依赖 JSON.stringify 的键顺序，保证进程重启、重复投递后字节一致。
 */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
