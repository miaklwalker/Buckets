---
title: "Type Narrowing"
description: "How a type-predicate condition makes buckets report a narrower item type instead of the engine's input type."
---

Declare a condition with a **type predicate** and the engine records what
that condition proves. The combinators carry it through the expression, so a
bucket hands back the narrow type rather than the engine's input type.

```ts
import { BucketEngine } from "@michaelrwalker/buckets";

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

## How it composes

| Rule | Bucket item type |
| --- | --- |
| `() => "isString"` | `string` |
| `OR("isString", "isNumber")` | `string \| number` |
| `AND("isString", "isTruthy")` | `string`: a non-predicate condition narrows the *set*, not the type |
| `AND("isString", "isNumber")` | `never`: the type says nothing can ever be in it, which is true |
| `NOT("isString")` | the input type: knowing what something *isn't* proves nothing |

`AND` intersects what its operands prove. `OR` unions it. `NOT` can't narrow
at all. Knowing an item isn't a string says nothing about what it is, so a
bucket built on `NOT("isString")` keeps the engine's input type, honestly.

A condition declared without a type predicate — an ordinary
`(item) => boolean` — proves nothing about the shape, so it contributes
`unknown` to any intersection it's part of. `unknown` combined with a real
narrowed type in `AND` still yields the narrowed type; on its own it falls
back to the engine's input type rather than "narrowing" to `unknown`.

## Discriminated unions: a router falls out of it

The useful case is a discriminated union, because TypeScript reduces the
intersection of two narrowed unions down to the variant they share. That's
enough to build an HTTP router where dispatch needs no casts:

```ts
interface Request<TMethod extends string, TPath extends string, TBody> {
  readonly method: TMethod;
  readonly path: TPath;
  readonly body: TBody;
  readonly authorization: string | null;
}

type IncomingRequest =
  | Request<"GET", "/users", undefined>
  | Request<"POST", "/users", { name: string; email: string }>
  | Request<"POST", "/orders", { sku: string; quantity: number }>;

const router = new BucketEngine()
  .defineInput<IncomingRequest>()
  .defineCondition({
    name: "isPOST",
    checkFn: (r): r is Extract<IncomingRequest, { method: "POST" }> =>
      r.method === "POST",
  })
  .defineCondition({
    name: "toUsers",
    checkFn: (r): r is Extract<IncomingRequest, { path: "/users" }> =>
      r.path === "/users",
  })
  .defineBucket({
    name: "createUser",
    checkFn: ({ AND }) => AND("isPOST", "toUsers"),
  });

const report = await router.process(traffic);

for (const request of report.buckets.createUser) {
  request.body.email; // string — the other variants are gone
  // request.body.sku; // compile error, that's the order route
}
```

`isPOST` and `toUsers` each prove one axis of the union; `AND` intersects
them down to the single variant matching both, `POST /users`, with its
concrete `body` type.

## You don't always have to write the predicate by hand

TypeScript infers a type predicate for a `checkFn` like
`(m) => m.channel === "email"` when the comparison discriminates a union, and
the engine picks that up the same way it would an explicit `(item): item is
X => ...`.

## What this is, and isn't

This is a **claim, not a proof**: the narrowing is only as honest as your
predicate, exactly like any other TypeScript type guard. If `checkFn` lies
about what it checks, the bucket's type lies too; nothing at runtime
verifies it.

It's also entirely opt-in. A condition returning a plain `boolean` narrows
nothing, and its buckets keep the engine's input type, which is what every
example other than a type-predicate one does. There's no penalty for not
using it: it's a type-level bonus for the cases where it's worth the extra
few characters in `checkFn`'s return type.

## What the compiler rejects

```ts
// @ts-expect-error strings is string[], never number[].
const wrongType: number[] = report.buckets.strings;

// @ts-expect-error a union of primitives has no .toUpperCase().
report.buckets.primitives.map((p) => p.toUpperCase());

// @ts-expect-error NOT proves nothing, so this stays unknown.
report.buckets.notStrings.map((v) => v.length);

// @ts-expect-error the bucket name has to exist.
report.buckets.symbols;
```
