# Proposal: Artifact judges (`judges:`)

Status: **shipped** — superseded by `docs/design.md` §24 (this proposal is kept for historical context; the authoritative spec is design.md §24).
Build path: **one PR (J1)** — static foundation first, runtime on top, as ordered commits within the same delivery (§6 Q4, §7).

---

## 1. Problem

An artifact should be able to carry its own **quality gate**: an optional agent
that evaluates the produced value and can reject it. If an artifact defines a
judge, the artifact is **not usable by downstream steps until the judge signs
off**. If no judge is defined, nothing changes — the artifact behaves exactly as
today (still fail-able by schema, still knock-back-able by a downstream
consumer).

The user's framing:

> Artifacts need their own judge "agent" similar to how a step has its own
> agent. Except these optional agents are responsible for evaluating the quality
> of an artifact and have the ability to reject it. This means if an artifact
> defines a judge, it's not considered ready for other steps until the judge has
> signed off. If no judge is defined, it works normally — can still be failed
> from schema or even a downstream consumer (that already works fine).

### 1.1 Why the existing reviewer pattern is not this

`examples/workflows/delivery.yaml` already has a reviewer:

```yaml
- name: reviewer
  consumes: [pr]
  produces: [verdict]     # a SEPARATE artifact
  body: Review `pr`. If not mergeable, reject pr (re-arms builder). Else green verdict.

- name: merger
  consumes: [verdict]     # the gate is "verdict is green", not "pr is good"
  produces: [merge]
```

This is an **after-the-fact downstream knock-back**, and it is categorically
different from what a judge is:

| | Reviewer-step (today) | Judge (proposed) |
|---|---|---|
| What gates | a *separate* artifact (`verdict`) that consumers wire to | the artifact *itself* (`pr`) |
| Consumer wiring | every consumer must consume `verdict`, not `pr` | consumers consume `pr` normally; gate is invisible to them |
| When it runs | after `pr` is green and visible | before `pr` is ever visible downstream |
| Reuse | must be hand-wired per artifact, per workflow | declared once on the `produces` entry |
| "Not ready" semantics | emergent from graph shape | a first-class property of the artifact |

The reviewer pattern makes *approval* a node in the graph. The judge makes
*approval a property of the artifact*. The user is asking for the second thing:
"not considered ready for other steps until the judge has signed off." You can
approximate it today only by rewiring every consumer through a proxy artifact —
which is exactly the boilerplate this feature removes.

### 1.2 What a judge is for (and is not)

A judge is **not** a replacement for review steps. When evaluating is domain
work — a software delivery pipeline reviews PRs; that is part of what the
pipeline *does* — it belongs in the graph as a step: visible, wired, producing
its own artifacts. `delivery.yaml` keeps its `reviewer` step, unchanged.

A judge is for **intrinsic quality criteria** on an artifact that would never
merit a node of its own: "this report has no placeholder text and every claim
carries a citation", "this dataset has no empty required columns", "this
summary actually covers every section of the source". It has the same
relationship to the value that schema does — schema checks *shape* at commit,
the judge checks *quality* at commit. Engine validation, not workflow
structure.

Rule of thumb: if the evaluation is part of the job, it's a step. If it's a
bar the artifact must clear regardless of the job, it's a judge.

---

## 2. Philosophy fit

owenloop's core invariant (§1, "the inversion"): **steps have no status;
eligibility is a pure function `state → eligible firings`, and everything else is
a consequence.** A good feature adds a new *condition on the state* and lets the
existing pure function do the rest — it does not add a new imperative code path.

The judge fits this exactly. It is one new lifecycle **condition** —
"green-but-not-yet-signed-off" — plus **machine-recognized synthesized
steps** (one per declared judge) that clear it. Every downstream behavior (eligibility, cascade, stalls,
schema, authority, done-ness) then falls out of machinery that already exists:

- The **synthesized judge step** has a direct precedent: `calls:` steps (§23) are
  already machine-handled marker steps — recognized by the model, excluded from
  `eligibleFirings`, never emitting a normal worker order. The judge step is the
  same shape (a `judges: <stem>` marker) but it *does* emit a worker order (it
  has an agent body), and its green/reject clears/re-arms the gate.
- The **not-ready condition** reuses the debt/settled partition (§5). A
  submitted-but-unjudged artifact reads as *outstanding*, not *green*, so
  `plainSatisfied` in `eligibleFirings` (`plainPaths.every(p => isGreen(...))`)
  already refuses to fire consumers — no new gate logic.
- **Judge rejects** reuse the producer's `judgmentRejects` / `maxAttempts` stall
  machinery (§6). A judge that keeps rejecting stalls the producer, same as a
  downstream consumer that keeps rejecting.
- **Schema** stays a refusal-before-green at *producer* commit (§19): the value
  is schema-checked when the producer commits, before it is ever handed to the
  judge. The judge never sees a schema-invalid value.
- The **forward cascade** (§7) treats the not-ready condition like non-terminal
  green: if an input moves, the producer re-arms and the (now-stale) judge
  verdict is discarded — level-triggered, idempotent, order-independent.

Net: no new imperative subsystem. One new state condition + one marker step, and
the pure function absorbs everything.

---

## 3. Mechanism

### 3.1 Lifecycle: the `submitted` condition

When a producer greens an artifact that has a judge, the artifact does **not**
land in the fully-usable `green` state. It lands in **`submitted`**: built,
schema-valid, but awaiting sign-off.

- `submitted` is a **debt-side** condition for consumers: `isGreen(submitted) =
  false`, so no consumer of the stem is eligible. It reads as *outstanding* in
  `done`/`allGreen` (the workflow is not done while an artifact is awaiting its
  judge).
- `submitted` is **not owed by the producer**: the producer has done its job.
  The outstanding work is the judge's.
- On judge **approve** → the approval is recorded in the artifact's
  per-version **sign-off ledger** (e.g. `approvals: { completeness: 7 }`
  against submitted version 7). When **every declared judge** has approved the
  current version, the artifact transitions `submitted → green` (version bumps
  at submit time, not at approve; see §4.4). Now consumers fire normally. With
  a single judge the ledger is one entry and approve is effectively the
  transition.
- On judge **reject** → any single reject wins immediately: the artifact
  transitions `submitted → rejected` with a `judgment` reason, bumping the
  **producer's** `judgmentRejects` **once per submission** (not once per
  judge). The producer re-arms (subject to `maxAttempts`), rebuilds,
  resubmits. Other judges' still-in-flight verdicts on that submission die on
  the §4.6 CAS check.

There are two ways to represent `submitted` — as a genuinely new sixth
`acceptance` state, or as `green` plus a "pending judge" marker. This is an open
fork; see §6, Q1. The rest of this doc is written against the new-state framing
because it makes the invariants self-evident, but the mechanism is identical
either way.

### 3.2 A judge is a step, owned by the engine (`judges:`)

**Principle: a judge is not a new kind of thing. It is a full `StepDef`,
synthesized by the def-builder and owned by the engine**, carrying a
`judges: <stem>` marker (analogous to `calls: <workflow>` in §23 — but where
`calls:` steps are inert markers, judge steps are complete, order-emitting
steps). N judges → N independent steps, N independent worker orders. The user
never writes the step; they write the `judges:` entry on the artifact, and the
declaration stays where it belongs — approval as a property of the artifact —
while the machinery is ordinary step machinery.

A judge differs from a hand-written step in **exactly three ways**:

1. **Trigger.** It is excluded from the normal eligibility path. Its firing
   condition is level-triggered: "the stem is in `submitted` and this judge
   has not signed off on the current version" — not "inputs are green".
   (Indeed `submitted` deliberately fails `isGreen`, so the normal path could
   never fire it.) All of a stem's judges fire in parallel on submit.
2. **It produces nothing.** Verdicts act on the existing artifact; no proxy
   `verdict` artifact exists. (The key difference from the reviewer-step.)
3. **Verdict commit.** A normal step's order commits by greening its produces.
   A judge's order commits with a `green`/`reject` verb against the judged
   stem, CAS-guarded by the submitted version it judged (§4.6), routed to the
   sign-off ledger / rejected transition (§3.1).

Everything else is **inherited from step machinery, not specified here**:

- **Consume edges and authority**: the judge consumes the judged stem — which
  is what grants it authority to reject it (§4.5) — and reads its value as the
  thing to evaluate. By default that is **all** it sees; `inputs: true` adds
  read-only consume edges on the producer's inputs for criteria that need the
  "what was asked for" as context.
- **Prompt surface**: `body` / `bodyFile` / `model`, parsed and resolved
  exactly as for steps (#38), same substitution surface.
- **Order lifecycle**: emission, claim, and the retry/timeout handling for
  orders that die — a judge that crashes or never returns a verdict is handled
  by the same order-failure machinery as any step (§4.10).
- **Throttles**: `cadence` / `maxRunsPerDay` fields exist because it is a
  `StepDef`; judge entries may set them (§5), same defaults as steps.
- **Observability**: `status` / `trace` / graph rendering see an ordinary step
  with a marker.

### 3.3 The mechanism table

Everything the judge needs, mapped to the machinery it reuses:

| Concern | How it works | Reuses |
|---|---|---|
| Consumers blocked until sign-off | `isGreen(submitted)=false` → `plainSatisfied` false | §3 firing rule |
| Judge gets an agent order | judge step fires when its stem is `submitted` and it hasn't signed off | §2 nodes / order build |
| Approve | recorded in sign-off ledger; all judges approved → `submitted → green` | §5 lifecycle |
| Reject | any reject: `submitted → rejected`, bump producer `judgmentRejects` once, re-arm producer | §6 stalls |
| Judge keeps rejecting | producer stalls at `maxAttempts`; human `retry` resets | §6 stalls |
| Value is garbage-shaped | schema refuses at producer commit, before `submitted` | §19 schema |
| Input moves under a submitted/approved artifact | cascade re-arms producer, discards verdict | §7 cascade |
| Only the judge may reject the stem | judge consumes the stem → passes `assertAuthority` | §4.1 authority |
| Judge order dies (crash/timeout/no verdict) | order retry/timeout machinery, artifact stays `submitted` | step order lifecycle |
| Human wants to ship it anyway | human `green` bypasses the ledger, `submitted → green` | §4.1 authority |
| Downstream reject still works | unchanged — a consumer of green `pr` can still knock it back | existing |
| Done-ness | `submitted` counts as outstanding | §15 completion |

---

## 4. Interactions and edge cases

### 4.1 Schema runs before the judge
Schema validation is a *refusal* at producer-commit (§19), so a schema-invalid
value never reaches `submitted` and never reaches the judge. The judge only ever
evaluates well-formed values. Schema failures bump `schemaRejects` (its own
counter / `maxSchemaFailures` stall), disjoint from the judge's
`judgmentRejects`. Two independent gates, two independent stalls.

### 4.2 No judge → identical to today
The `judges:` list is optional. Absent it, the def-builder synthesizes no judge
steps, producer-green lands directly in `green`, and the artifact is byte-for-byte
identical to current behavior. This is the "works normally" guarantee.

### 4.3 Forward cascade treats `submitted` like non-terminal green
If an input the producer consumed moves (or goes non-green) while the artifact is
`submitted` **or** judge-approved `green`, the cascade (§7) re-arms the producer
(via the existing cascade `reject` op — `rejected` is a debt state, so the
producer becomes eligible again) and the artifact leaves the usable set. A
pending or completed judge verdict on a now-stale value is discarded — the
producer rebuilds and resubmits, and the judges re-evaluate the fresh value.
Level-triggered, so no explicit "invalidate the verdict" step is needed.

**A cascade reject is an invalidation, not a quality verdict: it must NOT bump
`judgmentRejects`.** A strike against `maxAttempts` means "built something
bad", not "the inputs changed". Without this rule a frequently-moving upstream
input could stall a producer that never produced anything wrong.

### 4.4 Version bumps at submit, not at approve
The artifact's monotonic version (§12.1) bumps when the **producer** commits
(enters `submitted`), not when the judge approves. Rationale: the value is fixed
at submit; approval changes its *acceptance*, not its content. This keeps
fingerprint/CAS semantics (§12.2) unchanged — a consumer's recorded input
version matches the value it will actually read.

### 4.5 Authority: a one-line rule
Only a step that consumes an artifact's stem (or a human/engine) may
judgment-reject it (`assertAuthority`, §4.1). The synthesized judge step
consumes the judged stem, so it passes the existing authority check with **no
special-casing** — the judge is authorized by construction.

### 4.6 Concurrency corner (flagged for the build)
If the producer resubmits (a new `submitted` version) while a judge order for the
*previous* submission is still in flight, an approve/reject arriving from the
stale order must **re-arm the judge**, not act on the fresh submission. Handle
this with the same commit-fingerprint CAS the rest of the engine uses (§12.2):
the judge order records the submitted version it is judging; at approve/reject
commit the engine checks the artifact is still at that version and in
`submitted`, else the verdict is born-rejected (the judge simply re-fires on the
new submission). The version is already captured for free — the run
fingerprint records every consumed input's version at claim time — so the new
code is only the commit-side check, a judge-variant of `casCheck` (which for
normal steps requires inputs to be green; for a judge the requirement is
"still `submitted` at that version"). This is the one genuinely new race and
deserves an explicit test.

The same guard covers the multi-judge case with no extra machinery: when judge
A rejects, the artifact leaves `submitted` at that version, so judge B's
in-flight verdict is born-rejected on arrival. One CAS rule handles both the
resubmit race and the sibling-judge race.

### 4.7 `done` / `allGreen` must treat `submitted` as outstanding
`workflowStatus` derives `done` as "no artifact in a debt state". `submitted`
must be classified so that a workflow with an unjudged artifact is **not** done.
Concretely: `submitted` joins the "outstanding for completion" set even though
it is not a producer debt. (If implemented as new state: add to the completion
check. If implemented as green+marker: the marker gates done-ness.)

### 4.8 Terminal artifacts
A `terminal: true` artifact with a judge: the judge runs before the terminal
green becomes irreversible. Approve → terminal green (frozen, §15.2). This is
desirable — you want the sign-off *before* the irreversible commit, not after.
Reject before approve is fine (nothing irreversible has happened). No special
interaction beyond ordering, which already holds.

### 4.9 One rebuild budget, deliberately shared
Judge rejects and downstream-consumer knock-backs both bump `judgmentRejects`
against the same `maxAttempts`. This is intentional: the cap means "how many
total rebuilds of this artifact before a human looks", regardless of who asked
for the rebuild. Cascade invalidations do not count (§4.3), and schema refusals
have their own counter (§4.1) — the three failure kinds stay distinguishable in
the audit trail even though judge and consumer rejects share a budget.

### 4.10 Judge order failure is not a judge reject
A judge order that dies — agent crash, timeout, output that is neither approve
nor reject — is an **order failure**, handled by the same order retry/timeout
machinery as any step's dead order (a judge is a step, §3.2). It does **not**
bump `judgmentRejects` (no verdict was rendered) and the artifact stays in
`submitted`; the level-triggered condition simply re-fires the judge, bounded
by the same order-failure policy that bounds any other step. Three distinct
failure kinds, three distinct handlers: schema refusal (producer's problem,
§4.1), judge reject (value's problem, §3.1), order failure (judge's problem,
this section). Without this rule an artifact could hang in `submitted` forever
behind a judge that never answers.

### 4.11 Human override is a full bypass
`assertAuthority` already grants humans authority over everything. A human
`green` on a `submitted` artifact means "I've looked at it, ship it": the
artifact transitions `submitted → green` immediately, regardless of the
sign-off ledger — the human overrides all pending judges at once, they do not
sign one ledger slot. In-flight judge orders for that submission die on the
§4.6 CAS check (the artifact is no longer `submitted` at that version). A
human `reject` behaves as it does today. A human `retry` after a
judge-reject stall clears the sign-off ledger along with the counters, so the
rebuilt artifact is judged fresh.

---

## 5. YAML surface

A `judges:` list hangs off a `produces` entry (the object form
`{name, schema?, judges?}`):

```yaml
steps:
  - name: researcher
    consumes: [question]
    produces:
      - name: report
        schema: { type: object, required: [sections] }  # existing, optional
        judges:                                          # NEW, optional list
          - name: completeness
            body: |
              Evaluate `report`: every section present, no placeholder or TODO
              text, every claim carries a citation. If it falls short, reject
              `report` with the concrete gaps (this re-arms the researcher).
              Otherwise approve.
          - name: rigor
            bodyFile: judges/rigor.md # or a prompt loaded from disk (#38) —
                                      # body/bodyFile mutually exclusive
            model: claude-opus-4-8    # optional, per-judge model
            inputs: true              # optional, default false — judge also
                                      # reads the producer's inputs (`question`)
    maxAttempts: 5    # producer's cap — also bounds judge-reject → rebuild loops
```

- `name:` — required; keys the sign-off ledger and the audit trail.
- `body:` / `bodyFile:` — the judge agent's prompt (exactly one required,
  mutually exclusive — same rule as step bodies, #38). `bodyFile` is resolved
  against the workflow's base directory and read eagerly at def-load, exactly
  like a step's `bodyFile`; by the time the judge step is synthesized it
  carries a plain resolved body. Same substitution surface as a step body
  (`${WORKFLOW}`, `${RUN}`, and the judged value).
- `model:` — optional model override for that judge's order.
- `inputs:` — optional, **default `false`**: the judge sees only the judged
  value and evaluates it on its own merits. `true` adds read-only consume
  edges on the producer's inputs, for criteria that need the "what was asked
  for" as context (§3.2).
- `cadence:` / `maxRunsPerDay:` — optional throttles, same meaning and
  defaults as on steps. A judge is a `StepDef` (§3.2), so these fields exist
  anyway; firing is event-driven (on submit), the throttles just cap the rate.
- Judges' reject/approve reuse the existing `reject` / `green` verbs against
  the judged stem — no new CLI surface in the recommended path (see §6, Q2).

`delivery.yaml` is deliberately **unchanged**: PR review is domain work in that
pipeline and stays a `reviewer` step (§1.2). Judges cover the other case — a
quality bar that would never merit a node of its own.

---

## 6. Design decisions

### Locked (2026-07-01)

- **Multiple judges, engine-controlled.** `judges:` is a list; N entries → N
  synthesized steps and N independent orders. All must approve the current
  version (sign-off ledger); any single reject wins and bumps
  `judgmentRejects` once per submission. Deterministic guardrails over
  probabilistic verdicts — the engine aggregates, not one agent role-playing a
  panel. Quorum (`2 of 3`) is deliberately deferred; if ever needed it is a
  `require:` field on the list, purely additive.
- **Judge input access is opt-in, `inputs: false` by default.** A judge
  evaluates the artifact on its own merits unless the criteria need the
  producer's inputs as context.
- **Cascade invalidations don't bump `judgmentRejects`** (§4.3).
- **Judge and consumer rejects share the `maxAttempts` budget** (§4.9).
- **A judge is a step, owned by the engine** (§3.2). A full synthesized
  `StepDef` differing from a hand-written step in exactly three ways (trigger,
  no produces, verdict commit); order retry/timeout, throttles, prompt
  surface (`body`/`bodyFile`/`model`), authority, and observability are all
  inherited, not respecified.
- **Judge order failure ≠ judge reject** (§4.10): reuses step order-failure
  machinery, no `judgmentRejects` bump.
- **Human `green` on `submitted` is a full bypass** (§4.11), not one ledger
  slot.
- **Scope framing:** judges are intrinsic quality bars, not review steps
  (§1.2). `delivery.yaml` keeps its reviewer.

### Q1–Q4 (locked 2026-07-01, as recommended)

All four forks are resolved; nothing below remains open. The Q framing is kept
for the rationale record.

**Q1 — State model.** New sixth `acceptance` state `submitted`, *or* reuse
`green` + a "pending judge" marker (keeps the "five states" invariant, matches
the `held` idiom which is already a marker-on-an-existing-state)?
→ **Locked: new `submitted` state.** It makes every invariant
(`isGreen=false`, done-ness, cascade) self-evident and greppable. Honest blast
radius: six files, not three — the state enum + debt/settled sets
(`types.ts`), `canonicalKey` + model checker + classifiers (`model.ts`),
commit paths (`engine.ts`), the persisted acceptance cast (`store.ts`), the
`ALLOWED_IS` predicate whitelist (`defs.ts`), and CLI status rendering
(`cli.ts`). The marker alternative keeps the enum stable but hides an
*eligibility-relevant* condition behind `green` and scatters "is it really
usable?" checks — unlike `held`, which is a leaf annotation and a weaker
precedent than it looks.

**Q2 — Judge verbs.** Reuse `green`/`reject` against the stem, *or* add dedicated
`approve`/`reject-judge` verbs?
→ **Locked: reuse `green`/`reject`.** Zero new CLI/engine verb surface; the
judge's authority (via consume edge) already routes it correctly. A dedicated
verb is only worth it if we later need judge-specific audit distinct from
consumer rejects.

**Q3 — v1 scope.** Singleton `produces` only, *or* also support judges on map
(`src[$i]`) / collection (`src[]`) elements in v1?
→ **Locked: singleton only for v1.** Per-element judges multiply the firing
and stall bookkeeping; ship the common case first, follow with collections once
the singleton semantics are proven. Validation hard-errors `judges:` on a
non-singleton produce in v1. (Multiple judges on a singleton *are* in v1 —
that fork is locked above; this question is only about map/collection stems.)

**Q4 — Build path.** Sequenced delivery PRs J1a→J1b, one delivery instance, or a
`delivery-conductor` co-build?
→ **Locked (revised 2026-07-01): one PR (J1).** Originally locked as sequenced
J1a→J1b; revised to a single PR covering the whole feature. §7 keeps a
static-first ordering *within* the PR (types/parsing/model awareness land as
the first commits, runtime on top) so the review still reads in layers, but it
ships as one delivery instance.

---

## 7. Build plan (one PR: J1)

Single PR, single delivery instance (§6 Q4). Commit ordering within the PR:
static foundation first (types → defs → model awareness), runtime on top
(engine → store → CLI → example/e2e), so the review reads in layers. Line
references below are anchors against `588b97c`, verified by code audit
2026-07-01.

### 7.1 The one wiring decision that makes the inheritance real

The engine has two ways to drive a synthesized step:

1. the **`calls:` way** — `maintainCalls` (`engine.ts:288`) runs at the top of
   `tick`, mutating the store directly, entirely outside the
   `eligibleFirings → applySchedule → claim → buildOrder` pipeline and the
   `reap` lifecycle;
2. the **normal step way** — `tick` (`engine.ts:417`) runs `reap` →
   `eligibleFirings` (`model.ts:372`) → `applySchedule` (`engine.ts:464`,
   cadence / `maxRunsPerDay` / `parallel`) → `claim` (`engine.ts:523`, real
   task row) → `buildOrder` (`engine.ts:558`).

**Judges MUST take the normal way.** The `calls:` analogy is about the
*marker*, not the firing path — a `maintainCalls`-style bypass would silently
lose every inherited behavior §3.2 promises:

- throttles only exist in `applySchedule`, not `eligibleFirings`;
- the §4.10 order-failure machinery is `reap` (`engine.ts:935`): stale-claim
  TTL (`reapTtlMs`, default 2h, `engine.ts:47`) resets the task to idle with
  `attempts+1` — it only applies to orders that were `claim()`ed;
- `buildOrder` already does everything a judge order needs: it substitutes
  `${WORKFLOW}/${RUN}/...` into the body and copies each consumed artifact's
  value into `order.consumes` **without checking acceptance**
  (`engine.ts:566-570`) — a `submitted` value reads fine, because the
  green-ness gate lives in the eligibility path, which is exactly the part we
  replace.

Concretely: `eligibleFirings` gains a `step.judges` branch parallel to the
existing `if (step.calls) continue` (`model.ts:377`) — a judge step is
eligible iff its stem's artifact is `submitted` **and**
`approvals[judgeName] !== version`, replacing the `plainSatisfied` inputs-green
check. Everything downstream of eligibility is untouched step code.

### 7.2 Checklist by file

**types.ts**
- `Acceptance` gains `'submitted'` (`types.ts:11-16`).
- `submitted` fits **neither** existing partition — not `DEBT_STATES` (it is
  not producer-owed) nor `SETTLED_STATES` (it is not usable). Add
  `OUTSTANDING_STATES = DEBT_STATES ∪ {submitted}` and use it for every
  "anything outstanding?" question (done-ness, `allGreen`); keep `DEBT_STATES`
  for producer-owed semantics.
- `ProducePattern` gains
  `judges?: Array<{ name; body; model?; inputs?; cadence?; maxRunsPerDay? }>`
  (no `bodyFile` on the parsed type — raw-YAML only, resolved into `body` at
  parse, like `StepDef`).
- `ArtifactData` gains `approvals?: Record<string, number>` (judge name →
  approved version).
- `StepDef` gains the `judges?: string` marker (mirrors `calls?: string`,
  `types.ts:215`).
- `GraphNodeState` gains `'submitted'` (`types.ts:353`) — see model.ts below
  for why this is load-bearing.

**defs.ts**
- `parseProduces` (`defs.ts:138`) parses the `judges:` list; **`baseDir` must
  be threaded in** (it doesn't receive it today) so `bodyFile` resolves and
  reads eagerly, mirroring the step-level rules from #38 (`defs.ts:605-626`).
- Hard errors: judge without `name`; neither or both of `body`/`bodyFile`;
  duplicate judge names on a stem; `judges:` on a non-singleton produce (Q3);
  `judges:` on an input.
- Synthesize one **full `StepDef`** per entry, using the `calls:` template
  (`defs.ts:562-598`) as the shape but with these deltas: `judges: <stem>`
  marker; `consumes: [stem, ...(inputs ? producerInputs : [])]` (NOT `[]` —
  authority flows from consume edges via `assertAuthority`); `produces: []`;
  real resolved `body` + `model`; `cadence`/`maxRunsPerDay` from the entry or
  step defaults; `invalidates: []` (vestigial — audit confirms it is parsed
  but never read at runtime; authority is `consumes`-based only).
- `ALLOWED_IS` (`defs.ts:227`) gains `'submitted'` so user-authored
  `invariants:` can reference it.

**model.ts**
- `isGreen` stays `=== 'green'` (`model.ts:130`) — `submitted` is not green by
  construction; audit every debt/settled classifier touching acceptance.
- `eligibleFirings`: the `step.judges` branch (§7.1).
- `allArtifactsGreen` (`model.ts:190`) and `workflowStatus` done
  (`model.ts:750`) switch from `DEBT_STATES` to `OUTSTANDING_STATES` —
  otherwise a workflow with only `submitted` artifacts reads as **done**
  (confirmed gap).
- Cascade (`model.ts:561-579`): treat `submitted` like non-terminal green
  (input move → cascade reject → producer re-arms), with **no**
  `judgmentRejects` bump (§4.3).
- `canonicalKey` (`model.ts:1672`): `vRank` is currently
  `version===0 ? 0 : green ? 1 : 2` — without a distinct rank, `submitted`
  aliases with `rejected` and the model checker's BFS silently under-explores
  the state space. Give `submitted` its own rank.
- `buildGraph` node classifier (`model.ts:1069-1108`): add an explicit
  `submitted` branch — today an unmatched state falls through to the implicit
  "all green" case and a submitted artifact would **render as a green node**
  (confirmed gap).
- `applyOpInMemory` / `settleInMemory` (`model.ts:1299-1436`) mirror every new
  engine transition field-by-field; the differential conformance test
  (`test/check.test.ts`) stays green.

**engine.ts**
- `green()` (`engine.ts:618`) routing by artifact state and actor:
  - producer commit on a judged stem → `submitted` (not `green`), `approvals`
    cleared, version bumps (§4.4), schema still refuses first (§4.1);
  - judge-step actor on a `submitted` stem → record ledger slot; when every
    declared judge has approved this version → `submitted → green`. Terminal
    (`terminal: true`) is applied **here**, at approve — today `green()` sets
    it at producer commit (`engine.ts:663`), so this ordering is new code
    (§4.8);
  - human actor on a `submitted` stem → full bypass (§4.11), ledger
    irrelevant.
- `reject()` (`engine.ts:804`) — cannot be reused unmodified (audit): it
  unconditionally sets `rejected` with no knowledge of `submitted` as a
  source state or once-per-submission semantics. Extend: judge reject on
  `submitted` → `rejected`, `judgmentRejects++` once per submission, reason
  `kind: 'judgment'` (keeps `isHeld` unaffected — it keys on
  `'invalidated-irreversible'`, `model.ts:162`).
- CAS (§4.6): the run fingerprint already records consumed-input versions at
  claim (§12.2), so a judge order already carries the submitted version it
  judged. But `casCheck` (`engine.ts:1266`) requires inputs to be **green** —
  judge commits need a variant: "judged stem still `submitted` at the
  fingerprinted version", else the verdict is born-rejected and the judge
  re-fires. Covers both the resubmit race and the sibling-judge race.
- `retry()` (`engine.ts:873`) — resets acceptance + both counters today; must
  **also clear `approvals`** (§4.11). Not automatic.
- Order failure: nothing to build — judges flow through `claim()`/`reap()` by
  §7.1, so §4.10 is satisfied structurally. The PR's review test: **the only
  judge-specific engine code is the three deltas in §3.2.**

**store.ts**
- Additive migration following the existing pattern (`store.ts:330-356`):
  `ALTER TABLE artifact ADD COLUMN approvals TEXT` (JSON), map in
  `ArtifactRowRaw`/`mapArtifact` (`store.ts:143-180`), add to `putArtifact`
  column lists (`store.ts:477-509`), bump `SCHEMA_VERSION` (`store.ts:131`,
  currently `'4'`). Acceptance cast accepts `'submitted'`.

**cli.ts**
- `status` (`cli.ts:385`): `submitted` surfaces as outstanding (falls out of
  `OUTSTANDING_STATES`); render pending-judge names.
- `show` (`cli.ts:408`): acceptance renders automatically once persisted; add
  `approvals` display.
- `trace` (`cli.ts:413`): judge runs already appear as ordinary step runs
  (they are steps); add per-judge sign-off to the artifact biography.
- `tick`: judge orders appear in `TickResult.orders` automatically via §7.1.
- `graph` (`cli.ts:554`): renders via the new `GraphNodeState`.

**docs + example + tests**
- Promote this proposal to `design.md §24` (new section — no slot is reserved
  today); update README mental model + YAML surface.
- `delivery.yaml` stays as-is (§1.2). Add a new example workflow exercising
  `judges:` (the §5 researcher/report shape).
- e2e coverage: all-approve → green; one-reject → rebuild → resubmit →
  re-judge (ledger cleared); stall at `maxAttempts`; cascade discard without a
  strike (§4.3); the §4.6 stale-verdict race (both variants); a dead judge
  order reaped and re-fired without a `judgmentRejects` bump (§4.10); human
  `green` bypassing pending judges and human `retry` clearing the ledger
  (§4.11); terminal artifact greened-terminal only at approve (§4.8); judge
  throttles honored via `applySchedule` (§7.1). Plus: conformance test green,
  model checker exploring `submitted` as a distinct rank.

### Conduct brief
With all decisions locked (§6), this proposal becomes **one conduct brief
(J1)** in `~/code/.conduct-briefs/`, in the established format (Goal /
Required behavior+invariant / Tests to add / Verify `npm run check` / Out of
scope), driven through the dev-conduct delivery pipeline.
