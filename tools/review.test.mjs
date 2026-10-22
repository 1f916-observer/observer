// Unit tests for the review queue. Offline: no network, no GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engagement, ciState, todaysPicks, order, summarise, checkCommands, ageDays, KNOWN_CHECKS } from "./review.mjs";

const item = (key, over = {}) => ({
  key, repo: key.split("#")[0], age_days: 10, draft: false, ci: "none", small: true,
  engagement: { unreviewed: true }, ...over,
});

test("engagement: the author's own reviews and comments do not count as anyone looking", () => {
  const e = engagement("author", [{ user: { login: "author" }, state: "COMMENTED", submitted_at: "2026-10-01T00:00:00Z" }],
    [{ user: { login: "author" }, created_at: "2026-10-02T00:00:00Z" }]);
  assert.equal(e.unreviewed, true);
  assert.equal(e.reviews, 0);
  assert.equal(e.last_engagement_at, null);
});

test("engagement: somebody else's comment or review ends 'unreviewed', and approvals are counted", () => {
  const e = engagement("author",
    [{ user: { login: "r1" }, state: "APPROVED", submitted_at: "2026-10-03T00:00:00Z" },
      { user: { login: "r2" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T00:00:00Z" }],
    [{ user: { login: "c1" }, created_at: "2026-10-05T00:00:00Z" }]);
  assert.deepEqual(e, { reviews: 2, approvals: 1, changes_requested: 1, comments_by_others: 1, last_engagement_at: "2026-10-05T00:00:00Z", unreviewed: false });
});

test("engagement names nobody: logins go in, only counts and times come out", () => {
  const e = engagement("secret-author", [{ user: { login: "secret-reviewer" }, state: "APPROVED", submitted_at: "2026-10-03T00:00:00Z" }],
    [{ user: { login: "secret-commenter" }, created_at: "2026-10-04T00:00:00Z" }]);
  const text = JSON.stringify(e);
  for (const login of ["secret-author", "secret-reviewer", "secret-commenter", "login", "user"]) assert.ok(!text.includes(login), login);
});

test("ci: no CI is its own answer, not a pass", () => {
  assert.equal(ciState([], { statuses: [] }), "none");
  assert.equal(ciState(undefined, undefined), "none");
  assert.equal(ciState([{ status: "completed", conclusion: "success" }], { statuses: [] }), "green");
  assert.equal(ciState([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }], null), "red");
  assert.equal(ciState([{ status: "in_progress", conclusion: null }], null), "pending");
  assert.equal(ciState([], { statuses: [{ state: "error" }] }), "red");
  assert.equal(ciState([{ status: "completed", conclusion: "skipped" }], null), "green");
});

test("today's picks: the same for every reader on one day, different the next", () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`o/r#${i}`));
  const a = todaysPicks(items, "2026-10-22");
  assert.equal(a.length, 3);
  assert.deepEqual(todaysPicks([...items].reverse(), "2026-10-22"), a, "input order must not matter");
  const days = new Set(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"].map((d) => todaysPicks(items, d).join()));
  assert.ok(days.size >= 3, "picks should rotate across days");
});

test("today's picks skip what a reviewer's ten minutes should not go to", () => {
  const items = [
    item("o/r#1", { ci: "red" }),
    item("o/r#2", { draft: true }),
    item("o/r#3", { engagement: { unreviewed: false } }),
    item("o/r#4"),
  ];
  assert.deepEqual(todaysPicks(items, "2026-10-22"), ["o/r#4"]);
  assert.deepEqual(todaysPicks([], "2026-10-22"), []);
});

test("order: unreviewed first, then oldest", () => {
  const got = order([
    item("o/r#1", { age_days: 50, engagement: { unreviewed: false } }),
    item("o/r#2", { age_days: 5 }),
    item("o/r#3", { age_days: 40 }),
  ]).map((i) => i.key);
  assert.deepEqual(got, ["o/r#3", "o/r#2", "o/r#1"]);
});

test("summary: median, thresholds, and per-repo counts", () => {
  const s = summarise([item("a/x#1", { age_days: 2 }), item("a/x#2", { age_days: 40, ci: "green" }), item("b/y#1", { age_days: 20, engagement: { unreviewed: false } })]);
  assert.equal(s.open, 3);
  assert.equal(s.unreviewed, 2);
  assert.equal(s.median_age_days, 20);
  assert.equal(s.over_14_days, 2);
  assert.equal(s.over_30_days, 1);
  assert.deepEqual(s.by_repo["a/x"], { open: 2, unreviewed: 2, oldest_days: 40, ci_none: 1 });
  assert.equal(summarise([item("a/x#1", { age_days: 2 }), item("a/x#2", { age_days: 4 })]).median_age_days, 3);
  assert.equal(summarise([]).median_age_days, null);
});

test("check commands: a clean clone of the PR head, and an honest gap when no check is known", () => {
  const c = checkCommands("1f916-ai/protocol", 13, KNOWN_CHECKS["1f916-ai/protocol"]);
  assert.deepEqual(c, [
    "git clone https://github.com/1f916-ai/protocol && cd protocol",
    "git fetch origin pull/13/head && git checkout FETCH_HEAD",
    "node selftest.mjs && node testvectors/verify-rotate.mjs",
  ]);
  assert.match(checkCommands("o/r", 1, null)[2], /no known check/);
});

test("age is whole days since opening", () => {
  assert.equal(ageDays("2026-10-01T00:00:00Z", Date.parse("2026-10-22T23:59:00Z")), 21);
});
