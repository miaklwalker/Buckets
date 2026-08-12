import type { StandardSchemaV1 } from "@standard-schema/spec";
import { allAssignments } from "./enumerate.ts";
import {
	type ExprNode,
	evaluate,
	LOGIC,
	type LogicBuilder,
	type NamesOf,
	type NarrowOf,
	type Operand,
	onlyNames,
	PRECONDITION_LOGIC,
	type PreconditionBuilder,
	referencedNames,
	toExpr,
} from "./logic.ts";
import { mapWithConcurrency, resolveConcurrency } from "./schedule.ts";
import {
	type BucketAssignment,
	BucketError,
	type BucketFailure,
	type BucketItem,
	type BucketReport,
	type BucketSpec,
	type ComputedConditionSpec,
	type ConditionReport,
	type ConditionSpec,
	type GuardOf,
	type ProcessOptions,
	type UnmatchedItem,
	type ValidateBucket,
	type ValidateComputedCondition,
	type ValidateCondition,
} from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Internal storage (type-erased; the public API keeps the types)              */
/* -------------------------------------------------------------------------- */

interface StoredCondition {
	readonly name: string;
	readonly checkFn: (item: unknown) => boolean | Promise<boolean>;
	/** Undefined for a condition with no `when` — always runs. */
	readonly when: ExprNode<string> | undefined;
	/**
	 * How many `when` hops separate this condition from one with none — 0 for
	 * an ungated condition, otherwise one more than the furthest condition its
	 * `when` names. Conditions sharing a wave have nothing to wait on each
	 * other for, so a wave is evaluated as one concurrent batch; waves run in
	 * order because a later one may depend on an earlier one's verdict.
	 */
	readonly wave: number;
}

interface StoredBucket {
	readonly name: string;
	readonly expr: ExprNode<string>;
}

/** Same shape as a bucket — a computed condition differs only in what it feeds. */
type StoredComputed = StoredBucket;

type Outcome<TInput> =
	| {
			readonly kind: "classified";
			readonly item: TInput;
			readonly buckets: string[];
			readonly conditions: Record<string, boolean>;
	  }
	| {
			readonly kind: "failed";
			readonly failures: readonly BucketFailure<TInput, string>[];
	  };

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
	return issues
		.map((issue) => {
			const path = (issue.path ?? [])
				.map((segment) =>
					typeof segment === "object" ? String(segment.key) : String(segment),
				)
				.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A rule engine that sorts items into named buckets.
 *
 * You declare named conditions over the item, then declare buckets as boolean
 * expressions over those conditions. Buckets are independent rules rather than
 * a partition: an item lands in every bucket whose expression it satisfies, and
 * in `unmatched` if it satisfies none.
 *
 * ```ts
 * const engine = new BucketEngine()
 *   .defineInput(z.object({ weightKg: z.number().nullable(), photos: z.number() }))
 *   .defineCondition({ name: "hasWeight", checkFn: (p) => p.weightKg !== null })
 *   .defineCondition({ name: "hasPhoto", checkFn: (p) => p.photos > 0 })
 *   .defineBucket({ name: "shippable", checkFn: () => "hasWeight" })
 *   .defineBucket({
 *     name: "incomplete",
 *     checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("hasPhoto")),
 *   })
 *   .defineBucket({ name: "weightOnly", checkFn: ({ ONLY }) => ONLY("hasWeight") });
 *
 * const report = await engine.process(products);
 * report.buckets.shippable; // Product[]
 * ```
 *
 * A combination of conditions you name often enough is worth naming once, with
 * {@link defineComputedCondition} — the name then reads as a condition
 * everywhere afterwards.
 *
 * All three name parameters are inferred: every condition, computed condition
 * and bucket you declare widens them, which is what makes `checkFn`'s
 * combinators complete your condition names and reject anything else.
 */
export class BucketEngine<
	TInput = never,
	TGuards extends Record<string, unknown> = Record<never, never>,
	TBuckets extends Record<string, unknown> = Record<never, never>,
	TComputed extends Record<string, unknown> = Record<never, never>,
> {
	private schema: StandardSchemaV1 | undefined;
	private inputDefined = false;
	private readonly conditions: StoredCondition[] = [];
	private readonly computed: StoredComputed[] = [];
	private readonly buckets: StoredBucket[] = [];
	/** Conditions grouped by {@link StoredCondition.wave}, rebuilt on demand. */
	private waveGroupsCache: readonly StoredCondition[][] | undefined;

	/**
	 * Describe the items being sorted with a [Standard Schema](https://standardschema.dev)
	 * — Zod, Valibot, ArkType, Effect Schema, anything compliant. `TInput` is
	 * inferred from the schema's *output* type, so a schema that transforms
	 * gives conditions the transformed value, and that same value is what ends
	 * up in the report.
	 *
	 * Call it first. Conditions are typed against whatever the input was when
	 * they were defined, so defining them before the schema leaves them typed
	 * against `never`; the runtime enforces the ordering to match.
	 */
	defineInput<TSchema>(
		schema: StandardSchemaV1<unknown, TSchema>,
	): BucketEngine<TSchema, TGuards, TBuckets, TComputed>;
	/**
	 * Declare the item type without a schema, for when you already trust the
	 * data and only want the type safety: `.defineInput<Product>()`. Nothing is
	 * validated at runtime, so `report.errors` can then only ever contain
	 * condition failures.
	 */
	defineInput<TShape>(): BucketEngine<TShape, TGuards, TBuckets, TComputed>;
	defineInput<TSchema>(
		schema?: StandardSchemaV1<unknown, TSchema>,
	): BucketEngine<TSchema, TGuards, TBuckets, TComputed> {
		if (this.inputDefined) {
			throw new BucketError(
				"Input is already defined. Call .defineInput() once, before any condition.",
			);
		}
		if (this.conditions.length > 0 || this.computed.length > 0) {
			throw new BucketError(
				"Define the input before any condition — conditions defined earlier are typed against the wrong item.",
			);
		}
		if (schema !== undefined) {
			if (
				typeof schema !== "object" ||
				schema === null ||
				typeof (schema as StandardSchemaV1)["~standard"]?.validate !==
					"function"
			) {
				throw new BucketError(
					"defineInput() expects a Standard Schema (a value with a '~standard' property), or no argument at all.",
				);
			}
			this.schema = schema as StandardSchemaV1;
		}
		this.inputDefined = true;
		return this as unknown as BucketEngine<
			TSchema,
			TGuards,
			TBuckets,
			TComputed
		>;
	}

	/**
	 * Register a named predicate over the item. The name becomes part of this
	 * engine's type, so a bucket's combinators will complete it for you and
	 * reject anything else.
	 *
	 * `checkFn` may be async, and may throw — a throw sends that item to
	 * `report.errors` and leaves the rest of the batch alone.
	 *
	 * All conditions must be defined before the first computed condition and the
	 * first bucket, because `ONLY()` means "these and nothing else" and so
	 * depends on the complete set. Adding a condition afterwards would quietly
	 * change what an existing `ONLY` rule matches.
	 *
	 * `when` names a precondition over the conditions defined so far — a bare
	 * name, or `AND`/`OR`/`NOT` over them:
	 *
	 * ```ts
	 * .defineCondition({
	 *   name: "hasProduct",
	 *   checkFn: (item): item is typeof item & { product: Product } =>
	 *     item.product !== undefined,
	 * })
	 * .defineCondition({
	 *   name: "hasWeight",
	 *   when: () => "hasProduct",
	 *   // item.product is Product here, not Product | undefined — no `?.`,
	 *   // because `hasProduct` already proved it before this ever runs.
	 *   checkFn: (item) => item.product.weight > 0,
	 * })
	 * ```
	 *
	 * When the precondition is false, `hasWeight` is recorded `false` and its
	 * `checkFn` never runs — worth it when `checkFn` is the expensive one, and
	 * free of any risk to `ONLY`, since a condition whose precondition failed
	 * would have had nothing left to be true *of* anyway. That's the deal `when`
	 * makes on your behalf: it doesn't infer that `hasWeight` implies
	 * `hasProduct`, it trusts you to only gate a condition behind a precondition
	 * that actually is one.
	 *
	 * The skip always happens, whatever `when` is built from and however it's
	 * written. Narrowing `checkFn`'s `item` needs one more thing: `AND`/`OR`/
	 * `NOT` have to be called as *values*, not inside the `({ AND }) => ...`
	 * callback:
	 *
	 * ```ts
	 * .defineCondition({
	 *   name: "readyToShip",
	 *   when: AND("hasProduct", "isActive"),
	 *   // item.product is Product here too — AND, called as a value, carries
	 *   // enough to resolve the narrowing once TGuards is in scope.
	 *   checkFn: (item) => item.product.weight > 0,
	 * })
	 * ```
	 *
	 * The callback form (`when: ({ AND }) => AND(...)`) still works and still
	 * skips correctly, but leaves `checkFn`'s `item` at the plain input type —
	 * the same honest fallback `NOT` already gets in a bucket's combinators.
	 * The difference is a real TypeScript inference limit, not a design choice:
	 * `checkFn`'s contextual type can't be resolved from a *sibling callback
	 * parameter's own method call* within the same object literal, because by
	 * the time that's needed, the compiler has already committed to resolving
	 * it a different way (confirmed against a minimal, library-free repro). A
	 * value passed directly — `AND(...)`, no wrapping callback — doesn't hit
	 * that: its result is inferred before `checkFn` is even looked at, the same
	 * way a bare name already was.
	 *
	 * Trading the destructured callback for a value is also what costs you
	 * autocomplete on the condition names — `AND` called as a value has no
	 * engine in scope yet to complete against, only whatever `TGuards` it's
	 * eventually checked against once it reaches here. `({ AND }) => AND(...)`
	 * doesn't have that problem: `AND` there is already bound to this engine's
	 * real condition names. To get *both* — autocomplete on a compound `when`
	 * *and* narrowing — pass `checkFn` as a second argument instead of a
	 * property of the same object:
	 *
	 * ```ts
	 * .defineCondition(
	 *   { name: "readyToShip", when: ({ AND }) => AND("hasProduct", "isActive") },
	 *   (item) => item.product.weight > 0, // narrowed, and AND completed
	 * )
	 * ```
	 *
	 * This isn't just a nicer-looking version of the one-object form — it's a
	 * different call shape TypeScript resolves differently: `when` is now a
	 * complete argument on its own, so it's fully inferred before `checkFn` —
	 * the next argument — is ever contextually typed, sidestepping the same
	 * inference limit the callback form runs into inside one object.
	 */
	defineCondition<
		const TName extends string,
		const TWhenOperand extends
			| Operand<NamesOf<TGuards>>
			| undefined = undefined,
		TCheck extends (
			item: TInput & NarrowOf<TWhenOperand, TGuards>,
		) => boolean | Promise<boolean> = (
			item: TInput & NarrowOf<TWhenOperand, TGuards>,
		) => boolean | Promise<boolean>,
	>(
		condition: ConditionSpec<
			TName,
			TCheck,
			TWhenOperand | ((logic: PreconditionBuilder<TGuards>) => TWhenOperand)
		> &
			ValidateCondition<TName, TGuards, TComputed, TBuckets>,
	): BucketEngine<
		TInput,
		TGuards & { [K in TName]: GuardOf<TCheck> },
		TBuckets,
		TComputed
	>;
	defineCondition<
		const TName extends string,
		const TWhenOperand extends
			| Operand<NamesOf<TGuards>>
			| undefined = undefined,
		TCheck extends (
			item: TInput & NarrowOf<TWhenOperand, TGuards>,
		) => boolean | Promise<boolean> = (
			item: TInput & NarrowOf<TWhenOperand, TGuards>,
		) => boolean | Promise<boolean>,
	>(
		condition: {
			readonly name: TName;
			readonly when?: (logic: PreconditionBuilder<TGuards>) => TWhenOperand;
		} & ValidateCondition<TName, TGuards, TComputed, TBuckets>,
		checkFn: TCheck,
	): BucketEngine<
		TInput,
		TGuards & { [K in TName]: GuardOf<TCheck> },
		TBuckets,
		TComputed
	>;
	defineCondition(
		condition: {
			readonly name: string;
			readonly when?: (
				logic: PreconditionBuilder<TGuards>,
			) => Operand<NamesOf<TGuards>> | undefined;
			readonly checkFn?: unknown;
		},
		checkFnArg?: unknown,
	): unknown {
		const { name, when } = condition;
		const checkFn = checkFnArg !== undefined ? checkFnArg : condition.checkFn;

		if (typeof name !== "string" || name.length === 0) {
			throw new BucketError("A condition needs a non-empty name.");
		}
		if (typeof checkFn !== "function") {
			throw new BucketError(`Condition "${name}" needs a checkFn.`);
		}
		if (this.buckets.length > 0) {
			throw new BucketError(
				`Cannot define condition "${name}" after a bucket has been defined — ONLY() depends on the complete set of conditions. Define all conditions first.`,
			);
		}
		if (this.computed.length > 0) {
			throw new BucketError(
				`Cannot define condition "${name}" after a computed condition has been defined — a computed condition is built from the conditions that already exist. Define all conditions first.`,
			);
		}
		this.assertNameIsFree(name);

		const { whenExpr, wave } = this.resolveWhen(
			name,
			when as unknown as
				| Operand<string>
				| ((logic: PreconditionBuilder<unknown>) => Operand<string>)
				| undefined,
		);

		this.conditions.push({
			name,
			// The stored registry is erased: it holds predicates written against
			// whatever `TInput` was, and only ever receives validated items.
			checkFn: checkFn as (item: unknown) => boolean | Promise<boolean>,
			when: whenExpr,
			wave,
		});
		this.waveGroupsCache = undefined;

		return this;
	}

	/**
	 * Turns a `when` — a value or a callback that produces one — into the
	 * expression it names plus which wave the condition belongs to, or the
	 * no-precondition default (`undefined`, wave `0`) when there isn't one.
	 *
	 * A callback (`when: ({ AND }) => AND("a", "b")`) is always accepted, and
	 * a bare name works either as a callback (`when: () => "a"`) or a plain
	 * value (`when: "a"`). Only a standalone `AND`/`OR`/`NOT` result narrows
	 * `checkFn`'s item — it has to be handed over as the value itself
	 * (`when: AND("a", "b")`), not wrapped in a callback: see the doc comment
	 * on `defineCondition` for why the wrapped form can't carry the same
	 * narrowing through.
	 */
	private resolveWhen(
		conditionName: string,
		when:
			| Operand<string>
			| ((logic: PreconditionBuilder<unknown>) => Operand<string>)
			| undefined,
	): { whenExpr: ExprNode<string> | undefined; wave: number } {
		if (when === undefined) return { whenExpr: undefined, wave: 0 };

		let produced: Operand<string>;
		if (typeof when === "function") {
			produced = when(
				PRECONDITION_LOGIC as unknown as PreconditionBuilder<unknown>,
			);
		} else if (typeof when === "string" || typeof when === "object") {
			produced = when;
		} else {
			throw new BucketError(
				`Condition "${conditionName}"'s "when" needs a condition name, an expression like AND("a", "b"), or a function producing one — like () => "hasProduct" or ({ AND }) => AND("a", "b").`,
			);
		}
		const whenExpr = toExpr(produced);

		const known = new Map(
			this.conditions.map((existing) => [existing.name, existing.wave]),
		);
		let wave = 0;
		for (const referenced of referencedNames(whenExpr)) {
			const parentWave = known.get(referenced);
			if (parentWave === undefined) {
				throw new BucketError(
					`Condition "${conditionName}"'s "when" refers to unknown condition "${referenced}". A precondition can only name conditions already defined. Defined: ${[...known.keys()].join(", ") || "(none)"}.`,
				);
			}
			wave = Math.max(wave, parentWave + 1);
		}

		return { whenExpr, wave };
	}

	/**
	 * Name a combination of conditions, and have that name be a condition.
	 *
	 * `checkFn` receives the same combinators a bucket's does, bound to every
	 * condition defined so far, and returns the expression the name stands for:
	 *
	 * ```ts
	 * .defineComputedCondition({
	 *   name: "listedCorrectly",
	 *   checkFn: ({ AND }) => AND("hasWeight", "hasPrice", "hasCategory"),
	 * })
	 * .defineBucket({ name: "readyToShip", checkFn: ({ AND }) => AND("listedCorrectly", "inStock") })
	 * ```
	 *
	 * Afterwards the name works anywhere a condition name does: in a later
	 * computed condition (so they layer), in a bucket, and as a key of the
	 * report's `conditions` — which is the point, since seeing *why* an item was
	 * unmatched is easier in terms you named than in raw predicates.
	 *
	 * It costs nothing per item beyond the expression evaluation: the verdicts
	 * it reads were already collected, so this never re-runs a `checkFn`.
	 *
	 * Two rules follow from what these are. They come after every plain
	 * condition, since a computed condition can only be built out of what
	 * already exists — which also makes a cycle unstateable. And `ONLY` won't
	 * accept one: `ONLY` means "and every other condition is false", and a
	 * computed condition isn't another fact about the item, it's a restatement
	 * of the facts already counted. `ONLY("hasWeight")` therefore means exactly
	 * what it meant before you named anything.
	 */
	defineComputedCondition<
		const TName extends string,
		const TOperand extends Operand<NamesOf<TGuards & TComputed>>,
	>(
		condition: ComputedConditionSpec<
			TName,
			TGuards & TComputed,
			NamesOf<TGuards>,
			TOperand
		> &
			ValidateComputedCondition<TName, TGuards, TComputed, TBuckets>,
	): BucketEngine<
		TInput,
		TGuards,
		TBuckets,
		TComputed & { [K in TName]: NarrowOf<TOperand, TGuards & TComputed> }
	> {
		const { name, checkFn } = condition as ComputedConditionSpec<
			TName,
			TGuards & TComputed,
			NamesOf<TGuards>,
			TOperand
		>;

		if (typeof name !== "string" || name.length === 0) {
			throw new BucketError("A computed condition needs a non-empty name.");
		}
		if (typeof checkFn !== "function") {
			throw new BucketError(
				`Computed condition "${name}" needs a checkFn returning an expression, like ({ AND }) => AND("a", "b").`,
			);
		}
		if (this.buckets.length > 0) {
			throw new BucketError(
				`Cannot define computed condition "${name}" after a bucket has been defined — ONLY() depends on the complete set of conditions. Define all conditions first.`,
			);
		}
		this.assertNameIsFree(name);

		// The combinators are name-agnostic at runtime; the parameter type exists
		// only to type the names for whoever writes the callback.
		const produced = checkFn(
			LOGIC as unknown as LogicBuilder<TGuards & TComputed, NamesOf<TGuards>>,
		);
		const expr = toExpr(produced) as ExprNode<string>;
		this.assertKnownConditions(
			`Computed condition "${name}"`,
			expr,
			// Only what already exists — a computed condition may not name itself,
			// nor one defined after it, which is what rules out a cycle.
			new Set([
				...this.conditions.map((existing) => existing.name),
				...this.computed.map((existing) => existing.name),
			]),
		);

		this.computed.push({ name, expr });

		return this as unknown as BucketEngine<
			TInput,
			TGuards,
			TBuckets,
			TComputed & { [K in TName]: NarrowOf<TOperand, TGuards & TComputed> }
		>;
	}

	/**
	 * Declare a bucket as a boolean rule over the conditions. `checkFn` receives
	 * the combinators bound to this engine's condition names and returns the
	 * expression:
	 *
	 * ```ts
	 * .defineBucket({ name: "shippable", checkFn: () => "hasWeight" })
	 * .defineBucket({ name: "sellable", checkFn: ({ AND }) => AND("hasPhoto", "hasPrice") })
	 * .defineBucket({ name: "incomplete", checkFn: ({ OR, NOT }) => OR(NOT("hasPhoto"), NOT("hasPrice")) })
	 * .defineBucket({ name: "bareListing", checkFn: ({ ONLY }) => ONLY("hasTitle") })
	 * ```
	 *
	 * Conditions a rule doesn't name are free: `() => "hasWeight"` matches
	 * anything with a weight, whatever else is true of it. `ONLY(...)` is the
	 * strict form — exactly these conditions and no others.
	 *
	 * Buckets are independent, so rules may overlap freely and an item lands in
	 * every one it satisfies. Only the *name* has to be unique, which is checked
	 * at compile time and again here.
	 */
	defineBucket<
		const TName extends string,
		const TOperand extends Operand<NamesOf<TGuards & TComputed>>,
	>(
		bucket: BucketSpec<TName, TGuards & TComputed, TOperand, NamesOf<TGuards>> &
			ValidateBucket<TName, TBuckets>,
	): BucketEngine<
		TInput,
		TGuards,
		TBuckets & {
			[K in TName]: BucketItem<TOperand, TGuards & TComputed, TInput>;
		},
		TComputed
	> {
		const { name, checkFn } = bucket as BucketSpec<
			TName,
			TGuards & TComputed,
			TOperand,
			NamesOf<TGuards>
		>;

		if (typeof name !== "string" || name.length === 0) {
			throw new BucketError("A bucket needs a non-empty name.");
		}
		if (typeof checkFn !== "function") {
			throw new BucketError(
				`Bucket "${name}" needs a checkFn returning an expression, like ({ AND }) => AND("a", "b").`,
			);
		}
		if (this.buckets.some((existing) => existing.name === name)) {
			throw new BucketError(`A bucket named "${name}" is already defined.`);
		}

		// The combinators are name-agnostic at runtime; the parameter type exists
		// only to type the names for whoever writes the callback.
		const produced = checkFn(
			LOGIC as unknown as LogicBuilder<TGuards & TComputed, NamesOf<TGuards>>,
		);
		const expr = toExpr(produced) as ExprNode<string>;
		this.assertKnownConditions(`Bucket "${name}"`, expr, this.knownNames());

		this.buckets.push({ name, expr });

		return this as unknown as BucketEngine<
			TInput,
			TGuards,
			TBuckets & {
				[K in TName]: BucketItem<TOperand, TGuards & TComputed, TInput>;
			},
			TComputed
		>;
	}

	/**
	 * An independent engine with everything defined so far, at the same type.
	 *
	 * The `define*` methods mutate and return the same object, which is what
	 * makes the chain read the way it does — and what makes branching off a
	 * shared variable a trap:
	 *
	 * ```ts
	 * const base = engineWithConditions;
	 * const one = base.defineBucket({ name: "a", checkFn: () => "hasWeight" });
	 * const two = base.defineBucket({ name: "b", checkFn: () => "isDigital" });
	 * // one === two === base, and both now hold *both* buckets, while the
	 * // types still claim one each.
	 * ```
	 *
	 * `clone()` is the way to say what that was trying to say:
	 *
	 * ```ts
	 * const one = base.clone().defineBucket({ name: "a", checkFn: () => "hasWeight" });
	 * const two = base.clone().defineBucket({ name: "b", checkFn: () => "isDigital" });
	 * ```
	 *
	 * The copy is shallow, which is all it needs to be: a stored condition is a
	 * name and a function, a stored rule is a name and an expression tree, and
	 * nothing mutates either after they're registered. Defining anything on
	 * either engine afterwards leaves the other alone.
	 *
	 * The ordering rules come with it — a clone taken after the first bucket
	 * still refuses a new condition, since its `ONLY` rules were written against
	 * the set it already has.
	 */
	clone(): BucketEngine<TInput, TGuards, TBuckets, TComputed> {
		const copy = new BucketEngine<TInput, TGuards, TBuckets, TComputed>();

		copy.schema = this.schema;
		copy.inputDefined = this.inputDefined;
		copy.conditions.push(...this.conditions);
		copy.computed.push(...this.computed);
		copy.buckets.push(...this.buckets);

		return copy;
	}

	/** Every condition name, computed ones included, in definition order. */
	private knownNames(): Set<string> {
		return new Set([
			...this.conditions.map((condition) => condition.name),
			...this.computed.map((condition) => condition.name),
		]);
	}

	/** Conditions and computed conditions share one namespace. */
	private assertNameIsFree(name: string): void {
		if (!this.knownNames().has(name)) return;
		throw new BucketError(`A condition named "${name}" is already defined.`);
	}

	/**
	 * Every name a rule mentions has to be a condition that exists, and every
	 * name it mentions inside an `ONLY` has to be a base one — `ONLY` counts the
	 * conditions that are false, and a computed condition isn't one of those.
	 */
	private assertKnownConditions(
		label: string,
		expr: ExprNode<string>,
		known: ReadonlySet<string>,
	): void {
		for (const conditionName of referencedNames(expr)) {
			if (known.has(conditionName)) continue;
			throw new BucketError(
				`${label} refers to unknown condition "${conditionName}". Defined: ${[...known].join(", ") || "(none)"}.`,
			);
		}

		const base = new Set(this.conditions.map((condition) => condition.name));
		for (const conditionName of onlyNames(expr)) {
			if (base.has(conditionName)) continue;
			throw new BucketError(
				`${label} passes computed condition "${conditionName}" to ONLY(), which takes plain conditions only — ONLY() means "and every other condition is false", and a computed condition restates conditions already counted. Name the conditions it is built from instead.`,
			);
		}
	}

	/** The plain condition names, in definition order. */
	get conditionNames(): NamesOf<TGuards>[] {
		return this.conditions.map(
			(condition) => condition.name,
		) as NamesOf<TGuards>[];
	}

	/** The computed condition names, in definition order. */
	get computedConditionNames(): NamesOf<TComputed>[] {
		return this.computed.map(
			(condition) => condition.name,
		) as NamesOf<TComputed>[];
	}

	/** The bucket names, in definition order. */
	get bucketNames(): NamesOf<TBuckets>[] {
		return this.buckets.map((bucket) => bucket.name) as NamesOf<TBuckets>[];
	}

	/**
	 * Every combination of conditions that satisfies no bucket, each given as
	 * the conditions that would be true. These are precisely the items that
	 * would land in `report.unmatched`, so this answers "what have I not written
	 * a rule for yet?" without waiting for the data to tell you.
	 *
	 * Only the plain conditions are enumerated, and reported: those are the free
	 * variables, and a computed condition is derived from them rather than
	 * independently true or false.
	 *
	 * A condition with a `when` narrows what gets enumerated in the first place:
	 * an assignment where it's true but its precondition isn't is not a
	 * combination any item could actually produce, so it's dropped before the
	 * bucket rules are even checked — one more thing `when` buys for free
	 * besides the runtime skip.
	 *
	 * Enumerating is exponential, so this refuses to run past 16 conditions
	 * (65,536 combinations) rather than hanging. Nothing else enumerates.
	 */
	missingCombinations(): NamesOf<TGuards>[][] {
		const conditionNames = this.conditions.map((condition) => condition.name);

		return allAssignments(conditionNames, "missingCombinations()")
			.filter((baseTruths) => this.reachable(baseTruths))
			.filter((baseTruths) => {
				const truths = this.deriveComputed(baseTruths);
				return this.buckets.every(
					(bucket) => !evaluate(bucket.expr, truths, baseTruths),
				);
			})
			.map(
				(truths) =>
					// Report them in definition order rather than insertion order.
					conditionNames.filter((name) =>
						truths.has(name),
					) as NamesOf<TGuards>[],
			);
	}

	/**
	 * False when some condition is assigned true while its `when` isn't — no
	 * item can ever produce that assignment, since `checkFn` never even runs
	 * without the precondition holding first.
	 */
	private reachable(baseTruths: ReadonlySet<string>): boolean {
		return this.conditions.every((condition) => {
			if (condition.when === undefined || !baseTruths.has(condition.name)) {
				return true;
			}
			return evaluate(condition.when, baseTruths, baseTruths);
		});
	}

	/**
	 * Conditions grouped by {@link StoredCondition.wave}, in ascending order —
	 * wave 0 first, ungated or not. Cached because it never changes once
	 * conditions stop being defined, which `.process()` already requires.
	 */
	private get waveGroups(): readonly StoredCondition[][] {
		if (this.waveGroupsCache !== undefined) return this.waveGroupsCache;

		const groups: StoredCondition[][] = [];
		for (const condition of this.conditions) {
			while (groups.length <= condition.wave) groups.push([]);
			groups[condition.wave]?.push(condition);
		}
		this.waveGroupsCache = groups;
		return groups;
	}

	/**
	 * Fold the computed conditions into a set of base verdicts, in definition
	 * order so each one sees the ones before it, and record each verdict in
	 * `into` when a report is being built.
	 */
	private deriveComputed(
		baseTruths: ReadonlySet<string>,
		into?: Record<string, boolean>,
	): Set<string> {
		const truths = new Set(baseTruths);
		for (const condition of this.computed) {
			const value = evaluate(condition.expr, truths, baseTruths);
			if (into !== undefined) into[condition.name] = value;
			if (value) truths.add(condition.name);
		}
		return truths;
	}

	/**
	 * Sort a batch. Every item ends up in at least one bucket, in `unmatched`,
	 * or in `errors`, and order within each is the order the items arrived in,
	 * whatever `concurrency` is set to.
	 *
	 * Since buckets are independent rules, an item satisfying three of them is
	 * added to all three — summing the buckets can exceed the batch size.
	 *
	 * Nothing here throws for bad data: a schema failure or a throwing `checkFn`
	 * is recorded in `errors` and the batch continues. Configuration mistakes
	 * still throw, since those are yours rather than the data's.
	 */
	async process(
		items: readonly TInput[],
		options: ProcessOptions = {},
	): Promise<BucketReport<TInput, TGuards & TComputed, TBuckets>> {
		this.assertReady(".process()");
		if (!Array.isArray(items)) {
			throw new BucketError(
				".process() expects an array of items. Use .processOne() for a single item.",
			);
		}

		const concurrency = resolveConcurrency(options.concurrency);
		const buckets = {} as Record<string, TInput[]>;
		for (const bucket of this.buckets) buckets[bucket.name] = [];
		const unmatched: UnmatchedItem<TInput, NamesOf<TGuards & TComputed>>[] = [];
		const errors: BucketFailure<TInput, NamesOf<TGuards & TComputed>>[] = [];

		const outcomes = await mapWithConcurrency(items, concurrency, (item) =>
			this.evaluateItem(item),
		);

		for (const outcome of outcomes) {
			if (outcome.kind === "failed") {
				errors.push(
					...(outcome.failures as BucketFailure<
						TInput,
						NamesOf<TGuards & TComputed>
					>[]),
				);
				continue;
			}
			const conditions = outcome.conditions as ConditionReport<
				NamesOf<TGuards & TComputed>
			>;
			if (outcome.buckets.length === 0) {
				unmatched.push({ item: outcome.item, conditions });
				continue;
			}
			for (const name of outcome.buckets) {
				// Present because every bucket name was seeded above.
				(buckets[name] as TInput[]).push(outcome.item);
			}
		}

		return {
			// The per-bucket item types live in TBuckets; the runtime pushes the
			// same validated object into each bucket its rule matched.
			buckets: buckets as unknown as BucketReport<
				TInput,
				TGuards & TComputed,
				TBuckets
			>["buckets"],
			unmatched,
			errors,
		};
	}

	/**
	 * Sort a single item. Unlike {@link process}, this throws
	 * {@link BucketError} when the item fails validation or a `checkFn` throws
	 * — with one item there is no rest-of-the-batch to protect, and a caller
	 * handling one record wants the failure at the call site.
	 *
	 * An empty `buckets` array is not an error: it means the item satisfied no
	 * rule.
	 */
	async processOne(
		item: TInput,
	): Promise<BucketAssignment<TInput, TGuards & TComputed, TBuckets>> {
		this.assertReady(".processOne()");

		const outcome = await this.evaluateItem(item);
		if (outcome.kind === "failed") {
			const failure = outcome.failures[0];
			throw failure?.error instanceof BucketError
				? failure.error
				: new BucketError(
						`Could not classify item: ${failure?.error.message ?? "unknown failure"}`,
					);
		}

		return {
			item: outcome.item,
			buckets: outcome.buckets as NamesOf<TBuckets>[],
			conditions: outcome.conditions as ConditionReport<
				NamesOf<TGuards & TComputed>
			>,
		};
	}

	/**
	 * Validate one item, run every condition, derive the computed ones from
	 * those verdicts, then evaluate every bucket's rule.
	 */
	private async evaluateItem(raw: TInput): Promise<Outcome<TInput>> {
		let item = raw;

		if (this.schema !== undefined) {
			let validated: StandardSchemaV1.Result<unknown>;
			try {
				validated = await this.schema["~standard"].validate(raw);
			} catch (cause) {
				return {
					kind: "failed",
					failures: [{ item: raw, stage: "input", error: toError(cause) }],
				};
			}
			if (validated.issues !== undefined) {
				return {
					kind: "failed",
					failures: [
						{
							item: raw,
							stage: "input",
							error: new BucketError(
								`Input validation failed: ${formatIssues(validated.issues)}`,
								validated.issues,
							),
						},
					],
				};
			}
			item = validated.value as TInput;
		}

		const conditions: Record<string, boolean> = {};
		const failures: BucketFailure<TInput, string>[] = [];
		const baseTruths = new Set<string>();

		// One wave at a time: everything in a wave is independent of everything
		// else in it, so it runs as one concurrent batch (same as the old flat
		// Promise.allSettled did for every condition). A later wave only exists
		// because something in it has a `when`, and that can only name a
		// condition from an earlier wave — so `baseTruths` already has whatever
		// this wave's preconditions need by the time it's checked.
		for (const wave of this.waveGroups) {
			const runnable = wave.filter((condition) => {
				if (condition.when === undefined) return true;
				if (evaluate(condition.when, baseTruths, baseTruths)) return true;
				// The precondition failed, so this condition is false without
				// ever calling its checkFn — the whole point of `when`.
				conditions[condition.name] = false;
				return false;
			});
			if (runnable.length === 0) continue;

			// An async wrapper so a synchronously thrown checkFn rejects like any
			// other failure instead of escaping the batch.
			const settled = await Promise.allSettled(
				runnable.map(async (condition) =>
					Boolean(await condition.checkFn(item)),
				),
			);

			for (const [index, condition] of runnable.entries()) {
				const result = settled[index];
				if (result === undefined) continue;
				if (result.status === "rejected") {
					failures.push({
						item,
						stage: "condition",
						condition: condition.name,
						error: toError(result.reason),
					});
					continue;
				}
				conditions[condition.name] = result.value;
				if (result.value) baseTruths.add(condition.name);
			}
		}

		// A computed condition reads verdicts, so a missing one would make it
		// answer a question it wasn't asked. Bail before deriving anything.
		if (failures.length > 0) return { kind: "failed", failures };

		const truths = this.deriveComputed(baseTruths, conditions);

		return {
			kind: "classified",
			item,
			buckets: this.buckets
				.filter((bucket) => evaluate(bucket.expr, truths, baseTruths))
				.map((bucket) => bucket.name),
			conditions,
		};
	}

	/** The two ways an engine can be unusable, checked before any work starts. */
	private assertReady(method: string): void {
		if (!this.inputDefined) {
			throw new BucketError(
				`No input defined. Call .defineInput(schema) before ${method}.`,
			);
		}
		if (this.buckets.length === 0) {
			throw new BucketError(
				`No buckets defined. Call .defineBucket({ name, checkFn }) before ${method}.`,
			);
		}
	}
}
