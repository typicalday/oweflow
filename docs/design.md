# oweflow — design

A self-contained distillation of the dataflow-workflow-engine spec, restricted to
what the engine actually implements. The `§N` markers match the references in the
source (e.g. `model.ts` cites `§6`, `engine.ts` cites `§12`). Read it once and the
code reads as a transcription of these rules.

## §1 The inversion

A step has no status. It has **debts**. A step is eligible to run because of the
*state of its artifacts*, never because an orchestrator marked it ready. The
scheduler is therefore a pure function `state → eligible firings`; everything
else (knock-backs, fan-in, downstream invalidation) is a consequence of that
function rather than a feature bolted beside it.

## §2 Nodes

- **§2.1 Artifact** — a named value a loop produces and others consume. Carries an
  `acceptance` state, a monotonic `version` (0 until first green, +1 each green
  re-production), an optional captured `value` (a handle, meaningful only when
  green), a `fingerprint` (the versions of its inputs at build time), an
  append-only `reasons` thread, and two stall counters — `judgmentRejects` (§6)
  and `schemaRejects` (§18).
- **§2.2 Task / lease** — the claimable unit of work-in-flight. One per
  `(loop, key)`; `key` is `""` for plain/reduce/collection firings and the
  element path for a map firing.
- **§2.3 Run** — the audit/budget record created when a task is claimed; holds the
  claim's input **fingerprint** for the commit CAS.

## §3 The firing rule

A loop's eligibility depends on its consume mode:

- **plain** `x` — eligible when it owes an output and every plain input is green.
- **map** `src[$i]` — one independent firing per collection element; the firing
  for element *i* is eligible when `src[i]` is green and the per-element output
  `src[i].…` is a debt. Concurrency is capped by the loop's `parallel`.
- **reduce** `src[*]` — a single firing, eligible only when the collection's
  **seal** is green **and** every non-retracted bare member is green. It gates on
  the *members*, not on any per-element map output — so a map and a reduce over
  the same collection are concurrent branches, and the reduce's lever over a bad
  element is `retract`, not a verdict.

## §4 Reason threads

Every invalidating action (`reject`, `schema-reject`, `retract`, `skip`,
`reopen`, `retry`, `born-rejected`) appends a
`ReasonEntry { at, action, kind, by, text, fromVersion }`
to the artifact. The thread is append-only and travels with the artifact, so the
next order to (re)produce it carries the full feedback history in `owes[].reasons`.

## §5 Lifecycle states

The five `acceptance` states (§11.3) partition into:

- **debt** = `{ owed, rejected }` — a producer owes work.
- **settled** = `{ green, retracted, skipped }` — never reads as "stuck".

`owed` is declared-but-unbuilt or re-armed. `green` is accepted. `rejected` is
built-then-judged-unfit (or structurally re-armed). `retracted` is a consumer
dropping a collection member — **terminal**, leaves the `[*]` set. `skipped` is a
producer declining its own output on a dead branch — settled but re-armable if
its inputs revive.

## §6 Liveness — stalls

Three reject **kinds** (§11.9) are tracked:

- **judgment** — a consumer's verdict that the artifact is wrong. Bumps
  `judgmentRejects`.
- **validation** — a produced value failed the artifact's declared JSON Schema;
  the engine refused the commit (§18). Bumps a *separate* `schemaRejects`
  counter.
- **structural** — engine bookkeeping (a forward-cascade re-arm, a born-rejected
  commit). Bumps **neither** counter.

A counter rides on the *judged artifact*. Once `judgmentRejects ≥ maxAttempts`
(or `schemaRejects ≥ maxSchemaFailures`, §18) the artifact is **stalled**: it
remains a debt, but `eligibleFirings` stops producing any firing that would
rebuild it. The loop has demonstrably failed; a human must intervene.
`isStalled(a, cap)` and `isSchemaStalled(a, cap)` are the predicates;
`status.debts[].stalled` surfaces either; `blocked` deliberately excludes a
stalled loop (it isn't waiting on an input — it's out of attempts).

Clearing a stall:
- **`retry`** — reset *both* counters to 0 and re-owe the artifact (optionally
  with fresh guidance appended as a `retry` reason). The only path that resets
  the counters.
- **`retract`** — drop the member (collection elements).

## §7 The forward cascade (level-triggered)

A green output is green **only while** every input it consumed is still green and
unmoved. After any mutation, `settle()`:

1. **materializes** owed outputs of fired loops, and
2. runs the cascade to a fixpoint — any green artifact whose fingerprint no longer
   matches its inputs' current versions (an input moved, or went non-green) falls
   back to a **structural** `rejected` (a re-arm), which itself may invalidate
   *its* dependents. Skips propagate to plain dependents; a skipped branch
   re-arms when its inputs revive; a retracted element tombstones its map child.

Because it is level-triggered (a function of current state) rather than
edge-triggered (reacting to the change event), the cascade is idempotent and
order-independent — re-running `settle()` on a healthy graph yields no ops.

## §11 Collections

- **§11.1 produce `src[]`** — the producer `emit`s an unknown number of bare
  elements (`src[0]`, `src[1]`, …), then `seal`s. The seal is itself an artifact
  (`sealOf = src`); the collection is "complete" when the seal is green.
- **§11.2 map `src[$i]`** — fan-out: one firing per element, `${INDEX}` bound.
- **§11.x reduce `src[*]`** — fan-in: see §3.
- **§11.3** — the five-state lifecycle (above).
- **§11.8** — the forward cascade (above).
- **§11.9** — the three reject kinds (above): judgment, validation (§18), structural.

## §12 Concurrency

- **§12.1 versions** — each artifact carries a monotonic version; a green bumps it.
- **§12.2 commit-fingerprint CAS** — when a run is claimed it records the version
  of every input it consumed (its `fingerprint`). At commit time the engine
  re-reads those inputs; if any moved or is no longer green, the commit is
  **born-rejected** (a structural reject with a `born-rejected` reason) instead of
  landing a green that already rests on stale inputs. This makes concurrent
  advancement safe without locking the graph: two workers can race, and at most
  one lands green; the loser is re-armed with an honest reason.

## §15 Completion

- **§15.1** — a workflow is `done` when no artifact is in a debt state.
- **§15.2 destructive completion** — a loop marked `terminal: true` produces an
  output whose green is irreversible (a merge, a publish). Once green it is never
  re-armed by the forward cascade, even if an upstream input later moves. This is
  the one place the level-trigger is deliberately overridden, because the side
  effect cannot be taken back.

## §17 Derived status

`workflowStatus` is computed from artifact state on every call and never stored:

- `done` — no debts remain.
- `debts[]` — each non-green-owing artifact with its `acceptance`, `kind`
  (`judgment` / `validation` / `structural` / `unbuilt`), `stalled` flag, and
  latest `reason`.
- `eligible[]` — the firings that could run right now.
- `blocked[]` — loops that owe something but whose inputs aren't all green, with
  the specific non-green inputs holding them back (stalled loops excluded).

This is the operator's whole view, and because it is a pure read it can never
drift from the real state the engine acts on.

## §18 Schema validation

The engine is domain-neutral — it doesn't know what a `plan` *means*. But a
wiring may still want to guarantee its *shape*: that a `plan` is an object with
the fields its consumers expect, that an emitted `source` carries a `url`. An
artifact declaration (a `produces` entry or an `inputs` entry) may therefore
carry a `schema:` — a full **JSON Schema draft 2020-12** document, validated by
`@cfworker/json-schema` (zero codegen, near-zero transitive deps). A schema that
is itself malformed fails fast at **load** (`assertValidSchema` in defs.ts runs a
trial validation to force lazy `$ref` resolution), never at first commit.

**Enforcement is at commit time, and it is a refusal — not a verdict.** Shape is
the engine's business; *meaning* stays a consumer's `reject` (§6 judgment).

- **`green` (singleton / map output).** After the commit CAS (§12.2) passes, the
  value is validated against the produce's schema. On failure the green is
  refused: the artifact is written back `rejected` with `schemaRejects + 1`, a
  `schema-reject` reason (kind `validation`) carrying the summarized violations
  is appended, and the commit returns `outcome: 'schema-rejected'` **with the
  `issues[]`** — but the run/lease is *not* closed. The same worker can correct
  the value and re-`green` on the same open run; the per-artifact counter is the
  only bound, so a re-green can't bypass the stall.
- **`emit` (collection).** Every element is validated against the collection's
  schema *before any element is written*. One bad element refuses the **whole**
  emit atomically (nothing accretes), bumps the seal's `schemaRejects`, and
  returns `schema-rejected`. This stops a producer half-filling a collection with
  malformed members.
- **`provide` / `create` (inputs).** A `seedOwed` input supplied via `provide`,
  or an input supplied at `create`, is validated against the input's schema
  before it is seeded green. A violation is a hard error (non-zero CLI exit) —
  there is no producer to re-arm, so refusing outright is the only honest move.

**Liveness (§6 parallel).** Schema failures ride a counter *separate* from
judgment rejects, because they are categorically different — the engine refusing
a malformed value, not a consumer disagreeing with a sound one. Once
`schemaRejects ≥ maxSchemaFailures` the artifact is **schema-stalled**
(`isSchemaStalled`): it stays a debt but stops re-arming, exactly like a §6
judgment stall. The two caps (`maxSchemaFailures`, default 5; `maxAttempts`) are
tuned independently, a `maxSchemaFailures` of 0 disables the schema stall, and a
single `retry` resets *both* counters. `validateValue` is total — a schema that
somehow throws at validate time (an unresolved `$ref`, a stack overflow on a
self-referential schema + deeply nested value) is folded into an ordinary
validation failure rather than crashing the commit, and the surrounding
transaction rolls back cleanly.

**Trust boundary.** A schema is *operator-authored configuration* loaded from the
trusted `--defs` directory; the value it validates comes from a worker. The
engine assumes the schema itself is benign — in particular, a `pattern` /
`patternProperties` regex is compiled with `new RegExp(…, 'u')`, so a
catastrophically-backtracking pattern is an operator foot-gun (it could stall the
single-threaded engine on an adversarial value), not an attacker lever. Keep
`pattern`s linear. Worker-supplied *values* need no such trust: a malformed value
is just a schema-reject, bounded by `maxSchemaFailures`, and CLI values are
additionally bounded by the OS argument limit.
