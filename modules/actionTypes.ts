import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { NamesOf } from "./logic.ts";
import type { GuardOf, ProcessOptions } from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything {@link ActionEngine} throws. Configuration mistakes (a duplicate
 * action name, an action defined before the input) throw immediately from the
 * `define*` call that made them, so a misconfigured engine can never reach
 * `.process()`.
 *
 * `issues` is populated only when the cause was a Standard Schema validation
 * failure, and carries the raw issues from the schema library so you can
 * render them however you like.
 */
export class ActionError extends Error {
	override name = "ActionError";

	/** Present only when this error came from input validation. */
	readonly issues?: readonly StandardSchemaV1.Issue[];

	constructor(message: string, issues?: readonly StandardSchemaV1.Issue[]) {
		super(message);
		if (issues !== undefined) this.issues = issues;
	}
}

/* -------------------------------------------------------------------------- */
/* Specs — what you hand to defineAction                                      */
/* -------------------------------------------------------------------------- */

/**
 * What an item narrows to inside `actionFn`: a type-predicate `checkFn`
 * narrows it, an ordinary boolean predicate proves nothing about the shape
 * and leaves it as `TInput`.
 */
export type ActionInput<TCheck, TInput> =
	unknown extends GuardOf<TCheck> ? TInput : GuardOf<TCheck>;

/**
 * A named predicate-and-effect pair. `checkFn` decides whether `actionFn`
 * runs for a given item; `actionFn` receives the item — narrowed, if
 * `checkFn` was written as a type predicate — and does whatever the action is
 * for.
 *
 * Both may be sync or async, and either may throw: a throw is recorded
 * against that one item and this one action, and never stops another action
 * from running on the same item, nor the rest of the batch.
 */
export interface ActionSpec<TName extends string, TCheck, TInput, TResult> {
	readonly name: TName;
	readonly checkFn: TCheck;
	readonly actionFn: (
		item: ActionInput<TCheck, TInput>,
	) => TResult | Promise<TResult>;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** One item an action ran for, paired with what `actionFn` returned. */
export interface ActionRun<TInput, TResult> {
	readonly item: TInput;
	readonly result: TResult;
}

/**
 * An item every action's `checkFn` answered, and none of them matched. Since
 * this only happens when every `checkFn` resolved without throwing, `checks`
 * is always complete — one verdict per action.
 */
export interface UnmatchedActionItem<TInput, TActions extends string> {
	readonly item: TInput;
	readonly checks: Readonly<Record<TActions, boolean>>;
}

/**
 * An item that could not be fully processed. `stage` says where it happened:
 * `"input"` means the Standard Schema rejected it — nothing else could run,
 * so this is the only failure for that item. `"check"` means the named
 * action's `checkFn` threw; `"action"` means its `actionFn` threw once
 * `checkFn` had already matched. Either way, `action` names which one, and
 * every other action still ran normally.
 */
export interface ActionFailure<TInput, TActions extends string> {
	readonly item: TInput;
	readonly stage: "input" | "check" | "action";
	readonly action?: TActions;
	readonly error: Error;
}

/**
 * What `.process()` returns.
 *
 * Actions are independent, so membership here isn't exclusive the way
 * buckets are: an item can appear in more than one `results[name]` array, and
 * an item with one failing action can still appear in `results` for the
 * actions that succeeded. It appears in `unmatched` only when every action's
 * `checkFn` ran and none of them matched — an item that errored is never
 * also `unmatched`, since "no action fired" and "an action fired and threw"
 * are different facts.
 */
export interface ActionReport<
	TInput,
	TActions extends Record<string, { item: unknown; result: unknown }>,
> {
	/** One key per declared action, in definition order, always present. */
	readonly results: {
		readonly [K in keyof TActions]: ActionRun<
			TActions[K]["item"],
			TActions[K]["result"]
		>[];
	};
	readonly unmatched: readonly UnmatchedActionItem<TInput, NamesOf<TActions>>[];
	readonly errors: readonly ActionFailure<TInput, NamesOf<TActions>>[];
}

/**
 * What `.processOne()` returns. `matched` lists every action whose `checkFn`
 * matched and whose `actionFn` succeeded, in definition order; an empty array
 * is the single-item equivalent of `unmatched`. `checks` holds a verdict for
 * every action whose `checkFn` didn't throw — so, unlike
 * {@link UnmatchedActionItem}, it can be partial when `errors` isn't empty.
 */
export interface ActionAssignment<
	TInput,
	TActions extends Record<string, { item: unknown; result: unknown }>,
> {
	readonly item: TInput;
	readonly matched: NamesOf<TActions>[];
	readonly results: {
		readonly [K in keyof TActions]?: TActions[K]["result"];
	};
	readonly checks: Readonly<Partial<Record<NamesOf<TActions>, boolean>>>;
	readonly errors: readonly ActionFailure<TInput, NamesOf<TActions>>[];
}

export type { ProcessOptions as ActionProcessOptions };

/* -------------------------------------------------------------------------- */
/* Type-level validation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Intersected into `defineAction`'s parameter. Resolving to `unknown` is the
 * pass case — intersecting with `unknown` changes nothing. Otherwise it
 * retypes the offending property as a sentence, so the compiler reports the
 * rule that was broken instead of a structural mismatch.
 */
export type ValidateAction<TName extends string, TActions> =
	TName extends NamesOf<TActions>
		? { name: `An action named "${TName}" is already defined` }
		: unknown;
