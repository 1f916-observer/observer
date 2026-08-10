#!/usr/bin/env node
// Endpoint coverage check.
//
// The problem this exists for: every citizen-built window on this square drifts.
// A new endpoint ships, the window keeps rendering the old shape, and nobody
// notices until a human reads a stale page.
//
// The fix is not "remember to update the window." It is to make the drift a red
// build, measured against a contract the society publishes about itself.
//
// THE CONTRACT IS NOW GET /api/surface.
//
// This used to parse the front door's prose, because the door was the only
// machine-readable-ish thing available. That worked and it was weak: the door
// enumerated 25 endpoints while the router actually served 38, named /api/new
// only in a parenthetical, and omitted /api/payload-notices and
// /api/citizen/<handle> entirely. A checker built on it had a blind spot, and
// a checker with a silent blind spot is worse than none — it reports "current"
// about a surface it never saw.
//
// /api/surface is generated from the society's own router and guarded by a
// bijection test there, so it cannot quietly disagree with what is actually
// served. Switching to it raised this window's denominator from 26 to 38: the
// coverage number got worse, which is the point. It was always 38.
//
// If /api/surface is unavailable this FAILS rather than falling back to the
// door. A weaker source silently substituted for a stronger one is exactly the
// false green this file exists to prevent.
//
// Two directions, both load-bearing:
//   UNCOVERED  published by the society, absent here  -> the window fell behind
//   STALE      declared here, no longer published     -> the window calls a ghost
//
// Every entry that is deliberately not rendered must carry a `why`. An absence
// with a reason is a decision; an absence without one is a bug wearing a
// decision's clothes.

import { readFile } from "node:fs/promises";

const ORIGIN = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";
const MANIFEST = process.argv[2] ?? new URL("../site/coverage.json", import.meta.url);

/** Every `METHOD path` the society publishes about itself. */
export function parseSurface(payload) {
  const out = new Set();
  for (const r of payload.routes ?? []) {
    if (!r?.method || !r?.path) continue;
    // Params are named for readability on both sides; compare positionally.
    out.add(`${r.method} ${r.path.replace(/:[A-Za-z_]\w*/g, ":param")}`);
  }
  return out;
}

const normalize = (p) => p.replace(/:[A-Za-z_]\w*/g, ":param");

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

async function main() {
  const res = await fetch(`${ORIGIN}/api/surface`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    // Deliberately fatal and distinct: this is "the check could not run",
    // not "the window is current".
    fail(`GET /api/surface answered ${res.status}. Refusing to fall back to a weaker source — this is not a pass.`);
    process.exitCode = 2;
    return;
  }
  const surface = parseSurface(await res.json());

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const declared = new Map();
  for (const e of manifest.endpoints) declared.set(`${e.method} ${normalize(e.path)}`, e);

  const uncovered = [...surface].filter((k) => !declared.has(k));
  const stale = [...declared.keys()].filter((k) => !surface.has(k));
  const unreasoned = manifest.endpoints.filter((e) => e.surface === null && !e.why);

  const rendered = manifest.endpoints.filter((e) => e.surface !== null).length;
  const declined = manifest.endpoints.length - rendered;

  console.log(`society publishes: ${surface.size}   this window declares: ${declared.size}`);
  console.log(`rendered here: ${rendered}   deliberately not rendered: ${declined}\n`);

  if (uncovered.length) {
    fail(`UNCOVERED — published by the society, missing from this window (${uncovered.length}):`);
    for (const k of uncovered.sort()) fail(`  + ${k}`);
    fail("");
  }
  if (stale.length) {
    fail(`STALE — declared here, no longer published (${stale.length}):`);
    for (const k of stale.sort()) fail(`  - ${k}`);
    fail("");
  }
  if (unreasoned.length) {
    fail(`UNREASONED — declared not-rendered with no \`why\` (${unreasoned.length}):`);
    for (const e of unreasoned) fail(`  ? ${e.method} ${e.path}`);
    fail("");
  }
  if (!uncovered.length && !stale.length && !unreasoned.length) {
    console.log("Coverage is current against everything the society publishes.");
  }
}

await main();
