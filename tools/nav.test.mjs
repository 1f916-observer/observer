// The tab consolidation (29 -> 16) as a contract: the order is the one that
// was approved, every old tab still has a home, and every old address forwards
// to an address the router actually renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NAV, REDIRECTS, redirectFor, groupOf, subOf } from "../site/nav.js";

const OLD_TABS = ["#/", "#/top", "#/alltime", "#/projects", "#/review", "#/porch", "#/docket", "#/provenance", "#/listings",
  "#/payouts", "#/rail", "#/grants", "#/capabilities", "#/treasury", "#/citizens", "#/meters", "#/tags", "#/ballots",
  "#/events", "#/moderation", "#/attest", "#/legacy", "#/attestations", "#/partners", "#/analysts", "#/agentfirst",
  "#/official", "#/endpoints", "#/about"];

const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const routeRes = [...app.matchAll(/^\s*\[\/(\^#\\\/.*?\$)\/,/gm)].map((m) => new RegExp(m[1]));
const rendered = (h) => routeRes.some((re) => re.test(h));

test("16 top-level tabs, in the approved order", () => {
  assert.deepEqual(NAV.map((g) => g.label), ["Home", "Board", "Projects", "Census", "Bounties", "Money", "Docket", "Ballots",
    "Review", "Porch", "Partners", "Moderation", "Trust", "Meters", "Capabilities", "About"]);
});

test("every old tab address either still renders or forwards to one that does", () => {
  for (const h of OLD_TABS) {
    const to = redirectFor(h) ?? h;
    assert.ok(rendered(to), `${h} -> ${to} has no route`);
    assert.equal(redirectFor(to), null, `${to} redirects again`);
    assert.ok(groupOf(to), `${to} lights no tab`);
  }
});

test("every forwarded address selects its sub-tab", () => {
  for (const [from, to] of Object.entries(REDIRECTS)) assert.equal(subOf(to), to, `${from} -> ${to}`);
});

test("every top tab and sub-tab address is routed", () => {
  for (const g of NAV) {
    assert.ok(rendered(g.href), g.href);
    for (const [h] of g.subs ?? []) assert.ok(rendered(h), h);
  }
});

test("detail pages light their parent, and prefixes do not bleed", () => {
  assert.equal(groupOf("#/attestations/abc").label, "Trust");
  assert.equal(groupOf("#/grant/x").label, "Money");
  assert.equal(groupOf("#/docket/r12").label, "Docket");
  assert.equal(groupOf("#/citizen/ryan").label, "Census");
  assert.equal(groupOf("#/post/1"), null);
  assert.equal(redirectFor("#/attestations/abc"), null);
  assert.equal(groupOf("#/").label, "Home");
});
