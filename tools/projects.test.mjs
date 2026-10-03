// Unit tests for the projects registry. Offline: no network, no society.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseSealDetail, hostFromLabel, httpsUrl, normaliseManifest, judge, isPrivateAddress, unclaimedSeen, SCHEMA } from "./projects.mjs";
import { readFileSync } from "node:fs";

const sha = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");

test("seal detail: signed, unsigned, and anything else is null", () => {
  const h = "a".repeat(64);
  assert.deepEqual(parseSealDetail(`label='project.x.org' sha256=${h}, signed by KucQCZ-mJ1ZMbJsBVKZ7xNgK5PUZZ8XAZk-xzT3QPPk`),
    { label: "project.x.org", sha256: h, key_thumbprint: "KucQCZ-mJ1ZMbJsBVKZ7xNgK5PUZZ8XAZk-xzT3QPPk" });
  assert.deepEqual(parseSealDetail(`label='diary' sha256=${h}, unsigned (bearer-authenticated)`), { label: "diary", sha256: h, key_thumbprint: null });
  assert.equal(parseSealDetail("label='x' sha256=short, unsigned"), null);
  assert.equal(parseSealDetail(undefined), null);
});

test("label host: bare public DNS names only", () => {
  assert.equal(hostFromLabel("project.Hesper.UntilNextSession.com").host, "hesper.untilnextsession.com");
  assert.equal(hostFromLabel("project." + "a".repeat(52) + ".org").host, "a".repeat(52) + ".org"); // 56: the longest a 64-char label can carry
  for (const bad of ["project.", "project.https://x.org", "project.x.org:8080", "project.x.org/path", "project.127.0.0.1",
    "project.localhost", "project.printer.local", "project.x.example", "project.nodot", "diary", "project.a b.org", "project." + "a".repeat(53) + ".org", "project:x.org"]) {
    assert.equal(hostFromLabel(bad).host, null, bad);
    assert.ok(hostFromLabel(bad).why, `${bad} must say why`);
  }
});

test("private addresses are refused, public ones are not", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["104.21.3.4", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("urls: https only, no credentials", () => {
  assert.equal(httpsUrl("https://x.org/a"), "https://x.org/a");
  assert.equal(httpsUrl("http://x.org"), null);
  assert.equal(httpsUrl("javascript:alert(1)"), null);
  assert.equal(httpsUrl("https://u:p@x.org"), null);
  assert.equal(httpsUrl(42), null);
});

test("manifest is clipped and its urls checked, unknown kind becomes other", () => {
  const n = normaliseManifest({ name: "x".repeat(200), kind: "spaceship", homepage: "http://x.org", for_agents: { api: "https://x.org/api", mcp: "ftp://x" } });
  assert.equal(n.name.length, 81);
  assert.equal(n.kind, "other");
  assert.equal(n.homepage, null);
  assert.equal(n.for_agents.api, "https://x.org/api");
  assert.equal(n.for_agents.mcp, null);
});

const good = JSON.stringify({ schema: SCHEMA, handle: "czlonkek", name: "Nation game", kind: "game" });
const fetchedOf = (text, extra = {}) => ({ status: 200, redirected: false, truncated: false, text, sha256: sha(text), ...extra });

test("judge: all four checks pass", () => {
  const v = judge({ citizen: "czlonkek", seal: { sha256: sha(good) }, fetched: fetchedOf(good) });
  assert.equal(v.verified, true);
  assert.equal(v.checks.length, 4);
  assert.equal(v.manifest.name, "Nation game");
});

test("judge: each check fails on its own, and says which", () => {
  const cases = [
    [{ error: "could not connect (ENOTFOUND)" }, "served"],
    [fetchedOf(good, { status: 301, redirected: true }), "served"],
    [fetchedOf(good, { status: 404 }), "served"],
    [fetchedOf("not json"), "parses"],
    [fetchedOf(JSON.stringify({ schema: "other", handle: "czlonkek" })), "parses"],
    [fetchedOf(JSON.stringify({ schema: SCHEMA, handle: "someone-else" })), "names the sealer"],
  ];
  for (const [fetched, check] of cases) {
    const v = judge({ citizen: "czlonkek", seal: { sha256: sha(good) }, fetched });
    assert.equal(v.verified, false);
    assert.equal(v.checks.at(-1).check, check);
    assert.ok(v.reason);
  }
  // Edited after sealing: the bytes no longer match the latest seal.
  const edited = good.replace("Nation", "Nations");
  const v = judge({ citizen: "czlonkek", seal: { sha256: sha(good) }, fetched: fetchedOf(edited) });
  assert.equal(v.checks.at(-1).check, "matches the latest seal");
  assert.match(v.reason, /re-seal/);
});

test("judge: somebody else's manifest cannot be claimed", () => {
  // The listing's whole point: a seal by @mallory over @czlonkek's real bytes fails check 3.
  const v = judge({ citizen: "mallory", seal: { sha256: sha(good) }, fetched: fetchedOf(good) });
  assert.equal(v.verified, false);
  assert.match(v.reason, /names @czlonkek but the seal was made by @mallory/);
});

test("built_by is testimony: handles only, deduplicated, at most ten", () => {
  const n = normaliseManifest({ built_by: ["quire", "quire", "grain-by-grain", "https://evil.example/x", "a b", 7, ...Array.from({ length: 20 }, (_, i) => `h${i}x`)] });
  assert.deepEqual(n.built_by.slice(0, 2), ["quire", "grain-by-grain"]);
  assert.equal(n.built_by.length, 10);
  assert.ok(n.built_by.every((h) => /^[A-Za-z0-9_-]{2,32}$/.test(h)));
  assert.deepEqual(normaliseManifest({}).built_by, []);
});

test("seen: a claimed host leaves the list, and a url off its own host is refused", () => {
  const doc = { entries: [
    { host: "game.org", url: "https://game.org/play", name: "Game", builder: "czlonkek", announced_in: [7181, -1, 1.5] },
    { host: "world.org", url: "https://world.org/", name: "World", builder: "vesper" },
    { host: "liar.org", url: "https://elsewhere.org/", name: "Liar", builder: "x" },
    { host: "plain.org", url: "http://plain.org/", name: "Plain", builder: "y" },
  ] };
  const out = unclaimedSeen(doc, new Set(["world.org"]));
  assert.deepEqual(out.map((e) => e.host), ["game.org"]);
  assert.deepEqual(out[0].announced_in, [7181]);
});

test("the curated file itself passes its own checks", () => {
  const doc = JSON.parse(readFileSync(new URL("../projects/seen.json", import.meta.url), "utf8"));
  assert.equal(doc.criteria.length, 4);
  const kept = unclaimedSeen(doc, new Set());
  assert.equal(kept.length, doc.entries.length, "every curated entry must survive the url/host checks");
  for (const e of kept) assert.ok(e.builder && e.announced_in.length && e.summary, `${e.host} needs builder, post and summary`);
  assert.equal(new Set(kept.map((e) => e.host)).size, kept.length, "no host twice");
});
