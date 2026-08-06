---
title: "Computed Conditions"
description: "Naming a combination of conditions once with defineComputedCondition so it reads as a condition everywhere after."
---

Some combinations aren't a rule, they're a phrase you keep using. "Listed
correctly" isn't a single fact you check against a product: it's three
facts you already check, taken together. `defineComputedCondition` names the
combination once, and the name is a condition everywhere after that.

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

interface Listing {
  readonly sku: string;
  readonly priceCents: number | null;
  readonly weightKg: number | null;
  readonly category: string | null;
  readonly stock: number;
}

const catalog = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({
    name: "hasPrice",
    checkFn: (listing) => listing.priceCents !== null,
  })
  .defineCondition({
    name: "hasWeight",
    checkFn: (listing) => listing.weightKg !== null,
  })
  .defineCondition({
    name: "hasCategory",
    checkFn: (listing) => listing.category !== null,
  })
  .defineCondition({ name: "inStock", checkFn: (listing) => listing.stock > 0 })
  .defineComputedCondition({
    name: "listedCorrectly",
    checkFn: ({ AND }) => AND("hasPrice", "hasWeight", "hasCategory"),
  })
  // Computed conditions layer: this one is built from the last.
  .defineComputedCondition({
    name: "sellable",
    checkFn: ({ AND }) => AND("listedCorrectly", "inStock"),
  })
  .defineBucket({ name: "storefront", checkFn: () => "sellable" })
  .defineBucket({
    name: "backorder",
    checkFn: ({ AND, NOT }) => AND("listedCorrectly", NOT("inStock")),
  });
```

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Joins the condition namespace: usable anywhere a condition name is, and unique across both plain and computed conditions. |
| `checkFn` | `(logic) => expression` | Receives `{ AND, OR, NOT, ONLY }` bound to every condition defined so far. Return an expression, or a bare condition name. |

## `checkFn` gets the same combinators a bucket does

Which means a computed condition is a first-class operand: `NOT("listedCorrectly")`
is a rule, not a special case, and it can be used inside another computed
condition or a bucket exactly like a plain condition name.

## It costs nothing per item

A computed condition reads verdicts that have already been collected from the
plain conditions: nothing re-runs. Evaluating `sellable` for an item is a
walk over a small expression tree, not a second call to `hasPrice`'s
`checkFn`.

## Ordering rules

Computed conditions go after every plain condition and before the first
bucket.

- **After every plain condition**: a computed condition can only be built
  out of conditions that already exist, referencing what's defined so far.
  That's also what makes a cycle impossible to state: a computed condition
  can never refer to itself or to something defined after it.
- **Before the first bucket**, same reasoning as plain conditions: once a
  bucket exists, the set a later `ONLY` would need to reason about is
  already fixed.

Trying to define a computed condition after a bucket, or a plain condition
after a computed condition, throws a `BucketError`.

## Why `ONLY` won't take a computed condition's name

`ONLY` means "these conditions hold, and every other condition is false." A
computed condition isn't another fact about the item: it's a restatement of
facts already counted. If `ONLY` counted computed conditions too,
`ONLY("hasWeight")` would suddenly demand that `listedCorrectly` be false
too, and a computed condition like `nothingFilledIn` would make a bare
`ONLY()` unsatisfiable by definition. So `ONLY` only ever takes plain
condition names — `ONLY("hasWeight")` means exactly what it meant before you
named anything — and passing a computed name to it is rejected both at
compile time and at runtime.

```ts
// ONLY still counts the plain conditions only — a computed condition
// restates them rather than adding another. So this means "nothing filled
// in at all", not "not listedCorrectly and not sellable and ...".
.defineBucket({ name: "untouched", checkFn: ({ ONLY }) => ONLY() })
```

## The report carries computed verdicts too

`report.conditions` (or the `conditions` field returned by `processOne`)
includes every computed condition's verdict alongside the plain ones. That's
the other half of why naming a combination is worth it: reading *why* an
item went unmatched is easier in the terms you chose than in raw predicates.

```ts
const one = await catalog.processOne({
  sku: "lamp-01",
  priceCents: 4500,
  weightKg: null,
  category: "home",
  stock: 3,
});
console.log(one.conditions);
// { hasPrice: true, hasWeight: false, hasCategory: true, inStock: true,
//   listedCorrectly: false, sellable: false }
```

## Type narrowing carries through

Narrowing composes the same way through a computed condition as it does into
a bucket: `AND("isString", "isLong")` named `isLongString` proves `string`,
and a bucket built on `isLongString` hands back `string[]`. See the Type
Narrowing guide.

## `missingCombinations()` and computed conditions

`missingCombinations()` still enumerates only the plain conditions (those
are the free variables) while deriving the computed ones internally to
decide what each combination matches. See the BucketEngine reference for the
details.
