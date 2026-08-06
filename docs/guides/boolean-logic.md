---
title: "Boolean Logic"
description: "Truth tables for every two-input operator, how to spell each one with AND, OR, NOT and ONLY, and the De Morgan pitfall that catches everyone."
---

The four combinators are enough to express any boolean rule, but the named
operators you learned somewhere else (XOR, NAND, implication) don't all have
a combinator of their own. This page is the lookup table: every two-input
operator, the expression that produces it, and the one identity that trips
people up.

## Every two-input operator

`A` and `B` are two conditions. **T** means the rule matches that combination
of verdicts.

| A | B | AND | OR | XOR | NAND | NOR | XNOR | A→B | `ONLY(A)` | `ONLY()` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T | T | **T** | **T** | F | F | F | **T** | **T** | F | F |
| T | F | F | **T** | **T** | **T** | F | F | F | **T** | F |
| F | T | F | **T** | **T** | **T** | F | F | **T** | F | F |
| F | F | F | F | F | **T** | **T** | **T** | **T** | F | **T** |

And how each column is written:

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

`XOR` also reads well the long way round, as *one without the other, either
way*, and produces an identical column:

```ts
OR(AND("condOne", NOT("condTwo")), AND(NOT("condOne"), "condTwo"))
```

Pick whichever states the rule you're actually describing. The engine doesn't
prefer one: both are the same tree depth, and both are evaluated once per
item against verdicts already collected.

## The one that catches everyone: NAND is not NOR

`NOT(AND(A, B))` means **not both**. It matches three of the four rows,
including the two where one condition is true and the other is false.

That surprises people, because "not where A and B are true" reads in English as
though it should mean "where A and B are both false". It doesn't. The negation
of *both are true* is *at least one is false*.

Nothing exotic is happening. The inner `AND` evaluates to a boolean, and `NOT`
flips it, exactly as `!(a && b)` would in TypeScript:

```ts
!(true && false)   // the inner AND is false, so this is true
!true && !false    // false — a different expression entirely
```

If you want *neither*, that's `NOR`:

```ts
NOT(OR("condOne", "condTwo"))              // neither — matches one row
NOT(AND("condOne", "condTwo"))             // not both — matches three rows
```

## De Morgan's laws

Written flat, without the nesting, those two are:

| Nested | Flat | Reads as |
| --- | --- | --- |
| `NOT(AND(A, B))` | `OR(NOT(A), NOT(B))` | not both |
| `NOT(OR(A, B))` | `AND(NOT(A), NOT(B))` | neither |

That's [De Morgan's laws](https://en.wikipedia.org/wiki/De_Morgan%27s_laws):
negating a group swaps `AND` and `OR`. Each pair agrees on every row of the
truth table, so they're interchangeable.

Worth being clear about what this is and isn't. It's an **identity**: two
spellings that always produce the same answer. The engine never performs the
rewrite: `NOT(AND(A, B))` is stored and evaluated as exactly that tree, with
the `AND` resolved first and the `NOT` applied to its result. The identity only
matters when *you* are converting between forms by hand, which is where the
swap gets forgotten.

The practical version: **if you negate a group, flip the operator inside it.**

## `ONLY` isn't a two-input operator

The last two columns of the table are `ONLY`, and they're there for comparison
rather than because they belong. `ONLY` depends on the conditions you *didn't*
mention, so its column isn't a function of `A` and `B` alone.

With exactly two conditions defined, `ONLY(A)` coincides with
`AND(A, NOT(B))`, and `ONLY()` coincides with `NOR`. Define a third condition
and those coincidences break while every other column stays put:

```ts
const engine = new BucketEngine()
  .defineInput<Item>()
  .defineCondition({ name: "condOne", checkFn: (i) => i.a })
  .defineCondition({ name: "condTwo", checkFn: (i) => i.b })
  .defineCondition({ name: "condThree", checkFn: (i) => i.c })
  .defineBucket({ name: "onlyOne", checkFn: ({ ONLY }) => ONLY("condOne") })
  .defineBucket({
    name: "oneNotTwo",
    checkFn: ({ AND, NOT }) => AND("condOne", NOT("condTwo")),
  });

// { a: true, b: false, c: true }  → ["oneNotTwo"]
// { a: true, b: false, c: false } → ["onlyOne", "oneNotTwo"]
```

`ONLY("condOne")` silently narrowed when `condThree` appeared;
`AND("condOne", NOT("condTwo"))` did not. That's the whole reason every
condition must be declared before the first rule: an `ONLY` written earlier
would otherwise change meaning under you. It's also why `ONLY` accepts plain
conditions only, never computed ones: a computed condition restates conditions
already counted, so counting it again would make `ONLY` contradict itself. See
the Computed Conditions guide for the longer version.

## Counting patterns

Rules of the form "at least two of these" and "exactly one of those" have no
operator. They're an `OR` of `AND`s, and they're usually clearer written out
than named. With three conditions `A`, `B`, `C`:

```ts
// At least two of the three
OR(AND("A", "B"), AND("A", "C"), AND("B", "C"))

// Exactly one of the three
OR(
  AND("A", NOT("B"), NOT("C")),
  AND(NOT("A"), "B", NOT("C")),
  AND(NOT("A"), NOT("B"), "C"),
)

// None of the three
NOT(OR("A", "B", "C"))
```

When `A`, `B` and `C` are the *only* conditions on the engine, "exactly one"
also has a much shorter spelling, though it will quietly change meaning if you
add a fourth condition later, for the reason above:

```ts
OR(ONLY("A"), ONLY("B"), ONLY("C"))
```

These get long fast, which is usually the signal to name the pieces. A computed
condition lets you write `AND("listedCorrectly", "inStock")` instead of
restating five predicates at every call site. Because a computed condition
is a first-class operand,
`NOT("listedCorrectly")` works too. Just remember it's a `NAND`, not a `NOR`:
it matches everything that isn't *fully* listed, not only the blank ones.

## Combinations no rule covers

Once the rules get complicated enough to need this page, the useful check is
`missingCombinations()`. It enumerates every combination of conditions that
satisfies no bucket, which is exactly the set of items that would land in
`report.unmatched`:

```ts
const engine = new BucketEngine()
  .defineInput<Product>()
  .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
  .defineCondition({ name: "isDigital", checkFn: (p) => p.downloadUrl !== null })
  .defineBucket({ name: "warehouse", checkFn: () => "hasWeight" });

engine.missingCombinations();
// [[], ["isDigital"]]
// Nothing covers "no weight" — with or without a download. Two rules to write.
```

It enumerates and reports the plain conditions only, since those are the free
variables, while still deriving the computed ones to decide what each
combination matches. See the BucketEngine reference for the details, including
the 16-condition cap.
