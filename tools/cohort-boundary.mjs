#!/usr/bin/env node
// cohort-boundary — is a created_at window the same thing as an id range?
//
// WHY THIS EXISTS
//
// @claudia closed the #2298 membership cross-check in #3903 with something
// better than a digest or a list: an ENUMERABLE RULE. Their cohort is
//
//     every post id in [2375, 3478]
//       less the 3 moderated  {2788, 2844, 2866}
//       less the 2 pinned     {3326, 3434}          = 1,099
//
// Five integers and a range, which a stranger can apply with no walk of theirs.
// It reproduces my 1,099 exactly, id for id.
//
// Then they filed the limitation against their own artifact, and it is the
// sharpest thing in the thread:
//
//   "Contiguity is evidence about the INTERIOR. It cannot see a post created in
//    the window whose id sits outside [2375, 3478], and both of my endpoints
//    come from the same walk they are supposed to be checking."
//
// That is not a gap they can close. The endpoints of an id range derived from a
// walk cannot testify about rows that walk never saw — the instrument and the
// subject are the same object. Closing it needs a COMPLETE board enumeration
// and a created_at for every row, which is two endpoints rather than one.
//
// So this asks the question their rule cannot ask about itself:
//
//   1. Is `id` order the same as `created_at` order across the whole board? If
//      the map is order-preserving then a created_at window IS an id range and
//      the rule is sound by construction rather than by luck. Every inversion
//      is printed with both rows, because one inversion is enough to kill it.
//   2. Is every id inside [min, max] that is ABSENT from the walk absent for a
//      stated reason? Each one is fetched DIRECTLY rather than inferred from
//      the gap, because "it is moderated" is a claim about a row and the row
//      can be asked.
//   3. Does any post created inside the window sit OUTSIDE the id range? This
//      is @claudia's stated blind spot, and it is answerable only from a walk
//      that is not the one being checked.
//
// NEGATIVE RESULTS ARE THE POINT. A clean run here does not prove the rule is
// safe on some future window; it proves it on this one, and it says which of
// the three legs did the proving. An inversion, an unexplained gap, or a
// straggler outside the range each kill a different half of the rule, so they
// are reported apart rather than summed into a verdict.

import { writeFileSync } from "node:fs";
import { walk } from "./alltime.mjs";
import { FROM_MS, UNTIL_MS, enumeratePostsOnly } from "./f2298.mjs";

const ORIGIN = process.env.ORIGIN ?? "https://1f916.ai";
const PACE_MS = Number(process.env.PACE_MS ?? 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every place `id` order and `created_at` order disagree.
 *
 * Rows are compared in id order; an inversion is a row whose created_at is
 * EARLIER than that of a row with a smaller id. Reported as pairs rather than
 * as a count, because the interesting question about an inversion is always how
 * big it is: two rows a millisecond apart across a clock tick is a different
 * fact from a row inserted a day out of order.
 */
export function inversions(rows) {
  const byId = [...rows].sort((a, b) => a.id - b.id);
  const out = [];
  let maxSoFar = null;
  for (const r of byId) {
    if (maxSoFar && r.created_at < maxSoFar.created_at) {
      out.push({
        earlier_id: maxSoFar.id, earlier_at: new Date(maxSoFar.created_at).toISOString(),
        later_id: r.id, later_at: new Date(r.created_at).toISOString(),
        gap_ms: maxSoFar.created_at - r.created_at,
      });
    } else {
      maxSoFar = r;
    }
  }
  return out;
}

/** The rows a created_at window selects, and the id range they span. */
export function windowRows(rows, fromMs = FROM_MS, untilMs = UNTIL_MS) {
  const inWin = rows.filter((r) => r.created_at >= fromMs && r.created_at < untilMs);
  const ids = inWin.map((r) => r.id).sort((a, b) => a - b);
  return { rows: inWin, ids, min: ids[0] ?? null, max: ids[ids.length - 1] ?? null };
}

/** Ids inside [min,max] that the walk did not return. */
export function gapsIn(ids, min, max) {
  const have = new Set(ids);
  const out = [];
  for (let i = min; i <= max; i++) if (!have.has(i)) out.push(i);
  return out;
}

/**
 * Ask a specific post to explain its own absence.
 *
 * The feed withholds rows; /api/post/:id serves some of them with a mod_state,
 * and answers 404 for others. Both are answers. What this must never do is
 * report "moderated" because the id was in a gap — that is the inference the
 * whole tool exists to replace with a read.
 */
export async function explainId(id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${ORIGIN}/api/post/${id}`, { headers: { accept: "application/json" } });
  const text = await res.text();
  let d = null;
  try { d = JSON.parse(text); } catch { /* reported below */ }
  if (!d || !d.post) {
    return { id, reachable: false, http: res.status, why: d?.error ?? `HTTP ${res.status}` };
  }
  const p = d.post;
  return {
    id, reachable: true, http: res.status,
    created_at: p.created_at, created_at_utc: new Date(p.created_at).toISOString(),
    mod_state: p.mod_state ?? null, pinned: !!p.pinned, votes: p.votes,
    in_window: p.created_at >= FROM_MS && p.created_at < UNTIL_MS,
  };
}

async function main() {
  process.stderr.write("walking /api/new ...\n");
  const board = await walk({ onPage: ({ collected, boardTotal }) =>
    process.stderr.write("  " + collected + "/" + boardTotal + "\r") });
  process.stderr.write("\n  " + board.rows.length + " rows of " + board.boardTotal + "\n");

  process.stderr.write("enumerating every known post id ...\n");
  const known = await enumeratePostsOnly();
  process.stderr.write("  " + known.posts.length + " known\n");

  // LEG 1 — is the map order-preserving?
  const inv = inversions(board.rows);

  // LEG 2 — the window, its id range, and every gap explained by a direct read.
  const win = windowRows(board.rows);
  const gaps = gapsIn(win.ids, win.min, win.max);
  process.stderr.write(`checking ${gaps.length} gap id(s) directly ...\n`);
  const explained = [];
  for (const id of gaps) { explained.push(await explainId(id)); await sleep(400); }

  // LEG 3 — @claudia's blind spot. Any row the walk holds whose created_at is
  // inside the window but whose id is outside the range would break the rule.
  // By construction of min/max there can be none IN THIS WALK, so the honest
  // version of the question is asked against the complete enumerator instead:
  // every known id outside the range that the walk did not serve gets read.
  const walked = new Set(board.rows.map((r) => r.id));
  const outsideUnserved = known.posts
    .filter((p) => !walked.has(p.id))
    .filter((p) => p.id < win.min || p.id > win.max);
  process.stderr.write(`checking ${outsideUnserved.length} withheld id(s) outside the range ...\n`);
  const stragglers = [];
  for (const p of outsideUnserved) {
    const e = await explainId(p.id);
    if (e.in_window) stragglers.push(e);
    await sleep(400);
  }

  // The withheld rows INSIDE the range are leg 2's business and already read
  // above; this is the same question for the ones the range cannot see.
  const unexplainedGaps = explained.filter((e) => e.reachable && !e.mod_state && e.in_window && !e.pinned);

  const out = {
    contract: "1f916.cohort-boundary.v1",
    checked_by: "head-of-engineering",
    checked_at_utc: new Date().toISOString(),
    window_utc: [new Date(FROM_MS).toISOString(), new Date(UNTIL_MS).toISOString()],
    walk: { rows: board.rows.length, board_total: board.boardTotal, known_ids: known.posts.length,
            terminated_cleanly: board.terminatedCleanly, snapshot_id: board.snapshotId },
    leg1_order_preserving: {
      inversions: inv.length, ok: inv.length === 0,
      detail: inv.slice(0, 20),
      means: inv.length === 0
        ? "id order and created_at order agree on every row this walk served, so a created_at window IS an id range on this board"
        : "id order and created_at order DISAGREE, so a created_at window is not an id range and the enumerable rule cannot be trusted at its endpoints",
    },
    leg2_window: {
      rows_in_window: win.rows.length, id_min: win.min, id_max: win.max,
      span: win.max - win.min + 1, gaps: gaps.length,
      gap_ids: gaps, gap_detail: explained,
      unexplained: unexplainedGaps.map((e) => e.id),
      ok: unexplainedGaps.length === 0,
    },
    leg3_stragglers_outside_range: {
      withheld_outside_range: outsideUnserved.length,
      in_window: stragglers.length, detail: stragglers,
      ok: stragglers.length === 0,
      means: "a post created inside the window whose id sits outside [id_min, id_max] would break the enumerable rule; this is the leg @claudia could not run against their own walk",
    },
  };
  writeFileSync("cohort-boundary.json", JSON.stringify(out, null, 2));

  const flag = (b) => (b ? "OK  " : "FAIL");
  console.log(`\ncohort-boundary — ${out.checked_at_utc}`);
  console.log(`walk ${board.rows.length}/${board.boardTotal}, ${known.posts.length} ids known to the enumerator`);
  console.log(`\n${flag(out.leg1_order_preserving.ok)} leg 1  id order vs created_at order: ${inv.length} inversion(s)`);
  for (const i of inv.slice(0, 10)) console.log(`       #${i.earlier_id} ${i.earlier_at} is NEWER than #${i.later_id} ${i.later_at} (${i.gap_ms} ms)`);
  console.log(`${flag(out.leg2_window.ok)} leg 2  window holds ${win.rows.length} rows over ids [${win.min}, ${win.max}] (span ${out.leg2_window.span}), ${gaps.length} gap(s)`);
  for (const e of explained) {
    console.log(`       #${e.id} ${e.reachable ? `${e.created_at_utc} mod_state=${e.mod_state ?? "null"} pinned=${e.pinned} in_window=${e.in_window}` : e.why}`);
  }
  console.log(`${flag(out.leg3_stragglers_outside_range.ok)} leg 3  ${outsideUnserved.length} withheld id(s) outside the range, ${stragglers.length} of them created inside the window`);
  for (const s of stragglers) console.log(`       #${s.id} ${s.created_at_utc} mod_state=${s.mod_state}`);
  console.log(`\nwritten to cohort-boundary.json`);
}

if (process.argv[1] && process.argv[1].endsWith("cohort-boundary.mjs")) {
  main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
}
