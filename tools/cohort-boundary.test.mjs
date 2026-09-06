#!/usr/bin/env node
// Tests for the cohort-boundary legs.
//
// The one that matters is `inversions`. Its job is to FIND a defect that is
// almost always absent, so a version that returns [] unconditionally passes
// every test written against real board data — the board had 2 inversions in
// 4,097 rows when this was written. So the tests feed it inversions on purpose,
// at the sizes and positions that decide whether the enumerable rule survives:
// interior (harmless), and adjacent to a window boundary (fatal, silently).
//
// Each guard here was checked by breaking it and watching the suite go red:
// tracking the previous row instead of the running maximum misses the second
// of two consecutive inversions; an inclusive window end pulls a row in.

import test from "node:test";
import assert from "node:assert/strict";
import { inversions, windowRows, gapsIn } from "./cohort-boundary.mjs";
import { FROM_MS, UNTIL_MS } from "./f2298.mjs";

const row = (id, iso) => ({ id, created_at: Date.parse(iso) });

test("inversions: a monotone board has none", () => {
  const rows = [row(1, "2026-08-26T00:00:00Z"), row(2, "2026-08-26T00:00:01Z"), row(3, "2026-08-26T00:00:02Z")];
  assert.deepEqual(inversions(rows), []);
});

test("inversions: a later id with an earlier created_at is reported with both rows and the gap", () => {
  const rows = [row(1, "2026-08-26T00:00:00Z"), row(2, "2026-08-26T00:00:05Z"), row(3, "2026-08-26T00:00:03Z")];
  const inv = inversions(rows);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].earlier_id, 2);
  assert.equal(inv[0].later_id, 3);
  assert.equal(inv[0].gap_ms, 2000);
});

test("inversions: input order does not matter — rows are compared in id order", () => {
  const rows = [row(3, "2026-08-26T00:00:03Z"), row(1, "2026-08-26T00:00:00Z"), row(2, "2026-08-26T00:00:05Z")];
  assert.equal(inversions(rows).length, 1);
});

// THE GUARD. Comparing each row against its immediate predecessor rather than
// against the running maximum reports only the first of a run, which would have
// understated the board.
test("inversions: two consecutive out-of-order rows are both reported", () => {
  const rows = [
    row(1, "2026-08-26T00:00:00Z"),
    row(2, "2026-08-26T00:00:09Z"),
    row(3, "2026-08-26T00:00:03Z"),
    row(4, "2026-08-26T00:00:05Z"),
  ];
  const inv = inversions(rows);
  assert.equal(inv.length, 2);
  assert.deepEqual(inv.map((i) => i.later_id), [3, 4]);
  // Both are measured against the running maximum, #2, not against each other.
  assert.deepEqual(inv.map((i) => i.earlier_id), [2, 2]);
});

test("inversions: a millisecond counts — the real board's smallest was 6 ms", () => {
  const rows = [row(973, "2026-08-15T03:02:34.902Z"), row(974, "2026-08-15T03:02:34.896Z")];
  assert.equal(inversions(rows)[0].gap_ms, 6);
});

test("inversions: an empty or single-row board is not an error", () => {
  assert.deepEqual(inversions([]), []);
  assert.deepEqual(inversions([row(1, "2026-08-26T00:00:00Z")]), []);
});

/* ---------- the window, and why the boundary is the whole risk ---------- */

test("windowRows: selects [from, until) and reports the id span", () => {
  const rows = [
    row(10, new Date(FROM_MS - 1).toISOString()),
    row(11, new Date(FROM_MS).toISOString()),
    row(12, new Date(UNTIL_MS - 1).toISOString()),
    row(13, new Date(UNTIL_MS).toISOString()),
  ];
  const w = windowRows(rows);
  assert.deepEqual(w.ids, [11, 12]);
  assert.equal(w.min, 11);
  assert.equal(w.max, 12);
});

// THE FATAL CASE, and the reason leg 1 exists at all. An inversion straddling
// the window boundary makes the id range and the created_at window disagree
// about a row — and every downstream check (gap count, digest, cardinality)
// still reports clean, because they all derive from the same walk.
test("an inversion across the boundary makes the id range and the window disagree", () => {
  const rows = [
    row(100, new Date(FROM_MS + 5).toISOString()),   // in window, LOW id
    row(101, new Date(FROM_MS - 5).toISOString()),   // OUT of window, higher id
    row(102, new Date(FROM_MS + 50).toISOString()),  // in window
  ];
  const w = windowRows(rows);
  assert.deepEqual(w.ids, [100, 102]);
  // #101 sits inside [100, 102] and is NOT in the window. An enumerable rule
  // stated as "every id in [min,max] less the moderated" would wrongly include
  // it, and nothing in the cardinality would show that.
  assert.deepEqual(gapsIn(w.ids, w.min, w.max), [101]);
  assert.equal(inversions(rows).length, 1);
});

test("gapsIn: names every absent id in the span, in order", () => {
  assert.deepEqual(gapsIn([5, 7, 10], 5, 10), [6, 8, 9]);
});

test("gapsIn: a contiguous span has no gaps", () => {
  assert.deepEqual(gapsIn([5, 6, 7], 5, 7), []);
});

test("gapsIn: the real cohort's three gaps are exactly the moderated rows", () => {
  // ids 2375..3478 with the three known moderated rows removed
  const ids = [];
  for (let i = 2375; i <= 3478; i++) if (![2788, 2844, 2866].includes(i)) ids.push(i);
  assert.equal(ids.length, 1101);
  assert.deepEqual(gapsIn(ids, 2375, 3478), [2788, 2844, 2866]);
});
