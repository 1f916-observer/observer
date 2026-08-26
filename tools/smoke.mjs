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
//
// COULD NOT LOOK IS NOT THE SAME AS LOOKED AND FOUND IT BROKEN.
//
// This check used to report any non-2xx as "no longer returns what this window
// reads". It said that about an HTTP 429. A rate limit is not a schema change;
// the honest sentence is "we were throttled and did not get to look."
//
// It happened twice in a row on GitHub runners, on /api/payout-bindings/:id,
// and each time it produced a red build with a wrong reason and needed a manual
// re-run. A checker that reports the wrong reason is worse than one that stays
// quiet: somebody acts on the reason. So:
//
//   - the loop paces itself, because 31 requests fired back-to-back from one
//     shared runner IP is what tripped the limiter in the first place;
//   - a 429 or a 5xx is retried with backoff, honouring Retry-After;
//   - if it still cannot be read, it is counted as UNREADABLE and reported in
//     its own section, in its own words, and never as a schema failure.
//
// Unreadable still exits non-zero. It is not a pass — nothing was verified —
// but it exits 2 rather than 1, the same way endpoint-coverage.mjs already
// distinguishes "the check could not run" from "the window is stale".

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Between endpoints. Small enough that the run stays quick, large enough that
// 31 reads do not look like a burst to whatever is counting.
const PACE_MS = Number(process.env.SMOKE_PACE_MS ?? 250);
const RETRIES = Number(process.env.SMOKE_RETRIES ?? 3);

/** Is this worth trying again, or is it an answer? */
const isTransient = (status) => status === 429 || status >= 500;

/**
 * Fetch, retrying only what is worth retrying.
 *
 * Returns either {ok:true, body} or {ok:false, transient, reason}. A caller
 * that cannot tell those apart is the bug this function exists to fix.
 */
async function readEndpoint(url) {
  let last = { ok: false, transient: false, reason: "never attempted" };

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      // Honour Retry-After when the server bothered to say; otherwise back off
      // 1s, 2s, 4s. Capped, because a check that hangs is its own failure.
      const wait = Math.min(last.retryAfterMs ?? 2 ** (attempt - 1) * 1000, 8000);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return { ok: true, body: await res.json() };

      const retryAfter = Number(res.headers.get("retry-after"));
      last = {
        ok: false,
        transient: isTransient(res.status),
        reason: `HTTP ${res.status}`,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
      // A 404 or a 400 is the society's answer, not a hiccup. Stop asking.
      if (!last.transient) return last;
    } catch (err) {
      // A dropped connection is worth one more try; a bad URL is not, but we
      // cannot tell them apart here, so treat it as transient and let the
      // retry budget decide.
      last = { ok: false, transient: true, reason: err.message };
    }
  }
  return last;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const targets = manifest.endpoints.filter((e) => e.surface !== null && Array.isArray(e.requires) && e.requires.length);

  let failed = 0;
  let checked = 0;
  const unreadable = [];

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    if (i > 0 && PACE_MS) await sleep(PACE_MS);

    const path = substitute(entry.probe || entry.path);
    const result = await readEndpoint(ORIGIN + path);

    if (!result.ok) {
      if (result.transient) {
        // Throttled, or the society was unwell. Either way this says nothing
        // about whether the response still has the fields the view reads.
        unreadable.push({ entry, path, reason: result.reason });
      } else {
        console.error(`FAIL ${entry.method} ${entry.path} — ${result.reason} at ${path}`);
        failed++;
      }
      continue;
    }

    const problems = entry.requires.flatMap((p) => checkPath(result.body, p));
    checked += entry.requires.length;
    if (problems.length) {
      failed++;
      console.error(`FAIL ${entry.method} ${entry.path}  (renders: ${entry.surface})`);
      for (const p of problems) console.error(`     ${p}`);
    }
  }

  const looked = targets.length - unreadable.length;
  console.log(`\n${looked} of ${targets.length} endpoint(s) read, ${checked} field(s) checked against the live society.`);

  if (unreadable.length) {
    console.error(`\nUNREADABLE — could not be read after ${RETRIES} retries (${unreadable.length}):`);
    for (const u of unreadable) console.error(`  ? ${u.entry.method} ${u.entry.path} — ${u.reason} at ${u.path}`);
    console.error("This is NOT a schema failure and NOT a pass. Nothing about these was verified.");
  }

  if (failed) {
    console.error(`\n${failed} endpoint(s) no longer return what this window reads. The views above are rendering blanks or nothing.`);
    process.exit(1);
  }
  if (unreadable.length) {
    // Distinct from 1 on purpose: "we did not get to look" is a different fact
    // from "we looked and the shape had moved", and a human reading a red build
    // should be able to tell which one happened from the exit code alone.
    process.exit(2);
  }
  console.log("Every field each view depends on is still there.");
}

await main();
