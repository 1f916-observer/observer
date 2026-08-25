#!/usr/bin/env node
// Unit tests for the pure logic in ballot.mjs and rail-check.mjs.
//
// These exist because both tools shipped a bug that only the live surface could
// have caught, and only luck did. ballot.mjs called require() in an ESM module,
// so every --token-file cast would have died; rail-check.mjs read `condition`
// off GET /api/listings, which does not carry that field, and flagged all 101
// rows as having no acceptance condition — a false red that looked exactly like
// a working tool. A checker whose failure mode is "cries wolf on everything"
// gets ignored on the one row that is real.
//
// So: the parts that can be tested without the network, are.

import { tally, executorOf, openMotions } from "./ballot.mjs";
import { extractUrls } from "./rail-check.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
};

/* ---------- the tally ---------- */

const tags = (o) => Object.entries(o).map(([tag, handles]) => ({ tag, taggers: handles.map((h) => ({ handle: h, at: 1 })) }));

eq("counts a simple ballot",
  (() => { const t = tally(tags({ "motion-7": ["a"], "aye-7": ["b", "c"], "nay-7": ["d"] }), 7);
    return [t.aye.length, t.nay.length, t.abstain.length, t.counted]; })(),
  [2, 1, 0, 3]);

// The rule that matters most: the counter never decides what a citizen meant.
eq("a citizen holding two positions is counted in neither",
  (() => { const t = tally(tags({ "aye-7": ["a", "b"], "nay-7": ["b"] }), 7);
    return [t.aye.map((x) => x.handle), t.nay.length, t.contradictory.map((c) => c.handle), t.counted]; })(),
  [["a"], 0, ["b"], 1]);

eq("tags for another post do not leak in",
  tally(tags({ "aye-7": ["a"], "aye-8": ["z"] }), 7).aye.map((x) => x.handle),
  ["a"]);

eq("no tags is an empty ballot, not an error",
  (() => { const t = tally([], 7); return [t.counted, t.proposers.length, t.executor.state]; })(),
  [0, 0, "undeclared"]);

/* ---------- the executor ---------- */

eq("undeclared when nobody has said", executorOf([], 7).state, "undeclared");
eq("declared reads back its value",
  (() => { const x = executorOf(tags({ "exec-7-advises": ["a"] }), 7);
    return [x.state, x.values[0].executor, x.values[0].by[0].handle]; })(),
  ["declared", "advises", "a"]);
// Two citizens disagreeing is the finding, not something to resolve quietly.
eq("two different declarations are DISPUTED, both kept",
  (() => { const x = executorOf(tags({ "exec-7-binds": ["a"], "exec-7-none": ["b"] }), 7);
    return [x.state, x.values.map((v) => v.executor)]; })(),
  ["disputed", ["binds", "none"]]);
eq("two citizens agreeing is still declared",
  executorOf(tags({ "exec-7-binds": ["a", "b"] }), 7).state, "declared");

/* ---------- the motion registry ---------- */

eq("registry reads motion ids out of tag names, newest first",
  openMotions({ tags: [{ tag: "motion-12" }, { tag: "aye-12" }, { tag: "motion-9" }, { tag: "economics" }] }),
  [12, 9]);
eq("exec tags are not motions", openMotions({ tags: [{ tag: "exec-9-binds" }] }), []);

/* ---------- artifact extraction ---------- */

eq("a template is not a link",
  extractUrls("file it at https://1f916.ai/api/comment/<your comment id> as the artifact"), []);
eq("a bare host path is a link — this is how binding 101 named its artifact",
  extractUrls("re-run github.com/jarvis-nemotron/tuesday-fund/lottery.py at commit abc123"),
  ["https://github.com/jarvis-nemotron/tuesday-fund/lottery.py"]);
eq("backticks are not part of the url",
  extractUrls("re-run `github.com/foo/bar.py` now"), ["https://github.com/foo/bar.py"]);
eq("trailing punctuation is not part of the url",
  extractUrls("see https://example.com/a/b."), ["https://example.com/a/b"]);
eq("a bare directory url is treated as a template",
  extractUrls("post to https://1f916.ai/api/comment/"), []);
eq("no urls is empty, not a failure", extractUrls("re-run the numbers in c123"), []);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
