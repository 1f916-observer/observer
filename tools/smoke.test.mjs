// Units for the smoke check's two pure decisions.
//
// checkPath decides whether a live response still carries a field a view reads.
// retryDecision decides whether a failure is worth asking about again.
//
// The second one exists because this repo learned that a guard is proved by the
// round trip, not by the principle: break it, watch the suite go red, restore
// it. So the last test here reconstructs the OLD policy — retry anything
// transient — and asserts it would have retried the 43-second 503 that the new
// policy refuses. If someone deletes the expense rule, that test is the one
// that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { checkPath, retryDecision } from "./smoke.mjs";

test("checkPath: a present field passes", () => {
  assert.deepEqual(checkPath({ a: { b: 1 } }, "a.b"), []);
});

test("checkPath: a missing field is named with its parent", () => {
  const out = checkPath({ a: {} }, "a.b");
  assert.equal(out.length, 1);
  assert.match(out[0], /missing "b" under a/);
});

test("checkPath: every element of an array must carry the field", () => {
  assert.deepEqual(checkPath({ xs: [{ b: 1 }, { b: 2 }] }, "xs[].b"), []);
  assert.equal(checkPath({ xs: [{ b: 1 }, {}] }, "xs[].b").length, 1);
});

test("checkPath: an empty array is a fact about today, not a broken contract", () => {
  assert.deepEqual(checkPath({ xs: [] }, "xs[].b"), []);
});

test("retryDecision: a cheap 429 is worth asking again", () => {
  const d = retryDecision({ transient: true, elapsedMs: 120, attemptsLeft: 3 });
  assert.equal(d.retry, true);
});

test("retryDecision: a 404 is the society's answer, not a hiccup", () => {
  const d = retryDecision({ transient: false, elapsedMs: 80, attemptsLeft: 3 });
  assert.equal(d.retry, false);
  assert.match(d.why, /answered/);
});

test("retryDecision: the budget still runs out", () => {
  assert.equal(retryDecision({ transient: true, elapsedMs: 50, attemptsLeft: 0 }).retry, false);
});

test("retryDecision: an expensive failure is not asked again, and says what it cost", () => {
  // The measured case: GET /api/record/1f916-agent, 2026-09-13T20:04Z,
  // HTTP 503 after 43.3 seconds.
  const d = retryDecision({ transient: true, elapsedMs: 43265, attemptsLeft: 3 });
  assert.equal(d.retry, false);
  assert.match(d.why, /43\.3s/);
  assert.match(d.why, /costs the society the same again/);
});

test("retryDecision: the boundary is inclusive, so the threshold is a value the rule can produce", () => {
  assert.equal(retryDecision({ transient: true, elapsedMs: 10000, attemptsLeft: 3, expensiveMs: 10000 }).retry, false);
  assert.equal(retryDecision({ transient: true, elapsedMs: 9999, attemptsLeft: 3, expensiveMs: 10000 }).retry, true);
});

test("the guard is load-bearing: the policy it replaced would have retried the 43s 503", () => {
  // Reconstruction of the old rule, which consulted `transient` and nothing
  // else. If the expense rule is ever removed, retryDecision collapses onto
  // this and the assertion below fails.
  const oldPolicy = ({ transient, attemptsLeft }) => ({ retry: transient && attemptsLeft > 0 });
  const measured = { transient: true, elapsedMs: 43265, attemptsLeft: 3 };

  assert.equal(oldPolicy(measured).retry, true, "the old policy retried it");
  assert.equal(retryDecision(measured).retry, false, "the new policy must not");

  // Four attempts at 43.3s each is what that difference was worth.
  const oldCostS = 4 * 43.265;
  const newCostS = 1 * 43.265;
  assert.ok(oldCostS - newCostS > 120, "the saving is about two minutes of shared worker CPU per run");
});
