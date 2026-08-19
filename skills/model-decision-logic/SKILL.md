---
name: 'model-decision-logic'
description: >
  Model complex, multi-input boolean decisions — e.g. a shipping-policy
  table keyed on weight, price, and time of day — as named, type-checked
  conditions and rules instead of nested if/ternary/switch chains. Covers
  defineInput, defineCondition, when (preconditions), defineComputedCondition,
  the AND/OR/NOT/ONLY combinators, and the definedIn/presentIn/pathIn
  property-existence predicates. Load this before defineBucket or
  defineAction — every condition must be declared first.
metadata:
  type: core
  library: '@michaelrwalker/buckets'
  library_version: '0.5.0'
sources:
  - 'docs/guides/conditions.md'
  - 'docs/guides/preconditions.md'
  - 'docs/guides/boolean-logic.md'
  - 'docs/guides/computed-conditions.md'
  - 'docs/reference/combinators.md'
  - 'docs/reference/predicates.md'
  - 'modules/engine.ts'
  - 'modules/logic.ts'
  - 'modules/predicates.ts'
---

# Model Decision Logic with Conditions

## Setup

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

interface Order {
  readonly id: string;
  readonly price: number;
  readonly weightKg: number;
}

const shipping = new BucketEngine()
  .defineInput<Order>()
  .defineCondition({ name: "isHighValue", checkFn: (o) => o.price > 500 })
  .defineCondition({
    name: "isMidWeight",
    checkFn: (o) => o.weightKg > 50 && o.weightKg < 1000,
  })
  .defineCondition({ name: "isHeavy", checkFn: (o) => o.weightKg >= 1000 })
  .defineBucket({
    name: "policy1",
    checkFn: ({ AND }) => AND("isHighValue", "isMidWeight"),
  })
  .defineBucket({ name: "policy5", checkFn: () => "isHeavy" });

const report = await shipping.process(orders);
report.buckets.policy1; // Order[]
```

Every condition must be declared before the first `defineComputedCondition`
and the first `defineBucket` — the engine throws otherwise, because `ONLY`
needs the complete set of conditions to know what "nothing else" means.

## Core Patterns

### Gate an expensive or dependent condition with `when`

`checkFn` is skipped entirely — the condition is recorded `false` — when the
precondition doesn't hold. A bare-name `when` also narrows `checkFn`'s item:

```ts
import { definedIn, pathIn } from "@michaelrwalker/buckets";

.defineCondition({
  name: "hasProduct",
  checkFn: definedIn<Listing>()("product"),
})
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  // item.product is Product here, not Product | undefined — no `?.` needed.
  checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
})
```

For a compound precondition, pass `checkFn` as a second argument instead of
a sibling property — that's the only form that gets both autocomplete on the
`when` callback and narrowing on `checkFn`:

```ts
.defineCondition(
  { name: "readyToSell", when: ({ AND }) => AND("hasProduct", "isActive") },
  (item) => item.product.weightKg > 0, // narrowed, and AND autocompletes
)
```

### Model a nested optional object by gating existence, not optional-chaining every check

When several conditions read fields nested inside one optional object
(`product.name`, `product.description`), define one existence condition for
the parent and gate every nested condition on it with `when`, rather than
defending each `checkFn` with `?.`:

```ts
import { definedIn } from "@michaelrwalker/buckets";

interface Listing {
  readonly product?: { name: string; description: string };
}

.defineCondition({
  name: "hasProduct",
  checkFn: definedIn<Listing>()("product"),
})
.defineCondition({
  name: "hasName",
  when: () => "hasProduct",
  checkFn: (l) => l.product.name.length > 0, // no `?.`
})
.defineCondition({
  name: "hasDescription",
  when: () => "hasProduct",
  checkFn: (l) => l.product.description.length > 0,
})
```

### Use `definedIn`/`presentIn`/`pathIn` instead of hand-writing an existence predicate

For "is this property actually there" — the most common shape of type-guard
condition — reach for the built-in helpers instead of writing the type
predicate by hand. They check a real `Object.getOwnPropertyDescriptor`
(rejecting `__proto__`/`constructor`), narrow exactly like a hand-written
guard, and are shorter:

```ts
import { definedIn, presentIn, pathIn } from "@michaelrwalker/buckets";

// A property on checkFn's own parameter — pin the object type once, argument-free
.defineCondition({ name: "hasProduct", checkFn: definedIn<Listing>()("product") })

// null shouldn't count as "there" — use presentIn instead of definedIn
.defineCondition({ name: "hasAlternate", checkFn: presentIn<Listing>()("alternate") })

// A property one or more hops in — one .at() per hop, ending in isDefined/isPresent
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
})
```

`definedIn` accepts `null` as "there" (use it for `T | undefined`
properties); `presentIn` doesn't (use it when `T | null` shouldn't count).
Only reach for a hand-written predicate when the check isn't just
"is it there" — e.g. `weightKg > 10`.

### Name a reusable combination once with `defineComputedCondition`

A plain `AND(...)` of every fact that must hold is a complete, correct way
to state "is valid" — nothing about it is wrong. As a style preference, it
can also read better to name the negative — the ways something can fail —
and derive the positive from it, especially as the check list grows. Do
this with `OR`/`NOT`, never by wrapping the `AND` in `NOT` (see Common
Mistakes below for why `NOT(AND(...))` doesn't do this):

```ts
.defineComputedCondition({
  name: "hasInvalidField",
  checkFn: ({ OR, NOT }) =>
    OR(NOT("hasValidEmail"), NOT("hasValidPassword"), NOT("passwordsMatch")),
})
.defineComputedCondition({
  name: "isValid",
  checkFn: ({ NOT }) => NOT("hasInvalidField"),
})
```

A computed condition costs nothing per item — it walks an expression tree
over verdicts already collected, it never re-runs a `checkFn`. Must be
defined after every plain condition and before the first bucket.

### Hoist and share an expression across rules

Expressions are plain data: build one outside a `checkFn`, name it, and
reuse or negate it:

```ts
import { NOT, OR } from "@michaelrwalker/buckets";

const missingSomething = OR(NOT("hasPhotos"), NOT("hasPrice"));

.defineBucket({ name: "incomplete", checkFn: () => missingSomething })
.defineBucket({ name: "ready", checkFn: () => NOT(missingSomething) })
```

The standalone `AND`/`OR`/`NOT` still narrow types the same way the bound
versions do; only `ONLY` requires the bound (`{ AND, OR, NOT, ONLY }`) form.

## Common Mistakes

### CRITICAL Writing manual if/ternary/switch chains instead of the engine

Wrong:

```ts
function policyFor(order: Order): string {
  if (order.price > 500 && order.weightKg > 50 && order.weightKg < 1000) return "policy1";
  if (order.weightKg >= 1000) return "policy5";
  // ...more branches, each re-deriving the same facts
}
```

Correct:

```ts
const shipping = new BucketEngine()
  .defineInput<Order>()
  .defineCondition({ name: "isHighValue", checkFn: (o) => o.price > 500 })
  .defineCondition({ name: "isMidWeight", checkFn: (o) => o.weightKg > 50 && o.weightKg < 1000 })
  .defineCondition({ name: "isHeavy", checkFn: (o) => o.weightKg >= 1000 })
  .defineBucket({ name: "policy1", checkFn: ({ AND }) => AND("isHighValue", "isMidWeight") })
  .defineBucket({ name: "policy5", checkFn: () => "isHeavy" });
```

A hand-written `if` chain re-evaluates the same predicate in every branch
that needs it, and nothing stops two branches from disagreeing about what a
term like "high value" means. This is the library's core reason to exist —
recognize the shape (a decision keyed on several fields at once) and reach
for `BucketEngine` instead of nested conditionals.

Source: maintainer interview; docs/overview.md

### CRITICAL Inverting an AND-of-facts with `NOT(AND(...))` expecting it to mean "everything is valid"

Wrong:

```ts
.defineComputedCondition({
  name: "isValid",
  checkFn: ({ AND, NOT }) => NOT(AND("hasValidPassword", "passwordsMatch")),
  // NAND, not validity — true whenever something is WRONG
})
```

Correct:

```ts
// Directly: AND already says "all hold" — nothing to invert
.defineComputedCondition({
  name: "isValid",
  checkFn: ({ AND }) => AND("hasValidEmail", "hasValidPassword", "passwordsMatch"),
})

// Or, to name the failure mode explicitly — via De Morgan's, not NOT(AND(...)):
.defineComputedCondition({
  name: "hasInvalidField",
  checkFn: ({ OR, NOT }) => OR(NOT("hasValidEmail"), NOT("hasValidPassword"), NOT("passwordsMatch")),
})
.defineComputedCondition({
  name: "isValid",
  checkFn: ({ NOT }) => NOT("hasInvalidField"),
})
```

`NOT(AND(a, b))` is NAND: true whenever *at least one* operand is false, not
only when all of them are. Naming that expression `isValid` produces the
opposite of validity — it reads true precisely when something is wrong. A
plain `AND(...)` already states "all of these hold" directly and needs no
inversion; if you'd rather name the failure condition, the correct negative
form composes `OR`/`NOT` (De Morgan's), never `NOT(AND(...))`.

Source: maintainer interview; docs/guides/boolean-logic.md (NAND ≠ NOR)

### HIGH Confusing NAND with NOR

Wrong:

```ts
// Intending "neither condition holds"
checkFn: ({ AND, NOT }) => NOT(AND("condOne", "condTwo"))
```

Correct:

```ts
// "Neither" is NOR, not "not both"
checkFn: ({ OR, NOT }) => NOT(OR("condOne", "condTwo"))
```

`NOT(AND(A, B))` means "not both" and matches three of four truth-table
rows (including the two mixed rows), not just the all-false row English
phrasing suggests. The engine never rewrites the tree — it evaluates `AND`
first, then flips the result.

Source: docs/guides/boolean-logic.md

### HIGH Adding a condition after the first bucket or computed condition

Wrong:

```ts
const engine = new BucketEngine()
  .defineInput<Item>()
  .defineCondition({ name: "a", checkFn: (i) => i.a })
  .defineBucket({ name: "onlyA", checkFn: ({ ONLY }) => ONLY("a") })
  .defineCondition({ name: "b", checkFn: (i) => i.b }); // throws BucketError
```

Correct:

```ts
const engine = new BucketEngine()
  .defineInput<Item>()
  .defineCondition({ name: "a", checkFn: (i) => i.a })
  .defineCondition({ name: "b", checkFn: (i) => i.b })
  .defineBucket({ name: "onlyA", checkFn: ({ ONLY }) => ONLY("a") });
```

Every condition must be declared before the first computed condition and
the first bucket, because `ONLY` means "this and nothing else" — adding a
condition later would silently change what an existing `ONLY` rule matches,
so the engine throws instead.

Source: modules/engine.ts; docs/guides/conditions.md

### MEDIUM Passing a computed condition's name to `ONLY`

Wrong:

```ts
.defineComputedCondition({ name: "listedCorrectly", checkFn: ({ AND }) => AND("hasPrice", "hasWeight") })
.defineBucket({ name: "bad", checkFn: ({ ONLY }) => ONLY("listedCorrectly") }) // compile + runtime error
```

Correct:

```ts
.defineBucket({ name: "ok", checkFn: ({ AND, NOT }) => AND("hasPrice", NOT("hasWeight")) })
```

`ONLY` counts only plain conditions — a computed condition restates facts
already counted, so counting it too would make `ONLY` contradict itself.
Rejected at compile time and again at runtime.

Source: docs/guides/computed-conditions.md; docs/reference/combinators.md

### MEDIUM Optional-chaining a nested checkFn instead of gating on an existence condition

Wrong:

```ts
interface Listing { readonly product?: { name: string; description: string } }

.defineCondition({ name: "hasName", checkFn: (l: Listing) => (l.product?.name?.length ?? 0) > 0 })
.defineCondition({ name: "hasDescription", checkFn: (l: Listing) => (l.product?.description?.length ?? 0) > 0 })
// every condition on a product field re-derives "is product even there?"
```

Correct:

```ts
import { definedIn } from "@michaelrwalker/buckets";

.defineCondition({ name: "hasProduct", checkFn: definedIn<Listing>()("product") })
.defineCondition({ name: "hasName", when: () => "hasProduct", checkFn: (l) => l.product.name.length > 0 })
.defineCondition({ name: "hasDescription", when: () => "hasProduct", checkFn: (l) => l.product.description.length > 0 })
```

Gating nested conditions on a `hasProduct`-style existence condition with
`when` guarantees the parent is present before `checkFn` ever runs, so
downstream conditions read the narrowed type directly — no `?.`, no
repeated null checks scattered across every condition that touches the
object.

Source: maintainer interview; docs/guides/preconditions.md

### MEDIUM Hand-writing an existence type guard instead of using `definedIn`/`presentIn`/`pathIn`

Wrong:

```ts
.defineCondition({
  name: "hasProduct",
  checkFn: (item): item is Listing & { product: Product } =>
    item.product !== undefined,
})
```

Correct:

```ts
import { definedIn } from "@michaelrwalker/buckets";

.defineCondition({
  name: "hasProduct",
  checkFn: definedIn<Listing>()("product"),
})
```

A condition that only checks "is this property there" is exactly what
`definedIn` (or `presentIn`, when `null` shouldn't count) already writes for
you. A hand-written `item.product !== undefined` works for the common case
but skips the real `Object.getOwnPropertyDescriptor` check — and the
`__proto__`/`constructor` guard — that `definedIn`/`presentIn` use instead
of a bare comparison. For a property one or more hops deep
(`product.weightKg`), `pathIn` does the same thing per hop.

Source: docs/reference/predicates.md

### HIGH Tension: Ordering strictness vs iterative prototyping

This domain's ordering rules (every condition before the first computed
condition or bucket) conflict with `sort-items-into-buckets`'s natural
iteration style. Agents optimizing for fast prototyping tend to bolt on
"just one more condition" once buckets are already sketched out, and hit a
`BucketError` — the fix is `clone()`-ing the pre-bucket engine or
front-loading conditions, not fighting the ordering.

See also: sort-items-into-buckets/SKILL.md § Common Mistakes

### MEDIUM Tension: Type-narrowing honesty vs quick predicates

Writing `checkFn` as a plain `(item) => boolean` is faster to type but
throws away narrowing, which only pays off downstream in
`sort-items-into-buckets`. Agents optimizing for "make it compile fastest"
default to un-narrowed predicates even in discriminated-union cases (a
router, a variant dispatch) where narrowing is most of the value the
library offers over hand-written logic.

See also: sort-items-into-buckets/SKILL.md § Common Mistakes

### HIGH Tension: Async escape hatch vs bounded concurrency

Async `checkFn` support makes it tempting to put real I/O directly in a
condition, but `tune-async-and-scale`'s concurrency model is tuned for
cheap, bounded lookups, not orchestrated network calls with retries. See
that skill before writing an async condition that does more than a single
bounded lookup.

See also: tune-async-and-scale/SKILL.md § Common Mistakes

See also: sort-items-into-buckets/SKILL.md — conditions are almost always
written to feed a bucket; how `ONLY` and type predicates propagate into
bucket item types is worth knowing before writing the condition.
