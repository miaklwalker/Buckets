---
title: "Quick Start"
description: "A complete, runnable example: sorting a product catalog into fulfillment buckets."
---

This walks through a full example: sorting a small product catalog into
fulfillment lanes, from the input type to reading the report. It's adapted
from `examples/basic.ts` in the repository.

## Define the shape of an item

`defineInput` comes first. Here we skip runtime validation and just declare
the type, since the data is already trusted:

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

interface Product {
  readonly sku: string;
  readonly weightKg: number | null;
  readonly downloadUrl: string | null;
}

const engine = new BucketEngine().defineInput<Product>();
```

## Declare conditions

A condition is a name and a predicate. Each one is evaluated once per item,
however many buckets end up using it:

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

## Declare buckets

A bucket is a name and a boolean expression over condition names. Returning a
bare condition name is the whole rule for the simple case; `ONLY` is the
strict form, this condition, and nothing else true:

```ts
const fulfillment = withConditions
  .defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
  .defineBucket({ name: "digitalDelivery", checkFn: () => "isDownloadable" })
  .defineBucket({
    name: "purelyPhysical",
    checkFn: ({ ONLY }) => ONLY("hasWeight"),
  });
```

## Process a batch

```ts
const CATALOG: Product[] = [
  { sku: "mug-01", weightKg: 0.4, downloadUrl: null },
  { sku: "ebook-01", weightKg: null, downloadUrl: "https://cdn/ebook-01" },
  { sku: "vinyl-01", weightKg: 0.3, downloadUrl: "https://cdn/vinyl-01" },
  { sku: "giftcard-01", weightKg: null, downloadUrl: null },
];

const report = await fulfillment.process(CATALOG);

for (const [bucket, products] of Object.entries(report.buckets)) {
  console.log(`${bucket}: ${products.map((p) => p.sku).join(", ") || "—"}`);
}
// warehouse: mug-01, vinyl-01
// digitalDelivery: ebook-01, vinyl-01
// purelyPhysical: mug-01
```

`vinyl-01` has both a weight and a download URL, so it's in both `warehouse`
and `digitalDelivery`: the rules are independent, not a partition.
`giftcard-01` matches neither rule, so it doesn't appear in any bucket:

```ts
console.log(
  "unmatched:",
  report.unmatched.map((entry) => entry.item.sku),
);
// unmatched: giftcard-01
```

## Ask what you haven't covered

Before the data tells you, you can ask the engine which combinations of
conditions no bucket claims:

```ts
console.log("uncovered:", fulfillment.missingCombinations());
// [[]]
```

One combination goes unmatched: the empty one, meaning "neither `hasWeight`
nor `isDownloadable`" (exactly `giftcard-01`). Every other combination of the
two conditions is claimed by at least one bucket.

## Process a single item

`processOne` is for the request-handler case, sorting one item and getting
an answer at the call site, including a thrown error if something goes
wrong:

```ts
const one = await fulfillment.processOne({
  sku: "poster-01",
  weightKg: 0.1,
  downloadUrl: null,
});

console.log(`poster-01 -> [${one.buckets.join(", ")}]`, one.conditions);
// poster-01 -> [warehouse, purelyPhysical] { hasWeight: true, isDownloadable: false }
```

## Next

- **Defining Conditions** covers `defineCondition` and `defineInput` in full, including schema validation and error handling.
- **Buckets and Combinators** covers `AND`, `OR`, `NOT` and `ONLY` in depth.
- **Type Narrowing** shows how a type-predicate condition makes a bucket hand back a narrower type than the engine's input.
