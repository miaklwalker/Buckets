---
title: "Property Predicates"
description: "isPropertyDefined, isPropertyPresent, and their checkFn-shaped counterparts definedIn and presentIn, for gating and narrowing a condition on an optional or nullable property."
---

```ts
import {
  isPropertyDefined,
  isPropertyPresent,
  definedIn,
  presentIn,
} from "@michaelrwalker/buckets";
```

Four helpers for the same question — "is this property actually there?" —
in two forms: a general-purpose predicate usable anywhere, and a
`checkFn`-shaped version that narrows a condition's item type. Reach for
`definedIn`/`presentIn` when writing a condition; reach for
`isPropertyDefined`/`isPropertyPresent` for everything else.

## `isPropertyDefined(key)` / `isPropertyPresent(key)`

```ts
isPropertyDefined<Key extends PropertyKey>(key: Key): <Value>(value: Value) => value is ObjectWithDefinedProperty<Value, Key>;
isPropertyPresent<Key extends PropertyKey>(key: Key): <Value>(value: Value) => value is ObjectWithPresentProperty<Value, Key>;
```

Both check a real `Object.getOwnPropertyDescriptor`, not `key in value` or
`value[key] !== undefined` — `in` is true for a property whose value
genuinely is `undefined`, and a bare comparison can't tell "explicitly
`undefined`" apart from "not there at all". `__proto__`/`constructor` are
rejected outright, so neither can be used to read something off the
prototype chain.

| | `undefined` value | `null` value | absent | non-object |
| --- | --- | --- | --- | --- |
| `isPropertyDefined` | `false` | **`true`** | `false` | `false` |
| `isPropertyPresent` | `false` | `false` | `false` | `false` |

`isPropertyDefined` is the check for a property typed `T \| undefined` (an
optional property); `isPropertyPresent` is the one for `T \| null` too, when
`null` shouldn't count as having a real value.

Both are generic over `Value` — a plain `(value) => boolean`-shaped
predicate that works on anything, not tied to one object type:

```ts
listings.filter(isPropertyDefined("product"));
```

That generality is exactly why calling either of these directly as a
condition's `checkFn` **doesn't narrow**: `GuardOf` (how this package reads
what a `checkFn` proves) is a structural match against `checkFn`'s own type,
done without ever calling it — there's no argument in sight to resolve a
generic `Value` against. Use `definedIn`/`presentIn` for a condition instead.

## `definedIn<TObject>()(key)` / `presentIn<TObject>()(key)`

```ts
definedIn<TObject>(): <Key extends keyof TObject>(key: Key) => (item: TObject) => item is TObject & Record<Key, NonNullable<TObject[Key]>>;
presentIn<TObject>(): <Key extends keyof TObject>(key: Key) => (item: TObject) => item is TObject & Record<Key, NonNullable<TObject[Key]>>;
```

The `checkFn`-shaped counterpart of `isPropertyDefined`/`isPropertyPresent`:
pin `TObject` with an explicit, argument-free first call — there's nothing
in `key` alone that could tell TypeScript what object it belongs to — and
what comes out the other end is a perfectly ordinary, monomorphic predicate,
narrowing exactly like one written by hand.

```ts
interface Listing {
  readonly id: string;
  readonly product?: Product;
}

.defineCondition({
  name: "hasProduct",
  checkFn: definedIn<Listing>()("product"),
})
```

Calling `definedIn<Listing>()("nope")` for a key that isn't actually on
`Listing` is a compile error, same as any other `keyof` mistake. The actual
check is `isPropertyDefined`'s (`presentIn`'s is `isPropertyPresent`'s),
unchanged — this only narrows the type at the call site.

### The gap these don't fill: a nested property

`definedIn`/`presentIn` check a property of whatever `checkFn`'s own
parameter is. A property one level *into* that — `listing.product.weightKg`
— isn't reachable the same way, since `Listing` has no `weightKg` of its own:

```ts
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: (
    item,
  ): item is typeof item & { product: Record<"weightKg", number> } =>
    presentIn<Product>()("weightKg")(item.product),
})
```

`presentIn<Product>()("weightKg")` still does the real check, on
`item.product` — but the predicate that narrows `hasWeight` itself has to be
written on `item`, explicitly, since TypeScript's own predicate inference
doesn't chase into a call to something else that happens to be a predicate.
See the Preconditions guide for the fuller version of that limit.
