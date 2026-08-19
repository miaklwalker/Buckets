---
name: 'sort-items-into-buckets'
description: >
  Declare buckets as boolean expressions over conditions with defineBucket,
  process a batch or single item with process()/processOne(), and read the
  buckets/unmatched/errors report correctly — buckets are independent rules,
  not a partition. Covers missingCombinations(), clone(), and type narrowing
  from type-predicate conditions into bucket item types. Load this after
  model-decision-logic, once conditions already exist.
metadata:
  type: core
  library: '@michaelrwalker/buckets'
  library_version: '0.5.0'
sources:
  - 'docs/overview.md'
  - 'docs/guides/buckets.md'
  - 'docs/guides/cloning.md'
  - 'docs/guides/narrowing.md'
  - 'docs/reference/bucket-engine.md'
  - 'docs/reference/process-output.md'
  - 'modules/engine.ts'
---

# Sort Items into Buckets

## Setup

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

interface Product {
  readonly sku: string;
  readonly weightKg: number | null;
  readonly downloadUrl: string | null;
}

const fulfillment = new BucketEngine()
  .defineInput<Product>()
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
  });

const report = await fulfillment.process(catalog);
report.buckets.warehouse; // Product[]
```

`process()` and `processOne()` both require at least one bucket and an
input to already be defined — calling either before that throws a
`BucketError` immediately.

## Core Patterns

### Read the report: buckets, unmatched, errors

Every item ends up in at least one bucket, in `unmatched`, or in `errors` —
never silently dropped. `unmatched[].conditions` is the verdict combination
that satisfied no rule:

```ts
for (const [bucket, items] of Object.entries(report.buckets)) {
  console.log(`${bucket}: ${items.length}`);
}
for (const entry of report.unmatched) {
  console.log("no rule claims:", entry.conditions);
}
for (const failure of report.errors) {
  const where = failure.condition ?? failure.stage; // "input" or the throwing condition's name
  console.log(`failed (${where}): ${failure.error.message}`);
}
```

### Find uncovered combinations before the data does

```ts
console.log(fulfillment.missingCombinations());
// [["isDownloadable"]] — download-only items have no rule yet
```

Enumerates every combination of plain conditions no bucket claims. Refuses
past 16 conditions (65,536 combinations) — the only place in the library
that enumerates combinatorially.

### Branch a rule set with `clone()`

```ts
const base = new BucketEngine()
  .defineInput<Product>()
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null });

const today = base.clone().defineBucket({ name: "a", checkFn: () => "hasWeight" });
const proposed = base.clone().defineBucket({ name: "a", checkFn: ({ NOT }) => NOT("hasWeight") });
// today and proposed are independent; base is untouched by either
```

### Get a narrowed bucket type from a type-predicate condition

```ts
const sorter = new BucketEngine()
  .defineInput<unknown>()
  .defineCondition({ name: "isString", checkFn: (v): v is string => typeof v === "string" })
  .defineBucket({ name: "strings", checkFn: () => "isString" });

const report = await sorter.process(mixedBag);
report.buckets.strings.map((s) => s.toUpperCase()); // string[] — no cast
```

`AND` intersects what its operands prove, `OR` unions it, `NOT` proves
nothing (a bucket built on `NOT(...)` keeps the engine's input type).

## Common Mistakes

### CRITICAL Treating buckets as a partition of the batch

Wrong:

```ts
// Assuming an item can only be in one bucket
const total = Object.values(report.buckets).reduce((n, b) => n + b.length, 0);
assert(total === items.length); // fails whenever rules overlap
```

Correct:

```ts
// What's actually guaranteed: every item is in >=1 bucket, unmatched, or errors
const accounted = new Set([
  ...Object.values(report.buckets).flat().map(itemKey),
  ...report.unmatched.map((u) => itemKey(u.item)),
  ...report.errors.map((e) => itemKey(e.item)),
]);
assert(accounted.size === items.length);
```

Buckets are independent yes/no questions, not mutually exclusive
categories. An item satisfying two rules lands in both buckets, so summing
bucket lengths can exceed the batch size — that's the design, not a bug.

Source: docs/overview.md; docs/guides/buckets.md

### HIGH Branching a shared engine variable instead of using `clone()`

Wrong:

```ts
const base = engineWithConditions;
const one = base.defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.defineBucket({ name: "b", checkFn: () => "isDigital" });
// one === two === base; both hold *both* buckets at runtime
```

Correct:

```ts
const one = base.clone().defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.clone().defineBucket({ name: "b", checkFn: () => "isDigital" });
```

`define*` methods mutate the engine and return the same object. Two
variables built off one shared engine point at the same runtime object
holding every bucket ever defined on it, even though each call's return
type only claims what it just added.

Source: docs/guides/cloning.md

### MEDIUM Expecting a `NOT(...)` or plain-boolean bucket to narrow its item type

Wrong:

```ts
.defineCondition({ name: "isString", checkFn: (v): v is string => typeof v === "string" })
.defineBucket({ name: "notStrings", checkFn: ({ NOT }) => NOT("isString") })
// report.buckets.notStrings.map(v => v.length) — compile error, type is still the input type
```

Correct:

```ts
// If you need the narrowed type, write the positive predicate for what it IS
.defineCondition({ name: "isNumber", checkFn: (v): v is number => typeof v === "number" })
.defineBucket({ name: "numbers", checkFn: () => "isNumber" })
```

`NOT` proves nothing about what an item is, only what it isn't, and a
condition without a type predicate contributes nothing to narrow. This is
correct behavior, not a bug to cast around.

Source: docs/guides/narrowing.md; docs/reference/combinators.md

### MEDIUM Calling `process()`/`processOne()` before any bucket is defined

Wrong:

```ts
const engine = new BucketEngine().defineInput<Item>().defineCondition({ name: "a", checkFn: (i) => i.a });
await engine.process(items); // throws — no bucket defined yet
```

Correct:

```ts
const engine = new BucketEngine()
  .defineInput<Item>()
  .defineCondition({ name: "a", checkFn: (i) => i.a })
  .defineBucket({ name: "hasA", checkFn: () => "a" });
await engine.process(items);
```

Both require at least one bucket and an input; `processConditions()` is the
exception — it needs only an input, no bucket.

Source: docs/reference/bucket-engine.md

### MEDIUM Assuming `BucketEngine.processOne` doesn't throw, like `ActionEngine.processOne` does

Wrong:

```ts
// Copied from ActionEngine code, assuming errors come back in a field
const result = await bucketEngine.processOne(item);
if (result.errors.length) { /* ... */ } // BucketAssignment has no `errors` field — throws before this line
```

Correct:

```ts
try {
  const result = await bucketEngine.processOne(item);
} catch (error) {
  // error is a BucketError
}
```

`BucketEngine.processOne` throws on a validation or condition failure —
with one item there's no rest-of-the-batch to protect. `ActionEngine`'s
independence guarantees mean its `processOne` deliberately does not throw.
Code moved between the two engines without updating error handling will
misbehave.

Source: docs/reference/bucket-engine.md; docs/reference/action-engine.md

### HIGH Tension: Ordering strictness vs iterative prototyping

`model-decision-logic`'s ordering rules (every condition before the first
bucket) cut against bolting on "just one more condition" once buckets
already exist here. Agents iterating quickly hit a `BucketError` and may
try to work around the ordering instead of `clone()`-ing the pre-bucket
engine or front-loading conditions.

See also: model-decision-logic/SKILL.md § Common Mistakes

### MEDIUM Tension: BucketEngine vs ActionEngine mental models

`BucketEngine`'s shared boolean vocabulary (conditions reused and combined
across many buckets, `ONLY` depending on the complete set) pulls toward one
engine per decision domain. `run-independent-actions`'s independent,
non-shared predicate-and-effect pairs pull the other way. A "categorize and
notify" task can lead an agent to pick the wrong engine for half the
problem.

See also: run-independent-actions/SKILL.md § Common Mistakes

### MEDIUM Tension: Type-narrowing honesty vs quick predicates

Un-narrowed predicates (see `model-decision-logic`) are faster to write but
lose their payoff here: a bucket built on a plain-boolean condition keeps
the engine's input type instead of the narrowed variant, even in
discriminated-union cases (a router, a variant dispatch) where narrowing is
most of the value.

See also: model-decision-logic/SKILL.md § Common Mistakes

See also: run-independent-actions/SKILL.md — if the task turns out to be
"fire effects on qualifying items" rather than "group items under shared,
combinable rules," `ActionEngine` is the sibling to reach for instead.
