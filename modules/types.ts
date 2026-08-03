import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LogicBuilder, NamesOf, NarrowOf } from "./logic.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything this package throws. Configuration mistakes (a duplicate bucket
 * name, a condition defined after a bucket) throw immediately from the
 * `define*` call that made them, so a misconfigured engine can never reach
 * `.process()`.
 *
 * `issues` is populated only when the cause was a Standard Schema validation
 * failure, and carries the raw issues from the schema library so you can
 * render them however you like.
 */
export class BucketError extends Error {
	override name = "BucketError";

	/** Present only when this error came from input validation. */
	readonly issues?: readonly StandardSchemaV1.Issue[];

	constructor(message: string, issues?: readonly StandardSchemaV1.Issue[]) {
		super(message);
		if (issues !== undefined) this.issues = issues;
	}
}

/**
 * How many items {@link BucketEngine.process} evaluates at once when the caller
 * doesn't say.
 *
 * Bounded rather than "all of them", because a lane keeps one item's condition
 * promises alive for as long as it runs — one lane per item means every item's
 * promises exist simultaneously. On a 500,000-row batch of purely synchronous
 * predicates that measured 2.4 GB of heap at 280k rows/sec, against 283 MB at
 * 873k rows/sec here: unbounded is slower *and* heavier, which is no way to
 * treat a default. It remains available as an explicit `Infinity`.
 */
export const DEFAULT_CONCURRENCY = 256;

/* -------------------------------------------------------------------------- */
/* Specs — what you hand to the define* methods                                */
/* -------------------------------------------------------------------------- */

/**
 * A named predicate over an item. `checkFn` may be sync or async; whatever it
 * returns is coerced with `Boolean()`, and if it throws, the item lands in
 * `report.errors` rather than taking down the batch.
 *
 * Writing it as a **type predicate** — `(item): item is string => ...` — also
 * tells the engine what the condition proves, which is what makes buckets built
 * from it know their own item type.
 */
export interface ConditionSpec<TName extends string, TCheck> {
	readonly name: TName;
	readonly checkFn: TCheck;
}

/**
 * What a condition proves about an item. A type predicate contributes the type
 * it narrows to; an ordinary boolean predicate proves nothing about the shape,
 * so it contributes `unknown` and {@link BucketItem} falls back from there.
 *
 * The `any` is load-bearing and safe: only the predicate's right-hand side is
 * read, and a type predicate may sit on neither a `never` nor an inferred
 * parameter, so there is no narrower type that still matches every checkFn.
 */
export type GuardOf<TCheck> =
	// biome-ignore lint/suspicious/noExplicitAny: matching position only, see above
	TCheck extends (item: any) => item is infer TNarrow ? TNarrow : unknown;

/**
 * The item type a bucket hands back.
 *
 * A rule that proved nothing — `NOT(...)`, `ONLY()`, or any condition declared
 * without a type predicate — leaves `unknown`, and the bucket falls back to the
 * engine's input type rather than throwing away what was already known. When a
 * rule did prove something, that answer is used as-is: a type predicate's type
 * is by definition a subtype of what it was checking, so there is nothing left
 * to intersect it with.
 */
export type BucketItem<TOperand, TGuards, TInput> =
	unknown extends NarrowOf<TOperand, TGuards>
		? TInput
		: NarrowOf<TOperand, TGuards>;

/**
 * A named rule over the conditions. `checkFn` is handed the combinators bound
 * to this engine's conditions and returns the expression deciding membership:
 *
 * ```ts
 * { name: "incomplete", checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("hasPhoto")) }
 * ```
 *
 * Conditions an expression doesn't mention are free — a rule constrains only
 * what it names, unless it uses `ONLY`. Returning a bare condition name is
 * shorthand for that condition being true.
 */
export interface BucketSpec<TName extends string, TGuards, TOperand> {
	readonly name: TName;
	readonly checkFn: (logic: LogicBuilder<TGuards>) => TOperand;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** Every condition's verdict for one item, keyed by condition name. */
export type ConditionReport<TConditions extends string> = Readonly<
	Record<TConditions, boolean>
>;

/**
 * An item that answered every condition without error but matched no bucket.
 * `conditions` is the combination that satisfied nothing, which is normally
 * exactly the rule you have yet to write.
 */
export interface UnmatchedItem<TInput, TConditions extends string> {
	readonly item: TInput;
	readonly conditions: ConditionReport<TConditions>;
}

/**
 * An item that could not be classified. `stage` says where it died: `"input"`
 * means the Standard Schema rejected it, `"condition"` means a `checkFn` threw
 * (and `condition` names which one).
 */
export interface BucketFailure<TInput, TConditions extends string> {
	readonly item: TInput;
	readonly stage: "input" | "condition";
	readonly condition?: TConditions;
	readonly error: Error;
}

/**
 * What `.process()` returns.
 *
 * Buckets are independent rules, so an item appears in **every** bucket whose
 * expression it satisfies — the counts across `buckets` can exceed the size of
 * the batch, and that is not a bug. What is guaranteed is that every item shows
 * up somewhere: in at least one bucket, in `unmatched`, or in `errors`.
 *
 * Each bucket is typed by what its rule proved, so a bucket built from type
 * predicates hands back the narrow type rather than the engine's input type.
 */
export interface BucketReport<TInput, TGuards, TBuckets> {
	/** One key per declared bucket, in definition order, always present. */
	readonly buckets: { readonly [K in keyof TBuckets]: TBuckets[K][] };
	readonly unmatched: readonly UnmatchedItem<TInput, NamesOf<TGuards>>[];
	readonly errors: readonly BucketFailure<TInput, NamesOf<TGuards>>[];
}

/**
 * What `.processOne()` returns. `buckets` holds every rule the item satisfied,
 * in definition order; an empty array is the single-item equivalent of landing
 * in `unmatched`.
 */
export interface BucketAssignment<TInput, TGuards, TBuckets> {
	/** The validated item — the schema's *output*, so any transform applied. */
	readonly item: TInput;
	readonly buckets: NamesOf<TBuckets>[];
	readonly conditions: ConditionReport<NamesOf<TGuards>>;
}

/** Per-call knobs for `.process()`. */
export interface ProcessOptions {
	/**
	 * How many items to evaluate at once. Defaults to
	 * {@link DEFAULT_CONCURRENCY}.
	 *
	 * Raise it when conditions do I/O and the far end can take the traffic;
	 * lower it when it can't. `Infinity` evaluates the whole batch at once,
	 * which is worth knowing about but slower and far heavier on a big batch,
	 * since it keeps every item's promises alive simultaneously.
	 *
	 * Output order matches input order whatever this is set to.
	 */
	readonly concurrency?: number;
}

/* -------------------------------------------------------------------------- */
/* Type-level validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Intersected into `defineCondition`'s parameter. Resolving to `unknown` is
 * the pass case — intersecting with `unknown` changes nothing. Otherwise it
 * retypes the offending property as a sentence, so the compiler reports the
 * rule that was broken instead of a structural mismatch.
 */
export type ValidateCondition<TName extends string, TGuards, TBuckets> = [
	NamesOf<TBuckets>,
] extends [never]
	? TName extends NamesOf<TGuards>
		? { name: `A condition named "${TName}" is already defined` }
		: unknown
	: {
			name: "Define every condition before the first bucket — ONLY() depends on the full set";
		};

/** The `defineBucket` counterpart of {@link ValidateCondition}. */
export type ValidateBucket<TName extends string, TBuckets> =
	TName extends NamesOf<TBuckets>
		? { name: `A bucket named "${TName}" is already defined` }
		: unknown;
