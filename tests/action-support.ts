import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ActionEngine } from "../main.ts";

/** A product shaped like something you would actually act on. */
export interface Product {
	readonly sku: string;
	readonly weight: number | null;
	readonly digital: boolean;
}

export const PRODUCTS: readonly Product[] = [
	{ sku: "physical-1", weight: 2, digital: false },
	{ sku: "download-1", weight: null, digital: true },
	{ sku: "hybrid-1", weight: 1, digital: true },
	{ sku: "vapour-1", weight: null, digital: false },
];

/**
 * A minimal Standard Schema, so the tests exercise the real `~standard`
 * protocol without depending on Zod.
 */
export function schema<TOutput>(
	validate: (
		value: unknown,
	) =>
		| StandardSchemaV1.Result<TOutput>
		| Promise<StandardSchemaV1.Result<TOutput>>,
): StandardSchemaV1<unknown, TOutput> {
	return {
		"~standard": {
			version: 1,
			vendor: "test",
			validate,
		},
	};
}

/** Accepts any object, rejects everything else. */
export const productSchema = schema<Product>((value) =>
	typeof value === "object" && value !== null
		? { value: value as Product }
		: { issues: [{ message: "expected an object" }] },
);

/**
 * A predicate that records every item it saw and how many calls were in
 * flight at once — the only way to assert on concurrency, which leaves no
 * trace in the return value.
 */
export function tracker(delayMs = 0) {
	let inFlight = 0;
	const state = { peak: 0, calls: 0 };

	return {
		state,
		checkFn: async (): Promise<boolean> => {
			inFlight += 1;
			state.calls += 1;
			state.peak = Math.max(state.peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			inFlight -= 1;
			return true;
		},
	};
}

export type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

export type Expect<T extends true> = T;

/**
 * Pull one type parameter back out of a configured engine. Both have to be
 * inferred at once — matching against `ActionEngine<infer TInput>` fills the
 * rest with its `never` default and simply fails to match.
 */
export type InputOf<TEngine> =
	TEngine extends ActionEngine<infer TInput, infer _A> ? TInput : never;

export type ActionNamesOf<TEngine> =
	TEngine extends ActionEngine<infer _I, infer TActions>
		? Extract<keyof TActions, string>
		: never;

/** The item type a particular action's `actionFn` receives. */
export type ActionItemOf<TEngine, TName extends string> =
	TEngine extends ActionEngine<infer _I, infer TActions>
		? TName extends keyof TActions
			? TActions[TName] extends { item: infer TItem }
				? TItem
				: never
			: never
		: never;
