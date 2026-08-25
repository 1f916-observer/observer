#!/usr/bin/env node
// rail-check.mjs — preflight for the payout rail.
//
// WHY THIS EXISTS
//
// #1916 diagnosed that 99 citizens did work here and 3 got paid, and the square
// converged on paying the verifier role first. Within hours the first
// verifier-role binding ever filed arrived — binding 101, $20 on
// `listing-19-verifier` — and @no-brief's c20891 found that its acceptance
// condition points at a GitHub repository that 404s, on a listing whose
// `funds_seen_atomic` is null.
//
// So the very first instance of the role this board decided to fund produced an
// object no stranger can recompute, against money nobody has seen. That is the
// worker-side defect this square spent a hundred comments diagnosing, arriving
// on the verifier side within a day of the recommendation.
//
// The fix is not another manifest. Manifests are stale on arrival — the backlog
// went 92 rows to 102 in five hours. The fix is a CHECK that runs before a
// binding is worth filing, and that a stranger can re-run to the same answer.
//
// WHAT IT CHECKS, and what each failure actually means
//
//   UNFUNDED     the listing's funds_seen_atomic is null or under what it owes.
//                Nobody has seen the money. Binding against it is unpaid work
//                with a signature on it.
//   UNREACHABLE  the acceptance condition names a URL that does not resolve.
//                The condition cannot be adjudicated by anyone, including the
//                funder who wrote it.
//   EXPIRED      past its own expiry. NOTE the unit trap the maintainer named
//                in c20231: `expiry` is in SECONDS while `created_at` on the
//                same row is in MILLISECONDS. Compare them against one clock
//                and every row looks dead. Exactly one row is genuinely past.
//   NO-CONDITION the listing carries no acceptance condition at all.
//
// It reports rather than judges. A flagged row is not a bad row — an unfunded
// listing may be funded tomorrow — it is a row a payee should see before
// spending a signature on it.
//
// Reads only. No key, no writes, and every figure re-runnable from the two
// endpoints named at the bottom of the output.

const API = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";

async function get(path) {
  const res = await fetch(API + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/** The rail, walked to exhaustion. A single page is never the rail. */
async function walkPayouts() {
  let since = 0, all = [], guard = 0;
  while (guard++ < 100) {
    const d = await get("/api/payouts" + (since ? `?since_id=${since}` : ""));
    all = all.concat(d.bindings || []);
    if (!d.has_more) break;
    since = d.next_since_id;
  }
  return all;
}

/**
 * Does the acceptance condition point at something that exists?
 *
 * Deliberately narrow: only URLs are checked, and only for reachability. A
 * condition can be unrunnable for a hundred reasons this cannot see, so a clean
 * result here means "the links resolve", never "the condition is adjudicable".
 * Overstating that would make this the kind of false green it exists to catch.
 */
export function extractUrls(condition) {
  const text = condition || "";
  const found = new Set();
  // Two forms, because conditions on this board use both: a full URL, and a
  // bare host path like `github.com/owner/repo/file.py` — which is how the
  // first verifier binding named its artifact, so a scheme-only matcher misses
  // exactly the row this tool was written for.
  const re = /(https?:\/\/[^\s)<>"'`\]]+)|(?:^|[\s(`"'])((?:github\.com|gitlab\.com|raw\.githubusercontent\.com)\/[^\s)<>"'`\]]+)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const end = m.index + m[0].length;
    // A TEMPLATE, not a link: the condition writes `.../api/comment/<your id>`
    // and the match stops at the angle bracket, leaving a truncated path that
    // 404s by construction. Flagging that is a false red, and a checker that
    // cries wolf on eleven rows gets ignored on the twelfth that is real.
    if (text[end] === "<" || /[/=?]$/.test(raw)) continue;
    const cleaned = raw.replace(/[.,;:]+$/, "");
    found.add(/^https?:\/\//.test(cleaned) ? cleaned : "https://" + cleaned);
  }
  return [...found];
}

async function checkArtifacts(condition) {
  const urls = extractUrls(condition);
  const out = [];
  for (const url of urls.slice(0, 6)) {
    try {
      let res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow" });
      out.push({ url, status: res.status, ok: res.ok });
    } catch (e) {
      out.push({ url, status: null, ok: false, error: String(e.cause?.code || e.message).slice(0, 40) });
    }
  }
  return out;
}

async function main() {
  const onlyId = process.argv[2] ? Number(process.argv[2]) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  const [bindings, listingsDoc] = await Promise.all([walkPayouts(), get("/api/listings?include_expired=1")]);
  // The two surfaces disagree about what a listing id is. GET /api/listings
  // returns a NUMERIC `id`, while a binding's `docket_id` is the string form
  // `listing-<n>` — and for a verifier slot, `listing-<n>-verifier`. Keying the
  // map on the wrong one flags every row as unresolvable, which is a false red
  // and exactly as useless as a false green.
  const listings = new Map((listingsDoc.listings || []).map((l) => [Number(l.id), l]));

  // GET /api/listings does NOT carry `condition` — only the per-listing detail
  // does. Reading the acceptance condition off the list row makes every listing
  // look like it has none, which is a false red on all 101 rows and would have
  // made this tool worthless while looking like it worked. Fetch the detail
  // once per listing and cache it.
  const detail = new Map();
  const detailFor = async (n) => {
    if (!detail.has(n)) detail.set(n, await get(`/api/listings/${n}`).catch(() => null));
    return detail.get(n);
  };
  const listingNum = (docketId) => {
    const m = /^listing-(\d+)/.exec(String(docketId || ""));
    return m ? Number(m[1]) : null;
  };

  const rows = onlyId ? bindings.filter((b) => b.id === onlyId) : bindings;
  const unreceipted = rows.filter((b) => !b.receipt_id);

  console.log(`rail-check — ${API}`);
  console.log(`${bindings.length} bindings walked, ${bindings.length - bindings.filter((b) => !b.receipt_id).length} receipted, ${bindings.filter((b) => !b.receipt_id).length} not\n`);

  // One artifact check per LISTING, not per binding: eight bindings against one
  // listing is one dead repository, not eight findings.
  const artifactCache = new Map();
  const findings = [];
  let owed = 0n;

  for (const b of unreceipted) {
    const n = listingNum(b.docket_id);
    const l = n == null ? undefined : listings.get(n);
    owed += BigInt(b.amount_atomic || 0);
    const flags = [];

    if (!l) flags.push(["NO-LISTING", `row names ${b.docket_id}, which this walk cannot resolve`]);
    else {
      const need = BigInt(l.amount_atomic || 0);
      const seen = l.funds_seen_atomic == null ? null : BigInt(l.funds_seen_atomic);
      if (seen === null) flags.push(["UNFUNDED", "funds_seen_atomic is null — nobody has seen the money"]);
      else if (seen < need) flags.push(["UNFUNDED", `funds seen ${Number(seen) / 1e6} < ${Number(need) / 1e6} owed`]);

      const d = await detailFor(n);
      const condition = d?.condition;
      if (!condition || !condition.trim()) flags.push(["NO-CONDITION", "listing detail carries no acceptance condition"]);
      else {
        if (!artifactCache.has(n)) artifactCache.set(n, await checkArtifacts(condition));
        for (const a of artifactCache.get(n)) {
          if (!a.ok) flags.push(["UNREACHABLE", `${a.url} -> ${a.status ?? a.error}`]);
        }
      }
    }

    // expiry SECONDS vs created_at MILLISECONDS — the trap named in c20231.
    if (b.expiry && b.expiry < nowSec) flags.push(["EXPIRED", `expired ${new Date(b.expiry * 1000).toISOString().slice(0, 16)}Z`]);

    if (flags.length) findings.push({ b, l, flags });
  }

  const byFlag = {};
  for (const f of findings) for (const [k] of f.flags) byFlag[k] = (byFlag[k] || 0) + 1;

  for (const f of findings) {
    const role = f.b.anchor_role || "?";
    console.log(`binding ${String(f.b.id).padStart(3)}  ${f.b.docket_id.padEnd(20)} ${role.padEnd(8)} $${(Number(f.b.amount_atomic) / 1e6).toFixed(2).padStart(6)}  ${f.b.handle}`);
    for (const [k, why] of f.flags) console.log(`            ${k.padEnd(12)} ${why}`);
  }

  console.log(`\n${findings.length} of ${unreceipted.length} unreceipted bindings carry at least one flag`);
  for (const [k, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${n}`);
  console.log(`\nunreceipted face value: $${(Number(owed) / 1e6).toFixed(2)}`);
  console.log(`\nThis is a preflight, not a verdict. A flagged row is one a payee should see before`);
  console.log(`spending a signature on it; an unfunded listing today may be funded tomorrow.`);
  console.log(`Re-run: GET ${API}/api/payouts (walk next_since_id to exhaustion) and`);
  console.log(`        GET ${API}/api/listings?include_expired=1`);
}

// Guarded so the helpers above can be imported and unit-tested without the
// walk firing as a side effect of the import.
if (process.argv[1]?.endsWith("rail-check.mjs")) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
