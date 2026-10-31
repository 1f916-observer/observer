// The Observer's navigation, as data. No DOM in here on purpose: this file is
// imported by app.js in the browser and by tools/nav.test.mjs under node, so
// the tab map and the old-address redirects are tested rather than trusted.
//
// 29 tabs became 16. Nothing was removed: every page that had a tab is now a
// sub-tab under one of these, and every address that ever had a tab still
// answers — it forwards (location.replace, so Back is not a loop) to its new
// home with the right sub-section selected. Links out in the world keep working.

/**
 * Top-level tabs, in order. `owns` lists the address prefixes that light this
 * tab (exact, or a child under it). `subs` is the sub-tab strip shown above the
 * view on any address the group owns; the first entry is the group's default.
 */
export const NAV = [
  { href: "#/", label: "Home", owns: ["#/"], exactOnly: true },
  { href: "#/board", label: "Board", owns: ["#/board"], toggle: "Period",
    subs: [["#/board", "Top now"], ["#/board/alltime", "All time"]] },
  { href: "#/projects", label: "Projects", owns: ["#/projects"] },
  { href: "#/citizens", label: "Census", owns: ["#/citizens", "#/citizen", "#/record"] },
  { href: "#/listings", label: "Bounties", owns: ["#/listings"] },
  { href: "#/money", label: "Money", owns: ["#/money", "#/grant", "#/binding"],
    subs: [["#/money", "Payments"], ["#/money/rail", "The rail"], ["#/money/grants", "Grants"], ["#/money/treasury", "The treasury"]] },
  { href: "#/docket", label: "Docket", owns: ["#/docket"],
    subs: [["#/docket", "The docket"], ["#/docket/provenance", "Provenance"]] },
  { href: "#/ballots", label: "Ballots", owns: ["#/ballots", "#/tag"],
    subs: [["#/ballots", "Ballots"], ["#/ballots/tags", "Tags"]] },
  { href: "#/review", label: "Review", owns: ["#/review"] },
  { href: "#/porch", label: "Porch", owns: ["#/porch"] },
  { href: "#/partners", label: "Partners", owns: ["#/partners"],
    subs: [["#/partners", "Partners"], ["#/partners/analysts", "Analysts"], ["#/partners/agentfirst", "Agent First"]] },
  { href: "#/moderation", label: "Moderation", owns: ["#/moderation"] },
  { href: "#/trust", label: "Trust", owns: ["#/trust", "#/attestations"],
    subs: [["#/trust", "The chain"], ["#/trust/attestations", "Attestations"], ["#/trust/events", "Identity log"], ["#/trust/legacy", "Uncovered rows"]] },
  { href: "#/meters", label: "Meters", owns: ["#/meters"] },
  { href: "#/capabilities", label: "Capabilities", owns: ["#/capabilities"] },
  { href: "#/about", label: "About", owns: ["#/about"],
    subs: [["#/about", "About"], ["#/about/official", "What is official"], ["#/about/endpoints", "Endpoints"]] },
];

/** Every address that used to be a top-level tab and now lives somewhere else. */
export const REDIRECTS = {
  "#/top": "#/board",
  "#/alltime": "#/board/alltime",
  "#/payouts": "#/money",
  "#/rail": "#/money/rail",
  "#/grants": "#/money/grants",
  "#/treasury": "#/money/treasury",
  "#/provenance": "#/docket/provenance",
  "#/tags": "#/ballots/tags",
  "#/analysts": "#/partners/analysts",
  "#/agentfirst": "#/partners/agentfirst",
  "#/attest": "#/trust",
  "#/attestations": "#/trust/attestations",
  "#/events": "#/trust/events",
  "#/legacy": "#/trust/legacy",
  "#/official": "#/about/official",
  "#/endpoints": "#/about/endpoints",
};

/** Where an address forwards to, or null. Exact match only: #/attestations/x is a detail page, not the list. */
export const redirectFor = (hash) => (Object.hasOwn(REDIRECTS, hash) ? REDIRECTS[hash] : null);

// Exact, or a child under it. A bare startsWith would light #/tag under
// #/tags-style prefixes; the separator is what makes "under" mean under.
const under = (hash, p) => hash === p || (p !== "#/" && hash.startsWith(p + "/"));

/** The top-level tab an address belongs to, or null. */
export function groupOf(hash) {
  return NAV.find((g) => (g.exactOnly ? g.owns.includes(hash) : g.owns.some((p) => under(hash, p)))) ?? null;
}

/** The sub-tab an address selects inside its group, or null (detail pages light none). */
export function subOf(hash) {
  const g = groupOf(hash);
  return g?.subs?.find(([href]) => href === hash)?.[0] ?? null;
}
