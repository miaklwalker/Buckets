# @michaelrwalker/buckets — Skill Spec

`@michaelrwalker/buckets` is a rule engine for sorting items into named
buckets (`BucketEngine`) or running named side effects (`ActionEngine`),
using boolean rules over named, possibly-async conditions. It exists to
replace multi-input decision logic — nested if/ternary/switch chains keyed
on several fields at once — with named, reusable, type-checked conditions
and rules.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| Modeling decisions | Turning ad hoc boolean logic into named conditions, gated preconditions, and named combinations | model-decision-logic |
| Sorting and dispatch | Declaring buckets over conditions, processing a batch, reading the report | sort-items-into-buckets |
| Running effects | Running named side effects on qualifying items, independently of one another | run-independent-actions |
| Operating at scale | Async conditions, concurrency tuning, condition audits, live progress | tune-async-and-scale |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| --- | --- | --- | --- | --- |
| Model decision logic with conditions | core | Modeling decisions | defineInput, defineCondition, when, defineComputedCondition, AND/OR/NOT/ONLY, definedIn/presentIn/pathIn | 7 |
| Sort items into buckets | core | Sorting and dispatch | defineBucket, process/processOne, BucketReport, missingCombinations(), type narrowing | 5 |
| Run independent actions | core | Running effects | defineAction, ActionEngine.process/processOne, ActionReport | 3 |
| Tune async conditions and scale | core | Operating at scale | async checkFn, concurrency, processConditions(), onProgress/liveConditionReport() | 5 |

## Failure Mode Inventory

### Model decision logic with conditions (7 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Confusing NAND with NOR | HIGH | docs/guides/boolean-logic.md | — |
| 2 | Writing manual if/ternary/switch chains instead of using the engine | CRITICAL | maintainer interview | — |
| 3 | Adding a condition after the first bucket or computed condition | HIGH | modules/engine.ts; docs/guides/conditions.md | — |
| 4 | Passing a computed condition's name to ONLY | MEDIUM | docs/guides/computed-conditions.md; docs/reference/combinators.md | — |
| 5 | Inverting an AND-of-facts with NOT(AND(...)) expecting it to mean "everything is valid" | CRITICAL | maintainer interview; docs/guides/boolean-logic.md | — |
| 6 | Optional-chaining a nested checkFn instead of gating on an existence condition with when | MEDIUM | maintainer interview; docs/guides/preconditions.md | — |
| 7 | Hand-writing an existence type guard instead of using definedIn/presentIn/pathIn | MEDIUM | docs/reference/predicates.md | — |

### Sort items into buckets (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Treating buckets as a partition of the batch | CRITICAL | docs/overview.md; docs/guides/buckets.md | — |
| 2 | Branching a shared engine variable instead of using clone() | HIGH | docs/guides/cloning.md | — |
| 3 | Expecting NOT(...)/plain-boolean buckets to narrow their item type | MEDIUM | docs/guides/narrowing.md; docs/reference/combinators.md | — |
| 4 | Calling process()/processOne() before any bucket is defined | MEDIUM | docs/reference/bucket-engine.md | — |
| 5 | Assuming BucketEngine.processOne doesn't throw, like ActionEngine's does | MEDIUM | docs/reference/bucket-engine.md; docs/reference/action-engine.md | run-independent-actions |

### Run independent actions (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Assuming one action's failure poisons another action | HIGH | docs/guides/actions.md | — |
| 2 | Reaching for the wrong engine (ActionEngine vs BucketEngine) for the task | MEDIUM | maintainer interview (provisional — new library) | sort-items-into-buckets |
| 3 | Assuming ActionEngine.processOne throws like BucketEngine's does | MEDIUM | docs/reference/action-engine.md | sort-items-into-buckets |

### Tune async conditions and scale (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Using an async condition for real network I/O with retries/backoff | HIGH | docs/guides/async-and-performance.md | — |
| 2 | Setting concurrency: Infinity expecting it to be faster or safer | MEDIUM | docs/guides/async-and-performance.md | — |
| 3 | Reusing one liveConditionReport() callback across two concurrent batches | LOW | modules/report.ts; docs/reference/bucket-engine.md | — |
| 4 | Assuming onProgress fires in input order, not completion order | LOW | docs/reference/process-output.md | — |
| 5 | Calling missingCombinations() past the 16-condition cap | LOW | docs/reference/bucket-engine.md | model-decision-logic |

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Ordering strictness vs iterative prototyping | model-decision-logic ↔ sort-items-into-buckets | Adding a condition after buckets exist throws; an agent may fight the ordering instead of clone()-ing or front-loading conditions |
| BucketEngine vs ActionEngine mental models | sort-items-into-buckets ↔ run-independent-actions | A "categorize and notify" task can lead to picking the wrong engine for half the problem |
| Type-narrowing honesty vs quick predicates | model-decision-logic ↔ sort-items-into-buckets | Defaulting to un-narrowed predicates loses the library's main type-level benefit in discriminated-union cases |
| Async escape hatch vs bounded concurrency | model-decision-logic ↔ tune-async-and-scale | Treating I/O-shaped needs as async conditions fights concurrency defaults tuned for cheap lookups |

## Cross-References

| From | To | Reason |
| --- | --- | --- |
| model-decision-logic | sort-items-into-buckets | ONLY and type predicates propagate into bucket types; design conditions with that in mind |
| sort-items-into-buckets | run-independent-actions | Independent-effects tasks belong on ActionEngine instead |
| tune-async-and-scale | model-decision-logic | when's skip behavior is often cheaper than making a condition async |
| run-independent-actions | sort-items-into-buckets | Similar-looking report shapes mean different things for independence guarantees |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| --- | --- | --- |
| model-decision-logic | — | — |
| sort-items-into-buckets | — | — |
| run-independent-actions | — | — |
| tune-async-and-scale | — | — |

No skill has 3+ backends/adapters/drivers, and no topic exceeds 10 distinct
operators or option shapes (the four combinators are the densest surface,
already fully covered by docs/reference/combinators.md).

## Remaining Gaps

| Skill | Question | Status |
| --- | --- | --- |
| run-independent-actions | Which AI-agent-specific mistakes are actually observed once the library sees real usage? (New library — maintainer had no data at interview time.) | open |
| tune-async-and-scale | Has onProgress/liveConditionReport() shipped in a release yet? (Uncommitted working-tree changes at scan time.) | open |

## Recommended Skill File Structure

- **Core skills:** all four — model-decision-logic, sort-items-into-buckets, run-independent-actions, tune-async-and-scale (the library is framework-agnostic; there are no framework-specific skills)
- **Framework skills:** none
- **Lifecycle skills:** none — the maintainer described the library's use as flat ("identify decisions, build buckets or effects"), not a multi-stage journey warranting its own skill
- **Composition skills:** none — the one composition point (Standard Schema validators) is covered inline in model-decision-logic rather than as its own skill
- **Reference files:** none needed — no skill has a dense-enough surface (>10 patterns) or 3+ subsystems to warrant a separate reference file

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| --- | --- | --- |
| Zod / Valibot / ArkType / Effect Schema (via Standard Schema) | defineInput(schema) | No — covered inline in model-decision-logic |
