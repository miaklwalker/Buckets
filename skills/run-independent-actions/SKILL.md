---
name: 'run-independent-actions'
description: >
  Use ActionEngine's defineAction to run named side effects (notify,
  dispatch, charge a fee) on the items that qualify for each one,
  independently of one another. Covers process()/processOne(), and how
  ActionEngine's failure and unmatched semantics differ from BucketEngine's
  shared-expression model. Load this when the task is "run effects on
  qualifying items," not "group items under shared, combinable rules."
metadata:
  type: core
  library: '@michaelrwalker/buckets'
  library_version: '0.5.0'
sources:
  - 'docs/guides/actions.md'
  - 'docs/reference/action-engine.md'
  - 'modules/actionEngine.ts'
---

# Run Independent Actions

## Setup

```ts
import { ActionEngine } from "@michaelrwalker/buckets";

interface Order {
  readonly id: string;
  readonly status: "paid" | "pending";
  readonly riskScore: number;
}

const dispatch = new ActionEngine()
  .defineInput<Order>()
  .defineAction({
    name: "notifyWarehouse",
    checkFn: (order) => order.status === "paid",
    actionFn: (order) => dispatchToWarehouse(order.id),
  })
  .defineAction({
    name: "flagForReview",
    checkFn: (order) => order.riskScore > 80,
    actionFn: (order) => queueForReview(order.id),
  });

const report = await dispatch.process(orders);
report.results.notifyWarehouse; // { item, result }[]
```

Actions may be declared in any order relative to each other — there's no
`ONLY`-style dependency on the complete set, because actions never share a
boolean expression with each other.

## Core Patterns

### An order that qualifies for two actions triggers both

```ts
// An order that is both paid and risky triggers BOTH notifyWarehouse and
// flagForReview — nothing had to be enumerated to say so, the same
// independence buckets have.
```

### One action's failure doesn't stop another action on the same item

```ts
const report = await new ActionEngine()
  .defineInput<Order>()
  .defineAction({
    name: "chargeFraudFee",
    checkFn: (order) => order.riskScore > 80,
    actionFn: (order) => chargeFee(order.id), // throws for order-3
  })
  .defineAction({
    name: "flagForReview",
    checkFn: (order) => order.riskScore > 80,
    actionFn: (order) => queueForReview(order.id),
  })
  .process(orders);

report.results.flagForReview; // still includes order-3
report.errors; // [{ item: order-3, stage: "action", action: "chargeFraudFee", ... }]
```

### `processOne` returns errors instead of throwing

```ts
const one = await dispatch.processOne(order);
// { item, matched, results, checks, errors }
// matched: every action that ran successfully, in definition order
// errors: this item's action failures — processOne does NOT throw on them
```

`ActionEngine.processOne` only throws an `ActionError` when input
validation itself fails, since nothing can run without a valid item.

### Write `checkFn` as a type predicate to narrow `actionFn`'s input

```ts
.defineAction({
  name: "chargeFraudFee",
  checkFn: (order): order is Order & { paymentMethodId: string } =>
    order.riskScore > 80 && order.paymentMethodId !== undefined,
  actionFn: (order) => chargeCard(order.paymentMethodId, order.total), // no `?.` needed
})
```

## Common Mistakes

### HIGH Assuming one action's failure poisons another, the way one condition's failure poisons a bucket

Wrong:

```ts
// Assuming a failed action means no other action ran for this item
if (report.errors.some((e) => e.item === order)) {
  assert(!report.results.flagForReview.some((r) => r.item === order)); // wrong — it can still be there
}
```

Correct:

```ts
// flagForReview's success and chargeFraudFee's failure are independent facts
const flagged = report.results.flagForReview.some((r) => r.item === order);
const chargeFailed = report.errors.some((e) => e.item === order && e.action === "chargeFraudFee");
// both can be true at once
```

A bucket's rule can reference several conditions in one boolean expression,
so one throwing condition makes the whole item unevaluable for that rule.
Actions don't share expressions with each other at all — `chargeFraudFee`
throwing is recorded in `report.errors` and `flagForReview` still runs for
that same item.

Source: docs/guides/actions.md

### MEDIUM Reaching for the wrong engine — ActionEngine vs BucketEngine — for the task

Wrong:

```ts
// Using ActionEngine to build what's actually a shared decision table,
// duplicating the same checkFn logic across several actions
.defineAction({ name: "warehouse", checkFn: (p) => p.weightKg !== null, actionFn: (p) => routeToWarehouse(p) })
.defineAction({ name: "digital", checkFn: (p) => p.downloadUrl !== null, actionFn: (p) => routeToDigital(p) })
// no shared vocabulary, no ONLY, no way to express "purely physical" without repeating both checks
```

Correct:

```ts
// BucketEngine when the checks compose into a shared vocabulary
const routing = new BucketEngine()
  .defineInput<Product>()
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
  .defineCondition({ name: "isDigital", checkFn: (p) => p.downloadUrl !== null })
  .defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
  .defineBucket({ name: "digital", checkFn: () => "isDigital" })
  .defineBucket({ name: "purelyPhysical", checkFn: ({ ONLY }) => ONLY("hasWeight") });
```

The two engines have nearly identical fluent APIs, so a task description
that sounds like both ("categorize and notify") can lead to picking the
wrong one. If the real need is a shared, combinable boolean vocabulary,
it's `BucketEngine`, even if some buckets trigger effects downstream; if
it's independent effects with no `ONLY`-style completeness requirement,
it's `ActionEngine`.

Source: maintainer interview (library is new — this failure mode is a
provisional inference, not yet an observed real-world mistake)

### MEDIUM Assuming `ActionEngine.processOne` throws, like `BucketEngine.processOne` does

Wrong:

```ts
try {
  const result = await actionEngine.processOne(item);
} catch (error) {
  // unreachable for a checkFn/actionFn failure — ActionEngine.processOne doesn't throw for these
}
```

Correct:

```ts
const result = await actionEngine.processOne(item);
if (result.errors.length > 0) {
  // handle per-action failures here instead
}
```

`BucketEngine.processOne` throws because a bucket's rule can share
conditions across an expression — a single item has no rest-of-the-batch to
protect. `ActionEngine.processOne` deliberately does not throw on a
`checkFn`/`actionFn` failure, since actions are independent and one failing
shouldn't hide whether the others matched.

Source: docs/reference/action-engine.md

### MEDIUM Tension: BucketEngine vs ActionEngine mental models

This domain's independent, non-shared predicate-and-effect pairs pull
toward `ActionEngine`; `sort-items-into-buckets`'s shared boolean
vocabulary (conditions combined across many buckets, `ONLY` depending on
the complete set) pulls the other way. A "categorize and notify" task can
lead to picking the wrong engine for half the problem.

See also: sort-items-into-buckets/SKILL.md § Common Mistakes

See also: sort-items-into-buckets/SKILL.md — the report shape looks
similar (`results`/`unmatched`/`errors` vs `buckets`/`unmatched`/`errors`)
but means different things for independence guarantees; worth cross-
checking when moving code between the two engines.
