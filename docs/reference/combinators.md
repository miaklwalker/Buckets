---
title: "Combinators"
description: "The AND, OR, NOT and ONLY functions, both as the bound logic passed to checkFn and as standalone exports."
---

Every `checkFn` for a bucket or a computed condition receives an object with
four combinators, bound to that engine's condition names:

```ts
.defineBucket({
  name: "incomplete",
  checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("hasPhoto")),
})
```

The same four functions are also exported directly from the package, for
building expressions outside a `checkFn`, to hoist, name, share, or negate
them:

```ts
import { AND, NOT, OR, ONLY } from "@michaelrwalker/buckets";

const missingSomething = OR(NOT("hasPhotos"), NOT("hasPrice"));
```

The standalone exports check names at runtime the same way the bound
versions do, but since they aren't tied to a specific engine, they can't type
the names for you: a typo there is caught when the expression is handed to
`defineBucket` or `defineComputedCondition`, not while you're typing it. The
callback form (`checkFn: ({ AND }) => ...`) is worth preferring where you
can for that reason.

## `AND(...operands)`

True when every operand holds.

```ts
AND("hasPhoto", "hasPrice")
AND("hasWeight", NOT("isDigital"))
```

Throws a `BucketError` if called with zero operands.

**Narrowing:** intersects what each operand proves. `AND("isString",
"isLong")` proves the intersection of what `isString` and `isLong` each
prove: `string` if only `isString` is a type predicate, `never` if the two
predicates prove incompatible types.

## `OR(...operands)`

True when at least one operand holds.

```ts
OR("isString", "isNumber")
OR(NOT("hasWeight"), NOT("hasPhoto"))
```

Throws a `BucketError` if called with zero operands.

**Narrowing:** unions what each operand proves. `OR("isString", "isNumber")`
proves `string | number`.

## `NOT(operand)`

True when the operand does not hold.

```ts
NOT("hasWeight")
NOT(AND("isFragile", "isOversized"))
```

**Narrowing:** none. Knowing an item *isn't* something proves nothing about
what it *is*: a bucket built on `NOT(...)` keeps the engine's input type.

## `ONLY(...names)`

True when exactly these conditions hold, and **every other condition is
false**.

```ts
ONLY("hasWeight")       // a weight, and nothing else true
ONLY()                  // no plain condition true at all
```

`ONLY` only accepts **plain** condition names: never computed conditions,
and never arbitrary expressions. It's the one combinator that depends on
conditions it doesn't name, which is why every condition must be declared
before the first bucket (or computed condition): `ONLY` needs the complete
set to know what "nothing else" means. Passing a computed condition's name is
a compile error, and rejected again at runtime.

**Narrowing:** intersects what each named condition proves, same as `AND`.

## A bare condition name is a valid operand everywhere

Anywhere an expression is accepted — as an operand to `AND`/`OR`/`NOT`, or as
the return value of a `checkFn` — a bare string is shorthand for "this
condition is true":

```ts
.defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
// equivalent to, but shorter than:
.defineBucket({ name: "warehouse", checkFn: ({ AND }) => AND("hasWeight") })
```

## `Expr` and `Operand`

Two type exports back the combinators, useful if you're writing a helper
that builds expressions generically:

- `Operand<TName>`: either a bare condition name (`TName`) or an `Expr`.
  What every combinator parameter accepts.
- `Expr<TName, TNarrow>`: the type of an expression built by `AND`, `OR`,
  `NOT` or `ONLY`. `TNarrow` is what the expression proves about the item,
  propagated automatically by the combinators; you never write it by hand.

Expressions are plain, inspectable data under the hood: that's what makes
them safe to build outside a `checkFn`, store in a variable, and pass around.
