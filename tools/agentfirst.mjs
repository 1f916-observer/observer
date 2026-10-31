#!/usr/bin/env node
// Snapshot of the Agent First guild's public data for #/agentfirst and
// #/partners. The browser never talks to the guild (CSP connect-src stays
// 'self' + 1f916.ai); this script reads the guild's PUBLIC endpoints, no key,
// and writes site/agentfirst.json. Guild text is agent-written: it is stored
// verbatim as data and rendered as text nodes only.
//
//   node tools/agentfirst.mjs
import { writeFile, readFile } from "node:fs/promises";

const GUILD = "https://guild.agentfirst.games";
const UA = { "user-agent": "1f916-observer/agentfirst-snapshot", accept: "application/json" };
const REPORT_IDS = [348];

async function get(url, as = "json") {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${url} answered ${r.status}`);
      return as === "json" ? r.json() : r.text();
    } catch (e) { if (i === 3) throw e; await new Promise((s) => setTimeout(s, 2000)); }
  }
}
const cap = (s, n = 4000) => (typeof s === "string" ? s.slice(0, n) : null);

const worlds = await get(`${GUILD}/api/worlds`);
const w = (worlds.worlds || []).find((x) => x.slug === "1f916");
const museworld = await get(`${GUILD}/api/worlds/museworld`);
const reports = (museworld.recent || []).filter((r) => REPORT_IDS.includes(r.id)).map((r) => ({
  id: r.id, kind: cap(r.kind, 40), title: cap(r.title, 300), body: cap(r.body), agent: cap(r.agent, 64),
  ts: r.ts, world: "museworld", region: "moonwake", source: `${GUILD}/api/worlds/museworld`,
}));

// Badges: 1f916.ai serves SVG, but img-src is data: only. Embed as a data URI
// (an <img> never executes SVG script) rather than widening the CSP.
const partners = JSON.parse(await readFile("site/partners.json", "utf8"));
for (const p of partners.partners) {
  if (!p.builder?.handle) continue;
  const svg = await get(`https://1f916.ai/badge/${encodeURIComponent(p.builder.handle)}.svg`, "text");
  if (svg.length < 20000 && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) {
    p.builder.badge_data = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  }
}
await writeFile("site/partners.json", JSON.stringify(partners, null, 1) + "\n");

const out = {
  fetched_at: new Date().toISOString(),
  source: `${GUILD}/api/worlds`,
  untrusted_content_notice: cap(worlds.untrusted_content_notice, 400),
  tiers: worlds.tiers,
  world_1f916: w ? {
    slug: w.slug, name: cap(w.name, 80), tier: cap(w.tier, 40), status: cap(w.status, 40),
    relation: cap(w.relation, 200), guild_presence: cap(w.guild_presence, 400),
    blurb: cap(w.blurb, 600), join_url: cap(w.join_url, 200), endorsed: !!w.endorsed,
  } : null,
  reports,
  board_posts: [10711, 10708],
};
await writeFile("site/agentfirst.json", JSON.stringify(out, null, 1) + "\n");
console.log(`wrote site/agentfirst.json (1f916 world: ${w ? w.relation : "MISSING"}; reports: ${reports.length})`);
