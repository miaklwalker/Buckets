import assert from "node:assert";
import test, { describe } from "node:test";
import {
	AND,
	BucketEngine,
	BucketError,
	DEFAULT_CONCURRENCY,
	NOT,
	ONLY,
	OR,
} from "../main.ts";
import { PRODUCTS, type Product, productSchema, tracker } from "./support.ts";

/**
 * Every rule the type system enforces is re-checked at runtime, because
 * JavaScript consumers and casts both walk straight past the types.
 *
 * Reaching those guards means lying to the compiler about what the engine
 * already knows — these helpers hand back the same live engine typed as though
 * nothing had been declared yet, which is the one thing that makes the
 * offending call compile. Casting the *argument* instead would infer the name
 * as `never` and collapse the whole parameter type.
 */
type Forgotten<TEngine> =
	TEngine extends BucketEngine<infer TInput, infer TConditions, infer _B>
		? BucketEngine<TInput, TConditions>
		: never;

type ForgottenConditions<TEngine> =
	TEngine extends BucketEngine<infer TInput, infer _C, infer _B>
		? BucketEngine<TInput>
		: never;

function forget<TEngine>(engine: TEngine): Forgotten<TEngine> {
	return engine as unknown as Forgotten<TEngine>;
}

/** As {@link forget}, but also forgets the conditions. */
function forgetConditions<TEngine>(
	engine: TEngine,
): ForgottenConditions<TEngine> {
	return engine as unknown as ForgottenConditions<TEngine>;
}

describe("configuration errors", () => {
	test("a duplicate condition name is rejected", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true });

		assert.throws(
			() =>
				forgetConditions(engine).defineCondition({
					name: "heavy",
					checkFn: () => true,
				}),
			BucketError,
		);
	});

	test("a condition defined after a bucket is rejected", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "heavy" });

		assert.throws(
			() =>
				forgetConditions(engine).defineCondition({
					name: "late",
					checkFn: () => true,
				}),
			{
				name: "BucketError",
				message: /Define all conditions first/,
			},
		);
	});

	test("a duplicate bucket name is rejected", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "heavy" });

		assert.throws(
			() =>
				forget(engine).defineBucket({ name: "all", checkFn: () => "heavy" }),
			{ name: "BucketError", message: /already defined/ },
		);
	});

	test("a bucket cannot reference an undefined condition", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true });

		assert.throws(
			() =>
				engine.defineBucket({
					name: "typo",
					checkFn: ({ NOT }) => NOT("heavey" as "heavy"),
				}),
			{
				name: "BucketError",
				message: /unknown condition "heavey"\. Defined: heavy/,
			},
		);
	});

	test("a bucket needs a checkFn that returns an expression", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true });

		assert.throws(
			() => engine.defineBucket({ name: "no fn", checkFn: undefined as never }),
			{ name: "BucketError", message: /needs a checkFn/ },
		);
		assert.throws(
			() =>
				engine.defineBucket({
					name: "not an expr",
					checkFn: () => 42 as never,
				}),
			{ name: "BucketError", message: /condition name or an expression/ },
		);
	});

	test("input cannot be defined twice", () => {
		const engine = new BucketEngine().defineInput<Product>();

		assert.throws(() => engine.defineInput(productSchema), {
			name: "BucketError",
			message: /already defined/,
		});
	});

	test("input cannot be defined after a condition", () => {
		const engine = new BucketEngine().defineCondition({
			name: "heavy",
			checkFn: () => true,
		});

		assert.throws(() => engine.defineInput(productSchema), {
			name: "BucketError",
			message: /Define the input before any condition/,
		});
	});

	test("defineInput rejects a value that is not a Standard Schema", () => {
		assert.throws(
			() => new BucketEngine().defineInput({ parse: () => null } as never),
			{ name: "BucketError", message: /Standard Schema/ },
		);
	});

	test("an unnamed condition or bucket is rejected", () => {
		const engine = new BucketEngine().defineInput<Product>();

		assert.throws(
			() => engine.defineCondition({ name: "", checkFn: () => true }),
			BucketError,
		);
		assert.throws(
			() => engine.defineCondition({ name: "ok", checkFn: undefined as never }),
			BucketError,
		);
		assert.throws(
			() =>
				engine
					.defineCondition({ name: "ok", checkFn: () => true })
					.defineBucket({ name: "", checkFn: () => "ok" }),
			BucketError,
		);
	});

	test("missingCombinations refuses to enumerate an absurd number of conditions", () => {
		// Forget the conditions each round so the 17 identical `string` names
		// don't trip the duplicate-name check in the type layer.
		let engine = new BucketEngine().defineInput<Product>();
		for (let index = 0; index < 17; index += 1) {
			engine = forgetConditions(
				engine.defineCondition({ name: `c${index}`, checkFn: () => true }),
			);
		}

		assert.throws(() => engine.missingCombinations(), {
			name: "BucketError",
			message: /refuses/,
		});
	});

	test("nothing else enumerates, so 17 conditions still process fine", async () => {
		let engine = new BucketEngine().defineInput<Product>();
		for (let index = 0; index < 17; index += 1) {
			engine = forgetConditions(
				engine.defineCondition({ name: `c${index}`, checkFn: () => true }),
			);
		}

		const report = await (
			engine as unknown as BucketEngine<Product, { c0: Product }>
		)
			.defineBucket({ name: "all", checkFn: () => "c0" })
			.process([PRODUCTS[0] as Product]);

		assert.strictEqual(report.buckets.all.length, 1);
	});
});

describe("combinator validation", () => {
	test("AND and OR need operands", () => {
		assert.throws(() => AND(), BucketError);
		assert.throws(() => OR(), BucketError);
	});

	test("an operand that is neither a name nor an expression is rejected", () => {
		assert.throws(() => NOT(42 as never), BucketError);
		assert.throws(() => AND("a", null as never), BucketError);
	});

	test("ONLY takes names, not expressions", () => {
		assert.throws(() => ONLY(NOT("a") as never), BucketError);
	});
});

describe("readiness", () => {
	test("processing without an input is an error, not an empty report", async () => {
		await assert.rejects(() => new BucketEngine().process([]), {
			name: "BucketError",
			message: /No input defined/,
		});
	});

	test("processing without buckets is an error", async () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true });

		await assert.rejects(() => engine.process([]), {
			name: "BucketError",
			message: /No buckets defined/,
		});
	});

	test("process rejects a single item passed where an array belongs", async () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "heavy" });

		await assert.rejects(() => engine.process(PRODUCTS[0] as never), {
			name: "BucketError",
			message: /Use \.processOne\(\)/,
		});
	});
});

describe("concurrency", () => {
	test("a batch smaller than the default limit runs entirely in parallel", async () => {
		const probe = tracker(5);
		const report = await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "slow", checkFn: probe.checkFn })
			.defineBucket({ name: "all", checkFn: () => "slow" })
			.process(PRODUCTS);

		assert.strictEqual(report.buckets.all.length, PRODUCTS.length);
		assert.strictEqual(probe.state.peak, PRODUCTS.length);
	});

	test("a larger batch is capped at the default rather than running unbounded", async () => {
		const probe = tracker(1);
		const rows = Array.from({ length: DEFAULT_CONCURRENCY * 3 }, () => ({
			sku: "s",
			weight: 1,
			digital: false,
		}));

		await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "slow", checkFn: probe.checkFn })
			.defineBucket({ name: "all", checkFn: () => "slow" })
			.process(rows);

		assert.strictEqual(probe.state.peak, DEFAULT_CONCURRENCY);
		assert.strictEqual(probe.state.calls, rows.length);
	});

	test("Infinity is still available for anyone who wants it", async () => {
		const probe = tracker(1);
		const rows = Array.from({ length: DEFAULT_CONCURRENCY + 50 }, () => ({
			sku: "s",
			weight: 1,
			digital: false,
		}));

		await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "slow", checkFn: probe.checkFn })
			.defineBucket({ name: "all", checkFn: () => "slow" })
			.process(rows, { concurrency: Number.POSITIVE_INFINITY });

		assert.strictEqual(probe.state.peak, rows.length);
	});

	test("never exceeds the requested limit", async () => {
		const probe = tracker(5);
		await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "slow", checkFn: probe.checkFn })
			.defineBucket({ name: "all", checkFn: () => "slow" })
			.process(PRODUCTS, { concurrency: 2 });

		assert.strictEqual(probe.state.peak, 2);
		assert.strictEqual(probe.state.calls, PRODUCTS.length);
	});

	test("a limit larger than the batch is harmless", async () => {
		const probe = tracker();
		const report = await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "slow", checkFn: probe.checkFn })
			.defineBucket({ name: "all", checkFn: () => "slow" })
			.process([PRODUCTS[0] as Product], { concurrency: 100 });

		assert.strictEqual(report.buckets.all.length, 1);
	});

	test("a nonsensical limit is rejected rather than deadlocking", async () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "heavy", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "heavy" });

		for (const concurrency of [0, -1, 1.5, Number.NaN]) {
			await assert.rejects(() => engine.process(PRODUCTS, { concurrency }), {
				name: "BucketError",
				message: /positive integer/,
			});
		}
	});
});
