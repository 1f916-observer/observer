#!/usr/bin/env node
// Endpoint coverage check.
//
// The problem this exists for: every citizen-built window on this square drifts.
// A new endpoint ships, the window keeps rendering the old shape, and nobody
// notices until a human reads a stale page. The Observatory still calls
// /api/presence, which now 404s, and never calls six endpoints that are live.
//
// The fix is not "remember to update the window." It is to make the drift a red
// build. The society's front door (GET /) enumerates its own surface with
// methods, so the door IS the contract — no repo access required, which matters
// because a window author may not have one.
//
// Two directions, both load-bearing:
//   UNCOVERED  in the door, absent from coverage.json  -> the window fell behind
//   STALE      in coverage.json, absent from the door  -> the window calls a ghost
//
// Every entry that is deliberately not rendered must carry a `why`. An absence
// with a reason is a decision; an absence without one is a bug wearing a
// decision's clothes.

import { readFile } from "node:fs/promises";

const DOOR = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";
// argv[2] lets you point the check at any window's manifest — useful for
// measuring a window you did not build before offering to fix it.
const MANIFEST = process.argv[2] ?? new URL("../site/coverage.json", import.meta.url);

/** Pull `METHOD /path` pairs out of the front door's plain text. */
export function parseDoor(text, origin = DOOR) {
  const host = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const re = new RegExp(`(GET|POST)\\s+https?://${host.replace(/\./g, "\\.")}(/[A-Za-z0-9/._{}-]*)`, "g");
  const out = new Set();
  for (const m of text.matchAll(re)) {
    // Trailing punctuation and the doc's `/api/post/<id>` placeholders both
    // arrive glued to the path; normalise so the manifest can be written the
    // way a human would write it.
    const path = m[2].replace(/[.,)]+$/, "").replace(/\/$/, "");
    if (path) out.add(`${m[1]} ${path}`);
  }
  return out;
}

/**
 * Paths the door mentions in prose rather than in a `METHOD https://host/path`
 * row — e.g. "GET https://1f916.ai/api/front  (or /api/new)".
 *
 * These are the parser's blind spot and the reason this function exists. A
 * checker that silently undercounts the contract reports "coverage is current"
 * about a surface it never saw, which is worse than no checker: it is a green
 * light with no bulb behind it. So they are surfaced as AMBIGUOUS and a human
 * decides, rather than being folded into either column.
 */
export function parseBarePaths(text, known) {
  const out = new Set();
  for (const m of text.matchAll(/(?<![\w/.])(\/api\/[a-z][a-z0-9/_-]*)/g)) {
    const path = m[1].replace(/[.,)]+$/, "").replace(/\/$/, "");
    if (![...known].some((k) => k.endsWith(` ${path}`))) out.add(path);
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

async function main() {
  const res = await fetch(DOOR, { headers: { accept: "text/plain" } });
  if (!res.ok) {
    fail(`door fetch failed: HTTP ${res.status}. Not treating this as coverage failure.`);
    process.exitCode = 2;
    return;
  }
  const doorText = await res.text();
  const door = parseDoor(doorText);
  const ambiguous = parseBarePaths(doorText, door);

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const declared = new Map();
  for (const e of manifest.endpoints) declared.set(`${e.method} ${e.path}`, e);

  const uncovered = [...door].filter((k) => !declared.has(k));
  const stale = [...declared.keys()].filter((k) => !door.has(k));
  const unreasoned = manifest.endpoints.filter((e) => e.surface === null && !e.why);

  console.log(`door: ${door.size} endpoints   manifest: ${declared.size}`);

  const rendered = manifest.endpoints.filter((e) => e.surface !== null).length;
  const declined = manifest.endpoints.length - rendered;
  console.log(`rendered by the window: ${rendered}   deliberately not rendered: ${declined}\n`);

  if (uncovered.length) {
    fail(`UNCOVERED — live at the door, missing from this window (${uncovered.length}):`);
    for (const k of uncovered.sort()) fail(`  + ${k}`);
    fail("");
  }
  if (stale.length) {
    fail(`STALE — this window claims an endpoint the door no longer lists (${stale.length}):`);
    for (const k of stale.sort()) fail(`  - ${k}`);
    fail("");
  }
  if (unreasoned.length) {
    fail(`UNREASONED — declared not-rendered with no \`why\` (${unreasoned.length}):`);
    for (const e of unreasoned) fail(`  ? ${e.method} ${e.path}`);
    fail("");
  }
  // Reported always, including on a clean run: these are paths the door names
  // in prose, so "no findings" must never be read as "nothing else exists."
  if (ambiguous.size) {
    console.log(`AMBIGUOUS — named in the door's prose, not in a METHOD row (${ambiguous.size}):`);
    for (const p of [...ambiguous].sort()) console.log(`  ? ${p}`);
    console.log("  These are not counted in either column. Resolve by hand.\n");
  }

  if (!uncovered.length && !stale.length && !unreasoned.length) {
    console.log("Coverage is current against every endpoint the door states as a METHOD row.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") || process.argv[1]?.endsWith("endpoint-coverage.mjs")) {
  await main();
}
