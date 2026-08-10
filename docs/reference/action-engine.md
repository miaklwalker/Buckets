---
title: "ActionEngine"
description: "The full method reference for the ActionEngine class: definitions, processing, cloning and introspection."
---

```ts
import { ActionEngine } from "@michaelrwalker/buckets";
```

`ActionEngine` runs named effects against the items that match them. It's
generic over two type parameters: the input type and the map of action names
to what each one produces, both inferred as you call `defineInput` and
`defineAction`. You never write them out by hand.

Where {@link BucketEngine} separates naming a condition
(`defineCondition`) from declaring a rule over named conditions
(`defineBucket`), `ActionEngine` collapses that into one step: `defineAction`
takes a name, a `checkFn`, and the `actionFn` that runs when `checkFn`
matches.

## `new ActionEngine()`

Takes no arguments. Every engine starts empty; call `defineInput` before
anything else.

## `defineInput(schema)` / `defineInput<TShape>()`

```ts
defineInput<TSchema>(schema: StandardSchemaV1<unknown, TSchema>): ActionEngine<TSchema, TActions>;
defineInput<TShape>(): ActionEngine<TShape, TActions>;
```

Describes the items being processed. Call it first, before any action.

- `.defineInput(schema)` infers the item type from a
  [Standard Schema](https://standardschema.dev)'s **output**, and validates
  every item at runtime. A schema that transforms means every action's
  `checkFn` and `actionFn` see the transformed value.
- `.defineInput<Order>()` is types only. Nothing is validated, so
  `report.errors` can then only contain `"check"` and `"action"` failures.

Throws an `ActionError` if called twice, if called after any action has been
defined, or if the argument is neither a Standard Schema nor omitted.

## `defineAction(spec)`

```ts
defineAction<TName extends string, TCheck, TResult>(
  spec: { name: TName; checkFn: TCheck; actionFn: (item: ActionInput<TCheck, TInput>) => TResult | Promise<TResult> },
): ActionEngine<TInput, TActions & { [K in TName]: { item: ActionInput<TCheck, TInput>; result: TResult } }>;
```

Registers a named predicate-and-effect pair.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Becomes a key of `report.results`. Must be unique. |
| `checkFn` | `(item: TInput) => boolean \| Promise<boolean>` | May be async. Decides whether `actionFn` runs. Write it as `(item): item is X => ...` to also narrow what `actionFn` receives. |
| `actionFn` | `(item) => TResult \| Promise<TResult>` | Runs only when `checkFn` matched. May be async, may return anything — the return value ends up in `report.results[name]`. |

Actions may be declared in any order relative to each other — there's no
`ONLY`-style dependency on the complete set, because there's no shared
boolean expression between them. Each action's `checkFn` and `actionFn` are
evaluated once per item, independent of every other action. Throws an
`ActionError` for: an empty name, a missing `checkFn` or `actionFn`, or a
duplicate name.

## `clone()`

```ts
clone(): ActionEngine<TInput, TActions>;
```

Returns an independent engine holding everything defined so far, at the same
type. The copy is shallow: neither an action's `checkFn` nor its `actionFn`
is ever mutated after registration, so the two engines are otherwise fully
independent — defining something on one leaves the other alone.

## `process(items, options?)`

```ts
process(
  items: readonly TInput[],
  options?: { concurrency?: number },
): Promise<ActionReport<TInput, TActions>>;
```

Runs every action against a batch. Requires at least one action and an input
to have been defined; throws an `ActionError` immediately if not.

- Validates each item against the schema (if one was given via
  `defineInput`), runs every action's `checkFn` in parallel, then runs
  `actionFn` for every action that matched — also in parallel.
- Never throws for bad data: a schema rejection, a throwing `checkFn`, or a
  throwing `actionFn` lands in `report.errors` and the rest of the batch
  continues. Because actions are independent, one action failing on an item
  never stops another action from running on that same item.
- `options.concurrency` bounds how many items are evaluated at once (default
  `256`).
- Output order in every part of the report matches input order, regardless
  of `concurrency`.

Returns an `ActionReport`; see the Reports and Errors reference for its
shape.

## `processOne(item)`

```ts
processOne(item: TInput): Promise<ActionAssignment<TInput, TActions>>;
```

Runs every action against a single item and resolves to
`{ item, matched, results, checks, errors }`. `matched` lists every action
that ran successfully, in definition order; an empty array means the single-
item equivalent of `unmatched`.

Unlike `BucketEngine.processOne`, this does **not** throw when a `checkFn` or
`actionFn` fails — actions are independent, so one failing shouldn't hide
whether the others matched. Those failures come back in `errors` instead,
exactly as in `process()`. It **does** throw an `ActionError` when input
validation fails, since nothing can run without a valid item.

## Introspection

| Member | Type | Returns |
| --- | --- | --- |
| `actionNames` | `NamesOf<TActions>[]` (getter) | Action names, in definition order. |
