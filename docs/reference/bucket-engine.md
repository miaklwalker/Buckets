---
title: "BucketEngine"
description: "The full method reference for the BucketEngine class: definitions, processing, cloning and introspection."
---

```ts
import { BucketEngine } from "@michaelrwalker/buckets";
```

`BucketEngine` is the only class the package exports for building an engine.
It's generic over four type parameters: the input type, the map of
condition names to what each proves, the map of bucket names to their item
types, and the map of computed condition names, all of which are inferred
as you call the `define*` methods. You never write them out by hand.

## `new BucketEngine()`

Takes no arguments. Every engine starts empty; call `defineInput` before
anything else.

## `defineInput(schema)` / `defineInput<TShape>()`

```ts
defineInput<TSchema>(schema: StandardSchemaV1<unknown, TSchema>): BucketEngine<TSchema, ...>;
defineInput<TShape>(): BucketEngine<TShape, ...>;
```

Describes the items being sorted. Call it first, before any condition.

- `.defineInput(schema)` infers the item type from a
  [Standard Schema](https://standardschema.dev)'s **output**, and validates
  every item at runtime. A schema that transforms means conditions and the
  report both see the transformed value.
- `.defineInput<Product>()` is types only. Nothing is validated, so
  `report.errors` can then only contain condition failures.

Throws a `BucketError` if called twice, if called after any condition has
been defined, or if the argument is neither a Standard Schema nor omitted.

## `defineCondition(spec)` / `defineCondition(spec, checkFn)`

```ts
defineCondition<TName extends string, TWhen, TCheck>(
  spec: { name: TName; when?: TWhen; checkFn: TCheck },
): BucketEngine<TInput, TGuards & { [K in TName]: GuardOf<TCheck> & NarrowOf<TWhen, TGuards> }, ...>;

defineCondition<TName extends string, TWhen, TCheck>(
  spec: { name: TName; when?: TWhen },
  checkFn: TCheck,
): BucketEngine<TInput, TGuards & { [K in TName]: GuardOf<TCheck> & NarrowOf<TWhen, TGuards> }, ...>;
```

Registers a named predicate over the item.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes part of the engine's type. Must be unique: checked against both conditions and computed conditions. |
| `when` | see below | Optional. Gates `checkFn` on a precondition — see the Preconditions guide. |
| `group` | `string` | Optional, purely descriptive. Plays no role in evaluation — it only labels the condition's row in a `processConditions()` report, e.g. `group: "existence check"`. |
| `checkFn` | `(item: TInput) => boolean \| Promise<boolean>` | May be async. The return value is coerced with `Boolean()`. Throwing sends that item to `report.errors`. Write it as `(item): item is X => ...` to also narrow the buckets built from it. |

`checkFn` may be a property alongside `when`, or a second argument — the
second argument form is the only one that gets both autocomplete on a
compound `when` (`({ AND }) => AND(...)`) *and* narrowing at once; see the
Preconditions guide for why.

`when` accepts any of: a bare condition name (`() => "hasProduct"`), an
`AND`/`OR`/`NOT` expression called as a value (`AND("hasProduct", "isActive")`,
narrows, no autocomplete), or a callback bound to this engine's condition
names (`({ AND }) => AND(...)`, autocompletes, doesn't narrow when `checkFn`
is a sibling property). Whichever form, `checkFn` is skipped and the
condition recorded `false` when the precondition doesn't hold. Throws a
`BucketError` if `when` names a condition not yet defined.

Whatever a gated condition's `when` proved is always folded into its own
guard — `GuardOf<TCheck> & NarrowOf<TWhen, TGuards>`, not `GuardOf<TCheck>`
alone — regardless of whether `checkFn`'s own predicate mentions it. This is
what lets a chain of preconditions be gated on just the nearest link
(`when: () => "hasWeight"`, not `when: () => AND("hasProduct", "hasWeight")`)
without losing what an earlier link in the chain proved; see the
Preconditions guide.

Every condition runs once per item. Conditions with no `when` — or whose
`when` only names other ungated conditions — run concurrently, in one wave;
a `when` that names a condition from a later wave waits for it, so a chain
of preconditions is staged rather than all fired at once. Must be defined
before the first computed condition and the first bucket. Throws a
`BucketError` for: an empty name, a missing `checkFn`, a duplicate name, or
a condition defined too late in the chain.

## `defineComputedCondition(spec)`

```ts
defineComputedCondition<TName extends string, TOperand>(
  spec: { name: TName; checkFn: (logic) => TOperand },
): BucketEngine<TInput, TGuards, TBuckets, TComputed & { [K in TName]: NarrowOf<TOperand, TGuards> }>;
```

Names a boolean combination of conditions defined so far, and makes that name
usable anywhere a condition name is, including in a later computed
condition and in `report.conditions`.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Joins the condition namespace. Must be unique across conditions and computed conditions. |
| `checkFn` | `(logic: { AND, OR, NOT, ONLY }) => expression` | Bound to every condition defined so far. Return an expression or a bare condition name. |

Must be defined after every plain condition and before the first bucket.
`ONLY` inside a computed condition still only accepts plain condition names.
Throws a `BucketError` for the same category of mistakes as `defineCondition`,
plus a rule referencing an unknown condition, or `ONLY` given a computed
condition's name.

## `defineBucket(spec)`

```ts
defineBucket<TName extends string, TOperand>(
  spec: { name: TName; checkFn: (logic) => TOperand },
): BucketEngine<TInput, TGuards, TBuckets & { [K in TName]: BucketItem<TOperand, TGuards, TInput> }, TComputed>;
```

Declares a bucket as a boolean rule over the conditions.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes a key of `report.buckets`. Must be unique: the only uniqueness rule a bucket has. |
| `checkFn` | `(logic: { AND, OR, NOT, ONLY }) => expression` | Bound to this engine's condition names. Return an expression or a bare condition name. |

Buckets may be defined in any order relative to each other, but only after
every condition and computed condition. Throws a `BucketError` for a missing
or duplicate name, a missing `checkFn`, or a rule referencing an unknown
condition.

## `clone()`

```ts
clone(): BucketEngine<TInput, TGuards, TBuckets, TComputed>;
```

Returns an independent engine holding everything defined so far, at the same
type. The copy is shallow: conditions and rules aren't deep-cloned, since
neither is ever mutated after registration, but the two engines are
otherwise fully independent: defining something on one leaves the other
alone. See the Cloning and Reuse guide.

## `process(items, options?)`

```ts
process(
  items: readonly TInput[],
  options?: { concurrency?: number },
): Promise<BucketReport<TInput, TGuards & TComputed, TBuckets>>;
```

Sorts a batch. Requires at least one bucket and an input to have been
defined; throws a `BucketError` immediately if not.

- Validates each item against the schema (if one was given via
  `defineInput`), runs every condition — concurrently within each `when`
  wave, see `defineCondition` above — derives the computed conditions, then
  evaluates every bucket.
- Never throws for bad data: a schema rejection or a throwing `checkFn`
  lands the item in `report.errors` and the rest of the batch continues.
- `options.concurrency` bounds how many items are evaluated at once
  (default `256`). See the Async Conditions and Performance guide.
- Output order in every part of the report matches input order, regardless
  of `concurrency`.

Returns a `BucketReport`; see the Reports and Errors reference for its
shape.

## `processOne(item)`

```ts
processOne(item: TInput): Promise<BucketAssignment<TInput, TGuards & TComputed, TBuckets>>;
```

Sorts a single item and resolves to `{ item, buckets, conditions }`, where
`buckets` lists every rule it satisfied, in definition order. An empty array
means it satisfied none: the single-item equivalent of `unmatched`.

Unlike `process`, this **throws** a `BucketError` on a validation or
condition failure: with one item, there's no rest-of-the-batch to protect.

## `processConditions(items, options?)`

```ts
processConditions(
  items: readonly TInput[],
  options?: { concurrency?: number },
): Promise<ConditionBatchReport<TInput, TGuards & TComputed>>;
```

Runs every condition over a batch, the same way `process()` does, but
**requires no bucket** — only `.defineInput()`. Useful for trying out a set
of conditions before there's a rule to sort by, or for a report over the
conditions themselves.

Resolves to:

```ts
interface ConditionBatchReport<TInput, TConditions> {
  readonly results: readonly { item: TInput; conditions: ConditionReport<TConditions> }[];
  readonly errors: readonly BucketFailure<TInput, TConditions>[];
  readonly summary: readonly { name: TConditions; group: string | undefined; passing: number; failing: number }[];
}
```

- `results` — every item's own verdicts, in input order. What `errors`
  claims an item is excluded here, same as `process()`'s `unmatched`/`errors`
  split.
- `errors` — items that couldn't be classified: a schema rejection, or a
  `checkFn` that threw. As in `process()`, one throwing condition drops the
  whole item, not just that condition's verdict.
- `summary` — how often each condition, plain and computed alike, came out
  true versus false across the batch. `group` carries whatever was given to
  `defineCondition`'s `group`, or `undefined` for an ungrouped condition and
  for every computed condition, which has no `group` of its own.

Pass `summary` — or the whole report — to `formatConditionReport()` /
`printConditionReport()` (from `"@michaelrwalker/buckets"`) for a table:

```ts
import { formatConditionReport } from "@michaelrwalker/buckets";

const report = await engine.processConditions(items);
console.log(formatConditionReport(report));
```

```
┌─────────────────┬────────────┬─────────┬─────────┬──────────────────────┐
│ Group           │ Condition  │ Passing │ Failing │ Distribution         │
├─────────────────┼────────────┼─────────┼─────────┼──────────────────────┤
│ existence check │ hasProduct │     150 │     150 │ ██████████░░░░░░░░░░ │
│ existence check │ hasBrand   │     300 │       0 │ ████████████████████ │
└─────────────────┴────────────┴─────────┴─────────┴──────────────────────┘
```

Rows sort by `group`, in the order each group was first seen; an ungrouped
condition sorts last and prints `—`. `{ barWidth?: number }` (default `20`)
controls how wide the distribution bar is; `printConditionReport` is the
same thing written straight to `console.log`. See the Reports and Errors
reference for `ConditionSummary` and `ConditionAssignment`.

## Introspection

| Member | Type | Returns |
| --- | --- | --- |
| `conditionNames` | `NamesOf<TGuards>[]` (getter) | Plain condition names, in definition order. |
| `computedConditionNames` | `NamesOf<TComputed>[]` (getter) | Computed condition names, in definition order. |
| `bucketNames` | `NamesOf<TBuckets>[]` (getter) | Bucket names, in definition order. |
| `missingCombinations()` | `NamesOf<TGuards>[][]` | Every combination of plain conditions that satisfies no bucket. |

### `missingCombinations()`

Enumerates every possible assignment of true/false over the **plain**
conditions (the free variables; computed conditions are derived, not
independently chosen), derives the computed conditions for each combination,
and returns the ones no bucket's expression matches. Each result is the list
of condition names that would be true in that combination, in definition
order.

These are exactly the combinations that would produce an `unmatched` entry in
`report.unmatched`, so this answers "what have I not written a rule for?"
without needing data to surface it.

Refuses to run past 16 conditions (65,536 combinations), throwing a
`BucketError` instead of hanging: the only place in the library that
enumerates combinatorially. Nothing on the per-item hot path does this;
sorting an item evaluates each bucket's expression directly against that
item's already-computed verdicts.

```ts
console.log(engine.missingCombinations());
// [[]]                     — no conditions true, and nothing claims that
// [["hasWeight"]]          — hasWeight alone, uncovered
// [["hasWeight", "isDigital"]]
```
