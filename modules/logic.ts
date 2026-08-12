import { BucketError } from "./types.ts";

/**
 * The runtime shape of an expression: a plain tree, inspectable, which is what
 * lets an engine report the conditions a rule depends on and makes an
 * expression safe to hoist, name and reuse.
 */
export type ExprNode<TName extends string> =
	| { readonly kind: "condition"; readonly name: TName }
	| { readonly kind: "not"; readonly operand: ExprNode<TName> }
	| { readonly kind: "and"; readonly operands: readonly ExprNode<TName>[] }
	| { readonly kind: "or"; readonly operands: readonly ExprNode<TName>[] }
	| { readonly kind: "only"; readonly names: readonly TName[] };

/**
 * Never exists at runtime. It keys an optional phantom property, which is how
 * an expression carries what it narrows the item to without that type having
 * anywhere real to live.
 */
declare const NARROW: unique symbol;

/**
 * A boolean expression over condition names.
 *
 * `TNarrow` is the type an item is known to have when this expression holds —
 * `unknown` unless the conditions involved were declared with type predicates.
 * It is inferred and propagated by the combinators; you never write it.
 *
 * Build these with {@link AND}, {@link OR}, {@link NOT} and {@link ONLY} rather
 * than by hand.
 */
export type Expr<TName extends string, TNarrow = unknown> = ExprNode<TName> & {
	// Wrapped in a tuple on purpose. The property must be optional so that real
	// expression objects satisfy the type, and an optional `TNarrow` reads as
	// `TNarrow | undefined` — which for an uninhabited narrowing collapses
	// `never | undefined` into `undefined`, quietly turning "nothing can ever be
	// in this bucket" into "this bucket holds undefined". `[never] | undefined`
	// keeps the two apart.
	readonly [NARROW]?: [TNarrow];
};

/**
 * Never exists at runtime either. Keys the phantom that lets a *standalone*
 * `AND`/`OR`/`NOT` result — one built with no engine in scope, as `when`'s
 * value-position form does — carry the operands it was built from, so
 * {@link NarrowOf} can work out what it narrows to once it does have an
 * engine's `TGuards` to resolve them against. `Expr`'s `NARROW` phantom can't
 * do this job itself: a standalone combinator has no `TGuards` yet to compute
 * a narrow answer *into*, only the raw ingredients to compute one later.
 */
declare const OPS: unique symbol;

/** The phantom {@link OPS} keys, carrying what built a standalone expression. */
export type Composed<
	TKind extends "and" | "or" | "not",
	TOperands extends readonly unknown[],
> = {
	readonly [OPS]?: [TKind, TOperands];
};

/**
 * Anywhere an expression is accepted, a bare condition name means "this
 * condition is true" — so `OR("isVip", NOT("hasWeight"))` needs no wrapper
 * around the first operand, and a bucket that turns on a single condition is
 * just `checkFn: () => "hasWeight"`.
 *
 * Two different kinds of expression satisfy this: one bound to an engine's
 * `TGuards` (a `LogicBuilder`/`PreconditionBuilder` combinator, carrying
 * {@link Expr}'s `NARROW` phantom) and one built standalone, with the
 * exported `AND`/`OR`/`NOT` (carrying {@link Composed}'s `OPS` phantom
 * instead, since there was no `TGuards` yet to resolve a narrow answer
 * against). {@link NarrowOf} reads whichever one is actually present.
 */
export type Operand<TName extends string> =
	| TName
	| Expr<TName, unknown>
	| (ExprNode<TName> & Composed<"and" | "or" | "not", readonly unknown[]>);

/**
 * The union of every condition name a tuple of operands touches, unwrapping a
 * standalone `AND`/`OR`/`NOT` recursively via its {@link Composed} phantom —
 * the same set {@link referencedNames} computes at runtime. This is how a
 * standalone combinator's own name-union is known before it has ever seen a
 * `TGuards` to check names against.
 */
export type NamesIn<TOperands extends readonly unknown[]> =
	TOperands extends readonly [
		infer THead,
		...infer TTail extends readonly unknown[],
	]
		?
				| (THead extends string
						? THead
						: THead extends Composed<
									"and" | "or" | "not",
									infer TInner extends readonly unknown[]
								>
							? NamesIn<TInner>
							: never)
				| NamesIn<TTail>
		: never;

/**
 * What one operand narrows the item to: a bare name resolves through the
 * engine's guard map; a bound combinator's result carries its own answer via
 * `NARROW`; a standalone combinator's result carries its raw operands via
 * `OPS` and gets resolved here, now that `TGuards` is finally in scope; and
 * anything unrecognised contributes `unknown`.
 */
export type NarrowOf<TOperand, TGuards> = TOperand extends keyof TGuards
	? TGuards[TOperand]
	: TOperand extends Composed<"and", infer TOperands extends readonly unknown[]>
		? IntersectAll<TOperands, TGuards>
		: TOperand extends Composed<
					"or",
					infer TOperands extends readonly unknown[]
				>
			? NarrowOf<TOperands[number], TGuards>
			: TOperand extends Composed<"not", readonly unknown[]>
				? unknown
				: TOperand extends Expr<string, infer TNarrow>
					? TNarrow
					: unknown;

/**
 * Folds operands pairwise into an intersection.
 *
 * Deliberately not `UnionToIntersection<NarrowOf<TOps[number]>>`: a condition
 * declared without a type predicate contributes `unknown`, and
 * `string | unknown` collapses to `unknown` *before* any intersection happens,
 * losing the narrowing. `string & unknown` is just `string`.
 *
 * A single operand passes through untouched — nothing was folded, so there's
 * nothing to flatten, and leaving it alone keeps a lone condition's proven
 * type identical to what it always was. Two or more get `Prettify`'d: without
 * it, `AND("hasProduct", "isActive")` would read as
 * `Listing & Record<"product", Product> & Record<"isActive", boolean>` one
 * `&` per operand, instead of the one merged object it actually is. `Prettify`
 * alone would mangle a callable operand — `keyof` a function type is just its
 * own properties (`name`, `length`, …), never its call signature — so a fold
 * that resolves to something still callable skips it and stays as-is.
 */
export type IntersectAll<
	TOperands extends readonly unknown[],
	TGuards,
> = TOperands extends readonly [infer THead, ...infer TTail]
	? TTail extends readonly []
		? NarrowOf<THead, TGuards>
		: FoldedIntersection<
				NarrowOf<THead, TGuards> & IntersectAll<TTail, TGuards>
			>
	: unknown;

type FoldedIntersection<T> = unknown extends T
	? // `unknown` itself, meaning nothing in the fold narrowed anything —
		// `Prettify<unknown>` would be `{}` (`keyof unknown` is `never`), which
		// would wrongly read as "proved the empty object" instead of "proved
		// nothing", so this has to bypass `Prettify` entirely.
		T
	: T extends (...args: never[]) => unknown
		? T
		: Prettify<T>;

/**
 * The four combinators, handed to a bucket's `checkFn` already bound to that
 * engine's conditions. Destructure the ones you need:
 *
 * ```ts
 * .defineBucket({
 *   name: "incomplete",
 *   checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("hasPhoto")),
 * })
 * ```
 *
 * `TGuards` maps each condition name to what it proves about the item, so these
 * signatures both reject unknown names and carry type narrowing through to the
 * bucket. `NOT` is the one that can't narrow: knowing an item *isn't* a string
 * says nothing about what it is.
 *
 * `TOnlyNames` is the subset of names `ONLY` will accept — the *base*
 * conditions, since a computed condition is a restatement of those rather than
 * an independent fact, and "and nothing else is true" only means anything over
 * the facts. It defaults to every name, which is what a free-standing
 * expression gets.
 *
 * The same functions are exported from the package for expressions you want to
 * hoist and share. Those don't narrow — a free-standing expression has no guard
 * map to resolve names against — but they still check the names.
 */
export interface LogicBuilder<
	TGuards,
	TOnlyNames extends string = NamesOf<TGuards>,
> {
	readonly AND: <const TOperands extends readonly Operand<NamesOf<TGuards>>[]>(
		...operands: TOperands
	) => Expr<NamesOf<TGuards>, IntersectAll<TOperands, TGuards>>;
	readonly OR: <const TOperands extends readonly Operand<NamesOf<TGuards>>[]>(
		...operands: TOperands
	) => Expr<NamesOf<TGuards>, NarrowOf<TOperands[number], TGuards>>;
	readonly NOT: (
		operand: Operand<NamesOf<TGuards>>,
	) => Expr<NamesOf<TGuards>, unknown>;
	readonly ONLY: <const TNames extends readonly TOnlyNames[]>(
		...names: TNames
	) => Expr<NamesOf<TGuards>, IntersectAll<TNames, TGuards>>;
}

/**
 * The `when` counterpart of {@link LogicBuilder} — the same `AND`/`OR`/`NOT`,
 * minus `ONLY`. A precondition is written mid-chain, before the rest of the
 * conditions exist, and `ONLY` means "and every other condition is false" —
 * a question that doesn't have an answer yet at that point.
 */
export type PreconditionBuilder<TGuards> = Pick<
	LogicBuilder<TGuards>,
	"AND" | "OR" | "NOT"
>;

/** The string keys of a name-to-something map — condition names, bucket names. */
export type NamesOf<TGuards> = Extract<keyof TGuards, string>;

/**
 * Flattens an intersection into one plain object type, for display only —
 * `Prettify<A & B>` and `A & B` accept exactly the same values, but a hover
 * or error message shows the merged shape instead of the intersection that
 * produced it. `AND("hasProduct", "isActive")` narrows through
 * {@link IntersectAll}, which folds operands pairwise (`A & (B & (C & ...))`)
 * — exactly the kind of nested intersection this exists for. Exported so a
 * `checkFn` written against several conditions at once, or any other
 * intersection this package hands back, can be prettied up the same way.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Lifts a bare condition name into an expression node. Exported because a
 * bucket's `checkFn` may return either form, so anything consuming one has to
 * be able to normalise it.
 */
export function toExpr<TName extends string>(
	operand: Operand<TName>,
): ExprNode<TName> {
	if (typeof operand === "string") return { kind: "condition", name: operand };
	if (
		typeof operand !== "object" ||
		operand === null ||
		typeof (operand as ExprNode<TName>).kind !== "string"
	) {
		throw new BucketError(
			`Expected a condition name or an expression, received ${String(operand)}.`,
		);
	}
	return operand;
}

function requireOperands<TName extends string>(
	label: string,
	operands: readonly Operand<TName>[],
): ExprNode<TName>[] {
	if (operands.length === 0) {
		throw new BucketError(`${label}() needs at least one operand.`);
	}
	return operands.map(toExpr);
}

/**
 * True when every operand is true.
 *
 * Standalone, so `TName` is neither known nor asked for — instead the return
 * type carries the operands themselves via {@link Composed}'s phantom, which
 * is what lets `when: AND("hasProduct", "isActive")` — value position, no
 * engine's combinators in scope yet — still resolve to the right narrowing
 * once `defineCondition` has a `TGuards` to check it against. Nothing here
 * changes what actually runs: `evaluate`/`referencedNames`/etc. only ever see
 * the plain `{ kind, operands }` shape underneath.
 */
export function AND<const TOperands extends readonly Operand<string>[]>(
	...operands: TOperands
): ExprNode<NamesIn<TOperands>> & Composed<"and", TOperands> {
	return {
		kind: "and",
		operands: requireOperands("AND", operands),
	} as ExprNode<NamesIn<TOperands>> & Composed<"and", TOperands>;
}

/** True when at least one operand is true. See {@link AND} for `Composed`. */
export function OR<const TOperands extends readonly Operand<string>[]>(
	...operands: TOperands
): ExprNode<NamesIn<TOperands>> & Composed<"or", TOperands> {
	return { kind: "or", operands: requireOperands("OR", operands) } as ExprNode<
		NamesIn<TOperands>
	> &
		Composed<"or", TOperands>;
}

/** True when the operand is false. See {@link AND} for `Composed`. */
export function NOT<const TOperand extends Operand<string>>(
	operand: TOperand,
): ExprNode<NamesIn<[TOperand]>> & Composed<"not", [TOperand]> {
	return { kind: "not", operand: toExpr(operand) } as ExprNode<
		NamesIn<[TOperand]>
	> &
		Composed<"not", [TOperand]>;
}

/**
 * True when exactly these conditions hold and **every other condition is
 * false** — the strict form, for when "has a weight" should not also mean "has
 * a weight and is digital".
 *
 * It is the one combinator that depends on conditions it doesn't name, which is
 * why every condition has to be defined before the first bucket.
 */
export function ONLY<TName extends string>(
	...names: readonly TName[]
): ExprNode<TName> {
	for (const name of names) {
		if (typeof name !== "string") {
			throw new BucketError(
				`ONLY() takes condition names, received ${String(name)}.`,
			);
		}
	}
	return { kind: "only", names: [...names] };
}

/** The combinators as a plain object, for handing to a `checkFn`. */
export const LOGIC = { AND, OR, NOT, ONLY } as unknown as LogicBuilder<
	Record<string, unknown>
>;

/**
 * {@link LOGIC} without `ONLY`, for handing to a `when`. Withholding it at
 * runtime too (not just in the type) means a plain-JS caller who destructures
 * `ONLY` off this object gets `undefined` and a native "not a function" error,
 * rather than an `ONLY` that silently means something different than it does
 * everywhere else.
 */
export const PRECONDITION_LOGIC = {
	AND,
	OR,
	NOT,
} as unknown as PreconditionBuilder<Record<string, unknown>>;

/**
 * Evaluates an expression against one set of true conditions.
 *
 * `baseTruths` is the subset of `truths` that `ONLY` counts against, and
 * defaults to all of them. An engine with computed conditions passes the base
 * ones: a computed condition is derived from those, so counting it as another
 * thing that is "also true" would make `ONLY` contradict itself.
 */
export function evaluate(
	expr: ExprNode<string>,
	truths: ReadonlySet<string>,
	baseTruths: ReadonlySet<string> = truths,
): boolean {
	switch (expr.kind) {
		case "condition":
			return truths.has(expr.name);
		case "not":
			return !evaluate(expr.operand, truths, baseTruths);
		case "and":
			return expr.operands.every((operand) =>
				evaluate(operand, truths, baseTruths),
			);
		case "or":
			return expr.operands.some((operand) =>
				evaluate(operand, truths, baseTruths),
			);
		case "only":
			return (
				baseTruths.size === new Set(expr.names).size &&
				expr.names.every((name) => baseTruths.has(name))
			);
	}
}

/** Every condition name an expression mentions, for validating it up front. */
export function referencedNames(
	expr: ExprNode<string>,
	into: Set<string> = new Set(),
): Set<string> {
	switch (expr.kind) {
		case "condition":
			into.add(expr.name);
			break;
		case "not":
			referencedNames(expr.operand, into);
			break;
		case "only":
			for (const name of expr.names) into.add(name);
			break;
		case "and":
		case "or":
			for (const operand of expr.operands) referencedNames(operand, into);
			break;
	}
	return into;
}

/**
 * Every name an expression uses *inside an `ONLY`*, at any depth. Those are the
 * ones that have to be base conditions rather than computed ones, which is
 * checked when the rule is defined rather than per item.
 */
export function onlyNames(
	expr: ExprNode<string>,
	into: Set<string> = new Set(),
): Set<string> {
	switch (expr.kind) {
		case "only":
			for (const name of expr.names) into.add(name);
			break;
		case "not":
			onlyNames(expr.operand, into);
			break;
		case "and":
		case "or":
			for (const operand of expr.operands) onlyNames(operand, into);
			break;
		case "condition":
			break;
	}
	return into;
}
