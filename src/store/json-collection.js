import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 极简 JSON 文件持久化：单文件集合 + 临时文件原子替换。
 * 进程重启后从磁盘完整恢复；不依赖任何第三方数据库。
 * 写串行化由服务层的单条全局写链保证，persist() 只负责原子落盘。
 */
export class JsonCollection {
  constructor(dir, filename) {
    this.path = join(dir, filename);
    this.data = null;
  }

  async load(fallback) {
    if (existsSync(this.path)) {
      this.data = JSON.parse(await readFile(this.path, "utf8"));
    } else {
      this.data = fallback;
    }
    return this.data;
  }

  /** 临时文件原子替换；调用方自行保证不会并发调用。 */
  async persist() {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }

  snapshot() {
    return structuredClone(this.data);
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).sort();
}
