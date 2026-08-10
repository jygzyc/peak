import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_UI } from "../generated/assets.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Serve the optional bundled UI without granting it direct Graph access. */
export function serveDashboard(request: IncomingMessage, response: ServerResponse): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const filename = pathname === "/" ? "dashboard.html"
    : pathname === "/preview.html" ? "preview.html"
    : pathname === "/tasks.html" ? "tasks.html"
    : undefined;
  if (!filename) return false;
  // Embedded first, with the dist on-disk file as fallback (the dev flow and existing dist layout are unchanged).
  let content: string | Buffer | undefined = EMBEDDED_UI[filename];
  if (content === undefined) {
    const candidates = [
      join(MODULE_DIR, filename),
      join(MODULE_DIR, "ui", filename),
    ];
    const path = candidates.find(existsSync);
    if (!path) return false;
    content = readFileSync(path);
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(content);
  return true;
}
