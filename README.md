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

### Every two-input operator, written out

The usual named operators, and how each one is spelled here. `A` and `B` are two
conditions; `T` means the rule matches that combination.

| A | B | AND | OR | XOR | NAND | NOR | XNOR | A→B | `ONLY(A)` | `ONLY()` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T | T | **T** | **T** | F | F | F | **T** | **T** | F | F |
| T | F | F | **T** | **T** | **T** | F | F | F | **T** | F |
| F | T | F | **T** | **T** | **T** | F | F | **T** | F | F |
| F | F | F | F | F | **T** | **T** | **T** | **T** | F | **T** |

```ts
AND   →  AND("condOne", "condTwo")                       // both
OR    →  OR("condOne", "condTwo")                        // at least one
XOR   →  AND(OR("condOne", "condTwo"),                   // one but not both
             NOT(AND("condOne", "condTwo")))
NAND  →  NOT(AND("condOne", "condTwo"))                  // not both
NOR   →  NOT(OR("condOne", "condTwo"))                   // neither
XNOR  →  OR(AND("condOne", "condTwo"),                   // both or neither
            AND(NOT("condOne"), NOT("condTwo")))
A→B   →  OR(NOT("condOne"), "condTwo")                   // if one, then two
```

`XOR` also reads well the long way round, as "one without the other, either way":
`OR(AND("condOne", NOT("condTwo")), AND(NOT("condOne"), "condTwo"))`. Both give
the same column.

Two of these are worth pausing on, because they're where intuition usually
slips. **`NAND` is not `NOR`.** `NOT(AND(A, B))` says *not both*, so it matches
the two mixed rows as well as the empty one — the inner `AND` is evaluated to a
boolean and then flipped, nothing more. *Neither* is `NOT(OR(A, B))`. Written
flat those are `OR(NOT(A), NOT(B))` and `AND(NOT(A), NOT(B))` respectively,
which is [De Morgan's laws](https://en.wikipedia.org/wiki/De_Morgan%27s_laws):
negating a group swaps `AND` and `OR`. The engine never performs that rewrite —
it just evaluates the tree you gave it — but the identity is what makes the two
forms agree on every row.

The last two columns are `ONLY`, which has no textbook name because it isn't a
two-input operator: it also depends on the conditions you *didn't* mention. With
exactly two conditions defined, `ONLY(A)` coincides with `AND(A, NOT(B))` and
`ONLY()` with `NOR` — but define a third condition and those columns change
while every other column stays put. That's the whole difference between `ONLY`
and the rest, and why conditions must all be defined before the first rule.

## Naming a combination

Some combinations aren't a rule, they're a phrase you keep using. "Listed
correctly" isn't a fact you check against a product; it's three facts you
already check, taken together. `defineComputedCondition` names the combination
once, and the name is a condition everywhere after that:

```ts
.defineComputedCondition({
  name: "listedCorrectly",
  checkFn: ({ AND }) => AND("hasWeight", "hasPrice", "hasCategory"),
})
.defineComputedCondition({
  name: "sellable",
  checkFn: ({ AND }) => AND("listedCorrectly", "inStock"),   // they layer
})
.defineBucket({ name: "storefront", checkFn: () => "sellable" })
.defineBucket({
  name: "backorder",
  checkFn: ({ AND, NOT }) => AND("listedCorrectly", NOT("inStock")),
})
```

`checkFn` gets the same combinators a bucket does, so a computed condition is a
first-class operand — `NOT("listedCorrectly")` is a rule, not a special case.
The name also shows up in `report.conditions`, which is the other half of why
it's worth naming: reading *why* an item went unmatched is easier in the terms
you chose than in raw predicates.

It costs nothing per item. A computed condition reads verdicts that have
already been collected, so nothing re-runs — see `examples/computed.ts`.

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
| `when` | see below | Optional. Gates `checkFn` on a precondition. |
| `group` | `string` | Optional, purely descriptive. Labels this condition's row in a `processConditions()` report — plays no part in evaluation. |
| `checkFn` | `(item) => boolean \| Promise<boolean>` | May be async. The return value is coerced with `Boolean()`. Throwing sends that one item to `report.errors`. Write it as a type predicate — `(item): item is X` — to also narrow the buckets built from it. May be a property alongside `when`, or a second argument. |

Every condition is evaluated once per item — concurrently, unless a `when`
puts it in a later wave — before any rule runs, so a condition used by five
buckets still costs one call. Define all of them before the first computed
condition and the first bucket: `ONLY` means "these and nothing else", so a
condition added later would quietly change what an existing `ONLY` rule
matches. The engine rejects it rather than let that happen.

### `when`: gating a condition on another

```ts
.defineCondition({
  name: "hasProduct",
  checkFn: (item): item is Listing & { product: Product } =>
    item.product !== undefined,
})
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  // item.product is Product here, not Product | undefined.
  checkFn: (item) => item.product.weightKg !== null,
})
```

`checkFn` is skipped and the condition recorded `false` whenever the
precondition doesn't hold — worth it when `checkFn` is the expensive one.
Three ways to write `when`, each a different narrowing/autocomplete tradeoff:

| Form | Narrows `checkFn`? | Autocompletes names? |
| --- | --- | --- |
| A bare name: `when: () => "hasProduct"` | Yes | N/A |
| A value: `when: AND("hasProduct", "isActive")` | Yes | No |
| A callback: `when: ({ AND }) => AND(...)` | No | Yes |
| `checkFn` as a second argument | Yes | Yes |

The last row is the one that gets both, for a compound precondition:

```ts
.defineCondition(
  { name: "readyToSell", when: ({ AND }) => AND("hasProduct", "isActive") },
  (item) => item.product.weightKg > 0, // narrowed, and AND autocompletes
)
```

See `docs/guides/preconditions.md` for why the callback form alone can't
narrow — a real TypeScript limitation, not a design choice — and the rest of
the detail: chaining, how it interacts with `ONLY` and
`missingCombinations()`, and what gets rejected.

## `defineComputedCondition`

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Joins the condition namespace — usable anywhere a condition name is, and unique across both kinds. |
| `checkFn` | `(logic) => expression` | Receives `{ AND, OR, NOT, ONLY }` bound to every condition defined so far. Return an expression, or a bare condition name. |

Goes after every plain condition and before the first bucket. The first half is
what a computed condition *is* — built out of what already exists, which is also
why a cycle can't be stated. The second half is `ONLY` again.

`ONLY` takes plain conditions only, and counts only those. It means "and every
other condition is false", and a computed condition isn't another fact about the
item — it's a restatement of facts already counted. Were it counted too,
`ONLY("hasWeight")` would demand that `listedCorrectly` be false, and a computed
`nothingFilledIn` would make `ONLY()` unsatisfiable. So `ONLY("hasWeight")`
means exactly what it meant before you named anything, and passing a computed
name to it is a compile error.

Narrowing carries through the same way it does into a bucket:
`AND("isString", "isLong")` named `isLongString` proves `string`, and a bucket
built on that name hands back `string[]`.

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

## `clone()`

An independent engine holding everything defined so far, at the same type.

The `define*` methods mutate and return the same object — that's what makes the
chain read the way it does, and it means branching off a shared variable does
not do what it looks like:

```ts
const one = base.defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.defineBucket({ name: "b", checkFn: () => "isDigital" });
// one === two === base. Both engines now hold *both* buckets, while the types
// still claim one each — so `one.process()` evaluates a rule its report has no
// key for.
```

`clone()` is how you say what that was trying to say:

```ts
const one = base.clone().defineBucket({ name: "a", checkFn: () => "hasWeight" });
const two = base.clone().defineBucket({ name: "b", checkFn: () => "isDigital" });
```

Which is the useful shape for trying two rule sets over one set of conditions —
a proposed rule change, run against the same batch as the current rules and
diffed. See `examples/clone.ts`.

The copy is shallow, which is all it needs to be: a stored condition is a name
and a function, a stored rule is a name and an expression tree, and nothing
mutates either after it's registered. The ordering rules come with it — a clone
taken after the first bucket still refuses a new condition, since its `ONLY`
rules were written against the set it already has.

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

## `processConditions(items, options?)`

Runs every condition over a batch, without requiring a single bucket to be
defined — only `.defineInput()`. For trying out conditions before there's a
rule to sort by, or for a report over the conditions themselves:

```ts
const listings = new BucketEngine()
  .defineInput<Listing>()
  .defineCondition({
    name: "hasProduct",
    group: "existence check",
    checkFn: (l): l is Listing & { product: Product } => l.product !== null,
  })
  .defineCondition({ name: "hasBrand", group: "existence check", checkFn: (l) => l.brand !== null });

const report = await listings.processConditions(myListings);
console.log(formatConditionReport(report));
```

| Field | Type | Contains |
| --- | --- | --- |
| `results` | `{ item, conditions }[]` | Every item's own verdicts, in input order. |
| `errors` | `{ item, stage, condition?, error }[]` | Same shape and meaning as `process()`'s `errors`. |
| `summary` | `{ name, group, passing, failing }[]` | How often each condition — plain and computed alike — came out true versus false across the batch. `group` is whatever was given to `defineCondition`'s `group`, or `undefined` for an ungrouped or computed condition. |

`formatConditionReport(report, { barWidth? })` renders `summary` as a table,
grouped by `group` (ungrouped conditions sort last), with a block-drawn bar
showing what fraction of the batch passed:

```
┌─────────────────┬────────────┬─────────┬─────────┬──────────────────────┐
│ Group           │ Condition  │ Passing │ Failing │ Distribution         │
├─────────────────┼────────────┼─────────┼─────────┼──────────────────────┤
│ existence check │ hasProduct │     150 │     150 │ ██████████░░░░░░░░░░ │
│ existence check │ hasBrand   │     300 │       0 │ ████████████████████ │
└─────────────────┴────────────┴─────────┴─────────┴──────────────────────┘
```

`printConditionReport(report, options?)` is the same thing written straight
to `console.log`. See `examples/processConditions.ts` for a full run.

## Introspection

| Member | Returns |
| --- | --- |
| `conditionNames` | Plain condition names, in definition order. |
| `computedConditionNames` | Computed condition names, in definition order. |
| `bucketNames` | Bucket names, in definition order. |
| `missingCombinations()` | Every combination of conditions that satisfies no rule, each as the conditions that would be true. These are exactly the items that would land in `unmatched`, so it answers "what have I not written a rule for?" before the data tells you. Enumerates and reports the plain conditions only — those are the free variables — while still deriving the computed ones to decide what each combination matches. Refuses to enumerate past 16 conditions — the only thing here that ever enumerates. |

## Errors

Everything thrown is a `BucketError`. Configuration mistakes throw immediately
from the `define*` call that made them, so a misconfigured engine can't reach
`process`:

- a duplicate condition or bucket name — conditions and computed conditions
  share one namespace
- a condition defined after the first computed condition or the first bucket, or
  a computed condition defined after the first bucket
- a rule referencing a condition that doesn't exist, or a computed condition
  referencing one not yet defined
- `ONLY` handed a computed condition
- a `checkFn` returning something that is neither a condition name nor an
  expression, or `AND()`/`OR()` with no operands
- `defineInput` called twice, after a condition, or with a non–Standard Schema
- `process` or `processOne` before an input or any bucket is defined —
  `processConditions` needs only an input, no bucket
- a `concurrency` that isn't a positive integer or `Infinity`

When a `BucketError` comes from schema validation it carries the library's raw
`issues` so you can render them yourself.

Note what is *not* an error: rules that overlap, a rule that can never match
(`AND("a", NOT("a"))`), and combinations no rule covers. All three are legal —
overlap is the design, and the other two are what `missingCombinations()` and
an empty bucket are for.

## `ActionEngine`

`ActionEngine` is `BucketEngine`'s sibling for running named effects instead
of sorting into named groups. Where a bucket separates naming a condition
from declaring a rule over named conditions, an action carries its predicate
and its effect together:

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

Actions are independent, the same way buckets are: an order that's both paid
and risky triggers both actions. Unlike a bucket, though, an action doesn't
share a boolean expression with any other action, so one action's `checkFn`
or `actionFn` throwing never stops another action from running on that same
item — the failure is recorded in `report.errors` against that one action,
and every other action still runs. An item lands in `report.unmatched` only
when every action's `checkFn` ran and none of them matched; an item that
errored is never also `unmatched`.

`processOne(item)` mirrors `process` for a single item, resolving to
`{ item, matched, results, checks, errors }` — and, unlike
`BucketEngine.processOne`, it does **not** throw when a `checkFn` or
`actionFn` fails, for the same independence reason. It still throws an
`ActionError` when input validation itself fails, since nothing can run
without a valid item.

Everything else — `defineInput`, `clone()`, `concurrency`, and the shape of
the errors it throws — works exactly as it does on `BucketEngine`, just with
`ActionError` in place of `BucketError`. See the Actions guide and the
ActionEngine reference in `docs/` for the full details.

## Development

```bash
npm test
npm run typecheck
npm run format
npm run fix
npm run example
npm run example:computed
npm run example:clone
npm run example:actions
```
