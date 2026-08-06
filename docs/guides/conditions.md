---
title: "Defining Conditions"
description: "How defineInput and defineCondition work, and the ordering rules the engine enforces."
---

Every rule in Buckets is built on two things: the shape of an item
(`defineInput`) and the named predicates you check against it
(`defineCondition`). Both come before any bucket.

## `defineInput`

Call this first, before any condition. It has two forms.

### With a schema

```ts
import { BucketEngine } from "@michaelrwalker/buckets";
import { z } from "zod";

const engine = new BucketEngine().defineInput(
  z.object({
    sku: z.string(),
    weightKg: z.number().nullable(),
    downloadUrl: z.string().nullable(),
  }),
);
```

`defineInput(schema)` infers the item type from a
[Standard Schema](https://standardschema.dev)'s **output** type, and
validates every item at runtime before any condition sees it. A schema that
transforms its input (trimming a string, coercing a type) means conditions
and the final report both see the *transformed* value, not the raw one.

Any Standard Schema–compliant library works: Zod, Valibot, ArkType, Effect
Schema. Buckets depends only on the `@standard-schema/spec` types, not on any
particular library.

### Types only

```ts
const engine = new BucketEngine().defineInput<Product>();
```

`defineInput<Product>()` declares the item type without validating anything
at runtime. Use this when you already trust the data — the batch came from
your own database, say — and just want the type safety. Because nothing is
validated, `report.errors` can then only ever contain condition failures,
never `stage: "input"` entries.

### Ordering

Calling `defineInput` twice, or calling it after a condition has already been
defined, throws a `BucketError`. Conditions are typed against whatever
`TInput` was when they were declared, so defining them before the input type
exists would leave them typed against `never`: the runtime enforces the
ordering to match what the types already require.

## `defineCondition`

A condition is a name and a predicate:

```ts
const withConditions = engine
  .defineCondition({
    name: "hasWeight",
    checkFn: (product) => product.weightKg !== null,
  })
  .defineCondition({
    name: "isDownloadable",
    checkFn: (product) => product.downloadUrl !== null,
  });
```

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes part of the engine's type. Must be unique. |
| `checkFn` | `(item) => boolean \| Promise<boolean>` | May be async. The return value is coerced with `Boolean()`. Throwing sends that one item to `report.errors` instead of the whole batch. |

`name` becomes a literal in the engine's type parameters, which is what lets
`AND`, `OR`, `NOT` and `ONLY` in a later bucket autocomplete your condition
names and reject a typo at compile time.

### Every condition runs once, in parallel

Every condition is evaluated once per item, in parallel, before any bucket
runs, so a condition five different buckets depend on still costs exactly
one call per item. This is also why conditions have to be fully declared
before the first bucket: a bucket's `ONLY` rule means "these and nothing
else", and that only makes sense once the complete set of conditions is
known.

### Ordering rules

Define all plain conditions first: before the first computed condition
(`defineComputedCondition`) and before the first bucket
(`defineBucket`). Trying to add a condition afterward throws a `BucketError`:
adding it later would silently change what an existing `ONLY` rule matches,
so the engine refuses rather than let that happen quietly.

Condition names and computed condition names share one namespace, so a
`defineCondition` call with a name already used by a condition *or* a
computed condition also throws.

## Writing `checkFn`

The simplest form returns a plain `boolean`:

```ts
.defineCondition({ name: "inStock", checkFn: (listing) => listing.stock > 0 })
```

It can be async, which is useful when deciding a condition means an I/O call:

```ts
.defineCondition({
  name: "payingCustomer",
  checkFn: (ticket) => isPaidAccount(ticket.accountId),
})
```

See the Async Conditions and Performance guide for how the engine bounds
concurrency across a batch of async conditions, and what happens when one
throws.

### Type predicates

Writing `checkFn` as a type predicate — `(item): item is X => ...` — tells
the engine what the condition *proves*, not just whether it holds:

```ts
.defineCondition({
  name: "isString",
  checkFn: (v): v is string => typeof v === "string",
})
```

Buckets built from a condition like this hand back the narrow type rather
than the engine's input type. This is entirely opt-in: an ordinary boolean
predicate still works exactly as before, it just narrows nothing. See the
Type Narrowing guide for the full story, including how narrowing composes
through `AND`, `OR` and `NOT`.
