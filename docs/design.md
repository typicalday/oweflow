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
  append-only `reasons` thread, and the `judgmentRejects` counter.
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

Every invalidating action (`reject`, `retract`, `skip`, `reopen`, `retry`,
`born-rejected`) appends a `ReasonEntry { at, action, kind, by, text, fromVersion }`
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

Two reject **kinds** (§11.9) are tracked separately:

- **judgment** — a consumer's verdict that the artifact is wrong. Bumps
  `judgmentRejects`.
- **structural** — engine bookkeeping (a forward-cascade re-arm, a born-rejected
  commit). Does **not** bump the counter.

The counter rides on the *judged artifact*. Once `judgmentRejects ≥ maxAttempts`
the artifact is **stalled**: it remains a debt, but `eligibleFirings` stops
producing any firing that would rebuild it. The loop has demonstrably failed; a
human must intervene. `isStalled(a, cap)` is the predicate; `status.debts[].stalled`
surfaces it; `blocked` deliberately excludes a stalled loop (it isn't waiting on
an input — it's out of attempts).

Clearing a stall:
- **`retry`** — reset `judgmentRejects` to 0 and re-owe the artifact (optionally
  with fresh guidance appended as a `retry` reason). The only path that resets the
  counter.
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
- **§11.9** — the two reject kinds (above).

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
  (`judgment` / `structural` / `unbuilt`), `stalled` flag, and latest `reason`.
- `eligible[]` — the firings that could run right now.
- `blocked[]` — loops that owe something but whose inputs aren't all green, with
  the specific non-green inputs holding them back (stalled loops excluded).

This is the operator's whole view, and because it is a pure read it can never
drift from the real state the engine acts on.
