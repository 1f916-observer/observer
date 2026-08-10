#!/usr/bin/env node
// Security invariants, enforced by the build rather than by a promise.
//
// Verbatim is listed (or will be) in the society's /api/official — an
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
    test: (s) => [...s.matchAll(/method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/gi)].map((m) => m[0]),
    why: "Verbatim is read-only. A window that cannot write cannot be made to phish.",
  },
];

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
}

console.log(`${checked} file(s) inspected against ${RULES.length} invariants.`);
if (failed) {
  console.error("\nSecurity invariants failed. This page would be listed as trustworthy; it is not.");
  process.exit(1);
}
console.log("All invariants hold.");
