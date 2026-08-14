import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_UI } from "../generated/assets.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// Look beside the compiled module (dist/ui) and one level up at the on-disk ui/ fallback.
const UI_ROOTS = [MODULE_DIR, join(MODULE_DIR, "ui")];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * Map a request pathname to a posix-relative UI resource path, or null when it
 * is unsafe or empty. `/` serves the dashboard entry; everything else maps to
 * its path under ui/. Traversal and backslash segments are rejected.
 */
function resolveUiPath(pathname: string): string | null {
  let rel = pathname === "/" ? "dashboard.html" : pathname.slice(1);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const segments = rel.split("/");
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes("\\")) return null;
    cleaned.push(segment);
  }
  return cleaned.length ? cleaned.join("/") : null;
}

function contentTypeFor(rel: string): string {
  return CONTENT_TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream";
}

function readFromDisk(rel: string): Buffer | string | undefined {
  for (const root of UI_ROOTS) {
    const base = resolve(root);
    const abs = resolve(root, rel);
    if (abs !== base && !abs.startsWith(base + sep)) continue;
    if (existsSync(abs)) {
      try {
        return readFileSync(abs);
      } catch {
        // try the next root
      }
    }
  }
  return undefined;
}

/**
 * Serve the optional bundled UI as a small static site, without granting it
 * direct Graph access. Returns true when the request was handled.
 */
export function serveDashboard(request: IncomingMessage, response: ServerResponse): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const rel = resolveUiPath(pathname);
  if (!rel) return false;

  // Embedded bundle first, with the on-disk ui/ tree as a fallback (dev flow and
  // existing dist layout both keep working).
  let content: string | Buffer | undefined = EMBEDDED_UI[rel];
  if (content === undefined) content = readFromDisk(rel);
  if (content === undefined) return false;

  response.writeHead(200, { ...BASE_HEADERS, "content-type": contentTypeFor(rel) });
  response.end(content);
  return true;
}
