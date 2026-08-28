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

import { readFileSync } from "node:fs";
import { tally, executorOf, openMotions, terms, resolution } from "./ballot.mjs";
import { extractUrls } from "./rail-check.mjs";
import { digest, ratifiedHash } from "./statement.mjs";
import { burstsOf, summariseDay } from "./presence-report.mjs";

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

/* ---------- the window and the CLI must not disagree ---------- */
//
// site/app.js carries its own copy of the terms and resolution rules, because a
// browser page cannot import a CLI module here. A copy is a thing that drifts,
// and a window reporting a different outcome than the tool would be worse than
// either alone — so the copy is checked against the original rather than
// trusted. This is the same discipline as endpoint-coverage: make the drift a
// red build instead of a promise.
{
  // Normalise line endings first: the working copy is CRLF on Windows, and an
  // extractor that assumes \n silently returns two characters instead of a
  // function, which fails as "not defined" rather than as "extraction broke".
  const src = readFileSync(new URL("../site/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`site/app.js no longer defines ${name}`);
    const end = src.indexOf("\n}\n", start);
    if (end < 0) throw new Error(`could not find the end of ${name} in site/app.js`);
    return src.slice(start, end + 3);
  };
  const win = new Function(grab("ballotTerms") + grab("ballotResolution") +
    "; return { ballotTerms, ballotResolution };")();

  const AT = Date.parse("2026-08-26T00:00:00Z");
  const T = (aye, nay, abs = 0) => ({
    aye: Array.from({ length: aye }, (_, i) => ({ handle: "a" + i })),
    nay: Array.from({ length: nay }, (_, i) => ({ handle: "n" + i })),
    abstain: Array.from({ length: abs }, (_, i) => ({ handle: "b" + i })),
  });
  const tg = (...names) => names.map((n) => ({ tag: n, taggers: [{ handle: "x", at: 1 }] }));

  const scenarios = [
    ["open clock, passing", tg("until-9-20260901", "pass-9-66"), T(7, 2)],
    ["open clock, failing", tg("until-9-20260901", "pass-9-90"), T(7, 2)],
    ["closed and passed", tg("until-9-20260801", "pass-9-66"), T(7, 2)],
    ["no threshold", tg("until-9-20260901"), T(7, 2)],
    ["no deadline at all", tg("pass-9-50"), T(1, 1)],
    ["quorum not met", tg("until-9-20260901", "pass-9-50", "quorum-9-20"), T(7, 2)],
    ["disputed deadline", tg("until-9-20260901", "until-9-20261001", "pass-9-50"), T(3, 1)],
    ["no decisive ballots", tg("until-9-20260901", "pass-9-50"), T(0, 0, 4)],
  ];

  for (const [name, tags, t] of scenarios) {
    const a = resolution(t, terms(tags, 9), AT);
    const b = win.ballotResolution(t, win.ballotTerms(tags, 9), AT);
    eq(`window agrees with CLI: ${name}`,
      [b.outcome, b.clock, b.share], [a.outcome, a.clock, a.share_aye]);
  }
}


/* ---------- the clock has to actually bind ---------- */
//
// The first version of the terms surface counted every ballot regardless of
// when it was applied, which made the deadline decorative: a citizen could wait
// for an unfavourable close and then vote. Found by testing the clock against
// itself rather than by anyone reporting it.
{
  const T0 = Date.parse("2025-12-30T00:00:00Z");
  const before = Date.parse("2025-12-31T00:00:00Z");
  const after = Date.parse("2026-07-01T00:00:00Z");
  const base = [
    { tag: "motion-9", taggers: [{ handle: "p", at: T0 }] },
    { tag: "until-9-20260101", taggers: [{ handle: "p", at: T0 }] },
  ];

  const flip = [...base,
    { tag: "pass-9-50", taggers: [{ handle: "p", at: T0 }] },
    { tag: "aye-9", taggers: [{ handle: "a", at: before }] },
    { tag: "nay-9", taggers: [{ handle: "l1", at: after }, { handle: "l2", at: after }] }];
  const ft = tally(flip, 9);
  eq("ballots after the close are not counted", [ft.aye.length, ft.nay.length], [1, 0]);
  eq("but they are kept and shown, not silently dropped", ft.late.map((v) => v.position), ["nay", "nay"]);
  eq("so a closed motion cannot be flipped after the fact",
    resolution(ft, ft.terms, Date.now()).outcome, "passed");

  const retro = [...base,
    { tag: "aye-9", taggers: [{ handle: "a", at: before }] },
    { tag: "pass-9-99", taggers: [{ handle: "sneak", at: after }] }];
  const rt = tally(retro, 9);
  eq("a threshold declared after the close does not govern", rt.terms.pass.state, "late");
  eq("and the outcome reports undeclared rather than the retroactive rule",
    resolution(rt, rt.terms, Date.now()).outcome, "undeclared");

  // An open motion must not accidentally inherit the filter.
  const open = [{ tag: "motion-9", taggers: [{ handle: "p", at: T0 }] },
    { tag: "pass-9-50", taggers: [{ handle: "p", at: T0 }] },
    { tag: "aye-9", taggers: [{ handle: "a", at: after }] }];
  eq("with no deadline every ballot counts", tally(open, 9).aye.length, 1);
  eq("and none are marked late", tally(open, 9).late.length, 0);

  // and the window agrees about all of it
  const src = readFileSync(new URL("../site/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const grab = (n) => { const a = src.indexOf(`function ${n}(`); const b = src.indexOf("\n}\n", a); return src.slice(a, b + 3); };
  const win = new Function(grab("ballotTerms") + grab("ballotResolution") + "; return { ballotTerms, ballotResolution };")();
  for (const [name, tags] of [["late-ballot scenario", flip], ["retroactive-threshold scenario", retro]]) {
    const t = tally(tags, 9);
    eq(`window agrees after the close fix: ${name}`,
      win.ballotResolution(t, win.ballotTerms(tags, 9), Date.now()).outcome,
      resolution(t, t.terms, Date.now()).outcome);
  }
}


/* ---------- object: #480 part 3's fourth position ---------- */
{
  const T = Date.parse("2026-01-01T00:00:00Z");
  const mk = (n, hs) => ({ tag: n, taggers: hs.map((h) => ({ handle: h, at: T })) });

  const blocked = [mk("motion-9", ["p"]), mk("pass-9-66", ["p"]),
    mk("aye-9", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]), mk("nay-9", ["n1"]),
    mk("object-9-c500", ["o1"])];
  const bt = tally(blocked, 9);
  eq("an objection is parsed with the comment carrying its reason",
    bt.objections.map((o) => [o.handle, o.reason_comment]), [["o1", 500]]);
  eq("an objection does not dilute the aye share",
    resolution(bt, bt.terms, Date.now()).share_aye, 88.9);
  eq("but it gates the motion at 10% of ballots",
    resolution(bt, bt.terms, Date.now()).outcome, "blocking");

  const under = [mk("motion-9", ["p"]), mk("pass-9-66", ["p"]),
    mk("aye-9", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]), mk("nay-9", ["n1", "n2"]),
    mk("object-9-c500", ["o1"])];
  eq("under 10% it does not block",
    (() => { const t = tally(under, 9); return resolution(t, t.terms, Date.now()).outcome; })(), "passing");

  // an objection is a ballot, so the close filter applies to it too
  const lateObj = [mk("motion-9", ["p"]), mk("until-9-20260101", ["p"]), mk("pass-9-66", ["p"]),
    { tag: "aye-9", taggers: [{ handle: "a", at: Date.parse("2025-12-31T00:00:00Z") }] },
    { tag: "object-9-c500", taggers: [{ handle: "late", at: Date.parse("2026-07-01T00:00:00Z") }] }];
  const lt = tally(lateObj, 9);
  eq("an objection filed after the close does not block", lt.objections.length, 0);
  eq("and is kept in objections_late", lt.objections_late.length, 1);

  // window agreement on all three
  const src = readFileSync(new URL("../site/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const grab = (n) => { const a = src.indexOf(`function ${n}(`); const b = src.indexOf("\n}\n", a); return src.slice(a, b + 3); };
  const win = new Function(grab("ballotTerms") + grab("ballotResolution") + grab("ballotObjections") +
    "; return { ballotTerms, ballotResolution, ballotObjections };")();
  for (const [name, tags] of [["blocked", blocked], ["under threshold", under], ["late objection", lateObj]]) {
    const t = tally(tags, 9);
    const tms = win.ballotTerms(tags, 9);
    const u = tms.until;
    const dl = (u.state === "declared" && /^\d{8}$/.test(u.value))
      ? Date.parse(`${u.value.slice(0, 4)}-${u.value.slice(4, 6)}-${u.value.slice(6, 8)}T00:00:00Z`) : null;
    const wt = { ...t, objections: win.ballotObjections(tags, 9, dl) };
    eq(`window agrees on objections: ${name}`,
      win.ballotResolution(wt, tms, Date.now()).outcome, resolution(t, t.terms, Date.now()).outcome);
  }
}


/* ---------- statement: ratify the bytes, not the intention ---------- */
{
  const base = "The society says a thing.\n\nAnd a second line.\n";
  const h = digest(base);

  // A CRLF checkout must not produce a different society statement than an LF one.
  eq("CRLF and LF hash the same", digest(base.replace(/\n/g, "\r\n")), h);
  eq("trailing whitespace does not change the statement",
    digest(base.split("\n").map((l) => l + "  \t").join("\n")), h);
  eq("trailing blank lines do not change the statement", digest(base + "\n\n\n"), h);

  // Everything else must.
  eq("one character changes the hash", digest("The society says a thing!\n\nAnd a second line.\n") === h, false);
  eq("case changes the hash", digest(base.toUpperCase()) === h, false);
  eq("spacing INSIDE a line changes the hash",
    digest("The  society says a thing.\n\nAnd a second line.\n") === h, false);
  // A canonicaliser that tidies outbound text is one that can change what was said.
  eq("leading whitespace is preserved", digest("  indented\n") === digest("indented\n"), false);

  eq("the ratified hash is read out of the motion body",
    ratifiedHash(`we should say this\n\nstatement-sha256: ${h}\n\nthanks`), h);
  eq("a motion with no hash ratifies no bytes", ratifiedHash("we should say something nice"), null);
  eq("a short or malformed hash is not accepted",
    ratifiedHash("statement-sha256: abc123"), null);
  eq("the marker is matched case-insensitively",
    ratifiedHash(`STATEMENT-SHA256: ${h}`), h);
}

/* ---------- the presence report ---------- */

// These exist because the report shipped a coverage metric that could not
// answer the question it was for. It measured `records / 100` and called a day
// thin below half, so a day of 10 records taken inside two hours scored the
// same as 10 records spread across ten hours, and the 100 was never once
// reached in the series' whole life. Coverage is spread; these tests pin that.
{
  const rec = (at, floor) => ({ at, observed: true, floor });
  const opts = { hoursRequired: 12, gapMs: 15 * 60_000 };

  // The specimen is real: on 2026-08-28 one fired run wrote five records
  // 206 seconds apart. That is one visit, not five.
  const oneVisit = [
    rec("2026-08-28T01:01:59.110Z", 27), rec("2026-08-28T01:05:24.959Z", 30),
    rec("2026-08-28T01:08:50.817Z", 14), rec("2026-08-28T01:12:16.585Z", 23),
    rec("2026-08-28T01:15:42.407Z", 30),
  ];
  eq("five records inside a quarter hour are one burst", burstsOf(oneVisit, opts.gapMs).length, 1);
  eq("records 42 minutes apart are separate bursts",
    burstsOf([rec("2026-08-26T02:52:27Z", 41), rec("2026-08-26T03:44:40Z", 23)], opts.gapMs).length, 2);

  // The defect in one assertion: same record count, opposite coverage.
  const dense = summariseDay([...oneVisit, ...oneVisit.map((r) => rec(r.at.replace("T01:", "T12:"), r.floor))], opts);
  const spread = summariseDay(
    Array.from({ length: 10 }, (_, i) => rec(`2026-08-26T${String(i + 2).padStart(2, "0")}:10:00Z`, 30 + i)),
    opts,
  );
  eq("ten dense records and ten spread records are not the same coverage",
    [dense.n, dense.hours, dense.thin, spread.n, spread.hours, spread.thin],
    [10, 2, true, 10, 10, true]);
  eq("a burst is one visit however many rows it leaves", [dense.bursts, spread.bursts], [2, 10]);

  // Twelve spread hours clears the bar; the same count crammed into two does not.
  const twelve = summariseDay(
    Array.from({ length: 12 }, (_, i) => rec(`2026-08-26T${String(i + 2).padStart(2, "0")}:10:00Z`, 30)),
    opts,
  );
  eq("twelve distinct hours is trendable", [twelve.hours, twelve.thin], [12, false]);

  // Note 4's argument, applied to bursts: a dense visit must not outvote a day.
  // Nine spread readings of 10 and one burst of five readings of 100 has a
  // median of 10 by burst and 100 by record. The burst reading is the true one.
  const skewed = summariseDay(
    [
      ...Array.from({ length: 9 }, (_, i) => rec(`2026-08-26T${String(i + 2).padStart(2, "0")}:10:00Z`, 10)),
      ...Array.from({ length: 5 }, (_, i) => rec(`2026-08-26T20:${String(i * 3).padStart(2, "0")}:00Z`, 100)),
    ],
    opts,
  );
  eq("a dense burst cannot outvote a spread day's median", skewed.median, 10);
  // The peak is still a max over every record, and is still labelled a
  // high-water mark rather than trended.
  eq("bursting does not touch the peak", skewed.peak, 100);

  // A failed sample is data. It must count toward neither the median nor a
  // silent zero, and must still put its hour on the record as attempted.
  const withOutage = summariseDay(
    [rec("2026-08-26T02:10:00Z", 30), { at: "2026-08-26T09:10:00Z", observed: false, floor: null }],
    opts,
  );
  eq("an outage is an attempted hour and never a zero",
    [withOutage.n, withOutage.outages, withOutage.hours, withOutage.median], [1, 1, 2, 30]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
