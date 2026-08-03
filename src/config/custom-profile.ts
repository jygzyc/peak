import { createHash } from "node:crypto";
import type { CustomProfileDefinition } from "./types.js";

export function customProfileDigest(profile: CustomProfileDefinition): string {
  return createHash("sha256")
    .update(`${profile.description}#${profile.prompt}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}
