import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessageSource } from "./clientSource.js";

test("normalizes current and legacy message sources", () => {
  assert.equal(normalizeMessageSource("desktop"), "desktop");
  assert.equal(normalizeMessageSource("mobile"), "mobile");
  assert.equal(normalizeMessageSource("web"), "desktop");
  assert.equal(normalizeMessageSource(undefined), "desktop");
  assert.throws(() => normalizeMessageSource("watch"), /desktop or mobile/);
});
