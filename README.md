# presence-data

An append-only record of how many people have been reading
[the Observer](https://1f916.observer) at once.

This branch holds data, not code. It shares no history with `main` on purpose:
it is written by a scheduled job every 15 minutes and would otherwise bury the
repository's real history under tens of thousands of automated commits.

## What this is not

It is **not** analytics. The Observer ships no analytics, and
[`SECURITY.md`](https://github.com/1f916-observer/observer/blob/main/SECURITY.md)
says so in public:

> It loads nothing from a third party. No web fonts, no CDN, no analytics, and
> zero runtime dependencies.

That is still true, and this branch exists because it is true. Nothing was added
to the page. No script runs in your browser, no cookie is set, no identifier is
stored, and nothing about any individual reader is collected or recorded here.

The only thing being written down is a number the site already tells anybody who
asks, at <https://1f916.observer/api/presence>.

## What the number means

`/api/presence` counts distinct browsers that sent a heartbeat within a 45-second
window — **as seen by one serverless instance**. Traffic is spread across many
instances, so any single response is a **lower bound** on the number of people
reading, never the total. The endpoint says so itself with `approximate: true`,
and the page renders it with a `≥`.

Everything in this branch inherits that. Every `floor` value below means *at
least this many*, and the true number is higher by an unknown amount.

## How each record is made

The sampler
([`tools/presence-sample.mjs`](https://github.com/1f916-observer/observer/blob/main/tools/presence-sample.mjs))
takes six samples five seconds apart, because consecutive requests are answered
by different instances. Then:

- it reports `max(samples)` as the floor;
- it **never sums** the samples — the same readers appear in more than one
  sample, so a sum would double-count them and turn an honest floor into a
  confident fiction;
- it keeps every raw sample in the record, so the aggregate can be recomputed by
  anyone who doubts it;
- it sends **no `?id=`**, so the act of observing does not register the observer
  as a reader and inflate the very number it is reading.

## Failures are recorded as failures

A sample that errors is written with `"observed": false` and the error text. It
is never written as `"floor": 0`. A zero and an outage are indistinguishable once
they reach a chart, and only one of them is true.

Likewise, a missing record is a **gap**, not a quiet period. GitHub delays and
sometimes drops scheduled runs; the report counts coverage per day and refuses to
state a trend across days too thin to carry one.

## Format

One JSON object per line in `presence-history.jsonl`:

```json
{"at":"2026-08-26T02:48:25.801Z","endpoint":"https://1f916.observer/api/presence","observed":true,"floor":36,"samples":[10,32,32,36],"attempted":4,"succeeded":4,"errors":[],"bound":"lower","method":"max of independent samples; never summed","endpoint_self_reports_approximate":true,"ttl_ms":45000}
```

## Reading it

From a checkout of `main`, with this branch fetched alongside:

```
node tools/presence-report.mjs presence-history.jsonl
```

It prints a per-day table and a 7-day trend. The trend is taken on the **median**
rather than the peak: a daily peak is a maximum over that day's samples, so it
climbs with the *number* of samples, and trending peaks would quietly convert
cron reliability into apparent audience growth.
