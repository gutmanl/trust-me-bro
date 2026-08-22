# The verdict comparison — PROMPT-05's ship gate

This directory holds the recorded output of `scripts/compare-prompt-verdicts.ts`:
the measurement that decides whether rubric prompt **v1.2.0** may become a new
project's default. Nothing here is loaded by the test suite, and nothing here is
a cassette.

> **Nothing in this directory exists until the harness has been run.** It is
> written on the machine that holds the real project registers, by a human, with
> a logged-in agent CLI and real subscription quota. A fresh clone, CI and a
> cloud session all see an empty directory, and that is the correct state until
> the run happens.

## What the harness does

It generates verdicts for a frozen corpus of real claims under four different
prompt configurations ("arms") and counts how many claims change their verdict
between them. The question it answers is the one Success Criterion 1 asks: did a
milestone about _presentation_ move the _verdicts_?

## The four arms, in run order

| Arm                 | Rubric template    | Attribution template | Paired against                 |
| ------------------- | ------------------ | -------------------- | ------------------------------ |
| `noise-floor`       | v1.1.0             | v1.1.0               | the corpus's recorded verdicts |
| `v1.1.0-baseline`   | v1.1.0             | v1.1.0               | the corpus's recorded verdicts |
| `v1.2.0-ordering-a` | v1.2.0             | v1.2.0               | `v1.1.0-baseline`              |
| `v1.2.0-ordering-b` | v1.2.0-plain-first | v1.2.0-plain-first   | `v1.1.0-baseline`              |

**The noise floor runs first, and it can stop the rest.** There is no temperature
and no seed anywhere in the adapter layer, so re-running v1.1.0 against itself
also flips verdicts. Without that number the gate cannot tell "the prompt moved
it" from "the model is nondeterministic". If the floor alone exceeds the
tolerance rule the harness writes the report and exits without running the
remaining three arms — spending them against an uninterpretable baseline is
waste, and what to do instead is 03-05's decision, not a script's.

Each arm **renders and validates at its own prompt version**. The v1.1.0 arms are
judged against the single-reasoning contract and the v1.2.0 arms against the
two-layer one, so the floor measures the model rather than a contract mismatch.
Every record names the version and the contract it was judged under, so the
artifact can be audited for exactly that mistake after the fact.

Ordering B carries no SHA pin — it is the unpinned variant, addressed by naming
its version string. Its mechanical rules come from the v1.2 rule set, whose
`claim_types` block is byte-identical to v1.1's, so the arms differ in exactly
one variable: the prose template.

## How to invoke it

Run from the `software/` directory. Both loaders resolve their data files from
the process working directory.

```bash
# Prerequisite, always, before spending anything: a failed login discovered on
# call 40 wastes 39 calls.
npx tsx scripts/adapter-smoke.ts claude

# All four arms, full N.
npx tsx scripts/compare-prompt-verdicts.ts claude

# The noise floor alone at a reduced sample size.
npx tsx scripts/compare-prompt-verdicts.ts claude --arm noise-floor --n 10

# What it would do, and what the gate line looks like — no CLI call, no quota.
npx tsx scripts/compare-prompt-verdicts.ts --dry-run
npx tsx scripts/compare-prompt-verdicts.ts --help
```

It needs `tests/corpus/verdict-fixtures.json`, which
`scripts/extract-verdict-fixtures.ts` freezes out of the real registers.

## How to resume

**A rate-limit pause mid-run is expected, not exceptional.** A rate-limited
attempt never consumes retry budget and never fails a job, and the harness
appends every result to `results.ndjson` as it arrives rather than buffering to
the end. On restart it reads that file and skips every
`(arm, claim, job kind, evidence)` unit already recorded.

So: **re-run the same command.** Nothing is recorded twice, no work is repeated,
and a three-hour run survives being interrupted. Exit code `3` means the run
paused and everything up to that point is on disk.

## The files

| File             | What it is                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `results.ndjson` | One JSON object per line, one line per job. Append-only **run output**, not a cassette: nothing replays it and nothing in the test suite reads it. A partial file is still analysable, and the report can be regenerated from it alone with `--dry-run`. |
| `REPORT.md`      | The generated report. Gating section first, then the reported-but-not-gating numbers, then the side-by-side prose dump.                                                                                                                                  |

Each NDJSON line carries the arm, the claim and evidence ids, the job kind, the
prompt version and the template digest **actually used**, the backend and the
model it reported, the raw output, the derived verdict, the contract-validation
outcome and the attempt it passed on, the latency, and the string
`joinReasoningRoles` would have persisted.

Two fields on every rubric line rather than one: **`verdict_pre_cap`** (the
model's own verdict) and **`verdict_post_cap`** (after
`combineCalibrationResult`). The mechanical cap sits between them and is
untouched by this phase, so it absorbs part of any upward drift — a single
number would hide exactly the thing being measured.

## The gate line

`REPORT.md` states each arm's result twice: once in prose for the human, and once
as a machine-readable line the harness emits itself.

```
GATE_RESULT: PASS arm=v1.2.0-ordering-a flips=1/30 two_step=0
```

Prefix, verdict word, arm name, paired flip count over N, two-step-move count.
03-05 greps for `^GATE_RESULT: PASS arm=<chosen arm>` before it edits
`DEFAULT_RUBRIC_VERSION`.

**Do not hand-edit these lines.** Everything else in the ship gate is already
mechanical — the report exists, it quotes the pre-registered rule verbatim,
03-05's own test pins the constant's post-state. _This arm passed_ was the one
link carried only by a human having read a paragraph, and one printed line closes
it. A line edited to read `PASS` because the prose beside it argues for one is
the exact substitution the gate exists to prevent. An arm that did not run has no
line, and the report says so in words.

A `FAIL` with `flips=0/0` is not a tolerance breach: it means the arm ran but had
nothing to compare against, and the report says so beside the table.

## The tolerance rule

Pre-registered — written into the harness before any data existed:

> at most 2 of 30 claims (7 percent) change their persisted `calibration_result`,
> and no claim moves between `licensed` and `pending_adjudication`

It is evaluated on the **persisted** (post-cap) verdict, and the **paired
per-claim flip count** is the statistic. The distribution is reported but does not
gate: at N = 30 two arms can show identical `licensed` / `weakened` /
`pending_adjudication` counts with every individual claim swapped. A two-step move
fails the arm outright, because moving between licensed and parked is
qualitatively different from a one-step move.

The rule is applied in its ratio form so a reduced-N arm is still evaluable, and
the report states the reduced N in the same place as the number.

**Never adjust this rule after seeing the data.** A tolerance chosen afterwards is
a description of the data wearing a rule's clothes. A breach is reported as a
breach and routed to 03-05's decision checkpoint.

## What is reported but does not gate

The first-attempt contract pass rate per arm (the calibration input for the
plain-layer character cap), the glossary quote-refusal rate per arm, the
attribution `relation_type` flips, prose length per layer, hedge-word hits per
layer, and the plain/technical token overlap. No readability score is computed at
all.

The hedge count comes from a word list defined in the harness itself. It is a
diagnostic and never a gate: a word-list lint false-positives on legitimate
German, and a retry loop on grammatical prose is worse than its miss rate. The
quote-refusal rate reproduces the display tier's own refusal condition and is
reported only — it does not license relaxing that logic.

Last and most important, `REPORT.md` ends with a **side-by-side prose dump**,
v1.1.0 beside each v1.2.0 arm for every claim. That is the input to the human
diff review, and it is the only check that catches semantic overstatement — a
plain layer asserting more than the technical layer supports. Nothing mechanical
replaces it.

## What the harness does not do

It opens no register store and performs no register write of any kind. It calls
backends directly against a throwaway directory under the OS temp dir, the way
`scripts/adapter-smoke.ts` does, and never targets a real project directory. A
register write from a measurement script would be an unattributed entry in an
append-only, hash-chained log.

It is also never reachable from `npm run check`: it lives under `scripts/`, has
no npm script entry, and is invoked through `tsx` directly.
