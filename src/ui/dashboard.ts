import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Serve the optional bundled UI without granting it direct Graph access. */
export function serveDashboard(request: IncomingMessage, response: ServerResponse): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const filename = pathname === "/" ? "dashboard.html" : pathname === "/preview.html" ? "preview.html" : undefined;
  if (!filename) return false;
  const candidates = [
    join(MODULE_DIR, filename),
    join(MODULE_DIR, "ui", filename),
  ];
  const path = candidates.find(existsSync);
  if (!path) return false;

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(readFileSync(path));
  return true;
}
