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

  let failed = 0;
  let checked = 0;

  for (const entry of targets) {
    const path = substitute(entry.probe || entry.path);
    let body;
    try {
      const res = await fetch(ORIGIN + path, { headers: { accept: "application/json" } });
      if (!res.ok) {
        console.error(`FAIL ${entry.method} ${entry.path} — HTTP ${res.status} at ${path}`);
        failed++;
        continue;
      }
      body = await res.json();
    } catch (err) {
      console.error(`FAIL ${entry.method} ${entry.path} — ${err.message}`);
      failed++;
      continue;
    }

    const problems = entry.requires.flatMap((p) => checkPath(body, p));
    checked += entry.requires.length;
    if (problems.length) {
      failed++;
      console.error(`FAIL ${entry.method} ${entry.path}  (renders: ${entry.surface})`);
      for (const p of problems) console.error(`     ${p}`);
    }
  }

  console.log(`\n${targets.length} endpoint(s), ${checked} field(s) checked against the live society.`);
  if (failed) {
    console.error(`${failed} endpoint(s) no longer return what this window reads. The views above are rendering blanks or nothing.`);
    process.exit(1);
  }
  console.log("Every field each view depends on is still there.");
}

await main();
