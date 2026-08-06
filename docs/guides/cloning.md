---
title: "Cloning and Reuse"
description: "What clone() does, the mutation gotcha it exists to solve, and using it to compare two rule sets."
---

The `define*` methods mutate the engine and return the same object: that's
what makes a chain like
`new BucketEngine().defineInput(...).defineCondition(...).defineBucket(...)`
read the way it does. It also means branching off a shared variable does not
do what it looks like:

```ts
const base = engineWithConditions;
const one = base.defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.defineBucket({ name: "b", checkFn: () => "isDigital" });
// one === two === base. Both engines now hold *both* buckets, while the
// types still claim one each — so `one.process()` evaluates a rule its
// report has no key for.
```

`one` and `two` are the same JavaScript object. The type system doesn't
notice, because each `defineBucket` call returns a type that only claims the
bucket it just added, but at runtime, both variables point at an engine
holding every bucket ever defined on it.

## `clone()`

```ts
const one = base.clone().defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.clone().defineBucket({ name: "b", checkFn: () => "isDigital" });
```

`clone()` returns an independent engine holding everything defined so far, at
the same type. `one` and `two` are now genuinely separate engines: defining
something on one leaves the other untouched.

The copy is shallow, which is all it needs to be: a stored condition is a
name and a function, a stored rule is a name and an expression tree, and
nothing mutates either one after it's registered. The ordering rules travel
with the clone too: a clone taken after the first bucket still refuses a new
condition, since its `ONLY` rules were already written against the set it
has.

## The useful shape: comparing two rule sets

Clone is for trying a proposed rule change against the same batch as the
current rules, then diffing the two reports:

```ts
interface Parcel {
  readonly sku: string;
  readonly weightKg: number | null;
  readonly fragile: boolean;
  readonly hazardous: boolean;
  readonly longestSideCm: number;
}

const parcels = new BucketEngine()
  .defineInput<Parcel>()
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
  .defineCondition({ name: "isFragile", checkFn: (p) => p.fragile })
  .defineCondition({ name: "isHazardous", checkFn: (p) => p.hazardous })
  .defineCondition({ name: "isOversized", checkFn: (p) => p.longestSideCm > 120 });

const today = parcels
  .clone()
  .defineBucket({
    name: "courier",
    checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isHazardous")),
  })
  .defineBucket({
    name: "freight",
    checkFn: ({ AND }) => AND("hasWeight", "isOversized"),
  });

// The proposal: fragile parcels go freight too, and courier stops
// overlapping with them.
const proposed = parcels
  .clone()
  .defineBucket({
    name: "courier",
    checkFn: ({ AND, NOT }) =>
      AND("hasWeight", NOT("isHazardous"), NOT("isFragile"), NOT("isOversized")),
  })
  .defineBucket({
    name: "freight",
    checkFn: ({ AND, NOT, OR }) =>
      AND("hasWeight", NOT("isHazardous"), OR("isOversized", "isFragile")),
  });

const before = await today.process(parcelBatch);
const after = await proposed.process(parcelBatch);

const courierToday = new Set(before.buckets.courier.map((p) => p.sku));
const courierAfter = new Set(after.buckets.courier.map((p) => p.sku));

console.log(
  "leaving courier:",
  [...courierToday].filter((sku) => !courierAfter.has(sku)),
);
console.log(
  "joining courier:",
  [...courierAfter].filter((sku) => !courierToday.has(sku)),
);
```

`parcels` — the base engine with just the conditions defined — is left
exactly as it was after both clones. Its `conditionNames` and `bucketNames`
are unchanged, ready for a third branch if you need one.

Because the conditions are declared once on `parcels` and only the buckets
differ between `today` and `proposed`, the diff above is purely about the
*rules*: the underlying facts about each parcel were computed identically
for both runs.
