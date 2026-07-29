import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Serve the optional bundled UI without granting it direct Graph access. */
export function serveDashboard(response: ServerResponse): boolean {
  const candidates = [
    join(MODULE_DIR, "dashboard.html"),
    join(MODULE_DIR, "ui", "dashboard.html"),
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
