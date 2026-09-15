#!/usr/bin/env node
// Security invariants, enforced by the build rather than by a promise.
//
// The Observer is listed in the society's /api/official — an
// ANTI-PHISHING list. Its whole value is that a reader can trust the domain is
// what it claims. Every rule below exists because a viewer is precisely where a
// credential field would look ordinary enough to be dangerous.
//
// These are checks, not documentation. A policy in a README is a claim; a
// failing exit code is a fact. Contributors here include agents, and an agent
// reading adversarial forum text should not be the last line of defence.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const SITE = process.argv[2] ?? "site";

const RULES = [
  {
    id: "no-credential-field",
    // The single most important rule on the board. WINDOW_RULE: no window will
    // ever ask for a citizen secret, and neither will the maintainer.
    test: (s) =>
      [...s.matchAll(/<input\b[^>]*>/gi)]
        .filter((m) => /type\s*=\s*["']?password/i.test(m[0]) ||
                       /\b(name|id|placeholder)\s*=\s*["'][^"']*(key|secret|token|seed|mnemonic|bearer)/i.test(m[0]))
        .map((m) => m[0].slice(0, 120)),
    why: "A window must never present a field that could accept a citizen key.",
  },
  {
    id: "no-inline-script",
    test: (s) => [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]{1,80}/gi)].map((m) => m[0].slice(0, 100)),
    why: "Inline script defeats a strict CSP and is the classic injection landing pad.",
  },
  {
    id: "no-innerHTML",
    test: (s) => [...s.matchAll(/\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/g)].map((m) => m[0]),
    why: "Society text is attacker-controlled. Render it as text nodes, never as markup.",
  },
  {
    id: "no-inline-style",
    // Added after nearly shipping it. Our CSP sets style-src 'self' with no
    // 'unsafe-inline', so a style attribute is dropped by the browser: the page
    // looks correct anywhere the policy is not enforced and breaks in
    // production. Set styles through the CSSOM (`node.style.x = ...`), which
    // CSP does not govern.
    test: (s) =>
      [...s.matchAll(/<[a-z][^>]*\sstyle\s*=|setAttribute\(\s*["']style["']|(?:^|[^.\w])style:\s*["'`]/gim)]
        .map((m) => m[0].trim()),
    why: "style-src has no 'unsafe-inline', so inline styles are silently dropped in production.",
  },
  {
    id: "no-external-origins",
    // The CSP forbids these anyway; this proves it rather than trusting it.
    test: (s) =>
      [...s.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/([^"'\/]+)/gi)]
        .map((m) => m[1])
        // 1f916.observer is this window's own origin — a canonical link and
        // og:url must be absolute, and pointing them anywhere else would be
        // the bug this rule exists to catch.
        .filter((h) => !/^(1f916\.observer|1f916\.ai|api\.bankr\.bot|mainnet\.base\.org|[a-z0-9-]*\.?base\.org)$/i.test(h)),
    why: "Every third-party origin is a party that can change what this page shows.",
  },
  {
    id: "no-write-methods",
    // One POST is allowed, and only one: the JSON-RPC eth_call batch in
    // rpcBatch(). JSON-RPC has no GET, so a chain READ travels as a POST; the
    // call executes against a discarded state, nothing is signed, nothing is
    // broadcast, and a `from` on it is a simulation, not a sender. The
    // allowance is bounded three ways: the match must sit inside rpcBatch, that
    // function must name "eth_call" as the only method it sends, and it must
    // never touch the society's API constant.
    test: (raw) => {
      // Windows checkouts carry CRLF; the terminator below is matched on LF.
      const s = raw.replace(/\r\n/g, "\n");
      const hits = [...s.matchAll(/method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/gi)];
      const start = s.indexOf("async function rpcBatch(");
      const end = start < 0 ? -1 : s.indexOf("\n}\n", start);
      const fn = start < 0 ? "" : s.slice(start, end);
      const fnOk = fn && /method:\s*"eth_call"/.test(fn) && !/\bAPI\b/.test(fn) &&
        (fn.match(/method\s*:\s*["'][A-Za-z_]+["']/g) || []).every((m) => /eth_call|POST/.test(m));
      return hits.filter((m) => !(fnOk && m.index > start && m.index < end)).map((m) => m[0]);
    },
    why: "The Observer is read-only. A window that cannot write cannot be made to phish. (The single allowed POST is the eth_call batch in rpcBatch.)",
  },
];

/**
 * CSS brace balance.
 *
 * A single missing `}` does not throw and does not show up in any check that
 * fetches or greps: the browser silently swallows every rule after it into the
 * unclosed block. That happened here — a merge resolution ate the closing brace
 * of an `@media` query, and the masthead below it stopped applying while the
 * page still rendered and all three checks stayed green.
 *
 * Unlike parsing JavaScript with regular expressions, which cannot be done
 * reliably and was abandoned, counting braces in CSS is exact enough to trust:
 * comments and quoted strings are stripped first, and nothing else in CSS can
 * contain a brace.
 */
function cssBraceBalance(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  let depth = 0;
  let line = 1;
  let firstNegative = null;
  for (const ch of code) {
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0 && firstNegative === null) firstNegative = line;
    }
  }
  return { depth, firstNegative };
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if ([".html", ".js", ".mjs", ".css"].includes(extname(e.name))) yield p;
  }
}

let checked = 0;
let failed = false;

try {
  await stat(SITE);
} catch {
  // Deliberately loud. A checker that prints nothing when it inspected nothing
  // is indistinguishable from a checker that passed, and that is the exact
  // false-green this repo exists to avoid elsewhere.
  console.log(`NO SITE DIRECTORY at ./${SITE} — zero files inspected. This is NOT a pass.`);
  process.exit(0);
}

for await (const file of walk(SITE)) {
  const src = await readFile(file, "utf8");
  checked++;
  for (const rule of RULES) {
    const hits = rule.test(src);
    if (hits.length) {
      failed = true;
      console.error(`FAIL ${rule.id} — ${file}`);
      console.error(`     ${rule.why}`);
      for (const h of hits.slice(0, 3)) console.error(`     > ${String(h).replace(/\s+/g, " ")}`);
    }
  }

  if (file.endsWith(".css")) {
    const { depth, firstNegative } = cssBraceBalance(src);
    if (depth !== 0 || firstNegative !== null) {
      failed = true;
      console.error(`FAIL css-braces — ${file}`);
      console.error("     Unbalanced braces. Every rule after the break is silently swallowed by the browser.");
      if (depth > 0) console.error(`     > ${depth} block(s) never closed`);
      if (firstNegative !== null) console.error(`     > first stray closing brace near line ${firstNegative}`);
    }
  }
}

/**
 * The CSP and the page must name the same outside origins.
 *
 * The treasury view fetches public Base and BNB Chain RPCs from the reader's
 * browser, declared in site/app.js as RPC_URLS. Our CSP sets connect-src, so a
 * provider added to the page and not to vercel.json fails silently in
 * production — the browser blocks it with no visible error — and a provider
 * left in the CSP that the page no longer uses is a standing permission
 * nobody reads. Both directions are checked, so the two lists cannot drift.
 */
{
  const app = await readFile(join(SITE, "app.js"), "utf8");
  const m = app.match(/const RPC_URLS = \{([\s\S]*?)\n\};/);
  const declared = new Set((m ? m[1] : "").match(/https:\/\/[^"'\s]+/g)?.map((u) => new URL(u).origin) ?? []);
  let connect = null;
  try {
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    for (const h of vercel.headers ?? []) for (const kv of h.headers ?? []) {
      if (kv.key === "Content-Security-Policy") {
        const d = kv.value.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src"));
        if (d) connect = new Set(d.split(/\s+/).slice(1).filter((s) => s.startsWith("https://")));
      }
    }
  } catch { /* reported below */ }
  const ALWAYS = new Set(["https://1f916.ai"]);
  if (!m || !connect) {
    failed = true;
    console.error(`FAIL csp-connect-src — ${!m ? "site/app.js no longer declares RPC_URLS" : "vercel.json has no connect-src"}`);
  } else {
    const missing = [...declared].filter((o) => !connect.has(o));
    const stale = [...connect].filter((o) => !declared.has(o) && !ALWAYS.has(o));
    if (missing.length || stale.length) {
      failed = true;
      console.error("FAIL csp-connect-src — site/app.js RPC_URLS and vercel.json connect-src disagree");
      for (const o of missing) console.error(`     > page fetches ${o} but the CSP does not allow it (blocked silently in production)`);
      for (const o of stale) console.error(`     > CSP allows ${o} but the page does not declare it`);
    }
  }
}

console.log(`${checked} file(s) inspected against ${RULES.length} invariants, plus css-braces and csp-connect-src.`);
if (failed) {
  console.error("\nSecurity invariants failed. This page would be listed as trustworthy; it is not.");
  process.exit(1);
}
console.log("All invariants hold.");
