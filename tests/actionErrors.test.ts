import assert from "node:assert";
import test, { describe } from "node:test";
import { ActionEngine, DEFAULT_CONCURRENCY } from "../main.ts";
import {
	PRODUCTS,
	type Product,
	productSchema,
	tracker,
} from "./action-support.ts";

/**
 * Every rule the type system enforces is re-checked at runtime, because
 * JavaScript consumers and casts both walk straight past the types.
 *
 * Reaching those guards means lying to the compiler about what the engine
 * already knows — this hands back the same live engine typed as though
 * nothing had been declared yet, which is the one thing that makes the
 * offending call compile.
 */
type Forgotten<TEngine> =
	TEngine extends ActionEngine<infer TInput, infer _A>
		? ActionEngine<TInput>
		: never;

function forget<TEngine>(engine: TEngine): Forgotten<TEngine> {
	return engine as unknown as Forgotten<TEngine>;
}

describe("configuration errors", () => {
	test("a duplicate action name is rejected", () => {
		const engine = new ActionEngine().defineInput<Product>().defineAction({
			name: "ship",
			checkFn: () => true,
			actionFn: () => undefined,
		});

		assert.throws(
			() =>
				forget(engine).defineAction({
					name: "ship",
					checkFn: () => true,
					actionFn: () => undefined,
				}),
			{ name: "ActionError", message: /already defined/ },
		);
	});

	test("input cannot be defined twice", () => {
		const engine = new ActionEngine().defineInput<Product>();

		assert.throws(() => engine.defineInput(productSchema), {
			name: "ActionError",
			message: /already defined/,
		});
	});

	test("input cannot be defined after an action", () => {
		const engine = new ActionEngine().defineAction({
			name: "ship",
			checkFn: () => true,
			actionFn: () => undefined,
		});

		assert.throws(() => engine.defineInput(productSchema), {
			name: "ActionError",
			message: /Define the input before any action/,
		});
	});

	test("defineInput rejects a value that is not a Standard Schema", () => {
		assert.throws(
			() => new ActionEngine().defineInput({ parse: () => null } as never),
			{ name: "ActionError", message: /Standard Schema/ },
		);
	});

	test("an unnamed action is rejected", () => {
		const engine = new ActionEngine().defineInput<Product>();

		assert.throws(
			() =>
				engine.defineAction({
					name: "",
					checkFn: () => true,
					actionFn: () => undefined,
				}),
			{ name: "ActionError", message: /non-empty name/ },
		);
	});

	test("an action needs a checkFn", () => {
		const engine = new ActionEngine().defineInput<Product>();

		assert.throws(
			() =>
				engine.defineAction({
					name: "ship",
					checkFn: undefined as never,
					actionFn: () => undefined,
				}),
			{ name: "ActionError", message: /needs a checkFn/ },
		);
	});

	test("an action needs an actionFn", () => {
		const engine = new ActionEngine().defineInput<Product>();

		assert.throws(
			() =>
				engine.defineAction({
					name: "ship",
					checkFn: () => true,
					actionFn: undefined as never,
				}),
			{ name: "ActionError", message: /needs an actionFn/ },
		);
	});
});

describe("readiness", () => {
	test("processing without an input is an error, not an empty report", async () => {
		await assert.rejects(() => new ActionEngine().process([]), {
			name: "ActionError",
			message: /No input defined/,
		});
	});

	test("processing without actions is an error", async () => {
		const engine = new ActionEngine().defineInput<Product>();

		await assert.rejects(() => engine.process([]), {
			name: "ActionError",
			message: /No actions defined/,
		});
	});

	test("process rejects a single item passed where an array belongs", async () => {
		const engine = new ActionEngine().defineInput<Product>().defineAction({
			name: "ship",
			checkFn: () => true,
			actionFn: () => undefined,
		});

		await assert.rejects(() => engine.process(PRODUCTS[0] as never), {
			name: "ActionError",
			message: /Use \.processOne\(\)/,
		});
	});
});

describe("concurrency", () => {
	test("a batch smaller than the default limit runs entirely in parallel", async () => {
		const probe = tracker(5);
		const report = await new ActionEngine()
			.defineInput<Product>()
			.defineAction({
				name: "slow",
				checkFn: probe.checkFn,
				actionFn: () => undefined,
			})
			.process(PRODUCTS);

		assert.strictEqual(report.results.slow.length, PRODUCTS.length);
		assert.strictEqual(probe.state.peak, PRODUCTS.length);
	});

	test("a larger batch is capped at the default rather than running unbounded", async () => {
		const probe = tracker(1);
		const rows = Array.from({ length: DEFAULT_CONCURRENCY * 3 }, () => ({
			sku: "s",
			weight: 1,
			digital: false,
		}));

		await new ActionEngine()
			.defineInput<Product>()
			.defineAction({
				name: "slow",
				checkFn: probe.checkFn,
				actionFn: () => undefined,
			})
			.process(rows);

		assert.strictEqual(probe.state.peak, DEFAULT_CONCURRENCY);
		assert.strictEqual(probe.state.calls, rows.length);
	});

	test("never exceeds the requested limit", async () => {
		const probe = tracker(5);
		await new ActionEngine()
			.defineInput<Product>()
			.defineAction({
				name: "slow",
				checkFn: probe.checkFn,
				actionFn: () => undefined,
			})
			.process(PRODUCTS, { concurrency: 2 });

		assert.strictEqual(probe.state.peak, 2);
		assert.strictEqual(probe.state.calls, PRODUCTS.length);
	});

	test("a nonsensical limit is rejected rather than deadlocking", async () => {
		const engine = new ActionEngine().defineInput<Product>().defineAction({
			name: "ship",
			checkFn: () => true,
			actionFn: () => undefined,
		});

		for (const concurrency of [0, -1, 1.5, Number.NaN]) {
			await assert.rejects(() => engine.process(PRODUCTS, { concurrency }), {
				name: "ActionError",
				message: /positive integer/,
			});
		}
	});
});
