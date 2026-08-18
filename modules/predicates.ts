/**
 * Whether `Key` is specific enough to `Pick` a single property with, or is
 * itself a wide type (`string`, `number`, `symbol`, or a template literal
 * with a widened segment, like `` `prefix-${string}` ``) that could match any
 * number of properties at once. `isPropertyDefined`/`isPropertyPresent` are
 * called with a specific key almost always, but nothing stops a caller from
 * passing a `string`, and a wide key genuinely can't be narrowed the same
 * way: there's no one property to intersect in.
 */
type HasWidenedTemplateSegment<Segment extends string> = string extends Segment
	? true
	: `${number}` extends Segment
		? true
		: `${bigint}` extends Segment
			? true
			: false;

type HasWidenedStringKey<Key extends string> = string extends Key
	? true
	: Key extends `${infer Prefix}${infer Suffix}`
		? HasWidenedTemplateSegment<Prefix> extends true
			? true
			: HasWidenedTemplateSegment<Suffix> extends true
				? true
				: false
		: false;

type HasWidenedKey<Key extends PropertyKey> = Key extends string
	? HasWidenedStringKey<Key> extends true
		? true
		: Extract<Key, object> extends never
			? false
			: true
	: Key extends number
		? number extends Key
			? true
			: Extract<Key, object> extends never
				? false
				: true
		: Key extends symbol
			? symbol extends Key
				? true
				: Extract<Key, object> extends never
					? false
					: true
			: false;

/**
 * What a predicate checks a property on, given whatever it was actually
 * called with: `object` if `Value` proves nothing yet (it's `unknown`, the
 * common case for a standalone predicate handed an arbitrary argument), or
 * whatever object-like part of `Value` survives — `Extract<Value, object>` —
 * otherwise. A `Value` with no object-like member at all narrows to `never`
 * downstream, which is exactly right: nothing of that type could ever have
 * had the property.
 */
type ObjectType<Value> = unknown extends Value
	? object
	: Extract<Value, object>;

type ObjectWithoutProperty<
	ObjectValue extends object,
	Key extends PropertyKey,
> = {
	[Property in keyof ObjectValue as Property extends Key
		? never
		: Property]: ObjectValue[Property];
};

/**
 * The fallback answer for a widened key: everything the object already had,
 * plus the key itself typed `unknown` rather than left absent. All that's
 * provable for `isPropertyDefined("prefix-" + suffix)` is "the object
 * survived the filter" — which property actually matched isn't knowable from
 * the key's type alone, so this doesn't claim more than that.
 */
type ObjectWithFallbackProperty<
	ObjectValue extends object,
	Key extends PropertyKey,
> = ObjectWithoutProperty<ObjectValue, Key> & {
	[Property in Key]-?: unknown;
};

type ObjectWithRequiredDefinedProperty<
	ObjectValue extends object,
	Key extends keyof ObjectValue,
> = ObjectValue & {
	[Property in keyof Pick<ObjectValue, Key>]-?: Exclude<
		ObjectValue[Property],
		undefined
	>;
};
type ObjectWithNarrowedDefinedProperty<
	ObjectValue extends object,
	Key extends PropertyKey,
> = ObjectValue extends unknown
	? Key extends keyof ObjectValue
		? ObjectWithRequiredDefinedProperty<ObjectValue, Key>
		: ObjectWithFallbackProperty<ObjectValue, Key>
	: never;

/** What {@link isPropertyDefined} proves about `Value` once its check passes. */
export type ObjectWithDefinedProperty<Value, Key extends PropertyKey> =
	ObjectType<Value> extends infer ObjectValue
		? [ObjectValue] extends [object]
			? HasWidenedKey<Key> extends true
				? // For widened keys we can only prove that the original object survives the filter.
					ObjectValue
				: ObjectWithNarrowedDefinedProperty<ObjectValue & object, Key>
			: never
		: never;

export type IsPropertyDefinedPredicate<Key extends PropertyKey> = <Value>(
	value: Value,
) => value is ObjectWithDefinedProperty<Value, Key>;

/**
 * Does `value` have `key`, with a value that isn't `undefined`? `null`
 * counts as defined here — a property explicitly set to `null` is still
 * there, just holding a value some other check might reject. Use
 * {@link isPropertyPresent} when you also want to rule out `null`.
 *
 * A real property-descriptor check, not `key in value` or `value[key] !==
 * undefined`: the former is true for a property whose value genuinely is
 * `undefined`, and the latter can't tell "explicitly `undefined`" apart from
 * "not there at all" — both matter differently depending on what you're
 * checking. `__proto__`/`constructor` are rejected outright, so this can't be
 * used to read (or be tricked into reading) something off the prototype
 * chain.
 *
 * Generic over `Value` rather than a specific object type, so the same
 * predicate works on anything: `array.filter(isPropertyDefined("email"))`,
 * a bucket's `checkFn`, anywhere a plain `(value) => boolean` fits. That
 * generality is also why it can't narrow a `checkFn` directly — see
 * {@link definedIn}.
 */
export function isPropertyDefined<Key extends PropertyKey>(
	key: Key,
): IsPropertyDefinedPredicate<Key> {
	return (<Value>(
		value: Value,
	): value is ObjectWithDefinedProperty<Value, Key> => {
		if (
			(typeof value !== "object" && typeof value !== "function") ||
			value === null
		) {
			return false;
		}

		const recordValue = value as Record<PropertyKey, unknown>;
		const propertyDescriptor = Object.getOwnPropertyDescriptor(
			recordValue,
			key,
		);

		if (propertyDescriptor === undefined || !("value" in propertyDescriptor)) {
			return false;
		}

		return propertyDescriptor.value !== undefined;
	}) as IsPropertyDefinedPredicate<Key>;
}

type ObjectWithRequiredPresentProperty<
	ObjectValue extends object,
	Key extends keyof ObjectValue,
> = ObjectValue & {
	[Property in keyof Pick<ObjectValue, Key>]-?: NonNullable<
		ObjectValue[Property]
	>;
};
type ObjectWithNarrowedPresentProperty<
	ObjectValue extends object,
	Key extends PropertyKey,
> = ObjectValue extends unknown
	? Key extends keyof ObjectValue
		? ObjectWithRequiredPresentProperty<ObjectValue, Key>
		: ObjectWithFallbackProperty<ObjectValue, Key>
	: never;

/** What {@link isPropertyPresent} proves about `Value` once its check passes. */
export type ObjectWithPresentProperty<Value, Key extends PropertyKey> =
	ObjectType<Value> extends infer ObjectValue
		? [ObjectValue] extends [object]
			? HasWidenedKey<Key> extends true
				? // For widened keys we can only prove that the original object survives the filter.
					ObjectValue
				: ObjectWithNarrowedPresentProperty<ObjectValue & object, Key>
			: never
		: never;

export type IsPropertyPresentPredicate<Key extends PropertyKey> = <Value>(
	value: Value,
) => value is ObjectWithPresentProperty<Value, Key>;

/**
 * As {@link isPropertyDefined}, and also rules out `null` — the check to
 * reach for when a property is typed `T | null`, not just `T | undefined`,
 * and a `null` shouldn't count as having a real value.
 */
export function isPropertyPresent<Key extends PropertyKey>(
	key: Key,
): IsPropertyPresentPredicate<Key> {
	return (<Value>(
		value: Value,
	): value is ObjectWithPresentProperty<Value, Key> => {
		if (
			(typeof value !== "object" && typeof value !== "function") ||
			value === null
		) {
			return false;
		}

		const recordValue = value as Record<PropertyKey, unknown>;
		const propertyDescriptor = Object.getOwnPropertyDescriptor(
			recordValue,
			key,
		);

		if (propertyDescriptor === undefined || !("value" in propertyDescriptor)) {
			return false;
		}

		const propertyValue = propertyDescriptor.value;

		return propertyValue !== null && propertyValue !== undefined;
	}) as IsPropertyPresentPredicate<Key>;
}

/**
 * The `checkFn`-shaped counterpart of {@link isPropertyDefined}: pins the
 * object type first, with an explicit, argument-free call, so what comes out
 * is an ordinary — monomorphic — predicate, not a generic one.
 *
 * `isPropertyDefined` alone can't narrow a `checkFn`: `GuardOf` (how this
 * package reads what a `checkFn` proves) is a structural, compile-time-only
 * match against `checkFn`'s own type — it never *calls* anything, so there's
 * no argument in sight to resolve `isPropertyDefined`'s `<Value>` against.
 * `definedIn<TObject>()` fixes `TObject` before the key is ever supplied, so
 * by the time `checkFn` sees the result, there's no generic parameter left
 * for `GuardOf` to fail to resolve.
 *
 * ```ts
 * .defineCondition({
 *   name: "hasProduct",
 *   checkFn: definedIn<Listing>()("product"),
 * })
 * ```
 *
 * The actual check is `isPropertyDefined`'s, unchanged — this only narrows
 * the type at the call site.
 */
export function definedIn<TObject>() {
	return <Key extends keyof TObject>(key: Key) => {
		const predicate = isPropertyDefined(key);
		return (
			item: TObject,
		): item is TObject & Record<Key, NonNullable<TObject[Key]>> =>
			predicate(item);
	};
}

/** As {@link definedIn}, delegating to {@link isPropertyPresent} instead. */
export function presentIn<TObject>() {
	return <Key extends keyof TObject>(key: Key) => {
		const predicate = isPropertyPresent(key);
		return (
			item: TObject,
		): item is TObject & Record<Key, NonNullable<TObject[Key]>> =>
			predicate(item);
	};
}

/**
 * The nested object a path of keys proves, ending in `TValue` at the last
 * one: `NestedPath<["product", "weightKg"], number>` is
 * `{ product: { weightKg: number } }`. What {@link pathIn} builds up one
 * `.at()` at a time, so the final `.isDefined()`/`.isPresent()` can hand back
 * a single type predicate instead of you writing one.
 */
type NestedPath<
	TPath extends readonly PropertyKey[],
	TValue,
> = TPath extends readonly [
	infer THead extends PropertyKey,
	...infer TTail extends readonly PropertyKey[],
]
	? {
			readonly [K in THead]: TTail extends readonly []
				? TValue
				: NestedPath<TTail, TValue>;
		}
	: TValue;

/**
 * A property path being built up by {@link pathIn}, one `.at()` at a time.
 * `TRoot` is the object the final predicate will run on; `TCurrent` is what's
 * known at the *current* step, which is what the next `.at()`/`.isDefined()`/
 * `.isPresent()` checks a key against.
 */
export interface PathPresence<
	TRoot,
	TPath extends readonly PropertyKey[],
	TCurrent,
> {
	/**
	 * Descend into `key`, checked for existence at runtime the same way
	 * {@link isPropertyDefined} checks any other property — this isn't a
	 * promise taken on faith, every step is verified when the chain finally
	 * runs.
	 */
	at<Key extends keyof TCurrent>(
		key: Key,
	): PathPresence<TRoot, [...TPath, Key], NonNullable<TCurrent[Key]>>;

	/**
	 * Finish the chain: `key` must be defined (not `undefined`) on whatever
	 * `.at(...)` reached, same as {@link isPropertyDefined}. Returns the
	 * predicate itself, ready to hand to `checkFn` — narrowing `TRoot` by the
	 * whole path, not just this last step.
	 */
	isDefined<Key extends keyof TCurrent>(
		key: Key,
	): (
		item: TRoot,
	) => item is TRoot &
		NestedPath<[...TPath, Key], Exclude<TCurrent[Key], undefined>>;

	/** As {@link isDefined}, and also excludes `null` on the last step. */
	isPresent<Key extends keyof TCurrent>(
		key: Key,
	): (
		item: TRoot,
	) => item is TRoot & NestedPath<[...TPath, Key], NonNullable<TCurrent[Key]>>;
}

/** Every step of `path`, in order, or `undefined` the moment one is missing. */
function walkPath(item: unknown, path: readonly PropertyKey[]): unknown {
	let current: unknown = item;
	for (const key of path) {
		if (key === "__proto__" || key === "constructor") return undefined;
		if (
			current === null ||
			(typeof current !== "object" && typeof current !== "function")
		) {
			return undefined;
		}
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
		current = descriptor.value;
	}
	return current;
}

function makePathPresence(
	path: readonly PropertyKey[],
	// biome-ignore lint/suspicious/noExplicitAny: type-erased builder, same as definedIn/presentIn's own cast
): PathPresence<any, any, any> {
	return {
		at: (key: PropertyKey) => makePathPresence([...path, key]),
		isDefined: (key: PropertyKey) => {
			const fullPath = [...path, key];
			return (item: unknown) => walkPath(item, fullPath) !== undefined;
		},
		isPresent: (key: PropertyKey) => {
			const fullPath = [...path, key];
			return (item: unknown) => {
				const value = walkPath(item, fullPath);
				return value !== null && value !== undefined;
			};
		},
		// biome-ignore lint/suspicious/noExplicitAny: type-erased builder, same as definedIn/presentIn's own cast
	} as PathPresence<any, any, any>;
}

/**
 * The chainable counterpart of {@link definedIn}/{@link presentIn}, for a
 * property that isn't on `checkFn`'s own parameter but somewhere *inside*
 * it — `item.product.weightKg`, not `item.weightKg`. One `.at(...)` per hop,
 * finishing with `.isDefined(...)` or `.isPresent(...)`:
 *
 * ```ts
 * .defineCondition({
 *   name: "hasWeight",
 *   when: () => "hasProduct",
 *   checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
 * })
 * ```
 *
 * No hand-written `(item): item is typeof item & { product: { weightKg:
 * number } } => ...` — the chain builds that predicate for you, the same way
 * `definedIn`/`presentIn` build one for a single property. Every hop is a
 * real check, in order, the moment the finished predicate actually runs —
 * `.at("product")` isn't assuming `hasProduct` already ran, it's verifying it
 * itself, same as `isPropertyDefined` would.
 */
export function pathIn<TObject>(): PathPresence<TObject, [], TObject> {
	return makePathPresence([]);
}
