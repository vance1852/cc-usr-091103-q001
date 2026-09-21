import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

// 仅附加事件日志：所有领域事实按顺序写入 JSONL。
// 重启时重放即可重建全部状态；同一 dedupeKey 重复投递只生效一次，
// 且同一键的载荷哈希必须一致，否则拒绝（检测到同名不同内容）。
export class EventStore {
  #file;
  #now;
  #seq = 0;
  #events = [];
  #seen = new Map(); // dedupeKey -> {seq, payloadHash}

  constructor(file, now = () => new Date().toISOString()) {
    this.#file = file;
    this.#now = now;
  }

  async load() {
    if (!existsSync(this.#file)) return;
    const lines = readFileSync(this.#file, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.seq !== this.#seq + 1) {
        throw new Error(`事件日志序号断裂：期望 ${this.#seq + 1}，读到 ${rec.seq}`);
      }
      this.#seq = rec.seq;
      this.#events.push(rec);
      if (rec.dedupeKey !== undefined) {
        this.#seen.set(rec.dedupeKey, { seq: rec.seq, payloadHash: rec.payloadHash });
      }
    }
  }

  append(type, payload, { dedupeKey, identity } = {}) {
    if (dedupeKey !== undefined) {
      const hit = this.#seen.get(dedupeKey);
      if (hit) {
        const payloadHash = hashPayload(identity ?? payload);
        if (hit.payloadHash !== payloadHash) {
          const err = new Error(`幂等键 ${dedupeKey} 曾用于不同载荷`);
          err.code = "DEDUPE_CONFLICT";
          throw err;
        }
        return { deduplicated: true, event: this.#events[hit.seq - 1] };
      }
    }
    const rec = {
      seq: this.#seq + 1,
      at: this.#now(),
      type,
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      ...(dedupeKey !== undefined ? { payloadHash: hashPayload(identity ?? payload) } : {}),
      payload,
    };
    mkdirSync(dirname(this.#file), { recursive: true });
    appendFileSync(this.#file, `${JSON.stringify(rec)}\n`);
    this.#seq = rec.seq;
    this.#events.push(rec);
    if (dedupeKey !== undefined) this.#seen.set(dedupeKey, { seq: rec.seq, payloadHash: rec.payloadHash });
    return { deduplicated: false, event: rec };
  }

  get events() {
    return this.#events;
  }

  byType(type) {
    return this.#events.filter((e) => e.type === type).map((e) => e.payload);
  }
}

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
