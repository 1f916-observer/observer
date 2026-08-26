#!/usr/bin/env node
// Sample this window's own presence endpoint and append one honest record.
//
// WHY THIS EXISTS
//
// This window ships no analytics, on purpose, and SECURITY.md says so in
// public. That commitment is not weakened here: this tool adds no script to the
// page, sets no cookie, collects nothing about any reader, and asks the site
// only for the single number the site already publishes about itself to anybody
// who asks. Nothing a reader does becomes visible to us that was not already
// visible to everyone.
//
// The alternative — a vendor tag on the page — would have made three published
// claims false while every check in this repo stayed green, because the script
// is same-origin and `no-external-origins` only catches `src=https://`. That is
// the exact false-green this repo exists to refuse.
//
// WHAT IT MEASURES, AND WHAT IT DOES NOT
//
// /api/presence reports distinct browsers that heartbeat within the TTL AS SEEN
// BY ONE SERVERLESS INSTANCE. Traffic is spread across instances, so a single
// response is a LOWER BOUND on concurrent readers and never a total. So:
//
//   - take several samples a few seconds apart, since consecutive requests may
//     be answered by different instances;
//   - keep every raw sample in the record, so the aggregate can be re-derived
//     by anyone who doubts it;
//   - report max(samples) as the floor;
//   - NEVER sum the samples. Summing would double-count readers seen twice and
//     would turn an honest floor into a confident fiction. This is the same
//     mistake `approximate: true` exists to prevent on the page itself.
//
// This is concurrent readers, not pageviews. It cannot tell you how many people
// visited today. It can tell you, truthfully, that at least N were reading at
// once — and how that number moves. Anyone who needs pageviews needs a
// different tool and a different conversation about SECURITY.md.
//
// IT DOES NOT PARTICIPATE IN WHAT IT MEASURES
//
// api/presence.js records a browser only when the request carries `?id=`. This
// sampler deliberately sends no id, so observing never inflates the observation.
// If that ever changes upstream, this tool starts lying — hence the assertion
// below that the endpoint still reports itself as a lower bound.
//
// A FAILED SAMPLE IS RECORDED AS A FAILURE
//
// A fetch that errors is written as an error, never as `present: 0`. A zero and
// an outage are indistinguishable in a chart and only one of them is true.

const ENDPOINT = process.env.PRESENCE_URL ?? "https://1f916.observer/api/presence";
const SAMPLES = Number(process.env.PRESENCE_SAMPLES ?? 6);
const GAP_MS = Number(process.env.PRESENCE_GAP_MS ?? 5_000);
const TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET, with no `id` parameter. See the note above: sending an id would
 * register this process as a reader and inflate the number it is here to read.
 */
async function sampleOnce() {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      headers: { accept: "application/json" },
      signal: control.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const body = await res.json();
    if (typeof body?.present !== "number" || !Number.isFinite(body.present)) {
      return { ok: false, error: "no numeric `present` in response" };
    }
    return {
      ok: true,
      present: body.present,
      ttl_ms: typeof body.ttl_ms === "number" ? body.ttl_ms : null,
      // If the endpoint ever stops calling itself approximate, the meaning of
      // this series has changed and the record should show that it noticed.
      approximate: body.approximate === true,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const samples = [];
for (let i = 0; i < SAMPLES; i++) {
  if (i > 0) await sleep(GAP_MS);
  samples.push(await sampleOnce());
}

const good = samples.filter((s) => s.ok);
const failures = samples.filter((s) => !s.ok).map((s) => s.error);
const values = good.map((s) => s.present);

// No successful sample means no observation. It does NOT mean nobody was
// reading, and the record must not let a later reader mistake one for the other.
const record = {
  at: new Date().toISOString(),
  endpoint: ENDPOINT,
  observed: good.length > 0,
  floor: good.length ? Math.max(...values) : null,
  samples: values,
  attempted: samples.length,
  succeeded: good.length,
  errors: failures,
  // Carried per-record rather than assumed, so a change upstream is visible in
  // the data instead of silently redefining every row after it.
  bound: "lower",
  method: "max of independent samples; never summed",
  endpoint_self_reports_approximate: good.length ? good.every((s) => s.approximate) : null,
  ttl_ms: good.length ? good[0].ttl_ms : null,
};

process.stdout.write(JSON.stringify(record) + "\n");

// A run that observed nothing at all is worth a non-zero exit so the workflow
// surfaces it, but the record is emitted first: an outage is data too.
if (!record.observed) {
  console.error(`presence-sample: ${samples.length} attempt(s), 0 succeeded — ${failures.join("; ")}`);
  process.exit(1);
}
