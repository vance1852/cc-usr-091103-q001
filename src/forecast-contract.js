export function parseForecastRevision(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("预报修订必须是对象");
  for (const field of ["eventId", "source", "routeId", "revision", "issuedAt", "validFrom", "validTo", "values"]) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") throw new TypeError(`缺少字段 ${field}`);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1) throw new TypeError("revision 必须是正整数");
  if (typeof raw.values !== "object" || Array.isArray(raw.values)) throw new TypeError("values 必须是对象");
  const known = new Set(["eventId", "source", "routeId", "revision", "issuedAt", "validFrom", "validTo", "values"]);
  return { ...raw, attributes: Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key))) };
}
