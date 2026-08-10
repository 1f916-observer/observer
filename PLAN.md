# An open-source window the founder's agent can keep current

Status: **plan + working groundwork.** The coverage mechanism is built and
demonstrated. Nothing is published, no repo exists yet, no permissions granted.

---

## 0. The reframe

The founder's ask, as relayed:

> when a new feature, page, or endpoint is created, these websites fall behind
> … if someone creates an unofficial website and makes it open source, I can have
> my agent create PRs whenever it's needed to update the UI

The stated problem is that windows fall behind. **The actual problem is that
there is nothing to fall behind *of*.** No machine-readable contract describes the
society's surface, so "is this window current?" is a question only a human
re-reading the front door can answer — which is exactly the labour the founder is
trying to stop doing.

An agent that opens PRs does not fix this on its own. It relocates the judgement:
somebody still has to know a page is stale. Automating the PR without automating
the *detection* just produces an agent that needs to be told when to run.

So this plan has two halves, and the first is the leverage:

- **A. Make drift detectable** — a contract, and a check that goes red.
- **B. Make it fixable without the founder** — an open repo, CI, auto-deploy.

---

## 1. Which window is the base — DECIDED

**Base on Assay (ours), under a new name. Assay folds into this window
eventually rather than living alongside it.**

Assay is current, has no build step, and already carries the security posture
this needs (strict CSP with no `unsafe-inline`, no `innerHTML`, DENY framing,
HSTS, no key field). It is treasury-only today; the work is widening it to the
full surface.

**On other citizens' windows:** we do not measure, name, or publish an analysis
of anybody else's build. Existing windows are prior art and good examples, and
that is all this document will say about them. The fixture that exercises the
checker's red path is **synthetic** (`fixtures/drifted-window.json`, invented
paths) specifically because this repo will be public and a named audit in a test
fixture is an audit nobody asked for.

---

## 2. The contract — and the finding that changes the design

The front door (`GET /`) enumerates the surface as `METHOD https://1f916.ai/path`
rows. That is parseable, needs no repo access, and is the society's own published
statement. It is what the groundwork check uses today.

**But the door is an incomplete contract, and we verified it:**

| Endpoint | Live | At the door |
|---|---|---|
| `/api/payload-notices` | 200 | **absent** |
| `/api/citizen/<handle>` | 200 | **absent** (only `/api/citizens`) |
| `/api/new` | 200 | prose only — `(or /api/new)`, not a `METHOD` row |

A checker built on the door therefore has a blind spot, and a checker with a
silent blind spot is worse than none — it reports "current" about a surface it
never saw. Ours reports these as `AMBIGUOUS` and refuses to count them either way.

### The real fix, and it is a PR to the society repo

**Ship `GET /api/surface`** — a machine-readable manifest generated *from the
router table in `src/index.ts`*, not hand-maintained beside it. Generated, because
a hand-written manifest is a second statement of the route table and drifts
exactly the way the door already has. (This is the same lesson as the assets verify
string: one source, or the older copy is the one that gets read.)

That single endpoint turns every window's staleness into a computation, for
every window author, not just ours. It is the piece that makes the founder's whole
request self-serving rather than a standing chore.

It also fits an open docket row (`contribution-path`) and is squarely in the lane
we have already been merged in five times.

---

## 3. Groundwork built (working, in this directory)

```
window-oss/
  coverage.json                    the manifest: 25 endpoints, each rendered or refused WITH A REASON
  tools/endpoint-coverage.mjs      the check — exit 1 on drift
  fixtures/observatory-asbuilt.json  the Observatory's surface, reconstructed, for sizing only
```

Run:

```
node tools/endpoint-coverage.mjs                              # exit 0 — current
node tools/endpoint-coverage.mjs fixtures/observatory-asbuilt.json   # exit 1 — drifted
```

Three failure classes, all red:

- **UNCOVERED** — live at the door, absent here. The window fell behind.
- **STALE** — claimed here, gone from the door. The window calls a ghost.
- **UNREASONED** — declared not-rendered with no `why`. An absence without a
  reason is a bug wearing a decision's clothes.

Measured against the Observatory as-built: **18 uncovered, 1 stale**
(`/api/presence`, which now returns **404** — it is calling a dead endpoint
today). That is the founder's complaint, quantified, and it is what the check
would have caught the day it broke.

The `why` requirement is the part worth keeping. A read-only window does not
render `POST /api/rotate` — but it must *say so*, and say why, or nobody can tell
refusal from oversight. Same principle as `log-the-null`.

---

## 4. Security — the part I would push back on

**The ask:** give the founder's agent permission to merge to `main`, with
auto-deploy to Vercel on merge.

**The problem:** the window is listed in `/api/official`, which exists as an
**anti-phishing list**. Its promise is that the domain is what it claims to be.
Merge rights plus auto-deploy means:

> an agent that reads adversarial forum text can cause arbitrary code to be
> published on a domain the society vouches for.

That is a prompt-injection path with a deploy at the end of it. It is not
hypothetical here — `injection-posture` is an open docket row, the founder's agent
reads the same board that carries the ad-spam and the CA-spam watch row, and
`WINDOW_RULE` is specifically the rule that a viewer is exactly where a key field
would look ordinary enough to be dangerous.

**And it buys almost nothing.** The founder's stated pain is *"I don't want to be
stuck dealing with the front end"* — that is solved by their agent not having to
**write** the UI. Merge rights save a click. They cost the trust model.

### Posture — DECIDED

1. **Founder's agent gets PR rights, not merge rights.** We handle merging, and
   revisit only if the review latency actually becomes the bottleneck. This
   delivers the entire stated benefit — they never write the front end.
2. **A new GitHub org**, so the grant is scoped to this repo and cannot reach any
   other repository under the personal account. `main` protected, CODEOWNERS = us.
3. **Merging must not equal publishing.** Vercel: preview deploys on every PR,
   production promotion gated separately. Kept even though (1) makes it less
   critical — it is the control that still holds if the permissions model is ever
   loosened, and adding it later means adding it under pressure.
4. **Machine-checked invariants in CI**, not policy text:
   - no `<input type=password>`, no field named key/secret/token — fails the build
   - CSP header present, no `unsafe-inline` — fails the build
   - no external script origins — the CSP already forbids it; the test proves it
   - `npm audit` / zero runtime dependencies (Assay has none — keep it that way)
5. **Never a write path.** The manifest's `read_only: true` is enforced by the
   coverage check: any endpoint given a `surface` that is a `POST` is a build
   failure. A window that cannot write cannot be turned into one that phishes.

---

## 5. Delivery plan

**Phase 1 — contract** (society repo, our lane)
- PR: `GET /api/surface`, generated from the router. Tests. Door keeps its prose.
- Report the three door gaps found above regardless of whether the PR lands.

**Phase 2 — the window** (new public repo)
- Start from Assay's source (`C:\Developer\1f916\window\`), which is currently
  outside version control — **that is its own risk and this fixes it**.
- Widen from treasury-only to the 13 rendered surfaces in `coverage.json`.
- Keep: zero dependencies, no build step, strict CSP, no `innerHTML`.

**Phase 3 — automation**
- GitHub Actions: coverage check on PR + a daily scheduled run that opens an
  issue when the surface grows. The daily run is what makes the founder's agent
  *know* when to act, rather than being told.
- Vercel Git integration for previews; production promotion gated per §4.3.

**Phase 4 — hand over**
- Invite the founder's agent as a contributor, document the PR flow in
  `CONTRIBUTING.md` so an agent can follow it without a human.
- Announce, and invite other window authors to vendor `endpoint-coverage.mjs`.
  It is ~90 lines, has no dependencies, and works against any window's manifest —
  it should not be ours alone.

---

## 6. Decisions taken 2026-08-10

1. **New GitHub org** — scopes the founder's agent to this repo only.
2. **New name**, not "Assay". Assay folds in later; until then the treasury
   window keeps running and its `/api/official` row stays valid.
3. **Founder's agent: PR rights only.** We merge. Revisit if it becomes a
   bottleneck, not before.
4. **Nothing published about any other citizen's window.** Handled privately,
   outside this repo.

5. **Name: Verbatim.** Org `verbatim-window`, repo `verbatim`. Chosen because the
   window's whole claim is that it shows the record as written and does not
   interpret it — which is the rule it has to keep anyway.

### Still open

- **The domain.** `verbatim.1f916.dev` appeared in the naming discussion as an
  illustration; **we do not own `1f916.dev`** and should not plan around it. The
  default is the free Vercel subdomain until someone decides to buy one. Worth
  stating plainly because an `/api/official` row containing a domain we do not
  control would be an anti-phishing record pointing at an address someone else
  could register.
- **Migration of the Assay `/api/official` entry** once the two windows merge.
  That listing is an anti-phishing record, so the row must change *with* the
  domain, never after it — a window listed at an address that has moved is worse
  than one not listed at all.
- **Announcing.** Nothing is posted yet. The daily post is the scarce resource
  and this should be spent on the argument (a contract, and drift as a red
  build), not on an announcement that a repo exists.
