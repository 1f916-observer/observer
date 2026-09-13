#!/usr/bin/env node
// Schema smoke check — the half endpoint coverage cannot see.
//
// endpoint-coverage.mjs catches an endpoint appearing or disappearing. It is
// blind to the response CHANGING SHAPE underneath a view that still renders, and
// shape is what actually breaks things. Every bug found while building this
// window would have sailed through a green coverage run:
//
//   /api/docket returns {docket:[...]} — the key guess was wrong, so the page
//     rendered "Rows 0": a confident claim the society's work queue was empty
//   /treasury holdings live at assets.holdings with value_cents
//   /api/changes requires ?since or answers 400
//   /api/attest keeps status and verified_head inside identity_log and treasury,
//     not at the top level, so every field on that view read as "—"
//
// So each rendered endpoint in coverage.json declares the fields its view
// actually reads. This fetches the live endpoint and fails if one goes missing.
// The declaration lives beside the coverage entry rather than in a second file,
// because two lists of endpoints would drift from each other exactly the way
// this repo exists to prevent.
//
// Field paths: `a.b` walks objects, `a[].b` means "every element of array a
// must have b". An empty array passes — the society is allowed to have no
// notices today, and that is not a schema failure.

import { readFile } from "node:fs/promises";

const ORIGIN = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";
const MANIFEST = process.argv[2] ?? new URL("../site/coverage.json", import.meta.url);

/** Resolve one field path against a response. Returns a list of failures. */
export function checkPath(root, path) {
  const parts = path.split(".");
  let cursors = [{ value: root, at: "" }];

  for (const rawPart of parts) {
    const isArray = rawPart.endsWith("[]");
    const key = isArray ? rawPart.slice(0, -2) : rawPart;
    const next = [];

    for (const cur of cursors) {
      if (cur.value == null || typeof cur.value !== "object") {
        return [`${path} — nothing at "${cur.at || "(root)"}" to read "${key}" from`];
      }
      if (!(key in cur.value)) {
        return [`${path} — missing "${key}"${cur.at ? ` under ${cur.at}` : " at the top level"}`];
      }
      const value = cur.value[key];
      const at = cur.at ? `${cur.at}.${key}` : key;

      if (isArray) {
        if (!Array.isArray(value)) return [`${path} — "${at}" is ${value === null ? "null" : typeof value}, expected an array`];
        // An empty array is a fact about today, not a broken contract.
        for (let i = 0; i < value.length; i++) next.push({ value: value[i], at: `${at}[${i}]` });
      } else {
        next.push({ value, at });
      }
    }
    cursors = next;
    if (!cursors.length) return [];
  }
  return [];
}

const substitute = (s) => s.replace("{{since24h}}", String(Date.now() - 86400000));

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const targets = manifest.endpoints.filter((e) => e.surface !== null && Array.isArray(e.requires) && e.requires.length);

  // Three outcomes, not two. "The society did not answer" and "the society
  // answered with a different shape" are different facts about different
  // parties, and this tool used to print both as "no longer returns what this
  // window reads. The views above are rendering blanks or nothing."
  //
  // That sentence is a claim about OUR bug. On a 503 or a 429 it is the wrong
  // reason, and a wrong reason is worse than silence because somebody acts on
  // it: the last time this fired it said three views were rendering blanks when
  // the truth was that the checker had been throttled for making too many
  // requests, and one endpoint was timing out on the society's own worker.
  //
  // So: a missing field fails the build, because that is this window's problem
  // to fix. An unavailable or throttled endpoint is reported, loudly, as NOT
  // CHECKED — it is not evidence of a defect here, and a checker that goes red
  // on someone else's outage is a checker people learn to ignore on the day it
  // is right.
  const schemaFailures = [];
  const unavailable = [];
  let checked = 0;

  for (const entry of targets) {
    const path = substitute(entry.probe || entry.path);
    let body;
    try {
      const res = await fetch(ORIGIN + path, { headers: { accept: "application/json" } });
      if (!res.ok) {
        const why = res.status === 429 ? "THROTTLED" : res.status >= 500 ? "UNAVAILABLE" : "REFUSED";
        // A 4xx that is not 429 is the one case in this branch that IS ours: we
        // asked for something the society does not serve, which usually means a
        // probe pinned to a row that has gone away.
        if (why === "REFUSED") schemaFailures.push({ entry, path, detail: `HTTP ${res.status} — the probe asked for something the society does not serve` });
        else unavailable.push({ entry, path, status: res.status, why });
        continue;
      }
      body = await res.json();
    } catch (err) {
      // A transport error is the society being unreachable, not a shape change.
      unavailable.push({ entry, path, status: 0, why: "UNREACHABLE", detail: err.message });
      continue;
    }

    const problems = entry.requires.flatMap((p) => checkPath(body, p));
    checked += entry.requires.length;
    if (problems.length) schemaFailures.push({ entry, path, problems });
  }

  for (const u of unavailable) {
    console.error(`NOT CHECKED  ${u.entry.method} ${u.entry.path} — ${u.why}${u.status ? " " + u.status : ""} at ${u.path}${u.detail ? " (" + u.detail + ")" : ""}`);
  }
  for (const f of schemaFailures) {
    console.error(`FAIL  ${f.entry.method} ${f.entry.path}  (renders: ${f.entry.surface})`);
    if (f.detail) console.error(`     ${f.detail}`);
    for (const p of f.problems || []) console.error(`     ${p}`);
  }

  console.log(`\n${targets.length} endpoint(s), ${checked} field(s) checked against the live society.`);
  if (unavailable.length) {
    console.log(`${unavailable.length} endpoint(s) could not be checked: the society did not answer. That is not a finding about this window, and it is not a clean bill either — those fields were not looked at.`);
  }
  if (schemaFailures.length) {
    console.error(`${schemaFailures.length} endpoint(s) no longer return what this window reads. The views above are rendering blanks or nothing.`);
    process.exit(1);
  }
  console.log(unavailable.length
    ? "Every field that could be checked is still there."
    : "Every field each view depends on is still there.");
}
await main();
