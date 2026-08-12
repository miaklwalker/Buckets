---
title: "Async Conditions and Performance"
description: "Writing async conditions, handling failures, and tuning concurrency for large batches."
---

`checkFn` may return `boolean | Promise<boolean>`, so a condition is allowed
to be asynchronous. Treat that as an escape hatch, not the primary use case.
It exists mainly for local, bounded work: a filesystem read, a lookup against
something already in memory or on disk. Real network work, an API call, a
database round trip, anything with retries or backoff to think about, is
better handled by something built for orchestrating I/O, like Stagehand.
Buckets evaluates a predicate; it doesn't sequence or retry a call for you.

The example below still uses a network call, since it's the clearest way to
show what an async condition looks like end to end. In practice, keep them
this rare, and know that reaching for one often enough is a sign the network
call belongs in a step before the data ever reaches `process()`.

Once conditions leave pure-function land, three things start to matter: schema
validation of what arrives, bounding how many items are in flight at once,
and where a failed lookup ends up.

## A triage example

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BucketEngine } from "@michaelrwalker/buckets";

interface Ticket {
  readonly id: string;
  readonly accountId: string;
  readonly body: string;
}

/** Stands in for a billing service call. Throws for an account it can't find. */
async function isPaidAccount(accountId: string): Promise<boolean> {
  const account = await billing.lookup(accountId);
  return account.plan !== "free";
}

const triage = new BucketEngine()
  .defineInput<Ticket>() // or defineInput(ticketSchema) to validate at runtime
  .defineCondition({
    name: "payingCustomer",
    checkFn: (ticket) => isPaidAccount(ticket.accountId),
  })
  .defineCondition({
    name: "mentionsOutage",
    checkFn: (ticket) => /outage|down|500/i.test(ticket.body),
  })
  .defineBucket({
    name: "pageOnCall",
    checkFn: ({ AND }) => AND("payingCustomer", "mentionsOutage"),
  })
  .defineBucket({ name: "priorityQueue", checkFn: () => "payingCustomer" })
  .defineBucket({
    name: "communityForum",
    checkFn: ({ AND, NOT }) => AND("mentionsOutage", NOT("payingCustomer")),
  });

const report = await triage.process(tickets, { concurrency: 4 });
```

## Skipping an async condition with `when`

If `isPaidAccount` is the expensive part, gating it on a cheap precondition
means it only runs for tickets that could possibly need it:

```ts
.defineCondition({
  name: "hasAccount",
  checkFn: (ticket) => ticket.accountId !== null,
})
.defineCondition({
  name: "payingCustomer",
  when: () => "hasAccount",
  checkFn: (ticket) => isPaidAccount(ticket.accountId),
})
```

A ticket with no `accountId` never calls `isPaidAccount` at all —
`payingCustomer` is recorded `false` without it running. This is a real
compute saving specifically when `checkFn` is the expensive one; for a cheap
synchronous check, skipping it saves nanoseconds and isn't the point — see
the Preconditions guide for what `when` buys you beyond the skip. Conditions
with nothing gating them still run concurrently, in one wave; a `when` adds a
wave boundary only where a real dependency exists.

## When a condition throws

Bad data never throws out of `process()`: one unparseable record, or one
failed lookup, shouldn't cost you the other 9,999. A throwing `checkFn` sends
that single item to `report.errors` and the rest of the batch continues:

```ts
for (const failure of report.errors) {
  // stage is "input" (schema rejected it) or "condition" (a checkFn threw)
  const where = failure.condition ?? failure.stage;
  console.log(`failed (${where}): ${failure.error.message}`);
}
```

`processOne`, by contrast, **throws** on the same failures. With a single
item there's no rest-of-the-batch to protect, and a caller handling one
record at a time wants the failure at the call site rather than wrapped in a
report:

```ts
try {
  const result = await triage.processOne(ticket);
} catch (error) {
  // error is a BucketError
}
```

## `concurrency`

`process(items, options)` accepts a `concurrency` option controlling how many
items are evaluated at once:

| Option | Default | Notes |
| --- | --- | --- |
| `concurrency` | `256` | How many items to evaluate at once. Raise it when conditions do I/O and the far end can take the traffic; lower it when it can't. Output order matches input order regardless. |

```ts
const report = await triage.process(tickets, { concurrency: 4 });
```

Output order always matches input order, whatever `concurrency` is set to:
a bucketed report that reshuffled itself depending on which predicate
resolved first would be miserable to diff or snapshot.

### Why the default is bounded, not `Infinity`

Each lane keeps one item's condition promises alive for as long as it's
running, so `concurrency: Infinity` means every item's promises exist
simultaneously: for a large batch, that's a lot of live promises at once.
Measured on 500,000 rows of synchronous predicates:

| `concurrency` | Time | Throughput | Heap |
| --- | --- | --- | --- |
| 64 | 528 ms | 947k rows/sec | 258 MB |
| 256 (default) | 573 ms | 873k rows/sec | 283 MB |
| 4096 | 686 ms | 729k rows/sec | 247 MB |
| `Infinity` | 1785 ms | 280k rows/sec | 2435 MB |

Unbounded is both the slowest and the heaviest option here, which is why it
isn't the default, but it's still available as an explicit `Infinity`.

`concurrency` must be a positive integer or `Infinity`; anything else throws
a `BucketError` immediately, before any items are processed.

## Scaling with the size of the batch

Conditions are evaluated once per item, and each bucket's rule is then a walk
over a small expression tree. The work is linear in
`(rows × conditions) + (rows × rules)`, with nothing exponential in it. The
only part of the library that can blow up combinatorially is
`missingCombinations()` (see the BucketEngine reference), which is why it
refuses to run past 16 conditions.

```ts
const engine = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({ name: "hasWeight", checkFn: (l) => l.weightKg !== null })
  .defineCondition({ name: "hasPhotos", checkFn: (l) => l.photos > 0 })
  .defineCondition({ name: "hasPrice", checkFn: (l) => l.price !== null })
  .defineBucket({
    name: "sellable",
    checkFn: ({ AND }) => AND("hasPhotos", "hasPrice"),
  });

const startedAt = performance.now();
const report = await engine.process(rows);
const elapsedMs = performance.now() - startedAt;
```

A row is stored by reference in each bucket it matched, not copied, so
membership in several overlapping buckets doesn't multiply memory use by the
row's size, only by the number of references.
