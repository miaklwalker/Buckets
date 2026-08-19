---
name: 'tune-async-and-scale'
description: >
  Async checkFns are an escape hatch for local, bounded work — not the
  default way to write a condition. Covers when reaching for async is
  actually warranted, tuning the concurrency option for large batches,
  auditing conditions with processConditions() before a bucket exists, and
  watching a long batch progress live with onProgress/liveConditionReport().
  Load this before writing a condition that does more than a single
  synchronous check.
metadata:
  type: core
  library: '@michaelrwalker/buckets'
  library_version: '0.5.0'
sources:
  - 'docs/guides/async-and-performance.md'
  - 'docs/reference/process-output.md'
  - 'docs/reference/bucket-engine.md'
  - 'modules/report.ts'
  - 'modules/schedule.ts'
---

# Tune Async Conditions and Scale

`checkFn` may return `boolean | Promise<boolean>`. Treat that as an escape
hatch for local, bounded work — a filesystem read, a lookup against
something already in memory — not the default way to write a condition, and
not a place to sequence or retry real network calls. `BucketEngine`
evaluates a predicate; it doesn't orchestrate I/O.

## Setup

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

interface Ticket {
  readonly id: string;
  readonly accountId: string;
  readonly body: string;
}

async function isPaidAccount(accountId: string): Promise<boolean> {
  const account = await billing.lookup(accountId); // throws for an unknown account
  return account.plan !== "free";
}

const triage = new BucketEngine()
  .defineInput<Ticket>()
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
  });

const report = await triage.process(tickets, { concurrency: 4 });
```

## Core Patterns

### Recognize when a condition should be async — vs when the I/O belongs before `process()`

Reaching for an async condition often enough is a sign the network call
belongs in a step before the data ever reaches `process()`:

```ts
// Prefer: resolve the I/O first, checkFn stays a pure lookup
const accounts = await billingLookupWithRetries(tickets.map((t) => t.accountId));
.defineCondition({
  name: "payingCustomer",
  checkFn: (ticket) => accounts.get(ticket.accountId)?.plan !== "free",
})
```

Reach for `checkFn: async (item) => ...` only for local, bounded work — not
retries, backoff, or anything with real network latency to manage.

### Skip an expensive async condition with `when`

```ts
.defineCondition({ name: "hasAccount", checkFn: (t) => t.accountId !== null })
.defineCondition({
  name: "payingCustomer",
  when: () => "hasAccount",
  checkFn: (t) => isPaidAccount(t.accountId), // never runs when hasAccount is false
})
```

### Tune `concurrency` by measurement, not by reaching for the extremes

```ts
await triage.process(tickets, { concurrency: 64 }); // measure, then adjust
```

Default is `256`. Output order always matches input order regardless of
`concurrency`.

### Audit conditions before a bucket exists

```ts
import { formatConditionReport } from "@michaelrwalker/buckets";

const report = await triage.processConditions(tickets);
console.log(formatConditionReport(report.summary));
```

`processConditions()` needs only `.defineInput()` — no bucket.

## Common Mistakes

### HIGH Using an async condition to do real network I/O with retries/backoff

Wrong:

```ts
.defineCondition({
  name: "payingCustomer",
  checkFn: async (ticket) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return (await billing.lookup(ticket.accountId)).plan !== "free"; }
      catch { await sleep(2 ** attempt * 100); }
    }
    throw new Error("billing lookup failed after retries");
  },
})
```

Correct:

```ts
// Resolve the I/O before process() runs; checkFn stays a pure lookup
const accounts = await billingLookupWithRetries(tickets.map((t) => t.accountId));
.defineCondition({
  name: "payingCustomer",
  checkFn: (ticket) => accounts.get(ticket.accountId)?.plan !== "free",
})
```

Async `checkFn` support exists mainly for local, bounded work. Real network
work — retries, backoff, anything with latency to manage — is better
handled by something built for orchestrating I/O, before the batch ever
reaches `process()`.

Source: docs/guides/async-and-performance.md

### MEDIUM Setting `concurrency: Infinity` expecting it to be faster or safer

Wrong:

```ts
await engine.process(largeItemBatch, { concurrency: Infinity }); // slowest and heaviest option
```

Correct:

```ts
await engine.process(largeItemBatch, { concurrency: 256 }); // default; raise/lower based on measurement
```

Each lane keeps one item's condition promises alive while running, so
`Infinity` means every item's promises exist simultaneously. Measured on
500,000 rows: `Infinity` is both the slowest (1785ms vs 573ms at the
default 256) and the heaviest (2435MB vs 283MB heap) option, which is why
it isn't the default.

Source: docs/guides/async-and-performance.md

### LOW Reusing one `liveConditionReport()` callback across two concurrent batches

Wrong:

```ts
const onProgress = liveConditionReport();
await Promise.all([
  engineA.processConditions(batchA, { onProgress }),
  engineB.processConditions(batchB, { onProgress }), // shares redraw state with the call above
]);
```

Correct:

```ts
await Promise.all([
  engineA.processConditions(batchA, { onProgress: liveConditionReport() }),
  engineB.processConditions(batchB, { onProgress: liveConditionReport({ stream: secondStream }) }),
]);
```

Each call to `liveConditionReport()` creates its own independent redraw
state (last-drawn frame, throttle timer). Sharing one callback instance
across two concurrent batches corrupts the redraw — frames interleave
against shared state instead of drawing independently.

Source: modules/report.ts; docs/reference/bucket-engine.md

### LOW Assuming `onProgress` fires in input order

Wrong:

```ts
let i = 0;
engine.processConditions(items, {
  onProgress: () => console.log(`finished ${items[i++].id}`), // wrong — not completion-matched
});
```

Correct:

```ts
// Use the fields onProgress actually provides, not an assumed correspondence to input order
engine.processConditions(items, {
  onProgress: ({ completed, total }) => console.log(`${completed}/${total} done`),
});
```

`onProgress` fires once per item in **completion order**, not input order —
the only order live progress can honestly report, since items finish
whenever their conditions do.

Source: docs/reference/process-output.md (ConditionProgress)

### LOW Calling `missingCombinations()` past the 16-condition cap

Wrong:

```ts
// 20 plain conditions defined on the engine
engine.missingCombinations(); // throws — refuses past 16 conditions
```

Correct:

```ts
// Group related conditions into computed conditions to reduce the
// free-variable count, or check coverage per sub-area instead of globally
```

`missingCombinations()` enumerates every 2^n assignment of the plain
conditions. It refuses to run past 16 conditions (65,536 combinations) and
throws a `BucketError` instead of hanging — the only place in the library
that enumerates combinatorially.

Source: docs/reference/bucket-engine.md

### HIGH Tension: Async escape hatch vs bounded concurrency

`model-decision-logic` makes it easy to reach for "just do the I/O here" in
a condition, but this domain's concurrency model is tuned for cheap,
bounded lookups, not orchestrated network calls with retries. Treating
every I/O-shaped need as "put it in an async condition" ends up fighting
the concurrency defaults (or setting `concurrency: Infinity` to compensate)
instead of pre-fetching before `process()` runs.

See also: model-decision-logic/SKILL.md § Common Mistakes

See also: model-decision-logic/SKILL.md — `when`'s skip behavior (`checkFn`
never runs when the precondition fails) is often the cheaper alternative to
making a condition async in the first place.
