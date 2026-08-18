---
title: "Property Predicates"
description: "isPropertyDefined, isPropertyPresent, their checkFn-shaped counterparts definedIn and presentIn, and pathIn for a nested property, for gating and narrowing a condition on an optional or nullable property."
---

```ts
import {
  isPropertyDefined,
  isPropertyPresent,
  definedIn,
  presentIn,
  pathIn,
} from "@michaelrwalker/buckets";
```

Helpers for the same question — "is this property actually there?" — in a
few forms: a general-purpose predicate usable anywhere, a `checkFn`-shaped
version that narrows a condition's item type, and a chainable version of
that for a property nested inside another. Reach for `definedIn`/`presentIn`
when writing a condition on one of its own properties, `pathIn` for a
property one or more hops in, and `isPropertyDefined`/`isPropertyPresent`
for everything else.

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

## `pathIn<TObject>().at(key)...isDefined(key)` / `.isPresent(key)`

```ts
pathIn<TObject>(): PathPresence<TObject, [], TObject>;
```

`definedIn`/`presentIn` check a property of whatever `checkFn`'s own
parameter is. A property one level *into* that — `listing.product.weightKg`
— isn't reachable the same way, since `Listing` has no `weightKg` of its own.
`pathIn` walks there: one `.at(key)` per hop, ending in `.isDefined(key)` or
`.isPresent(key)` to produce the predicate itself.

```ts
.defineCondition({
  name: "hasWeight",
  when: () => "hasProduct",
  checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
})
```

No hand-written `item is typeof item & { product: { weightKg: number } }`
needed — `pathIn` builds that predicate for you, narrowing the whole path at
once, not just the last step. `item.product.sku` stays available too:
`.at("product")` only says what's known at that hop, it doesn't discard the
rest of `Product`.

Every hop is checked for real, in the order given, the moment the finished
predicate runs — the same `Object.getOwnPropertyDescriptor` check as
`isPropertyDefined`/`isPropertyPresent`, including the `__proto__`/`constructor`
guard, at every step, not just the last. `.at("product")` isn't trusting that
some earlier `hasProduct` condition already ran; it verifies `product` itself
before descending into it.

`.isDefined`/`.isPresent` differ exactly like `isPropertyDefined`/
`isPropertyPresent` do — `.isDefined` accepts `null` on the final hop,
`.isPresent` doesn't:

```ts
pathIn<Listing>().at("product").isDefined("weightKg"); // null passes
pathIn<Listing>().at("product").isPresent("weightKg"); // null fails
```

Calling `.at("nope")` or `.isPresent("nope")` for a key that isn't actually
there at that hop is a compile error, same as `definedIn`/`presentIn`. See
the Preconditions guide for why a hand-written predicate is otherwise needed
to narrow past a call to another predicate.
