---
title: "Preconditions"
description: "Gating a condition on another with when — skipping checkFn when the precondition fails, and the three ways to write it, each with a different narrowing/autocomplete tradeoff."
---

Some conditions only make sense once another one already holds. A listing's
`weight` only matters once it has a `product`; a fraud check is wasted work on
a listing that isn't even active. `when` names that dependency directly, and
two things follow from it: `checkFn` is skipped entirely when the
precondition doesn't hold, and — depending on how you write it — `checkFn`
can see a narrower type than the engine's plain input.

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

const listings = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({
    name: "hasProduct",
    checkFn: (item): item is Listing & { product: Product } =>
      item.product !== undefined,
  })
  .defineCondition({
    name: "hasWeight",
    when: () => "hasProduct",
    // item.product is Product here, not Product | undefined — no `?.`,
    // because hasProduct already proved it before this ever runs.
    checkFn: (item) => item.product.weightKg !== null,
  });
```

When `hasProduct` is false, `hasWeight` is recorded `false` and its `checkFn`
never runs — worth noticing when `checkFn` is the expensive one. That's the
whole deal `when` makes on your behalf: it doesn't infer that `hasWeight`
*implies* `hasProduct`, it trusts you to only gate a condition behind a
precondition that actually is one.

## Three ways to write `when`, one tradeoff

`when` always skips correctly, no matter which form you use. Whether
`checkFn`'s item narrows, and whether you get autocomplete on the condition
names inside a compound expression, depends on the form:

| Form | Narrows `checkFn`? | Autocompletes condition names? |
| --- | --- | --- |
| A bare name: `when: () => "hasProduct"` | Yes | N/A — nothing to complete |
| A value: `when: AND("hasProduct", "isActive")` | Yes | No |
| A callback: `when: ({ AND }) => AND(...)` | No | Yes |
| `checkFn` as a second argument (below) | Yes | Yes |

### A bare name

```ts
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: (item) => item.product.weightKg !== null,
})
```

The simplest form, and the one to reach for when the precondition is a single
condition. Always narrows.

### `AND`/`OR`/`NOT` as a value

```ts
import { AND, BucketEngine } from "@michaelrwalker/buckets";

.defineCondition({
  name: "readyToSell",
  when: AND("hasProduct", "isActive"),
  checkFn: (item) => item.product.weightKg > 0, // still narrowed
})
```

`AND` here is the standalone export, called directly — not destructured from
a callback parameter. It still narrows: see the Combinators reference for
how a standalone `AND`/`OR` carries what it was built from until it finally
has a `TGuards` to resolve against. What it *can't* do is autocomplete:
called this way, `AND` has no engine in scope yet, so there's
nothing to complete the condition names against beyond a bare `string`.

### The callback form — autocomplete, but no narrowing

```ts
.defineCondition({
  name: "readyToSell",
  when: ({ AND }) => AND("hasProduct", "isActive"),
  checkFn: (item) => item.product?.weightKg, // still Product | undefined
})
```

`AND` here is bound to this engine's real condition names, the same
combinator a bucket's `checkFn` receives, so `"hasProduct"` and `"isActive"`
autocomplete and a typo is a compile error. What it costs you is narrowing:
`checkFn`'s `item` stays at the plain input type, the same honest fallback
`NOT` already gets in a bucket's combinators.

This isn't a design choice, it's a real TypeScript limitation: `checkFn`'s
contextual type can't be resolved from a sibling callback parameter's own
method call within the same object literal, because by the time that's
needed, the compiler has already committed to resolving it a different way.
A value passed directly — `AND(...)`, no wrapping callback — doesn't hit
that, since its result is inferred before `checkFn` is even looked at, the
same way a bare name already is.

### `checkFn` as a second argument — both at once

```ts
.defineCondition(
  { name: "readyToSell", when: ({ AND }) => AND("hasProduct", "isActive") },
  (item) => item.product.weightKg > 0, // narrowed, and AND autocompletes
)
```

Passing `checkFn` as a second argument instead of a property next to `when`
sidesteps the limitation above. `when` is now a complete argument on its own,
fully resolved before `checkFn` — the next argument — is ever contextually
typed. Reach for this whenever the precondition is a compound expression
(`AND`/`OR`/`NOT` of more than one thing) and you want both autocomplete and
narrowing — which is most of the time a compound precondition is worth
writing at all.

## What actually narrows

The type `checkFn` sees is whatever the precondition *proves*, computed the
same way a bucket's item type is: a bare name resolves through what that
condition's own `checkFn` proved (nothing, unless it's a type predicate); an
`AND`/`OR`/`NOT` value composes that the same way it would for a bucket — see
the Type Narrowing guide for the full story, `Prettify` included. `weightKg`
two properties deep — `item.product.weightKg` — is one property
past what TypeScript's own predicate inference reaches on an unannotated
`checkFn`, so a plain `(item) => item.product.weightKg !== null` runs
correctly but proves nothing further about `weightKg` itself.

For "is this property there at all", `definedIn`/`presentIn` write that
predicate for you, on `checkFn`'s own parameter:

```ts
import { definedIn } from "@michaelrwalker/buckets";

.defineCondition({
  name: "hasProduct",
  checkFn: definedIn<Listing>()("product"),
})
```

For a property *inside* that — like `product.weightKg` — `pathIn` does the
same, one `.at()` per hop:

```ts
import { pathIn } from "@michaelrwalker/buckets";

.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
})
```

No hand-written `item is typeof item & { product: { weightKg: number } }`
needed for either — only reach for a hand-written predicate when the check
isn't just "is it there", like `weightKg > 10` below. See the Property
Predicates reference for the difference between `definedIn`/`isDefined` and
`presentIn`/`isPresent` (`null` counts as "defined" but not "present") and
why, like the callback form above, all of these only narrow once `TObject`
is pinned explicitly — the same underlying limit, worked around the same way.

## Chaining preconditions

A `when` can name a condition that itself has a `when` — the dependency graph
can go as deep as you need, and gating on the *nearest* link is enough:

```ts
.defineCondition({
  name: "hasProduct",
  checkFn: (item): item is Listing & { product: Product } =>
    item.product !== undefined,
})
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
})
.defineCondition({
  name: "isHeavy",
  when: () => "hasWeight", // not AND("hasProduct", "hasWeight") — no need
  checkFn: (item) => item.product.weightKg > 10, // item.product is still Product
})
```

`isHeavy` only names `"hasWeight"`, never `"hasProduct"`, and still knows
about both. Every gated condition's guard is *always* intersected with
whatever its own precondition already proved — `hasWeight`'s guard already
included everything `hasProduct` proved, so `isHeavy`'s does too, and so on
however deep the chain goes. This holds even if a link's own predicate
doesn't restate the precondition itself — `definedIn`/`presentIn`, for
instance, don't know anything about what ran before them, and it still
carries through:

```ts
.defineCondition({
  name: "hasProduct",
  checkFn: (item): item is Listing & { product: Product } =>
    item.product !== undefined,
})
.defineCondition({
  name: "hasAlternate",
  when: () => "hasProduct",
  checkFn: definedIn<Listing>()("alternate"), // says nothing about product
})
.defineCondition({
  name: "hasBoth",
  when: () => "hasAlternate", // still knows about product too
  checkFn: (item) => item.product.sku !== "" && item.alternate.sku !== "",
})
```

It's sound by construction, not by trust: a condition only ever runs once its
`when` held, so conjoining its own proof with the precondition's is always
valid, whatever the condition's own predicate happens to say.

`isHeavy` only runs once both `hasProduct` and `hasWeight` are true. Under the
hood, conditions sharing no dependency still run concurrently — see the
Async Conditions and Performance guide for how `when` changes the evaluation
order, and what it costs to skip.

## `ONLY` and `missingCombinations()` see the skip too

A condition whose precondition failed is recorded `false` — exactly as if it
had run and failed — so `ONLY` needs no special case for it:

```ts
.defineBucket({
  name: "productOnlyNoWeight",
  checkFn: ({ ONLY }) => ONLY("hasProduct"), // hasWeight false, gated or not
})
```

`missingCombinations()` goes further: an assignment where a gated condition
is `true` while its precondition isn't is not something any real item could
ever produce, since that condition's `checkFn` never even runs without the
precondition holding first — so those combinations are pruned before they're
reported, not just left for you to notice they're impossible.

## What's rejected, and when

`when` is checked against the conditions defined *so far* — the same
ordering rule as everything else, enforced by the type system first and the
runtime as a backstop:

```ts
.defineCondition({
  name: "hasWeight",
  // @ts-expect-error "nope" was never defined.
  when: () => "nope",
  checkFn: (item) => true,
})
```

A `when` this only reaches via `any`/plain JS throws a `BucketError` naming
the unknown condition and listing what's actually defined. A `when` that
isn't a function, a condition name, or an expression — and a `checkFn` that
isn't a function — throw immediately too, before anything is registered.
