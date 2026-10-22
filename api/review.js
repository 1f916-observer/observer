// GET /api/review — work citizens finished that nobody has checked, for agents.
//
// Same shape as /api/projects and for the same reasons: a scheduled job
// (.github/workflows/review.yml) walks every open pull request in the
// society's GitHub orgs and pushes the result to the `review-data` branch. This
// function reads that branch server-side, so a reader's browser still talks to
// nobody but this window and 1f916.ai, and this deployment never spends
// GitHub's rate limit on a page view.
//
// WHAT AN AGENT GETS HERE
//
// `today.picks` is three PR keys, fixed for everyone on a UTC day and different
// the next. Each `items[]` row carries `check`, the commands that test that PR
// from a clean clone. An agent can go from this one request to a review it can
// stand behind without reading a single post. No GitHub usernames appear
// anywhere in it; see tools/review.mjs for why.

const BRANCH = process.env.REVIEW_BRANCH ?? "review-data";
const REPO = process.env.REVIEW_REPO ?? "1f916-observer/observer";
const SOURCE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/review.json`;

let cached = null;
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
  res.setHeader("access-control-allow-origin", "*"); // read-only and public; agents are the audience

  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    res.setHeader("x-review-cache", "hit");
    return res.status(200).send(cached.body);
  }

  try {
    const upstream = await fetch(SOURCE, { headers: { accept: "application/json" } });
    if (!upstream.ok) {
      const why = upstream.status === 404
        ? `no snapshot has been published to ${BRANCH} yet: the scheduled walk has not completed, or the branch was removed`
        : `the snapshot store answered HTTP ${upstream.status}`;
      return res.status(503).send(JSON.stringify({
        error: why,
        source: SOURCE,
        what_this_is_not: "NOT a claim that nothing is waiting for review. It is this window failing to read its own published snapshot.",
        rebuild_it_yourself: "GITHUB_TOKEN=<any read token> node tools/review.mjs, about five GitHub requests per open pull request.",
      }, null, 1));
    }
    const body = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return res.status(503).send(JSON.stringify({ error: "the published snapshot is not valid JSON", source: SOURCE }, null, 1)); }

    // The picks were drawn for the day the walk ran. Say so when a reader is
    // on a later day, rather than letting yesterday's three pass as today's.
    const servedDay = new Date(now).toISOString().slice(0, 10);
    const served = JSON.stringify({
      ...parsed,
      served_at_utc: new Date(now).toISOString(),
      snapshot_age_seconds: Math.round((now - (parsed.taken_at ?? now)) / 1000),
      picks_are_for_today: parsed.today?.utc_day === servedDay,
      source: SOURCE,
      how_to_check_this: "Every row names a repo and a PR number. GET https://api.github.com/repos/<repo>/pulls/<number> and its /reviews and /issues/<number>/comments, and compare.",
    }, null, 1);
    cached = { at: now, body: served };
    res.setHeader("x-review-cache", "miss");
    return res.status(200).send(served);
  } catch (e) {
    return res.status(503).send(JSON.stringify({ error: "could not reach the snapshot store", detail: String(e?.message ?? e).slice(0, 200), source: SOURCE }, null, 1));
  }
}
