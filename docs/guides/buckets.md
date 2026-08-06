---
title: "Buckets and Combinators"
description: "Declaring buckets as boolean expressions with AND, OR, NOT and ONLY, and what each one means."
---

A bucket is a name and a boolean expression over your condition names.
`checkFn` receives the four combinators, bound to this engine's condition
names, and returns the expression that decides membership.

```ts
.defineBucket({ name: "shippable", checkFn: () => "hasWeight" })
.defineBucket({ name: "sellable", checkFn: ({ AND }) => AND("hasPhoto", "hasPrice") })
.defineBucket({ name: "incomplete", checkFn: ({ OR, NOT }) => OR(NOT("hasPhoto"), NOT("hasPrice")) })
.defineBucket({ name: "bareListing", checkFn: ({ ONLY }) => ONLY("hasTitle") })
```

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes a key of `report.buckets`. Must be unique: the only uniqueness rule a bucket name has. |
| `checkFn` | `(logic) => expression` | Receives `{ AND, OR, NOT, ONLY }` bound to your condition names. Return an expression, or a bare condition name. |

## The four combinators

| Combinator | Meaning |
| --- | --- |
| `"hasWeight"` | A bare name is the condition itself: legal anywhere an expression is expected. |
| `AND(...)` | Every operand holds. |
| `OR(...)` | At least one operand holds. |
| `NOT(x)` | The operand does not hold. |
| `ONLY(...names)` | Exactly these hold, and every other condition is false. |

That's all of them.

## Conditions a rule doesn't mention are free

`checkFn: () => "hasWeight"` matches anything with a weight, whatever else is
true of it. A vinyl record that also has a download code still lands in a
bucket built on `"hasWeight"` alone: the rule only constrains what it names.

## `ONLY` is the strict form

`ONLY("hasWeight")` means a weight, and nothing else true. It's the one
combinator that depends on conditions it doesn't name, which is why every
condition has to be defined before the first bucket: `ONLY` needs the
complete set to know what "nothing else" covers.

`ONLY` only accepts plain conditions, never computed ones (see the Computed
Conditions guide for why). Passing a computed condition's name to `ONLY` is a
compile error, and the engine rejects it again at runtime if you get past the
types.

## Buckets are independent, not a partition

Rules may overlap freely, and an item lands in every bucket whose expression
it satisfies:

```ts
import { BucketEngine, NOT, OR } from "@michaelrwalker/buckets";

interface Listing {
  readonly id: string;
  readonly photos: number;
  readonly description: string;
  readonly price: number | null;
}

const quality = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({ name: "hasPhotos", checkFn: (l) => l.photos > 0 })
  .defineCondition({
    name: "hasDescription",
    checkFn: (l) => l.description.length >= 100,
  })
  .defineCondition({ name: "hasPrice", checkFn: (l) => l.price !== null })
  .defineBucket({ name: "needsPhotos", checkFn: ({ NOT }) => NOT("hasPhotos") })
  .defineBucket({
    name: "needsDescription",
    checkFn: ({ NOT }) => NOT("hasDescription"),
  })
  .defineBucket({ name: "needsPrice", checkFn: ({ NOT }) => NOT("hasPrice") });

const report = await quality.process(listings);

// A listing missing all three lands in all three buckets — membership
// double-counts on purpose.
const placements = Object.values(report.buckets).flat().length;
```

What's guaranteed instead of a partition: every item ends up in at least one
bucket, in `report.unmatched`, or in `report.errors`. Nothing disappears.

## Hoisting and sharing expressions

`checkFn` doesn't have to build the expression inline. Expressions are plain
data, so they can be built outside a bucket, named, shared and negated, and
`checkFn` then just returns one:

```ts
import { NOT, OR } from "@michaelrwalker/buckets";

const missingSomething = OR(
  NOT("hasPhotos"),
  NOT("hasDescription"),
  NOT("hasPrice"),
);

const quality = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({ name: "hasPhotos", checkFn: (l) => l.photos > 0 })
  .defineCondition({
    name: "hasDescription",
    checkFn: (l) => l.description.length >= 100,
  })
  .defineCondition({ name: "hasPrice", checkFn: (l) => l.price !== null })
  .defineBucket({ name: "needsWork", checkFn: () => missingSomething })
  .defineBucket({ name: "readyToPublish", checkFn: () => NOT(missingSomething) });
```

The callback form — `checkFn: ({ OR, NOT }) => ...` — is worth preferring
where you can, because it's the one that types the condition names for you.
The standalone `AND`/`OR`/`NOT`/`ONLY` exported from the package still check
names at runtime, but they have no engine to type them against, so a typo
there isn't caught until `defineBucket` validates the expression.

## What the engine checks when you call `defineBucket`

- Every condition name the expression refers to must exist: an unknown name
  throws immediately, not at `process()` time.
- A duplicate bucket name throws.
- `AND()` or `OR()` called with zero operands throws.
- A `checkFn` returning something that's neither a condition name nor an
  expression throws.

None of this waits for data. A misconfigured engine can't reach `process()`
in the first place.

## What's legal, deliberately

Rules that overlap, a rule that can never match (`AND("a", NOT("a"))`), and
combinations no rule covers are all legal: overlap is the design, and the
other two are exactly what `missingCombinations()` (see the BucketEngine
reference) and an empty bucket in the report are for.
