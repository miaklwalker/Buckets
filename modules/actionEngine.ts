import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type ActionAssignment,
	ActionError,
	type ActionFailure,
	type ActionInput,
	type ActionProcessOptions,
	type ActionReport,
	type ActionRun,
	type ActionSpec,
	type UnmatchedActionItem,
	type ValidateAction,
} from "./actionTypes.ts";
import type { NamesOf } from "./logic.ts";
import { mapWithConcurrency } from "./schedule.ts";
import { DEFAULT_CONCURRENCY } from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Internal storage (type-erased; the public API keeps the types)              */
/* -------------------------------------------------------------------------- */

interface StoredAction {
	readonly name: string;
	readonly checkFn: (item: unknown) => boolean | Promise<boolean>;
	readonly actionFn: (item: unknown) => unknown | Promise<unknown>;
}

type Outcome<TInput> =
	| {
			readonly kind: "classified";
			readonly item: TInput;
			readonly matched: string[];
			readonly results: Record<string, unknown>;
			readonly checks: Record<string, boolean>;
			readonly failures: ActionFailure<TInput, string>[];
	  }
	| {
			readonly kind: "failed";
			readonly failures: readonly ActionFailure<TInput, string>[];
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

/** As `resolveConcurrency` in schedule.ts, but throwing this engine's error. */
function resolveConcurrency(concurrency: number | undefined): number {
	if (concurrency === undefined) return DEFAULT_CONCURRENCY;
	if (concurrency === Number.POSITIVE_INFINITY) return concurrency;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new ActionError(
			`concurrency must be a positive integer or Infinity, received ${String(concurrency)}.`,
		);
	}
	return concurrency;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A rule engine that runs named actions against the items that match them.
 *
 * Where {@link BucketEngine} separates *naming a condition* from *declaring a
 * rule over named conditions*, `ActionEngine` collapses that into one step:
 * each action carries its own predicate and its own effect.
 *
 * ```ts
 * const engine = new ActionEngine()
 *   .defineInput<Order>()
 *   .defineAction({
 *     name: "notifyWarehouse",
 *     checkFn: (order) => order.status === "paid",
 *     actionFn: (order) => dispatchToWarehouse(order.id),
 *   })
 *   .defineAction({
 *     name: "flagForReview",
 *     checkFn: (order) => order.riskScore > 80,
 *     actionFn: (order) => queueForReview(order.id),
 *   });
 *
 * const report = await engine.process(orders);
 * report.results.notifyWarehouse; // { item, result }[]
 * ```
 *
 * Actions are independent, the same way buckets are: an order that is both
 * paid and risky triggers both actions, and nothing had to be enumerated to
 * say so. Unlike a bucket, though, an action's `checkFn` failing doesn't
 * poison anything else — there is no shared boolean expression depending on
 * it — so one action erroring on an item never stops another action from
 * running on that same item. See {@link ActionReport} for exactly what that
 * means for `results`, `unmatched` and `errors`.
 */
export class ActionEngine<
	TInput = never,
	TActions extends Record<string, { item: unknown; result: unknown }> = Record<
		never,
		never
	>,
> {
	private schema: StandardSchemaV1 | undefined;
	private inputDefined = false;
	private readonly actions: StoredAction[] = [];

	/**
	 * Describe the items being processed with a
	 * [Standard Schema](https://standardschema.dev) — Zod, Valibot, ArkType,
	 * Effect Schema, anything compliant. `TInput` is inferred from the
	 * schema's *output* type, so a schema that transforms gives actions the
	 * transformed value, and that same value is what ends up in the report.
	 *
	 * Call it first. Actions are typed against whatever the input was when
	 * they were defined, so defining them before the schema leaves them typed
	 * against `never`; the runtime enforces the ordering to match.
	 */
	defineInput<TSchema>(
		schema: StandardSchemaV1<unknown, TSchema>,
	): ActionEngine<TSchema, TActions>;
	/**
	 * Declare the item type without a schema, for when you already trust the
	 * data and only want the type safety: `.defineInput<Order>()`. Nothing is
	 * validated at runtime, so `report.errors` can then only ever contain
	 * check and action failures.
	 */
	defineInput<TShape>(): ActionEngine<TShape, TActions>;
	defineInput<TSchema>(
		schema?: StandardSchemaV1<unknown, TSchema>,
	): ActionEngine<TSchema, TActions> {
		if (this.inputDefined) {
			throw new ActionError(
				"Input is already defined. Call .defineInput() once, before any action.",
			);
		}
		if (this.actions.length > 0) {
			throw new ActionError(
				"Define the input before any action — actions defined earlier are typed against the wrong item.",
			);
		}
		if (schema !== undefined) {
			if (
				typeof schema !== "object" ||
				schema === null ||
				typeof (schema as StandardSchemaV1)["~standard"]?.validate !==
					"function"
			) {
				throw new ActionError(
					"defineInput() expects a Standard Schema (a value with a '~standard' property), or no argument at all.",
				);
			}
			this.schema = schema as StandardSchemaV1;
		}
		this.inputDefined = true;
		return this as unknown as ActionEngine<TSchema, TActions>;
	}

	/**
	 * Register a named action: a predicate and the effect that runs when it
	 * matches. The name becomes a key of `report.results`.
	 *
	 * `checkFn` and `actionFn` may each be sync or async, and each may throw.
	 * A `checkFn` throw means `actionFn` never runs for that item; either
	 * throw is recorded against this action and this item in `report.errors`,
	 * and every other action on that item still runs.
	 *
	 * Write `checkFn` as a type predicate — `(item): item is X => ...` — to
	 * have `actionFn` receive the narrowed type instead of `TInput`.
	 */
	defineAction<
		const TName extends string,
		TCheck extends (item: TInput) => boolean | Promise<boolean>,
		TResult,
	>(
		action: ActionSpec<TName, TCheck, TInput, TResult> &
			ValidateAction<TName, TActions>,
	): ActionEngine<
		TInput,
		TActions & {
			[K in TName]: { item: ActionInput<TCheck, TInput>; result: TResult };
		}
	> {
		const { name, checkFn, actionFn } = action as ActionSpec<
			TName,
			TCheck,
			TInput,
			TResult
		>;

		if (typeof name !== "string" || name.length === 0) {
			throw new ActionError("An action needs a non-empty name.");
		}
		if (typeof checkFn !== "function") {
			throw new ActionError(`Action "${name}" needs a checkFn.`);
		}
		if (typeof actionFn !== "function") {
			throw new ActionError(`Action "${name}" needs an actionFn.`);
		}
		if (this.actions.some((existing) => existing.name === name)) {
			throw new ActionError(`An action named "${name}" is already defined.`);
		}

		this.actions.push({
			name,
			// The stored registry is erased: it holds functions written against
			// whatever `TInput` was, and only ever receives validated items.
			checkFn: checkFn as (item: unknown) => boolean | Promise<boolean>,
			actionFn: actionFn as (item: unknown) => unknown | Promise<unknown>,
		});

		return this as unknown as ActionEngine<
			TInput,
			TActions & {
				[K in TName]: { item: ActionInput<TCheck, TInput>; result: TResult };
			}
		>;
	}

	/**
	 * An independent engine with everything defined so far, at the same type.
	 * The copy is shallow, which is all it needs to be: a stored action is a
	 * name and two functions, and neither is ever mutated after registration.
	 * Defining anything on either engine afterwards leaves the other alone.
	 */
	clone(): ActionEngine<TInput, TActions> {
		const copy = new ActionEngine<TInput, TActions>();

		copy.schema = this.schema;
		copy.inputDefined = this.inputDefined;
		copy.actions.push(...this.actions);

		return copy;
	}

	/** Every action name, in definition order. */
	get actionNames(): NamesOf<TActions>[] {
		return this.actions.map((action) => action.name) as NamesOf<TActions>[];
	}

	/**
	 * Run every action against a batch. Every item ends up contributing to at
	 * least one of `results`, `unmatched` or `errors` — see {@link ActionReport}
	 * for exactly how, since actions are independent and membership isn't
	 * exclusive the way buckets are.
	 *
	 * Nothing here throws for bad data: a schema failure, a throwing
	 * `checkFn`, or a throwing `actionFn` is recorded in `errors` and the
	 * batch continues. Configuration mistakes still throw, since those are
	 * yours rather than the data's.
	 */
	async process(
		items: readonly TInput[],
		options: ActionProcessOptions = {},
	): Promise<ActionReport<TInput, TActions>> {
		this.assertReady(".process()");
		if (!Array.isArray(items)) {
			throw new ActionError(
				".process() expects an array of items. Use .processOne() for a single item.",
			);
		}

		const concurrency = resolveConcurrency(options.concurrency);
		const results = {} as Record<string, ActionRun<unknown, unknown>[]>;
		for (const action of this.actions) results[action.name] = [];
		const unmatched: UnmatchedActionItem<TInput, NamesOf<TActions>>[] = [];
		const errors: ActionFailure<TInput, NamesOf<TActions>>[] = [];

		const outcomes = await mapWithConcurrency(items, concurrency, (item) =>
			this.evaluateItem(item),
		);

		for (const outcome of outcomes) {
			if (outcome.kind === "failed") {
				errors.push(
					...(outcome.failures as ActionFailure<TInput, NamesOf<TActions>>[]),
				);
				continue;
			}

			errors.push(
				...(outcome.failures as ActionFailure<TInput, NamesOf<TActions>>[]),
			);
			for (const name of outcome.matched) {
				(results[name] as ActionRun<unknown, unknown>[]).push({
					item: outcome.item,
					result: outcome.results[name],
				});
			}
			if (outcome.matched.length === 0 && outcome.failures.length === 0) {
				unmatched.push({
					item: outcome.item,
					checks: outcome.checks as Record<NamesOf<TActions>, boolean>,
				});
			}
		}

		return {
			// The per-action item and result types live in TActions; the runtime
			// pushes the same validated object into each action it matched.
			results: results as unknown as ActionReport<TInput, TActions>["results"],
			unmatched,
			errors,
		};
	}

	/**
	 * Run every action against a single item. Unlike {@link process}, this
	 * throws {@link ActionError} when input validation fails — with nothing
	 * validated, no action can run, so there is nothing partial to report.
	 *
	 * A `checkFn` or `actionFn` failure does **not** throw: actions are
	 * independent, so one failing shouldn't hide whether the others matched.
	 * Those show up in the returned `errors` instead, exactly as in
	 * {@link process}.
	 */
	async processOne(item: TInput): Promise<ActionAssignment<TInput, TActions>> {
		this.assertReady(".processOne()");

		const outcome = await this.evaluateItem(item);
		if (outcome.kind === "failed") {
			const failure = outcome.failures[0];
			throw failure?.error instanceof ActionError
				? failure.error
				: new ActionError(
						`Could not validate item: ${failure?.error.message ?? "unknown failure"}`,
					);
		}

		return {
			item: outcome.item,
			matched: outcome.matched as NamesOf<TActions>[],
			results: outcome.results as ActionAssignment<TInput, TActions>["results"],
			checks: outcome.checks as ActionAssignment<TInput, TActions>["checks"],
			errors: outcome.failures as unknown as readonly ActionFailure<
				TInput,
				NamesOf<TActions>
			>[],
		};
	}

	/**
	 * Validate one item, run every action's `checkFn` in parallel, then run
	 * `actionFn` for every action that matched — also in parallel. The two
	 * passes are separate because an action's effect should only ever run
	 * once its own check has passed, never speculatively.
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
							error: new ActionError(
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
		const checked = await Promise.allSettled(
			this.actions.map(async (action) => Boolean(await action.checkFn(item))),
		);

		const checks: Record<string, boolean> = {};
		const failures: ActionFailure<TInput, string>[] = [];
		const toRun: StoredAction[] = [];

		for (const [index, action] of this.actions.entries()) {
			const result = checked[index];
			if (result === undefined) continue;
			if (result.status === "rejected") {
				failures.push({
					item,
					stage: "check",
					action: action.name,
					error: toError(result.reason),
				});
				continue;
			}
			checks[action.name] = result.value;
			if (result.value) toRun.push(action);
		}

		const ran = await Promise.allSettled(
			toRun.map(async (action) => action.actionFn(item)),
		);

		const matched: string[] = [];
		const results: Record<string, unknown> = {};

		for (const [index, action] of toRun.entries()) {
			const result = ran[index];
			if (result === undefined) continue;
			if (result.status === "rejected") {
				failures.push({
					item,
					stage: "action",
					action: action.name,
					error: toError(result.reason),
				});
				continue;
			}
			matched.push(action.name);
			results[action.name] = result.value;
		}

		return { kind: "classified", item, matched, results, checks, failures };
	}

	/** The two ways an engine can be unusable, checked before any work starts. */
	private assertReady(method: string): void {
		if (!this.inputDefined) {
			throw new ActionError(
				`No input defined. Call .defineInput(schema) before ${method}.`,
			);
		}
		if (this.actions.length === 0) {
			throw new ActionError(
				`No actions defined. Call .defineAction({ name, checkFn, actionFn }) before ${method}.`,
			);
		}
	}
}
