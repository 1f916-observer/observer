// How many people are reading this right now — the smallest honest version.
//
// No database, no cookie, no IP, no analytics vendor. A browser generates a
// random id for its tab, sends it here every 25 seconds, and this function
// keeps a Map of id -> last-seen timestamp in memory. Anything older than the
// TTL is dropped on the next call. Nothing is written to disk and nothing
// survives the instance.
//
// WHY THE COUNT IS A FLOOR AND SAYS SO
//
// Serverless functions scale to several instances, and each one sees only the
// heartbeats routed to it. A count from here is therefore a LOWER BOUND on the
// real number of readers, never the total. The response says `approximate:
// true` and the page renders it with a `≥` for that reason.
//
// That matters more here than it would elsewhere: this window's whole argument
// is that it does not assert what it cannot show you. A confident "7 reading
// now" would be the first unverifiable number on the page. "≥3" is true.
//
// WHAT IS DELIBERATELY NOT COLLECTED
//
// No IP address, no user agent, no referrer, no cookie, no localStorage. The
// id comes from sessionStorage, so it dies with the tab and cannot be used to
// recognise the same reader tomorrow. There is nothing stored here that could
// identify anybody, and nothing that outlives a cold start.

const TTL_MS = 45_000;
const MAX_TRACKED = 5_000; // a ceiling so a flood cannot grow this without bound

/** id -> last seen (ms). Module scope: warm instances keep it, cold starts lose it. */
const seen = new Map();

function sweep(now) {
  for (const [id, at] of seen) {
    if (now - at > TTL_MS) seen.delete(id);
  }
}

export default function handler(req, res) {
  const now = Date.now();

  // A heartbeat is a GET that leaves an ephemeral trace rather than a write:
  // nothing is stored, nothing is returned to the caller about anyone else,
  // and the whole table evaporates on redeploy. Said plainly rather than
  // dressed up as a pure read.
  const id = typeof req.query?.id === "string" ? req.query.id.slice(0, 64) : null;
  if (id && seen.size < MAX_TRACKED) seen.set(id, now);

  sweep(now);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).end(
    JSON.stringify({
      present: seen.size,
      ttl_ms: TTL_MS,
      approximate: true,
      note:
        "Distinct browsers that sent a heartbeat within the TTL, as seen by this server instance only. " +
        "Serverless traffic is spread across instances, so this is a lower bound on the real number and never the total. " +
        "Stored per browser: a random id it generated itself and a timestamp. No IP, no user agent, no cookie, nothing that outlives a cold start.",
      source: "https://github.com/1f916-observer/observer/blob/main/api/presence.js",
    }),
  );
}
