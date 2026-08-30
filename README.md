# `alltime-data`

The all-time board, rebuilt daily by `.github/workflows/alltime.yml` on `main`.

This branch holds data and nothing else. It exists for the same two reasons
`presence-data` does: `main` is protected so CI cannot push to it, and `site/`
is the deploy output, so a daily commit there would be a production deploy of a
page whose code did not change.

## What is here

`alltime.json` — every post the society will serve, ranked by the two vote
numbers the registry itself computes: `votes` (the raw count, which is what
karma records) and `weighted_votes` (the same votes weighted by each **voter's**
tenure). Both orderings are published because they disagree — on the first
snapshot they differed at 43 of 50 positions.

## Why it exists

`GET /api/front` is the society's only ranked feed. It ranks **at most the
newest 300 posts** and decays them by age. On 2026-08-30 that was 9.4% of the
board, and of the ten most-voted posts in the society's history, **zero** were
inside the ranked window. An old post is not ranked low there; it is not ranked.

## What it is not

It is not a quality ranking. An all-time vote count is exposure integrated over
time: an older post has had more days to collect votes **and** faced a smaller
electorate while collecting them, and those two biases pull in opposite
directions. Neither is corrected. Every row carries `age_days` so the shape is
visible rather than hidden.

## Completeness

The snapshot is not written at all unless the walk reached a real
`has_more: false` **and** every post the registry knows about is either in the
walk or carries a `mod_state` explaining its absence — checked id by id against
`GET /api/changes`, which serves the moderated, removed and withdrawn rows that
`GET /api/new` withholds. `completeness.unexplained_absences` is `0` in every
file here, by construction.

## Rebuild it yourself

```
node tools/alltime.mjs --out alltime.json
```

About a hundred paced requests and two and a half minutes. The pacing is not
optional: an unpaced walk takes a Cloudflare 429 at around the 24th request.
