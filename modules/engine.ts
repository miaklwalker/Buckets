import type { StandardSchemaV1 } from "@standard-schema/spec";
import { allAssignments } from "./enumerate.ts";
import {
	evaluate,
	type ExprNode,
	LOGIC,
	type LogicBuilder,
	type NamesOf,
	type Operand,
	referencedNames,
	toExpr,
} from "./logic.ts";
import { mapWithConcurrency, resolveConcurrency } from "./schedule.ts";
import {
	type BucketAssignment,
	BucketError,
	type BucketFailure,
	type BucketReport,
	type BucketItem,
	type BucketSpec,
	type ConditionReport,
	type ConditionSpec,
	type GuardOf,
	type ProcessOptions,
	type UnmatchedItem,
	type ValidateBucket,
	type ValidateCondition,
} from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Internal storage (type-erased; the public API keeps the types)              */
/* -------------------------------------------------------------------------- */

interface StoredCondition {
	readonly name: string;
	readonly checkFn: (item: unknown) => boolean | Promise<boolean>;
}

interface StoredBucket {
	readonly name: string;
	readonly expr: ExprNode<string>;
}

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
 * Both name parameters are inferred: every condition and bucket you declare
 * widens them, which is what makes `checkFn`'s combinators complete your
 * condition names and reject anything else.
 */
export class BucketEngine<
	TInput = never,
	TGuards extends Record<string, unknown> = Record<never, never>,
	TBuckets extends Record<string, unknown> = Record<never, never>,
> {
	private schema: StandardSchemaV1 | undefined;
	private inputDefined = false;
	private readonly conditions: StoredCondition[] = [];
	private readonly buckets: StoredBucket[] = [];

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
	): BucketEngine<TSchema, TGuards, TBuckets>;
	/**
	 * Declare the item type without a schema, for when you already trust the
	 * data and only want the type safety: `.defineInput<Product>()`. Nothing is
	 * validated at runtime, so `report.errors` can then only ever contain
	 * condition failures.
	 */
	defineInput<TShape>(): BucketEngine<TShape, TGuards, TBuckets>;
	defineInput<TSchema>(
		schema?: StandardSchemaV1<unknown, TSchema>,
	): BucketEngine<TSchema, TGuards, TBuckets> {
		if (this.inputDefined) {
			throw new BucketError(
				"Input is already defined. Call .defineInput() once, before any condition.",
			);
		}
		if (this.conditions.length > 0) {
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
		return this as unknown as BucketEngine<TSchema, TGuards, TBuckets>;
	}

	/**
	 * Register a named predicate over the item. The name becomes part of this
	 * engine's type, so a bucket's combinators will complete it for you and
	 * reject anything else.
	 *
	 * `checkFn` may be async, and may throw — a throw sends that item to
	 * `report.errors` and leaves the rest of the batch alone.
	 *
	 * All conditions must be defined before the first bucket, because `ONLY()`
	 * means "these and nothing else" and so depends on the complete set. Adding
	 * a condition afterwards would quietly change what an existing `ONLY` rule
	 * matches.
	 */
	defineCondition<
		const TName extends string,
		TCheck extends (item: TInput) => boolean | Promise<boolean>,
	>(
		condition: ConditionSpec<TName, TCheck> &
			ValidateCondition<TName, TGuards, TBuckets>,
	): BucketEngine<
		TInput,
		TGuards & { [K in TName]: GuardOf<TCheck> },
		TBuckets
	> {
		const { name, checkFn } = condition as ConditionSpec<TName, TCheck>;

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
		if (this.conditions.some((existing) => existing.name === name)) {
			throw new BucketError(`A condition named "${name}" is already defined.`);
		}

		this.conditions.push({
			name,
			// The stored registry is erased: it holds predicates written against
			// whatever `TInput` was, and only ever receives validated items.
			checkFn: checkFn as (item: unknown) => boolean | Promise<boolean>,
		});

		return this as unknown as BucketEngine<
			TInput,
			TGuards & { [K in TName]: GuardOf<TCheck> },
			TBuckets
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
		const TOperand extends Operand<NamesOf<TGuards>>,
	>(
		bucket: BucketSpec<TName, TGuards, TOperand> &
			ValidateBucket<TName, TBuckets>,
	): BucketEngine<
		TInput,
		TGuards,
		TBuckets & { [K in TName]: BucketItem<TOperand, TGuards, TInput> }
	> {
		const { name, checkFn } = bucket as BucketSpec<TName, TGuards, TOperand>;

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
		const produced = checkFn(LOGIC as unknown as LogicBuilder<TGuards>);
		const expr = toExpr(produced) as ExprNode<string>;
		this.assertKnownConditions(name, referencedNames(expr));

		this.buckets.push({ name, expr });

		return this as unknown as BucketEngine<
			TInput,
			TGuards,
			TBuckets & { [K in TName]: BucketItem<TOperand, TGuards, TInput> }
		>;
	}

	/** Every name a rule mentions has to be a condition that exists. */
	private assertKnownConditions(
		name: string,
		referenced: ReadonlySet<string>,
	): void {
		const known = new Set(this.conditions.map((condition) => condition.name));
		for (const conditionName of referenced) {
			if (known.has(conditionName)) continue;
			throw new BucketError(
				`Bucket "${name}" refers to unknown condition "${conditionName}". Defined: ${[...known].join(", ") || "(none)"}.`,
			);
		}
	}

	/** The condition names, in definition order. */
	get conditionNames(): NamesOf<TGuards>[] {
		return this.conditions.map(
			(condition) => condition.name,
		) as NamesOf<TGuards>[];
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
	 * Enumerating is exponential, so this refuses to run past 16 conditions
	 * (65,536 combinations) rather than hanging. Nothing else enumerates.
	 */
	missingCombinations(): NamesOf<TGuards>[][] {
		const conditionNames = this.conditions.map((condition) => condition.name);

		return allAssignments(conditionNames, "missingCombinations()")
			.filter((truths) =>
				this.buckets.every((bucket) => !evaluate(bucket.expr, truths)),
			)
			.map(
				(truths) =>
					// Report them in definition order rather than insertion order.
					conditionNames.filter((name) =>
						truths.has(name),
					) as NamesOf<TGuards>[],
			);
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
	): Promise<BucketReport<TInput, TGuards, TBuckets>> {
		this.assertReady(".process()");
		if (!Array.isArray(items)) {
			throw new BucketError(
				".process() expects an array of items. Use .processOne() for a single item.",
			);
		}

		const concurrency = resolveConcurrency(options.concurrency);
		const buckets = {} as Record<string, TInput[]>;
		for (const bucket of this.buckets) buckets[bucket.name] = [];
		const unmatched: UnmatchedItem<TInput, NamesOf<TGuards>>[] = [];
		const errors: BucketFailure<TInput, NamesOf<TGuards>>[] = [];

		const outcomes = await mapWithConcurrency(items, concurrency, (item) =>
			this.evaluateItem(item),
		);

		for (const outcome of outcomes) {
			if (outcome.kind === "failed") {
				errors.push(
					...(outcome.failures as BucketFailure<TInput, NamesOf<TGuards>>[]),
				);
				continue;
			}
			const conditions = outcome.conditions as ConditionReport<
				NamesOf<TGuards>
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
				TGuards,
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
	): Promise<BucketAssignment<TInput, TGuards, TBuckets>> {
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
			conditions: outcome.conditions as ConditionReport<NamesOf<TGuards>>,
		};
	}

	/** Validate one item, run every condition, then every bucket's rule. */
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

		// An async wrapper so a synchronously thrown checkFn rejects like any
		// other failure instead of escaping the batch.
		const settled = await Promise.allSettled(
			this.conditions.map(async (condition) =>
				Boolean(await condition.checkFn(item)),
			),
		);

		const conditions: Record<string, boolean> = {};
		const failures: BucketFailure<TInput, string>[] = [];
		const truths = new Set<string>();

		for (const [index, condition] of this.conditions.entries()) {
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
			if (result.value) truths.add(condition.name);
		}

		if (failures.length > 0) return { kind: "failed", failures };

		return {
			kind: "classified",
			item,
			buckets: this.buckets
				.filter((bucket) => evaluate(bucket.expr, truths))
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
