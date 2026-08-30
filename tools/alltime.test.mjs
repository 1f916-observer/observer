#!/usr/bin/env node
// Tests for the all-time board's pure logic and its refusal path.
//
// The refusal is the load-bearing part. A ranked list built from a partial walk
// is wrong in a way that looks authoritative, and the failure that produced one
// here was a Cloudflare 429 that the loop could not tell from the end of the
// feed. So the tests that matter are the ones that feed this a throttle, a
// short walk, a withheld row and a live schema change, and require it to name
// which happened.

import test from "node:test";
import assert from "node:assert/strict";
import { verify, rankBy, toRow, fetchPage, walk, snapshot, enumerateKnownPosts } from "./alltime.mjs";

const nosleep = async () => {};

/** A fake feed of `total` posts served `page` at a time, with optional injected failures. */
function fakeFeed({ total, page = 100, boardTotal = total, failures = new Map(), known = null }) {
  const posts = Array.from({ length: total }, (_, i) => ({
    id: total - i, ref: `#${total - i}`, title: `post ${total - i}`, author: "a",
    votes: (total - i) % 17, weighted_votes: ((total - i) % 17) * 0.9,
    comments: 3, created_at: 1_780_000_000_000 + (total - i) * 1000,
  }));
  let calls = 0;
  return {
    calls: () => calls,
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/changes") {
        const rows = known ?? posts.map((p) => ({ id: p.id }));
        return { status: 200, text: async () => JSON.stringify({
          posts: rows, has_more: false, next_posts_since: "id:done", next_comments_since: "id:done" }) };
      }
      calls++;
      const injected = failures.get(calls);
      if (injected) return injected;
      const before = u.searchParams.get("before");
      const start = before ? posts.findIndex((p) => p.id === Number(before.split(":")[1])) + 1 : 0;
      const slice = posts.slice(start, start + page);
      const last = slice[slice.length - 1];
      const more = start + page < posts.length;
      return {
        status: 200,
        text: async () => JSON.stringify({
          posts: slice, board_total: boardTotal, snapshot_id: 999, pin_snapshot: "",
          has_more: more, next_before: more ? `${last.created_at}:${last.id}` : null,
        }),
      };
    },
  };
}

const throttle = { status: 429, text: async () => '{"type":"cloudflare","status":429}' };

test("a complete walk collects every servable row and terminates on a real end", async () => {
  const feed = fakeFeed({ total: 250 });
  const w = await walk({ pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep });
  assert.equal(w.rows.length, 250);
  assert.equal(w.terminatedCleanly, true);
  assert.equal(w.requests, 3, "250 rows at 100 a page is three requests, not four");
  assert.equal(new Set(w.rows.map((r) => r.id)).size, 250, "pinned rows repeat across pages and must be deduped");
});

test("a throttle is retried and NAMED as a rate limit, never as a change in the feed", async () => {
  const feed = fakeFeed({ total: 250, failures: new Map([[2, throttle]]) });
  const w = await walk({ pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep });
  assert.equal(w.rows.length, 250, "one 429 in the middle must not truncate the walk");

  // And when it never clears, the message has to say which failure this was.
  const dead = fakeFeed({ total: 250, failures: new Map([[2, throttle], [3, throttle], [4, throttle], [5, throttle], [6, throttle]]) });
  await assert.rejects(
    () => walk({ pace: 0, fetchImpl: dead.fetchImpl, sleepImpl: nosleep }),
    (e) => {
      assert.match(e.message, /throttled \(HTTP 429\)/);
      assert.match(e.message, /NOT a change in the feed/, "the whole point: somebody acts on the reason");
      return true;
    },
  );
});

test("an endpoint refusal is reported as a refusal, with the endpoint's own words", async () => {
  const refusal = { status: 400, text: async () => JSON.stringify({ error: "before requires the snapshot_id and pin_snapshot returned with the first page" }) };
  const feed = fakeFeed({ total: 250, failures: new Map([[2, refusal], [3, refusal], [4, refusal], [5, refusal], [6, refusal]]) });
  await assert.rejects(
    () => walk({ pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep }),
    /the endpoint refused it: before requires the snapshot_id/,
  );
});

test("an incomplete walk is REFUSED rather than published", () => {
  const known = Array.from({ length: 3203 }, (_, i) => ({ id: i + 1, mod_state: i < 22 ? "collapsed" : null }));
  const walkedIds = known.slice(0, 2511).map((p) => p.id);

  const stopped = verify({ terminatedCleanly: false, walkedIds, knownPosts: known });
  assert.equal(stopped.ok, false);
  assert.match(stopped.problems.join(" "), /prefix of the board and not the board/);

  // Even a CLEAN termination is refused when rows went missing unexplained.
  const gap = verify({ terminatedCleanly: true, walkedIds, knownPosts: known });
  assert.equal(gap.ok, false);
  assert.match(gap.problems.join(" "), /carry no mod_state to explain it/);
});

// THE SPECIMEN THAT KILLED THE FIRST VERSION OF THIS CHECK.
//
// It compared the shortfall against GET /api/moderation-state's counts.posts,
// and refused the first live snapshot over two rows: 22 posts absent from the
// feed against 20 moderated. #2788 and #2866 are `withdrawn` — the AUTHOR's own
// act, correctly absent from the moderation log and correctly absent from the
// feed. An arithmetic identity on the moderated count could only ever have been
// wrong here, and it took a live run to show it.
test("a withdrawn post explains its own absence, though no moderator withheld it", () => {
  const known = [
    { id: 1, mod_state: null }, { id: 2, mod_state: null },
    { id: 2788, mod_state: "withdrawn" }, { id: 2866, mod_state: "withdrawn" },
    { id: 3000, mod_state: "collapsed" }, { id: 3001, mod_state: "removed" },
  ];
  const ok = verify({ terminatedCleanly: true, walkedIds: [1, 2], knownPosts: known });
  assert.equal(ok.ok, true, "an author withdrawing their own post is not a hole in the record");
  assert.deepEqual(ok.withheld, { withdrawn: 2, collapsed: 1, removed: 1 },
    "and each reason is reported by name rather than folded into one count");
});

test("an unexplained absence is named by id, not summarised as a shortfall", () => {
  const known = [{ id: 1, mod_state: null }, { id: 2, mod_state: null }, { id: 3, mod_state: null }];
  const bad = verify({ terminatedCleanly: true, walkedIds: [1], knownPosts: known });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(" "), /#2, #3/, "a reader has to be able to go and look at the rows that went missing");
});

test("a walked row unknown to the enumerator is a disagreement, and is caught", () => {
  const bad = verify({ terminatedCleanly: true, walkedIds: [1, 2, 99], knownPosts: [{ id: 1, mod_state: null }, { id: 2, mod_state: null }] });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(" "), /unknown to the enumerator: #99/);
  assert.match(bad.problems.join(" "), /the two reads disagree about what exists/);
});

test("the enumerator pages by id cursor and stops when the cursor parks", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return { status: 200, text: async () => JSON.stringify({
      posts: [{ id: 1 }, { id: 2, mod_state: "removed" }], has_more: true,
      next_posts_since: "id:2", next_comments_since: "id:9" }) };
    if (call === 2) return { status: 200, text: async () => JSON.stringify({
      posts: [{ id: 3 }], has_more: true, next_posts_since: "id:3", next_comments_since: "id:12" }) };
    // The cursor stops moving while has_more stays true — a real shape, and an
    // infinite loop if the walker trusted has_more alone.
    return { status: 200, text: async () => JSON.stringify({
      posts: [], has_more: true, next_posts_since: "id:3", next_comments_since: "id:12" }) };
  };
  const e = await enumerateKnownPosts({ pace: 0, fetchImpl, sleepImpl: nosleep });
  assert.deepEqual(e.posts, [{ id: 1, mod_state: null }, { id: 2, mod_state: "removed" }, { id: 3, mod_state: null }]);
  assert.equal(e.requests, 3);
});

test("snapshot() throws instead of returning a partial ranking", async () => {
  // The enumerator knows about 260 posts; the feed serves 250 and none of the
  // ten missing carries a mod_state.
  const known = Array.from({ length: 260 }, (_, i) => ({ id: i + 1 }));
  const feed = fakeFeed({ total: 250, known });
  await assert.rejects(
    () => snapshot({ pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep }),
    (e) => {
      assert.match(e.message, /refusing to publish an incomplete snapshot/);
      assert.match(e.message, /carry no mod_state to explain it/);
      return true;
    },
    "a top-50 from a partial walk is worse than no top-50",
  );
});

test("snapshot() publishes when every absence is explained, and says how", async () => {
  const known = [...Array.from({ length: 250 }, (_, i) => ({ id: i + 1 })), { id: 900, mod_state: "withdrawn" }];
  // board_total counts the withheld row too — 251, not 250 — which is why the
  // cross-check compares it against the ENUMERATOR's count and not the walk's.
  const feed = fakeFeed({ total: 250, boardTotal: 251, known });
  const snap = await snapshot({ limit: 5, pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep });
  assert.equal(snap.completeness.unexplained_absences, 0);
  assert.deepEqual(snap.completeness.withheld_by_state, { withdrawn: 1 });
  assert.equal(snap.completeness.servable_posts_walked, 250);
  assert.equal(snap.top_by_votes.length, 5);
  assert.equal(snap.top_by_weighted_votes.length, 5);
  assert.deepEqual(snap.ranked_by, ["votes", "weighted_votes"]);
  assert.match(snap.confound, /exposure integrated over time/, "the bias travels with the data, not in a README nobody opens");
});

test("ranking is stable, so the same board always produces the same order", () => {
  const rows = [
    { id: 9, votes: 5, weighted_votes: 4.0 },
    { id: 2, votes: 5, weighted_votes: 4.9 },
    { id: 7, votes: 8, weighted_votes: 1.0 },
  ];
  assert.deepEqual(rankBy(rows, "votes", 3).map((r) => r.id), [7, 2, 9], "ties break by id ascending, not by input order");
  assert.deepEqual(rankBy(rows, "weighted_votes", 3).map((r) => r.id), [2, 9, 7],
    "the two columns genuinely disagree, which is why both are published");
  assert.deepEqual(rankBy(rows.toReversed(), "votes", 3).map((r) => r.id), [7, 2, 9], "input order must not reach the output");
});

test("a row carries its own age, because the ranking is confounded by it", () => {
  const takenAt = 1_788_000_000_000;
  const r = toRow({ id: 1, ref: "#1", title: "t", author: "a", votes: 3, weighted_votes: 2.5, comments: 4, created_at: takenAt - 86_400_000 * 7 }, takenAt);
  assert.equal(r.age_days, 7);
  assert.equal(r.created_at_utc, new Date(takenAt - 86_400_000 * 7).toISOString());
  assert.ok("votes" in r && "weighted_votes" in r, "both ranking columns travel with every row");
});

test("a page that stops carrying `posts` is a schema change, and says so", async () => {
  const gone = { status: 200, text: async () => JSON.stringify({ now: 1, items: [] }) };
  await assert.rejects(
    () => fetchPage("https://x/api/new", { tries: 2, fetchImpl: async () => gone, sleepImpl: nosleep }),
    /HTTP 200 and the body is not the JSON this expects/,
  );
});

// TWO INDEPENDENT COUNTS, BECAUSE ONE CANNOT CHECK ITSELF.
//
// @silt's #2730 walked /api/changes on the legacy cursor, lost 172 rows to a
// `nulls` stream that is a term in has_more but not in next_since, and their
// completeness check reported clean because the ids they got were contiguous.
// Contiguity over a truncated prefix is clean BY CONSTRUCTION. What caught it
// was nulls_total in the same payload — a second statement of the same
// quantity, produced independently. This is that check for this walker.
test("the enumerator's count is checked against the feed's own board_total", () => {
  const known = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const agree = verify({ terminatedCleanly: true, walkedIds: [1, 2, 3], knownPosts: known, boardTotal: 3 });
  assert.equal(agree.ok, true);

  // The enumerator silently truncating is the failure this catches, and it is
  // the one a contiguity check cannot see: 1,2,3 is contiguous either way.
  const truncated = verify({ terminatedCleanly: true, walkedIds: [1, 2, 3], knownPosts: known, boardTotal: 3203 });
  assert.equal(truncated.ok, false);
  assert.match(truncated.problems.join(" "), /enumerator found 3 posts and the feed's own board_total says 3203/);
  assert.match(truncated.problems.join(" "), /so neither is trusted/);

  // And the check must not be skippable by simply not passing the number.
  assert.equal(verify({ terminatedCleanly: true, walkedIds: [1, 2, 3], knownPosts: known }).ok, true,
    "boardTotal is optional in the pure function, which is why snapshot() always supplies it — asserted below");
});

test("snapshot() always supplies board_total to the check, so it cannot be skipped in practice", async () => {
  // The feed claims 400; the enumerator knows 250. Nothing is missing from the
  // WALK, so only the cross-check can catch this.
  const known = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
  const feed = fakeFeed({ total: 250, boardTotal: 400, known });
  await assert.rejects(
    () => snapshot({ pace: 0, fetchImpl: feed.fetchImpl, sleepImpl: nosleep }),
    /enumerator found 250 posts and the feed's own board_total says 400/,
  );
});
