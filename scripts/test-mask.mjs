#!/usr/bin/env node
// P0-4 test: mask() helper for sensitive log values.
import assert from "node:assert/strict";
import { mask } from "../lib/utils.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log("P0-4 mask() helper:");

t("masks long string", () => {
  assert.equal(mask("abcdefghijklmnop"), "abcd…mnop");
});

t("collapses too-short string", () => {
  assert.equal(mask("abcde"), "***");
});

t("respects keep argument", () => {
  assert.equal(mask("abcdefghijklmn", 2), "ab…mn");
});

t("null/undefined pass through", () => {
  assert.equal(mask(null), null);
  assert.equal(mask(undefined), undefined);
});

t("typical wx token (24 chars) gets masked", () => {
  const tok = "a".repeat(8) + "b".repeat(8) + "c".repeat(8);
  const m = mask(tok);
  assert.ok(!m.includes("bbbbbb"), `body should not appear: ${m}`);
  assert.ok(m.startsWith("aaaa") && m.endsWith("cccc"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
