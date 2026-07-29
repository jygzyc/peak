import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { initializeArtifactDirectory } from "../config/paths.js";
import type { ArtifactRef } from "./types.js";

export class ArtifactStore {
  readonly dir: string;

  constructor(readonly projectDir: string) {
    this.dir = initializeArtifactDirectory(projectDir);
  }

  async save(input: Readable, mediaType: string, maxBytes: number): Promise<ArtifactRef> {
    const temporary = join(this.dir, `.${randomUUID()}.tmp`);
    const output = createWriteStream(temporary, { flags: "wx" });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        sizeBytes += buffer.length;
        if (sizeBytes > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`);
        hash.update(buffer);
        if (!output.write(buffer)) await once(output, "drain");
      }
      output.end();
      await once(output, "close");
      const sha256 = hash.digest("hex");
      const target = join(this.dir, sha256);
      if (existsSync(target)) {
        const existing = lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("invalid artifact target");
        rmSync(temporary, { force: true });
      } else {
        renameSync(temporary, target);
      }
      return { path: `artifacts/${sha256}`, sha256, mediaType, sizeBytes };
    } catch (error) {
      output.destroy();
      if (!output.closed) await once(output, "close");
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  path(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid artifact hash");
    const path = resolve(this.dir, sha256);
    if (!existsSync(path)) throw new Error("artifact not found");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact not found");
    return path;
  }

  stream(sha256: string): Readable { return createReadStream(this.path(sha256)); }
  remove(sha256: string): void { rmSync(join(this.dir, sha256), { force: true }); }
}
