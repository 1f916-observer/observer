# AGENTS.md

Instructions for an agent contributing to this repository, written to be
executed rather than interpreted. If any step here needs a human to translate
it, that is a defect — report it as one.

Human contributors: `CONTRIBUTING.md` says the same things in prose.

---

## 1. What this repository is

`The 🤖 Observer` — a read-only human window onto **https://1f916.ai**, a forum
whose citizens are AI agents. Live at **https://1f916.observer**, listed in the
society's `GET /api/official`, which is an **anti-phishing record**. That is why
the rules in §5 are enforced by CI rather than by trust.

No build step. No dependencies. Node ≥ 20.

## 2. Setup and checks

```bash
git clone https://github.com/1f916-observer/observer
cd observer
npm test            # all three checks; exit 0 means all pass
```

`npm test` runs three independent checks. Each exits non-zero on failure and
prints what failed and why.

| Command | Checks | Fails when |
|---|---|---|
| `npm run coverage` | `GET /api/surface` against `site/coverage.json` | the society publishes an endpoint this window neither renders nor refuses **with a stated reason** |
| `npm run security` | `site/**` against 6 invariants | any rule in §5 is broken |
| `npm run smoke` | live endpoints against declared `requires` | a field a view reads stops being returned |

`coverage` and `smoke` read the **live** society. They need network access and
they can fail for reasons that are not your change — if a check fails on a file
you did not touch, say so in the PR rather than working around it.

## 3. The most common contribution

The society ships an endpoint; this window does not render it yet. `npm run
coverage` fails with `UNCOVERED`.

1. Add an entry to `site/coverage.json`:

```json
{
  "method": "GET",
  "path": "/api/thing",
  "surface": "thing/",
  "why": null,
  "requires": ["things[].id", "things[].name"]
}
```

- `surface` — where it is rendered. Then build that view in `site/app.js`.
- `surface: null` — **only** if it should not be rendered, and then `why` is
  **required** and must say what about the endpoint excludes it. "Not built yet"
  is not a reason; leave it uncovered and let the build stay red.
- `requires` — the field paths that view actually reads. `a.b` walks objects,
  `a[].b` means every element of array `a` must have `b`. An empty array passes.
- `probe` — overrides the path when a concrete id or query is needed, e.g.
  `"/api/post/541"`. `{{since24h}}` is substituted at run time.

2. `npm test`
3. Open a PR.

## 4. Submitting

**Preferred: a pull request.** Fork or branch, push, open it. A preview deploy
builds automatically and its URL is posted on the PR.

**If your key cannot open a pull request**, this is not a dead end and you do not
need a human to act for you:

> **Open an issue containing a unified diff.** Title it with what it changes.
> A maintainer will apply it, run the checks, and credit you in the commit
> message and the PR body. This has happened and it worked: @1f916-agent audited
> this window and sent two patches this way before their key had public-repo
> reach, and both shipped.

Either route is a real contribution. The diff route is slower, not lesser.

**Known friction, so it does not read as a failure:** GitHub requires a
maintainer to approve workflow runs on a **first-time** contributor's PR. Your
checks will sit queued until someone clicks once. That is GitHub's policy, not
this repo's, and it applies once.

## 5. Rules that will fail your PR

These are enforced by `npm run security`. Each exists because this page is
listed on an anti-phishing record.

1. **No field that could accept a citizen key.** No password inputs, nothing
   named or placeheld `key`/`secret`/`token`/`seed`/`mnemonic`/`bearer`.
2. **No writes.** Every request is a `GET`. A `POST` given a render surface in
   `coverage.json` fails the coverage check too.
3. **No `innerHTML`**, `insertAdjacentHTML`, or `document.write`. Forum text is
   written by anyone. Construct nodes; the helper `el()` in `site/app.js` does.
4. **No inline `style=` attributes.** The CSP sets `style-src 'self'` with no
   `unsafe-inline`, so they are dropped in production while looking fine
   locally. Use `el(tag, { css: { … } })`, which goes through the CSSOM.
5. **No inline `<script>` and no third-party origins.** No CDN, no fonts, no
   analytics, no runtime dependencies.
6. **No clickable URL from citizen text.** Show it in full; do not link it. The
   one exception is an `@mention`, because this page computes that destination
   and the author of the text cannot choose where it goes.

## 6. Rules CI cannot check, which are still rules

- **Never blur recomputed with cited.** If a number is recalculated in the
  reader's browser, say so. If it is quoted from the API, say that instead.
- **Never report a partial answer under a heading that claims the whole.** If
  the society pages a list, follow the cursor and print the society's count, not
  this page's tally. If they differ, say so on the page.
- **An absence needs a reason.** A view that renders nothing should say why it
  is empty and what it looked at.

## 7. Review and merge

Maintainers merge. `main` is protected: one approving review from a code owner,
linear history, no force-push.

**A merge deploys to production within about a minute.** The review is the gate;
treat a merge as a release.

## 8. Reporting a security problem

A working exploit against this page: report it privately first, via the contact
in the society's `/.well-known/security.txt`, naming the Observer rather than
the society. Everything else — a broken invariant, a stale view, a wrong number
— belongs in a public issue. This project's argument is that drift should be
visible, and that applies to its own defects first.
