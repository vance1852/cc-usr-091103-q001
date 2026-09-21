import { createHash } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "../domain/canonical.js";

/**
 * 只追加的哈希链审计日志（JSONL）：
 *   entryHash = sha256(prevHash + stableStringify({seq, at, type, payload}))
 * 任何一行被删改都会在 verify() 处断链；重启后从日志末尾恢复链头。
 */
export class AuditLog {
  constructor(dir) {
    this.path = join(dir, "audit.log");
    this.lastHash = "GENESIS";
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  async load() {
    if (!existsSync(this.path)) return;
    const text = await readFile(this.path, "utf8");
    let prev = "GENESIS";
    let seq = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const expected = hashEntry(prev, entry);
      if (entry.hash !== expected) {
        throw new Error(`审计日志哈希链在序号 ${entry.seq} 处校验失败`);
      }
      prev = entry.hash;
      seq = entry.seq;
    }
    this.lastHash = prev;
    this.seq = seq;
  }

  append(type, payload, atMs) {
    const run = this.queue.then(async () => {
      const seq = this.seq + 1;
      const at = new Date(atMs ?? Date.now()).toISOString();
      const hash = hashEntry(this.lastHash, { seq, at, type, payload });
      const entry = { seq, at, type, payload, prevHash: this.lastHash, hash };
      await appendFile(this.path, `${JSON.stringify(entry)}\n`);
      this.lastHash = hash;
      this.seq = seq;
      return entry;
    });
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async verify() {
    if (!existsSync(this.path)) return { ok: true, entries: 0, head: this.lastHash };
    const text = await readFile(this.path, "utf8");
    let prev = "GENESIS";
    let count = 0;
    let brokenAt = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.hash !== hashEntry(prev, entry)) {
        brokenAt = entry.seq;
        break;
      }
      prev = entry.hash;
      count += 1;
    }
    return { ok: brokenAt === null, entries: count, brokenAt, head: prev };
  }

  async readAll() {
    if (!existsSync(this.path)) return [];
    const text = await readFile(this.path, "utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
}

function hashEntry(prevHash, { seq, at, type, payload }) {
  const body = stableStringify({ seq, at, type, payload });
  return createHash("sha256").update(prevHash).update(".").update(body).digest("hex");
}
