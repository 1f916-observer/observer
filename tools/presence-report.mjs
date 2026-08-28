#!/usr/bin/env node
// Turn the presence series into the answer to "what has traffic been, and where
// is it trending?" — without inventing anything the series does not contain.
//
// Usage:  node tools/presence-report.mjs [path-to.jsonl] [--days 7] [--hours 12]
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
//
// 5. COVERAGE IS SPREAD, NOT COUNT — and this is a correction to what this file
//    used to do. It measured coverage as `records / EXPECT` with EXPECT = 100,
//    and called a day thin below half of that. Two things were wrong, and the
//    series itself caught both.
//
//    EXPECT WAS NEVER REACHABLE. The best day this series has ever had is 22
//    records (2026-08-26). A bar of 50 has therefore never once been met, so
//    the line "not enough well-covered days yet to state a trend" — which reads
//    as *give it time* — was reporting a threshold no delivery rate this
//    workflow has ever seen could clear. A guard that has never been able to
//    fire is not a guard. The report now says that about itself: see the
//    "NEVER been met" line below.
//
//    AND COUNT IS THE WRONG QUANTITY ANYWAY. On 2026-08-26 the sampler fired 22
//    times across 18 distinct UTC hours. On 2026-08-28 it fired twice and wrote
//    10 records, because a fired run now writes five — all of them inside a
//    13.7-minute window. Ten records over 2 hours is not "half as well covered"
//    as 22 over 18; it is a different measurement. Five samples three minutes
//    apart tell you about fourteen minutes, however many rows they leave in the
//    file.
//
//    So coverage is now the fraction of the day's 24 hours holding at least one
//    record, and note 4's argument gets applied a second time: just as a peak
//    climbs with sample count, a median drifts toward whichever moments were
//    sampled densely. Records are therefore grouped into BURSTS — consecutive
//    records less than --burst minutes apart, which is one visit of the sampler
//    — and the day's median is the median over one value per burst. A dense
//    burst counts once, which is what it is worth.
//
//    The newest day of a live series is always incomplete and will read thin
//    until it closes. That is the conservative direction and it is deliberate:
//    a partial day is never trended.

import { readFile } from "node:fs/promises";

/* ---------- pure logic, exported so units.mjs can test it ---------- */

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Group records into visits of the sampler. Anything closer together than
// `gapMs` is one visit: five samples inside a quarter of an hour are five
// readings of one moment in the day, not five moments.
export const burstsOf = (records, gapMs) => {
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  let cur = null;
  for (const r of sorted) {
    const t = Date.parse(r.at);
    if (cur && t - cur.last < gapMs) {
      cur.records.push(r);
      cur.last = t;
    } else {
      cur = { start: t, last: t, records: [r] };
      out.push(cur);
    }
  }
  return out;
};

export const summariseDay = (records, { hoursRequired, gapMs }) => {
  const observed = records.filter((r) => r.observed && typeof r.floor === "number");
  const hours = new Set(records.map((r) => r.at.slice(11, 13)));
  const bursts = burstsOf(observed, gapMs);
  // One value per burst, so a dense visit cannot outvote a spread-out day.
  const perBurst = bursts.map((b) => median(b.records.map((r) => r.floor))).filter((v) => v !== null);
  return {
    peak: observed.length ? Math.max(...observed.map((r) => r.floor)) : null,
    median: median(perBurst),
    records: records.length,
    n: observed.length,
    bursts: bursts.length,
    hours: hours.size,
    outages: records.length - observed.length,
    thin: hours.size < hoursRequired,
  };
};

export const groupByDay = (rows) => {
  const days = new Map();
  for (const r of rows) {
    const key = r.at.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }
  return days;
};

/* ---------- CLI ---------- */

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("presence-report.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
  };
  const path = args.find((a) => !a.startsWith("--") && !Number.isFinite(Number(a))) ?? "presence-history.jsonl";
  const DAYS = flag("days", 7);
  // Distinct UTC hours a day must hold a sample in before its median may carry
  // a trend. Half the day. Unlike the record count it replaces, it is bounded
  // by 24 and cannot be made unreachable by a change to how many rows one run
  // happens to write.
  const HOURS_REQUIRED = flag("hours", 12);
  // Records closer together than this are one visit of the sampler.
  const BURST_GAP_MS = flag("burst", 15) * 60_000;

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

  const opts = { hoursRequired: HOURS_REQUIRED, gapMs: BURST_GAP_MS };
  const days = groupByDay(rows);
  const keys = [...days.keys()].sort();
  const summarise = (key) => ({ key, ...summariseDay(days.get(key), opts) });
  const recent = keys.slice(-DAYS).map(summarise);
  const prior = keys.slice(-DAYS * 2, -DAYS).map(summarise);

  const line = (s) => {
    const peak = s.peak === null ? "     —" : `  >=${String(s.peak).padStart(3)}`;
    const med = s.median === null ? "    —" : `>=${String(s.median).padStart(3)}`;
    const warn = s.thin ? "  thin — see hrs" : s.outages ? `  ${s.outages} failed` : "";
    return `  ${s.key}   ${peak}   ${med}   ${String(s.n).padStart(4)}   ${String(s.bursts).padStart(6)}   ${`${s.hours}/24`.padStart(5)}${warn}`;
  };

  console.log(`\nPresence series — ${rows.length} record(s), ${keys[0]} to ${keys[keys.length - 1]}`);
  console.log(`Every figure is a FLOOR on concurrent readers, not pageviews.`);
  console.log(`Coverage is SPREAD: distinct UTC hours holding a sample, out of 24. A day needs ${HOURS_REQUIRED} to be trended.\n`);
  console.log("  date           peak    median      n   visits     hrs");
  console.log("  " + "-".repeat(62));

  for (const s of recent) console.log(line(s));

  // Trend, but only across days solid enough to carry one, and only on the
  // median — see note 4 at the top for why the peak must not be trended.
  const solid = recent.filter((s) => !s.thin && s.median !== null);
  const priorSolid = prior.filter((s) => !s.thin && s.median !== null);

  console.log("");
  if (solid.length < 2) {
    console.log(`Not enough well-covered days yet to state a trend (${solid.length} of ${DAYS}).`);
    // The line the old report could not print, and the reason it needed to.
    // "Give it time" and "this bar has never once been cleared" are different
    // sentences, and only one of them is actionable.
    const best = keys.map(summarise).reduce((a, b) => (b.hours > a.hours ? b : a));
    if (best.hours < HOURS_REQUIRED) {
      console.log(`The bar of ${HOURS_REQUIRED}/24 hours has NEVER been met in this series — best is ${best.hours}/24 on ${best.key}.`);
      console.log(`That is a fact about sampler delivery, not about readership, and waiting alone does not fix it.`);
    } else {
      console.log("The series needs to run before it can answer this. That is the honest reading.");
    }
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

  const totalOutages = recent.reduce((a, s) => a + s.outages, 0);
  if (totalOutages) console.log(`\n${totalOutages} failed sample(s) in the window — recorded as failures, never as zero.`);
  console.log("");
}
