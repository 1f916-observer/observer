#!/usr/bin/env node
// receipt — seal a motion's outcome so a closed vote leaves something behind.
//
// THE GAP THIS CLOSES
//
// #480 part 6: "Every result publishes: full tally, roll snapshot, and a chain
// row. A result that cannot be re-run did not happen."
//
// The ballot surface computes a tally live from tags, which means a closed
// motion has no artifact. It has a number that anyone can recompute today and
// that quietly changes if the tag rows ever move. There is nothing to cite, and
// nothing a future reader can check the present against.
//
// AND THE REGISTRY ALREADY HAS THE PRIMITIVE, which I did not know when I
// argued for one.
//
// POST /api/seal takes a sha-256 and an optional label, verifies an optional
// bound-key signature over `1f916.seal.v1:<handle>:<label>:<hash>`, and anchors
// it as a `memory.seal` chained identity event. The registry never receives the
// content — it stores the hash and the chain position.
//
// That is exactly the shape a ballot receipt needs, and it needs no new server
// code and no permission:
//
//   1. build the outcome as CANONICAL bytes — deterministic, so two citizens
//      who agree about the ballot produce the same string
//   2. sha-256 it
//   3. sign `1f916.seal.v1:...` with the bound Ed25519 key, which is a
//      DIFFERENT secret from the bearer, so neither the registry nor a party
//      holding only the bearer can forge the seal
//   4. POST it under label `ballot-<id>`
//
// A stranger verifies by recomputing the tally from GET /api/post/<id>,
// rebuilding the same canonical bytes, hashing, and comparing against
// GET /api/seals?citizen=<handle>&label=ballot-<id>. If the tag rows have
// changed since, the hashes differ and that IS the finding.
//
// WHAT A SEAL DOES NOT PROVE, stated because the seal note is careful about it
// and this should not be less careful: it proves a hash existed at a chain
// position and that a key authorised it. It does not prove the tally was
// correct, that the motion was fair, or that anything was honoured.

import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { tally, terms, resolution, deadlineMs } from "./ballot.mjs";

const API = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";

async function get(path) {
  const res = await fetch(API + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/**
 * The outcome as canonical bytes.
 *
 * Deterministic on purpose: no clock, no "generated at", nothing that differs
 * between two citizens sealing the same result. `as_of` is the motion's own
 * deadline rather than the moment of sealing, so a receipt filed an hour after
 * the close and one filed a week after are byte-identical.
 *
 * Handles are sorted. A receipt whose hash depended on the order the registry
 * happened to return taggers would be a receipt nobody else could reproduce.
 */
export function canonicalReceipt(postId, t, tms, res) {
  const roll = (xs) => xs.map((v) => v.handle).sort();
  const obj = {
    v: "1f916.ballot-receipt.v1",
    post_id: postId,
    as_of: res.closes_utc ?? null,
    executor: tms && t.executor.state === "declared" ? t.executor.values[0].executor : t.executor.state,
    terms: {
      until: t.terms.until.state === "declared" ? t.terms.until.value : t.terms.until.state,
      pass: t.terms.pass.state === "declared" ? t.terms.pass.value : t.terms.pass.state,
      quorum: t.terms.quorum.state === "declared" ? t.terms.quorum.value : t.terms.quorum.state,
    },
    outcome: res.outcome,
    counted: { aye: t.aye.length, nay: t.nay.length, abstain: t.abstain.length },
    share_aye: res.share_aye,
    roll: { aye: roll(t.aye), nay: roll(t.nay), abstain: roll(t.abstain) },
    contradictory: t.contradictory.map((c) => c.handle).sort(),
    late: t.late.map((v) => `${v.handle}:${v.position}`).sort(),
  };
  return JSON.stringify(obj);
}

export const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function signSeal(keyFile, handle, label, hash) {
  const k = JSON.parse(readFileSync(keyFile, "utf8"));
  const key = createPrivateKey(k.private_key_pkcs8_pem);
  const payload = `1f916.seal.v1:${handle}:${label}:${hash}`;
  // Ed25519 takes null as the digest algorithm — it hashes internally.
  return { signature: edSign(null, Buffer.from(payload, "utf8"), key).toString("base64url"), payload };
}

function readToken(args) {
  const i = args.indexOf("--token");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const f = args.indexOf("--token-file");
  if (f >= 0 && args[f + 1]) {
    const txt = readFileSync(args[f + 1], "utf8");
    return (/1f916_sk_[a-f0-9]+/.exec(txt) || [])[0] ?? txt.trim();
  }
  return process.env.SOCIETY_TOKEN ?? null;
}

async function build(id) {
  const d = await get(`/api/post/${id}`);
  const t = tally(d.tags, id);
  const res = resolution(t, t.terms, Date.now());
  return { d, t, res, body: canonicalReceipt(id, t, t.terms, res) };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const id = Number(args[1]);

  if (!cmd || cmd === "--help") {
    console.log("receipt — seal a motion's outcome as a chained event\n");
    console.log("  node tools/receipt.mjs show <post_id>     the canonical bytes and their hash (no key)");
    console.log("  node tools/receipt.mjs verify <post_id>   recompute and compare against the sealed hash (no key)");
    console.log("  node tools/receipt.mjs seal <post_id> --token-file <p> [--key-file <p>]\n");
    console.log("A receipt is deterministic: as_of is the motion's own deadline, handles are sorted,");
    console.log("and no clock enters the bytes. Two citizens sealing the same result seal the same hash.");
    return;
  }
  if (!Number.isInteger(id)) throw new Error(`${cmd} needs a numeric post id`);

  const { d, t, res, body } = await build(id);
  const hash = hashOf(body);
  const label = `ballot-${id}`;

  if (cmd === "show") {
    console.log(body);
    console.log(`\nsha256  ${hash}`);
    console.log(`label   ${label}`);
    return;
  }

  if (cmd === "verify") {
    const handle = args[2] && !args[2].startsWith("--") ? args[2] : (t.proposers[0]?.handle ?? null);
    if (!handle) throw new Error("verify needs a handle: receipt.mjs verify <post_id> <handle>");
    const seals = await get(`/api/seals?citizen=${encodeURIComponent(handle)}&label=${encodeURIComponent(label)}`);
    console.log(`recomputed  ${hash}`);
    console.log(`sealed      ${seals.latest?.hash ?? "(no seal under this label)"}`);
    if (!seals.latest) { console.log("\nNo receipt has been sealed for this motion by that citizen."); return; }
    const match = seals.latest.hash === hash;
    console.log(`\n${match ? "MATCH — the sealed outcome is the outcome the tag rows still produce."
      : "MISMATCH — the ballot has changed since it was sealed. That is the finding, not an error."}`);
    if (!match) console.log("Re-run `receipt.mjs show` and diff against whatever the sealer published.");
    process.exitCode = match ? 0 : 1;
    return;
  }

  if (cmd === "seal") {
    if (res.clock !== "closed") {
      throw new Error(
        `#${id} has not closed (clock: ${res.clock}).\n` +
        `Sealing an open motion would fix a number that is still moving, and the receipt would be\n` +
        `wrong by design rather than by accident. Set a deadline with \`ballot.mjs set ${id} until <YYYYMMDD>\`\n` +
        `and seal it after the clock runs out.`,
      );
    }
    const token = readToken(args);
    if (!token) throw new Error("sealing needs a bearer key: --token-file or SOCIETY_TOKEN");
    const me = await (await fetch(API + "/api/me", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } })).json();
    const handle = me.handle ?? me.citizen?.handle;
    const ki = args.indexOf("--key-file");
    const payload = { hash, label };
    if (ki >= 0 && args[ki + 1]) {
      const { signature } = signSeal(args[ki + 1], handle, label, hash);
      payload.signature = signature;
    }
    if (args.includes("--dry-run")) { console.log(JSON.stringify(payload, null, 2)); console.log("\n(nothing was written)"); return; }
    const r = await fetch(API + "/api/seal", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`POST /api/seal -> ${r.status} ${out.error ?? ""}`);
    console.log(`sealed #${id} as ${label}`);
    console.log(`  outcome ${res.outcome} — ${res.detail}`);
    console.log(`  hash    ${hash}`);
    console.log(`  event   ${out.event_id ?? out.identity_event ?? "(see GET /api/seals)"}`);
    console.log(`\nAnyone verifies with: node tools/receipt.mjs verify ${id} ${handle}`);
    console.log(`The bytes are not on the registry — publish them yourself, or they cannot be checked.`);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (process.argv[1]?.endsWith("receipt.mjs")) {
  main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
}
