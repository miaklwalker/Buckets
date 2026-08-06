---
title: "Overview"
description: "What Buckets is, the core idea behind it, and a motivating example."
---

Buckets is a rule engine for sorting items into named buckets. You declare
named conditions over an item, then declare buckets as boolean expressions
over those conditions. That way, the expensive, awkward part (is this thing
digital? does this account pay us?) is written once and answered once per
item, and the rules on top read like the sentences you'd use to describe
them.

```ts
import { BucketEngine } from "@michaelrwalker/buckets";
import { z } from "zod";

const fulfillment = new BucketEngine()
  .defineInput(
    z.object({
      sku: z.string(),
      weightKg: z.number().nullable(),
      downloadUrl: z.string().nullable(),
    }),
  )
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
  .defineCondition({
    name: "isDownloadable",
    checkFn: (p) => p.downloadUrl !== null,
  })
  .defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
  .defineBucket({ name: "digitalDelivery", checkFn: () => "isDownloadable" })
  .defineBucket({
    name: "purelyPhysical",
    checkFn: ({ ONLY }) => ONLY("hasWeight"),
  })
  .defineBucket({
    name: "incomplete",
    checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("isDownloadable")),
  });

const report = await fulfillment.process(catalog);

report.buckets.warehouse; // Product[]
```

Condition names, bucket names and the shape of the report are all inferred.
The combinators handed to `checkFn` are bound to *your* condition names, so a
typo like `NOT("hasWieght")` is a compile error on the name itself, rather
than a rule that silently never fires.

## Buckets are independent rules

An item lands in **every** bucket whose expression it satisfies. A vinyl
record with a download code is in both `warehouse` and `digitalDelivery`,
because it genuinely needs both. Summing the buckets can exceed the size of
the batch, and that isn't a bug — it's the point: Buckets doesn't partition
your data, it answers a separate yes/no question per bucket.

What's guaranteed is that no item disappears: every one ends up in at least
one bucket, in `unmatched`, or in `errors`.

Conditions a rule doesn't mention are **free**. `checkFn: () => "hasWeight"`
matches anything with a weight, whatever else is true of it. When you want
the strict reading — a weight and nothing else — `ONLY` gives it to you:
`ONLY("hasWeight")`.

## Why not just write the if-statements

Because the awkward part of a rule engine is rarely the boolean logic: it's
keeping the conditions and the rules that use them in sync as both grow. A
hand-written `if` chain re-evaluates the same predicate in every branch that
needs it, and there is nothing stopping two branches from disagreeing about
what "digital" means. Buckets separates the two: conditions are evaluated
once per item, in parallel, before any rule runs, and a bucket only ever
refers to a condition by name. Get a name wrong and the type checker — not a
runtime surprise three buckets later — tells you.

The engine also carries type information through the rules. A condition
written as a type predicate (`(item): item is X => ...`) tells the engine
what it proves, and the combinators propagate that through `AND`, `OR` and
`NOT`, so a bucket built from type predicates hands back the narrow type
instead of the engine's input type. See the Type Narrowing guide for what
that buys you.

## Where to go next

- **Installation**: add the package and the one thing it needs at runtime.
- **Quick Start**: a complete worked example, end to end.
- **Defining Conditions**: the building block everything else is made of.
