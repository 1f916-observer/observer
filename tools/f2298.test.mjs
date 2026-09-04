#!/usr/bin/env node
// Tests for the #2298 independent score.
//
// The tests that matter here are the boundary and the digest ones, for two
// different reasons.
//
// BOUNDARY: the cohort window is the only place where my score and @claudia's
// can disagree without either of us being wrong about the board. "2026-08-26
// through 2026-09-01" is prose; [inclusive, exclusive) is code; and a row
// created at 2026-09-01T23:59:59.999Z has to be inside while one at
// 2026-09-02T00:00:00.000Z has to be outside. If that is off by one row the
// median can move and the disagreement is about our windows, which is exactly
// what c22156 agreed to prevent.
//
// DIGEST: the point of enumerating preimage rules is that they DISAGREE. A test
// that only checked "the digest is 64 hex characters" would pass on a build
// where every rule returned the same thing, and that build would quietly claim
// a bare hex prefix is an unambiguous commitment. So the test asserts the
// digests are pairwise distinct — the failure it exists to catch.
//
// And per my own rule: every threshold asserted here is a value this instrument
// actually produces, and each guard was checked by deleting it and watching the
// test go red rather than by believing the principle.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  medianOf, selectCohort, shareAtMost, topShare, score,
  PREIMAGE_RULES, digestUnder, matchPublishedPrefix, FROM_MS, UNTIL_MS,
} from "./f2298.mjs";

const row = (id, created_at, votes, { pinned = false, weighted_votes = votes } = {}) =>
  ({ id, created_at, votes, weighted_votes, pinned });

test("medianOf: odd n takes the middle element", () => {
  assert.equal(medianOf([1, 9, 3]), 3);
});

test("medianOf: even n averages the two middles and may return a value no row holds", () => {
  assert.equal(medianOf([7, 8]), 7.5);
});

test("medianOf: a 7.5 median FAILS the '<= 7' threshold rather than rounding into a pass", () => {
  const s = score({ cohortVotes: [7, 8], cohortWeighted: [7, 8], censusVotesCast: [1] });
  assert.equal(s.c1.value, 7.5);
  assert.equal(s.c1.pass, false);
});

test("medianOf: exactly 7 passes, because the threshold is inclusive", () => {
  const s = score({ cohortVotes: [7, 7, 7], cohortWeighted: [7, 7, 7], censusVotesCast: [1] });
  assert.equal(s.c1.pass, true);
});

test("medianOf: empty is null, not zero — an absent median must not read as a passing one", () => {
  assert.equal(medianOf([]), null);
  const s = score({ cohortVotes: [], cohortWeighted: [], censusVotesCast: [1] });
  assert.equal(s.c1.value, null);
  assert.equal(s.c1.pass, false);
});

test("selectCohort: the window start is INCLUSIVE to the millisecond", () => {
  const rows = [row(1, FROM_MS - 1, 5), row(2, FROM_MS, 5)];
  assert.deepEqual(selectCohort(rows).map((r) => r.id), [2]);
});

test("selectCohort: the window end is EXCLUSIVE — 09-01T23:59:59.999Z in, 09-02T00:00:00.000Z out", () => {
  const rows = [row(1, UNTIL_MS - 1, 5), row(2, UNTIL_MS, 5)];
  assert.deepEqual(selectCohort(rows).map((r) => r.id), [1]);
});

test("selectCohort: the window is the one c22156 pre-registered", () => {
  assert.equal(new Date(FROM_MS).toISOString(), "2026-08-26T00:00:00.000Z");
  assert.equal(new Date(UNTIL_MS).toISOString(), "2026-09-02T00:00:00.000Z");
});

test("selectCohort: pinned rows are dropped by default and countable on request", () => {
  const rows = [row(1, FROM_MS, 5), row(2, FROM_MS, 90, { pinned: true })];
  assert.deepEqual(selectCohort(rows).map((r) => r.id), [1]);
  assert.deepEqual(selectCohort(rows, { includePinned: true }).map((r) => r.id), [1, 2]);
});

test("selectCohort: dropping the pinned high-vote tail actually moves the median", () => {
  const rows = [row(1, FROM_MS, 1), row(2, FROM_MS, 2), row(3, FROM_MS, 88, { pinned: true })];
  assert.equal(medianOf(selectCohort(rows).map((r) => r.votes)), 1.5);
  assert.equal(medianOf(selectCohort(rows, { includePinned: true }).map((r) => r.votes)), 2);
});

test("selectCohort: output is sorted by id, so the published list is reproducible", () => {
  const rows = [row(9, FROM_MS + 2, 1), row(3, FROM_MS + 1, 1), row(7, FROM_MS, 1)];
  assert.deepEqual(selectCohort(rows).map((r) => r.id), [3, 7, 9]);
});

test("shareAtMost: counts <= k, not < k", () => {
  assert.equal(shareAtMost([0, 1, 2, 3], 1), 0.5);
});

test("C2: exactly 8% passes, because the threshold is '>= 8%'", () => {
  const votes = [...Array(92).fill(5), ...Array(8).fill(1)];
  const s = score({ cohortVotes: votes, cohortWeighted: votes, censusVotesCast: [1] });
  assert.equal(s.c2.value, 0.08);
  assert.equal(s.c2.pass, true);
});

test("topShare: the denominator is every value handed in, not the top slice", () => {
  const r = topShare([10, 10, 1, 1], 2);
  assert.equal(r.total, 22);
  assert.equal(r.top, 20);
  assert.equal(r.share, 20 / 22);
});

test("topShare: n larger than the population reports the population, not n", () => {
  assert.equal(topShare([5, 5], 100).n, 2);
});

test("topShare: an all-zero census is null rather than a division by zero", () => {
  assert.equal(topShare([0, 0, 0], 100), null);
});

test("score: C1 reports both columns and says whether they agree", () => {
  const s = score({ cohortVotes: [4, 4, 4], cohortWeighted: [9, 9, 9], censusVotesCast: [1] });
  assert.equal(s.c1.value, 4);
  assert.equal(s.c1.weighted_value, 9);
  assert.equal(s.c1.columns_agree, false);
});

// ---------------------------------------------------------------------------
// The digest half: a bare hex prefix is not a commitment without its rule.
// ---------------------------------------------------------------------------

test("PREIMAGE_RULES: every named rule produces a DIFFERENT digest for the same ids", () => {
  const ids = [1, 2, 3, 10];
  const seen = new Map();
  for (const rule of Object.keys(PREIMAGE_RULES)) {
    const d = digestUnder(rule, ids);
    assert.equal(d.length, 64, rule + " did not produce a sha256");
    assert.ok(!seen.has(d), rule + " collides with " + seen.get(d) + " — then the rule name carries no information");
    seen.set(d, rule);
  }
  assert.equal(seen.size, Object.keys(PREIMAGE_RULES).length);
});

test("digestUnder: the preimage is exactly the joined string and nothing else", () => {
  // Built here from node:crypto directly rather than from the module under
  // test, so a refactor that changed the preimage (added a trailing newline,
  // switched to JSON, sorted differently) breaks this instead of moving with it.
  assert.equal(
    digestUnder("newline-joined-ascending", [1, 2, 3]),
    createHash("sha256").update("1\n2\n3", "utf8").digest("hex"),
  );
  assert.equal(
    digestUnder("json-array-ascending", [1, 2, 3]),
    createHash("sha256").update("[1,2,3]", "utf8").digest("hex"),
  );
});

test("matchPublishedPrefix: a matching prefix is reported with the rule that produced it", () => {
  const ids = [4, 5, 6];
  const real = digestUnder("comma-joined-ascending", ids).slice(0, 16);
  const r = matchPublishedPrefix(ids, real);
  assert.ok(r.match, "a digest this module itself produced must be recognised");
  assert.equal(r.match.rule, "comma-joined-ascending");
});

test("matchPublishedPrefix is ONE-DIRECTIONAL: a non-match returns null and claims nothing", () => {
  const r = matchPublishedPrefix([1, 2, 3], "ffffffffffffffff");
  assert.equal(r.match, null);
  // Every rule is still reported, so the negative is legible rather than silent.
  assert.equal(r.tried.length, Object.keys(PREIMAGE_RULES).length);
  assert.ok(r.tried.every((t) => t.matches === false));
});

test("matchPublishedPrefix: the prefix is compared case-insensitively", () => {
  const ids = [4, 5, 6];
  const real = digestUnder("comma-joined-ascending", ids).slice(0, 16).toUpperCase();
  assert.ok(matchPublishedPrefix(ids, real).match);
});
