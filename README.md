# @michaelrwalker/buckets

A rule engine for sorting items into named buckets. You declare named
conditions over an item, then declare buckets as boolean expressions over those
conditions — so the expensive, awkward part (is this thing digital? does this
account pay us?) is written once and answered once per item, and the rules on
top read like the sentences you'd use to describe them.

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

const fulfilment = new BucketEngine()
  .defineInput(z.object({ sku: z.string(), weightKg: z.number().nullable(), downloadUrl: z.string().nullable() }))
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
  .defineCondition({ name: "isDownloadable", checkFn: (p) => p.downloadUrl !== null })
  .defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
  .defineBucket({ name: "digitalDelivery", checkFn: () => "isDownloadable" })
  .defineBucket({ name: "purelyPhysical", checkFn: ({ ONLY }) => ONLY("hasWeight") })
  .defineBucket({
    name: "incomplete",
    checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("isDownloadable")),
  });

const report = await fulfilment.process(catalogue);

report.buckets.warehouse;      // Product[]
report.buckets["digitalMedia"] // compile error — no such bucket
```

Condition names, bucket names and the shape of the report are all inferred. The
combinators handed to `checkFn` are bound to *your* condition names, so
`NOT("hasWieght")` is a compile error on the name itself rather than a rule that
silently never fires.

## Buckets are independent rules

An item lands in **every** bucket whose expression it satisfies. A vinyl record
with a download code is in both `warehouse` and `digitalDelivery`, because it
genuinely needs both. Summing the buckets can exceed the size of the batch, and
that isn't a bug — it's the point.

What's guaranteed is that no item disappears: every one ends up in at least one
bucket, in `unmatched`, or in `errors`.

Conditions a rule doesn't mention are **free**. `checkFn: () => "hasWeight"`
matches anything with a weight, whatever else is true of it. When you want the
strict reading, `ONLY` gives it to you: `ONLY("hasWeight")` means a weight *and
nothing else true*.

| Combinator | Meaning |
| --- | --- |
| `"hasWeight"` | A bare name is the condition itself — legal anywhere an expression is |
| `AND(...)` | Every operand holds |
| `OR(...)` | At least one operand holds |
| `NOT(x)` | The operand does not hold |
| `ONLY(...names)` | Exactly these hold and every other condition is false |

Four is all you need when the operands are booleans. Anything else — "at least
two of these", "exactly one of those" — is an `OR` of `AND`s, and usually reads
better written out.

## Buckets know their own item type

Declare a condition with a **type predicate** and the engine records what that
condition proves. The combinators carry it through the expression, so a bucket
hands back the narrow type rather than the engine's input type:

```ts
const sorter = new BucketEngine()
  .defineInput<unknown>()
  .defineCondition({ name: "isString", checkFn: (v): v is string => typeof v === "string" })
  .defineCondition({ name: "isNumber", checkFn: (v): v is number => typeof v === "number" })
  .defineBucket({ name: "strings", checkFn: () => "isString" })
  .defineBucket({ name: "scalars", checkFn: ({ OR }) => OR("isString", "isNumber") });

const report = await sorter.process(mixedBag);

report.buckets.strings.map((s) => s.toUpperCase()); // string[]  — no cast
report.buckets.scalars;                             // (string | number)[]
```

It composes the way the logic does:

| Rule | Bucket item type |
| --- | --- |
| `() => "isString"` | `string` |
| `OR("isString", "isNumber")` | `string \| number` |
| `AND("isString", "isTruthy")` | `string` — a non-predicate condition narrows the *set*, not the type |
| `AND("isString", "isNumber")` | `never` — the type says nothing can ever be in it, which is true |
| `NOT("isString")` | the input type — knowing what something *isn't* proves nothing |

The useful case is a discriminated union, because TypeScript reduces the
intersection of two narrowed unions to the variant they share. That makes an
HTTP router fall out of it — see `examples/router.ts`:

```ts
.defineCondition({ name: "isPOST",  checkFn: (r): r is Extract<Req, { method: "POST" }> => r.method === "POST" })
.defineCondition({ name: "toUsers", checkFn: (r): r is Extract<Req, { path: "/users" }> => r.path === "/users" })
.defineBucket({ name: "createUser", checkFn: ({ AND }) => AND("isPOST", "toUsers") })

for (const request of report.buckets.createUser) {
  request.body.email; // string — the other variants are gone
  request.body.sku;   // compile error, that's the order route
}
```

You don't always have to write the predicate yourself: TypeScript infers one
for a `checkFn` like `(m) => m.channel === "email"`, and the engine picks that
up too.

Two things worth being clear about. This is a **claim, not a proof** — the
narrowing is only as honest as your predicate, exactly like any other type
guard. And it's opt-in: a condition returning plain `boolean` narrows nothing,
and its buckets keep the engine's input type, which is what every example other
than these two does.

## Install

```bash
npm install @michaelrwalker/buckets
```

Ships as TypeScript source — `main` and `types` both point at `main.ts`, so
what you read in your editor is what's published, with no `.d.ts` shadows and
no build step. Requires a toolchain that compiles TypeScript from
`node_modules` (Node's `--experimental-transform-types`, tsx, Bun, Vite,
Next.js, and most bundlers do this already).

Its one runtime dependency is [`@standard-schema/spec`](https://standardschema.dev),
which is types only and disappears at runtime. Bring whichever validation
library you like — Zod, Valibot, ArkType, Effect Schema — or none at all.

## `defineInput`

Describes the items being sorted. Call it first, before any condition.

| Form | Behaviour |
| --- | --- |
| `.defineInput(schema)` | Infers the item type from a Standard Schema's **output** and validates every item at runtime. A schema that transforms means conditions and the report both see the transformed value. |
| `.defineInput<Product>()` | Types only. Nothing is validated, so `report.errors` can then only contain condition failures. |

## `defineCondition`

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes part of the engine's type. Must be unique. |
| `checkFn` | `(item) => boolean \| Promise<boolean>` | May be async. The return value is coerced with `Boolean()`. Throwing sends that one item to `report.errors`. Write it as a type predicate — `(item): item is X` — to also narrow the buckets built from it. |

Every condition is evaluated once per item, in parallel, before any rule runs —
so a condition used by five buckets still costs one call. Define all of them
before the first bucket: `ONLY` means "these and nothing else", so a condition
added later would quietly change what an existing `ONLY` rule matches. The
engine rejects it rather than let that happen.

## `defineBucket`

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes a key of `report.buckets`. Must be unique — the only uniqueness rule there is. |
| `checkFn` | `(logic) => expression` | Receives `{ AND, OR, NOT, ONLY }` bound to your condition names. Return an expression, or a bare condition name. |

Expressions are plain data, so they can be built outside a bucket, named, shared
and negated — `checkFn` then just returns one:

```ts
import { NOT, OR } from "@michaelrwalker/buckets";

const missingSomething = OR(NOT("hasPhotos"), NOT("hasPrice"));

.defineBucket({ name: "incomplete", checkFn: () => missingSomething })
.defineBucket({ name: "ready",      checkFn: () => NOT(missingSomething) })
```

The callback form is worth preferring where you can, because it's the one that
types the condition names for you.

## `process(items, options?)`

Sorts a batch:

| Field | Type | Contains |
| --- | --- | --- |
| `buckets` | `Record<BucketName, Item[]>` | One key per declared bucket, always present even when empty. An item appears under every rule it satisfied. |
| `unmatched` | `{ item, conditions }[]` | Items that satisfied no rule. `conditions` is the combination that matched nothing — usually the rule you have yet to write. |
| `errors` | `{ item, stage, condition?, error }[]` | Items that couldn't be classified. `stage` is `"input"` (schema rejected it) or `"condition"` (a `checkFn` threw, and `condition` names it). |

Bad data never throws here — one unparseable record shouldn't cost you the
other 9,999. Configuration mistakes still throw, since those are yours rather
than the data's.

| Option | Default | Notes |
| --- | --- | --- |
| `concurrency` | `256` | How many items to evaluate at once. Raise it when conditions do I/O and the far end can take the traffic; lower it when it can't. Output order matches input order regardless. |

The default is bounded because each lane keeps one item's condition promises
alive while it runs, so `Infinity` means every row's promises exist at once.
Measured on `examples/scale.ts` at 500,000 rows of synchronous predicates:

| `concurrency` | Time | Throughput | Heap |
| --- | --- | --- | --- |
| 64 | 528 ms | 947k rows/sec | 258 MB |
| 256 (default) | 573 ms | 873k rows/sec | 283 MB |
| 4096 | 686 ms | 729k rows/sec | 247 MB |
| `Infinity` | 1785 ms | 280k rows/sec | 2435 MB |

Unbounded is both the slowest and the heaviest, which is why it isn't the
default — but it's there if you want it.

## `processOne(item)`

Sorts a single item and resolves to `{ item, buckets, conditions }`, where
`buckets` lists every rule it satisfied, in definition order. An empty array
means it satisfied none. Unlike `process`, this **throws** on a validation or
condition failure: with one item there is no rest-of-the-batch to protect, and a
caller handling one record wants the failure at the call site.

## Introspection

| Member | Returns |
| --- | --- |
| `conditionNames` | Condition names, in definition order. |
| `bucketNames` | Bucket names, in definition order. |
| `missingCombinations()` | Every combination of conditions that satisfies no rule, each as the conditions that would be true. These are exactly the items that would land in `unmatched`, so it answers "what have I not written a rule for?" before the data tells you. Refuses to enumerate past 16 conditions — the only thing here that ever enumerates. |

## Errors

Everything thrown is a `BucketError`. Configuration mistakes throw immediately
from the `define*` call that made them, so a misconfigured engine can't reach
`process`:

- a duplicate condition or bucket name
- a condition defined after the first bucket
- a rule referencing a condition that doesn't exist
- a `checkFn` returning something that is neither a condition name nor an
  expression, or `AND()`/`OR()` with no operands
- `defineInput` called twice, after a condition, or with a non–Standard Schema
- `process` or `processOne` before an input or any bucket is defined
- a `concurrency` that isn't a positive integer or `Infinity`

When a `BucketError` comes from schema validation it carries the library's raw
`issues` so you can render them yourself.

Note what is *not* an error: rules that overlap, a rule that can never match
(`AND("a", NOT("a"))`), and combinations no rule covers. All three are legal —
overlap is the design, and the other two are what `missingCombinations()` and
an empty bucket are for.

## Development

```bash
npm test
npm run typecheck
npm run format
npm run fix
npm run example
```
