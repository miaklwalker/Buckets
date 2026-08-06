---
title: "Reports and Errors"
description: "The shape of what process() and processOne() return, ProcessOptions, and every way BucketError is thrown."
---

## `BucketReport`

What `process()` resolves to:

```ts
interface BucketReport<TInput, TGuards, TBuckets> {
  readonly buckets: { readonly [K in keyof TBuckets]: TBuckets[K][] };
  readonly unmatched: readonly UnmatchedItem<TInput, NamesOf<TGuards>>[];
  readonly errors: readonly BucketFailure<TInput, NamesOf<TGuards>>[];
}
```

| Field | Type | Contains |
| --- | --- | --- |
| `buckets` | `Record<BucketName, Item[]>` | One key per declared bucket, always present even when empty, in definition order. An item appears under every rule it satisfied. |
| `unmatched` | `{ item, conditions }[]` | Items that satisfied no rule. `conditions` is the combination that matched nothing: usually the rule you have yet to write. |
| `errors` | `{ item, stage, condition?, error }[]` | Items that couldn't be classified. `stage` is `"input"` (schema rejected it) or `"condition"` (a `checkFn` threw, and `condition` names it). |

Because buckets are independent rules rather than a partition, an item can
appear in several buckets: the sum of all bucket lengths can exceed
`items.length`. What's guaranteed instead is that every input item appears
in exactly one of: at least one bucket, `unmatched`, or `errors`.

Each bucket's item type is whatever its rule's expression proved; see the
Type Narrowing guide. A bucket with no type-predicate conditions in its rule
keeps the engine's `TInput`.

## `BucketAssignment`

What `processOne()` resolves to:

```ts
interface BucketAssignment<TInput, TGuards, TBuckets> {
  readonly item: TInput;
  readonly buckets: NamesOf<TBuckets>[];
  readonly conditions: ConditionReport<NamesOf<TGuards>>;
}
```

`item` is the validated item: the schema's output, so any transform the
schema applied. `buckets` lists every bucket the item satisfied, in
definition order; an empty array is the single-item equivalent of an
`unmatched` entry.

## `ConditionReport`

```ts
type ConditionReport<TConditions extends string> = Readonly<Record<TConditions, boolean>>;
```

Every condition's verdict for one item, keyed by name: plain conditions and
computed conditions both. This is the type of `UnmatchedItem.conditions` and
`BucketAssignment.conditions`.

## `UnmatchedItem`

```ts
interface UnmatchedItem<TInput, TConditions extends string> {
  readonly item: TInput;
  readonly conditions: ConditionReport<TConditions>;
}
```

## `BucketFailure`

```ts
interface BucketFailure<TInput, TConditions extends string> {
  readonly item: TInput;
  readonly stage: "input" | "condition";
  readonly condition?: TConditions;
  readonly error: Error;
}
```

`stage: "input"` means the item never reached a condition: the Standard
Schema passed to `defineInput` rejected it, or threw while validating.
`stage: "condition"` means a `checkFn` threw or rejected; `condition` names
which one. `error` is always a real `Error`: a non-`Error` throw is wrapped
in one.

## `ProcessOptions`

```ts
interface ProcessOptions {
  readonly concurrency?: number;
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `concurrency` | `256` (`DEFAULT_CONCURRENCY`) | How many items to evaluate at once. Must be a positive integer or `Infinity`; anything else throws a `BucketError`. |

See the Async Conditions and Performance guide for the throughput/memory
trade-off behind the default.

## `BucketError`

```ts
class BucketError extends Error {
  override name: "BucketError";
  readonly issues?: readonly StandardSchemaV1.Issue[];
}
```

Everything this package throws is a `BucketError`. `issues` is present only
when the error came from Standard Schema validation, carrying the schema
library's raw issues so you can render them yourself.

Configuration mistakes throw **immediately** from the `define*` call that
made them, so a misconfigured engine can never reach `process()`. Every
runtime type-safety guard is also re-checked here, since a plain JavaScript
caller (or a TypeScript cast) can walk straight past the compile-time checks.

### What throws

- A duplicate condition or bucket name: conditions and computed conditions
  share one namespace.
- A condition defined after the first computed condition or the first
  bucket, or a computed condition defined after the first bucket.
- A rule referencing a condition that doesn't exist, or a computed condition
  referencing one not yet defined.
- `ONLY` handed a computed condition's name.
- A `checkFn` returning something that is neither a condition name nor an
  expression, or `AND()` / `OR()` called with no operands.
- `defineInput` called twice, after a condition has been defined, or with an
  argument that isn't a Standard Schema.
- `process()` or `processOne()` called before an input or any bucket is
  defined.
- A `concurrency` that isn't a positive integer or `Infinity`.

### What is deliberately *not* an error

Rules that overlap, a rule that can never match (`AND("a", NOT("a"))`), and
combinations no rule covers are all legal. Overlap is the design; the other
two are exactly what `missingCombinations()` and an empty bucket in the
report are for.

### `DEFAULT_CONCURRENCY`

```ts
const DEFAULT_CONCURRENCY = 256;
```

The value `process()` uses for `concurrency` when the caller doesn't specify
one, exported in case you want to reference it directly (e.g. to compute a
multiple of it).
