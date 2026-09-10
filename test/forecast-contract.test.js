import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseForecastRevision } from "../src/forecast-contract.js";

test("读取预报修订并保留来源扩展编号", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/forecast-revision.json", import.meta.url), "utf8"));
  const event = parseForecastRevision(raw);
  assert.equal(event.revision, 3);
  assert.equal(event.attributes.bulletinCode, "CW-2026-410");
});

test("拒绝没有有效版本号的修订", () => {
  assert.throws(() => parseForecastRevision({ eventId: "x", source: "s", routeId: "r", revision: 0, issuedAt: "t", validFrom: "t", validTo: "t", values: {} }));
});
