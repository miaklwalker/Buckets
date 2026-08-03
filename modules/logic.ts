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
 * Anywhere an expression is accepted, a bare condition name means "this
 * condition is true" — so `OR("isVip", NOT("hasWeight"))` needs no wrapper
 * around the first operand, and a bucket that turns on a single condition is
 * just `checkFn: () => "hasWeight"`.
 */
export type Operand<TName extends string> = TName | Expr<TName, unknown>;

/**
 * What one operand narrows the item to: a bare name resolves through the
 * engine's guard map, an expression carries its own answer, and anything
 * unrecognised contributes `unknown`.
 */
export type NarrowOf<TOperand, TGuards> = TOperand extends keyof TGuards
	? TGuards[TOperand]
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
 */
export type IntersectAll<
	TOperands extends readonly unknown[],
	TGuards,
> = TOperands extends readonly [infer THead, ...infer TTail]
	? NarrowOf<THead, TGuards> & IntersectAll<TTail, TGuards>
	: unknown;

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
 * The same functions are exported from the package for expressions you want to
 * hoist and share. Those don't narrow — a free-standing expression has no guard
 * map to resolve names against — but they still check the names.
 */
export interface LogicBuilder<TGuards> {
	readonly AND: <const TOperands extends readonly Operand<NamesOf<TGuards>>[]>(
		...operands: TOperands
	) => Expr<NamesOf<TGuards>, IntersectAll<TOperands, TGuards>>;
	readonly OR: <const TOperands extends readonly Operand<NamesOf<TGuards>>[]>(
		...operands: TOperands
	) => Expr<NamesOf<TGuards>, NarrowOf<TOperands[number], TGuards>>;
	readonly NOT: (
		operand: Operand<NamesOf<TGuards>>,
	) => Expr<NamesOf<TGuards>, unknown>;
	readonly ONLY: <const TNames extends readonly NamesOf<TGuards>[]>(
		...names: TNames
	) => Expr<NamesOf<TGuards>, IntersectAll<TNames, TGuards>>;
}

/** The string keys of a name-to-something map — condition names, bucket names. */
export type NamesOf<TGuards> = Extract<keyof TGuards, string>;

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

/** True when every operand is true. */
export function AND<TName extends string>(
	...operands: readonly Operand<TName>[]
): ExprNode<TName> {
	return { kind: "and", operands: requireOperands("AND", operands) };
}

/** True when at least one operand is true. */
export function OR<TName extends string>(
	...operands: readonly Operand<TName>[]
): ExprNode<TName> {
	return { kind: "or", operands: requireOperands("OR", operands) };
}

/** True when the operand is false. */
export function NOT<TName extends string>(
	operand: Operand<TName>,
): ExprNode<TName> {
	return { kind: "not", operand: toExpr(operand) };
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

/** Evaluates an expression against one set of true conditions. */
export function evaluate(
	expr: ExprNode<string>,
	truths: ReadonlySet<string>,
): boolean {
	switch (expr.kind) {
		case "condition":
			return truths.has(expr.name);
		case "not":
			return !evaluate(expr.operand, truths);
		case "and":
			return expr.operands.every((operand) => evaluate(operand, truths));
		case "or":
			return expr.operands.some((operand) => evaluate(operand, truths));
		case "only":
			return (
				truths.size === new Set(expr.names).size &&
				expr.names.every((name) => truths.has(name))
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
