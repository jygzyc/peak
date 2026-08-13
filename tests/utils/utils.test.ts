import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceTitle } from "../../dist/utils/helpers.js";

test("sourceTitle truncates by UTF-8 bytes without splitting characters", () => {
  const exact = "a".repeat(1024);
  assert.equal(sourceTitle(exact), exact);

  const truncated = sourceTitle(`${"a".repeat(1020)}😀a`);
  assert.equal(truncated, `${"a".repeat(1020)}...`);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 1024);
});
