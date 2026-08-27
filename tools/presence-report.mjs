#!/usr/bin/env node
// Turn the presence series into the answer to "what has traffic been, and where
// is it trending?" — without inventing anything the series does not contain.
//
// Usage:  node tools/presence-report.mjs [path-to.jsonl] [--days 7] [--expect 144]
//
// WHAT THIS REPORT IS CAREFUL ABOUT
//
// 1. Every number here is a FLOOR on concurrent readers. It is not pageviews,
//    not visitors, not sessions. A day whose peak floor is 40 means at least 40
//    browsers were reading at once; the true figure is higher by an unknown
//    amount. The report never drops the word "floor", because the moment it
//    does, somebody will quote it as a total.
//
// 2. A gap is not a zero. Runs that never happened and runs that failed are
//    counted and shown as coverage, so a quiet day and a broken sampler cannot
//    be confused. `security-invariants.mjs` refuses to print a pass when it
//    inspected nothing; same principle.
//
// 3. A window with thin coverage gets its trend suppressed rather than
//    estimated. Comparing a day with 140 observations against a day with 6 and
//    calling the difference a trend is the kind of confident-and-wrong number
//    this whole repo is a reaction against.
//
// 4. The TREND IS TAKEN ON THE MEDIAN, NOT THE PEAK — and that is a correctness
//    decision, not a style one. A daily peak is a maximum over that day's
//    samples, so it climbs with the NUMBER of samples: a day sampled 140 times
//    will out-peak an identical day sampled 20 times, for no reason connected
//    to readership. Trending peaks would therefore turn cron reliability into
//    apparent audience growth. The median is stable under sample count, so it
//    carries the trend; the peak stays in the table as a high-water mark and is
//    labelled as one.

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const path = args.find((a) => !a.startsWith("--") && !Number.isFinite(Number(a))) ?? "presence-history.jsonl";
const DAYS = flag("days", 7);
// Expected records per day.
//
// NOT the arithmetic of the cron. A */15 schedule implies 96 runs a day and
// GitHub delivered 21 in the first 26 hours — about 20%, gaps up to 5.4 hours,
// because scheduled workflows are dropped under load rather than queued. The
// workflow now takes five samples per fired run to compensate, so the number
// below is (observed fires) x (samples per run) and NOT (minutes in a day) /
// (cron interval). If the delivery rate moves, this is the figure that is
// wrong, and the coverage column is what will say so.
const EXPECT = flag("expect", 100);
// Below this fraction of expected records, a day is reported but not trended.
const THIN = 0.5;

let raw;
try {
  raw = await readFile(path, "utf8");
} catch {
  // Loud, for the same reason the invariant checker is loud about an empty run.
  console.error(`No series at ./${path} — nothing has been sampled yet. This is NOT "traffic was zero".`);
  process.exit(1);
}

const rows = raw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && typeof r.at === "string");

if (!rows.length) {
  console.error(`./${path} contains no readable records. This is NOT "traffic was zero".`);
  process.exit(1);
}

const dayOf = (iso) => iso.slice(0, 10);
const days = new Map();
for (const r of rows) {
  const key = dayOf(r.at);
  if (!days.has(key)) days.set(key, { observed: [], outages: 0, records: 0 });
  const d = days.get(key);
  d.records++;
  if (r.observed && typeof r.floor === "number") d.observed.push(r.floor);
  else d.outages++;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const keys = [...days.keys()].sort();
const recent = keys.slice(-DAYS);
const prior = keys.slice(-DAYS * 2, -DAYS);

const summarise = (key) => {
  const d = days.get(key);
  const cov = d.records / EXPECT;
  return {
    key,
    peak: d.observed.length ? Math.max(...d.observed) : null,
    median: median(d.observed),
    n: d.observed.length,
    outages: d.outages,
    coverage: cov,
    thin: cov < THIN,
  };
};

const line = (s) => {
  const cov = `${Math.round(s.coverage * 100)}%`;
  const peak = s.peak === null ? "     —" : `  >=${String(s.peak).padStart(3)}`;
  const med = s.median === null ? "    —" : `>=${String(s.median).padStart(3)}`;
  const warn = s.thin ? "  thin coverage" : s.outages ? `  ${s.outages} failed` : "";
  return `  ${s.key}   ${peak}   ${med}   ${String(s.n).padStart(4)}   ${cov.padStart(5)}${warn}`;
};

console.log(`\nPresence series — ${rows.length} record(s), ${keys[0]} to ${keys[keys.length - 1]}`);
console.log(`Every figure is a FLOOR on concurrent readers, not pageviews.\n`);
console.log("  date           peak    median      n   cover");
console.log("  " + "-".repeat(52));

const recentSummaries = recent.map(summarise);
for (const s of recentSummaries) console.log(line(s));

// Trend, but only across days solid enough to carry one, and only on the
// median — see note 4 at the top for why the peak must not be trended.
const solid = recentSummaries.filter((s) => !s.thin && s.median !== null);
const priorSolid = prior.map(summarise).filter((s) => !s.thin && s.median !== null);

console.log("");
if (solid.length < 2) {
  console.log(`Not enough well-covered days yet to state a trend (${solid.length} of ${DAYS}).`);
  console.log("The series needs to run before it can answer this. That is the honest reading.");
} else {
  const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const now = avg(solid.map((s) => s.median));
  const peak = Math.max(...solid.map((s) => s.peak));
  console.log(`Typical concurrent readers, last ${solid.length} well-covered day(s): >=${now} (median of daily medians).`);
  console.log(`High-water mark in that window: >=${peak}.`);

  if (priorSolid.length >= 2) {
    const was = avg(priorSolid.map((s) => s.median));
    const delta = now - was;
    const pct = was ? Math.round((delta / was) * 100) : null;
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    console.log(`Prior ${priorSolid.length} well-covered day(s): >=${was}.`);
    console.log(`Trend: ${dir}${pct === null ? "" : ` ${Math.abs(pct)}%`} (${was} -> ${now}).`);
    console.log(`Both endpoints are floors, so this compares floors — it is not a measured change in audience.`);
  } else {
    console.log(`No comparable prior window yet, so no trend is claimed.`);
  }
}

const totalOutages = recentSummaries.reduce((a, s) => a + s.outages, 0);
if (totalOutages) console.log(`\n${totalOutages} failed sample(s) in the window — recorded as failures, never as zero.`);
console.log("");
