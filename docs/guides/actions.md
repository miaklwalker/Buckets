---
title: "Actions"
description: "How defineAction works, how independent actions behave differently from buckets, and what that means for errors and unmatched items."
---

`ActionEngine` is `BucketEngine`'s sibling for a different shape of problem:
instead of sorting items into named groups, you want to run named effects —
send an email, dispatch a job, charge a fee — on the items that qualify for
each one.

```ts
import { ActionEngine } from "@michaelrwalker/buckets";

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

## One step, not two

`BucketEngine` separates naming a condition (`defineCondition`) from
declaring a rule over named conditions (`defineBucket`), because a bucket's
`AND`/`OR`/`ONLY` expression can reuse a condition across many buckets.
Actions don't share expressions with each other, so there's nothing to name
separately: `defineAction` takes the predicate and the effect together.

That also means there's no `ONLY` here, and no ordering requirement between
actions — each one is self-contained, so declaring `flagForReview` before or
after `notifyWarehouse` makes no difference.

## Actions are independent, like buckets

An order that is both paid and risky triggers **both** `notifyWarehouse` and
`flagForReview` — nothing had to be enumerated to say so. This is the same
independence buckets have: `checkFn`s that overlap just mean both actions
run.

## Unlike buckets, one action's failure doesn't poison another

A bucket's rule can reference several conditions in one expression, so if one
of those conditions throws, the engine has no sound way to evaluate the rule
— the whole item fails. An action's `checkFn` and `actionFn` don't feed into
anyone else's decision, so `ActionEngine` doesn't need that caution:

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

`chargeFraudFee` failing for `order-3` is recorded in `report.errors` and
never touches `flagForReview`, which still ran for that same order. This is
also why `processOne()` doesn't throw on a `checkFn`/`actionFn` failure the
way `BucketEngine.processOne()` does: with actions, a single failure was
never the whole story for that item.

## What counts as unmatched

An item lands in `report.unmatched` only when **every** action's `checkFn`
ran to completion and **none** of them matched. An item that errored on one
action is never also reported as unmatched, even if none of its other
actions matched either — "no action fired" and "an action fired and threw"
are different facts, and conflating them would hide the error.

## Writing `checkFn` and `actionFn`

Both may be sync or async:

```ts
.defineAction({
  name: "chargeFraudFee",
  checkFn: (order) => order.riskScore > 80,
  actionFn: async (order) => chargeCard(order.paymentMethodId, order.total),
})
```

Write `checkFn` as a type predicate — `(item): item is X => ...` — to have
`actionFn` receive the narrowed type instead of `TInput`, exactly as a
condition narrows a bucket in `BucketEngine`. See the Type Narrowing guide;
the mechanics are identical.

`actionFn`'s return value is not required to be meaningful — an action whose
whole point is a side effect can return `undefined` — but when it does return
something, that value ends up in `report.results[name]` alongside the item,
which is useful for actions that fetch or compute something you want back.
