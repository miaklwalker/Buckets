import assert from "node:assert";
import test, { describe } from "node:test";
import { AND, BucketEngine, BucketError, definedIn } from "../main.ts";
import type { Equal, Expect } from "./support.ts";

interface Product {
	readonly sku: string;
	readonly weightKg: number | null;
	readonly active: boolean;
}

interface Listing {
	readonly id: string;
	readonly product?: Product;
}

const LISTINGS: Listing[] = [
	{ id: "L1", product: { sku: "mug-01", weightKg: 0.4, active: true } },
	{ id: "L2", product: { sku: "lamp-01", weightKg: null, active: false } },
	{ id: "L3" },
];

/** Counts how many times `checkFn` actually ran, across every condition. */
function countedCheck() {
	const state = { calls: 0 };
	return {
		state,
		checkFn: (listing: Listing & { product: Product }) => {
			state.calls += 1;
			return listing.product.weightKg !== null;
		},
	};
}

describe("defineCondition with `when`", () => {
	test("checkFn never runs when the precondition is false", async () => {
		const weight = countedCheck();
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: weight.checkFn,
			})
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		const report = await engine.process(LISTINGS);

		// Only L1 and L2 have a product; L3 should never reach checkFn at all.
		assert.strictEqual(weight.state.calls, 2);
		assert.deepStrictEqual(
			report.buckets.weighed.map((l) => l.id),
			["L1"],
		);
	});

	test("a skipped condition is recorded false, same as if it had run and failed", async () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => listing.product.weightKg !== null,
			})
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		const draft = await engine.processOne(LISTINGS[2] as Listing);

		assert.deepStrictEqual(draft.conditions, {
			hasProduct: false,
			hasWeight: false,
		});
		assert.deepStrictEqual(draft.buckets, []);
	});

	test("a compound precondition via AND only runs once every branch holds", async () => {
		let fraudChecks = 0;
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "isActive",
				checkFn: (listing) => listing.product?.active === true,
			})
			.defineCondition({
				name: "passesFraudCheck",
				// AND called as a value (not `({ AND }) => AND(...)`) still
				// narrows `checkFn`'s `item` — no `?.` needed below.
				when: AND("hasProduct", "isActive"),
				checkFn: (listing) => {
					fraudChecks += 1;
					return listing.product.sku.length > 3;
				},
			})
			.defineBucket({ name: "trusted", checkFn: () => "passesFraudCheck" });

		const report = await engine.process(LISTINGS);

		// Only L1 has hasProduct AND isActive both true.
		assert.strictEqual(fraudChecks, 1);
		assert.deepStrictEqual(
			report.buckets.trusted.map((l) => l.id),
			["L1"],
		);
	});

	test("preconditions chain: a later gate can depend on an earlier gated condition", async () => {
		const calls: string[] = [];
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => {
					calls.push("hasWeight");
					return listing.product.weightKg !== null;
				},
			})
			// AND called as a value narrows same as a bare name would.
			.defineCondition({
				name: "isHeavy",
				when: AND("hasProduct", "hasWeight"),
				checkFn: (listing) => {
					calls.push("isHeavy");
					return (listing.product.weightKg ?? 0) > 1;
				},
			})
			.defineBucket({ name: "heavy", checkFn: () => "isHeavy" });

		// L2 has a product but a null weight, so hasWeight is false and
		// isHeavy — one wave further out — should never run for it.
		const report = await engine.processOne(LISTINGS[1] as Listing);

		assert.deepStrictEqual(report.conditions, {
			hasProduct: true,
			hasWeight: false,
			isHeavy: false,
		});
		assert.deepStrictEqual(calls, ["hasWeight"]);
	});

	test("ONLY still means every other base condition is false, gated ones included", async () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => listing.product.weightKg !== null,
			})
			.defineBucket({
				name: "productOnlyNoWeight",
				checkFn: ({ ONLY }) => ONLY("hasProduct"),
			});

		const report = await engine.process(LISTINGS);

		// L2 has a product but weightKg is null, so hasWeight is false and
		// hasProduct is the only true condition.
		assert.deepStrictEqual(
			report.buckets.productOnlyNoWeight.map((l) => l.id),
			["L2"],
		);
	});

	test("missingCombinations only enumerates what's reachable", () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => listing.product.weightKg !== null,
			})
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		// [] (nothing true) and ["hasProduct"] (a product with no weight) are
		// both real, reachable gaps. What's *not* here is ["hasWeight"] alone —
		// weighed but product-less — which no item could ever produce, since
		// hasWeight's checkFn only ever runs once hasProduct is true.
		assert.deepStrictEqual(engine.missingCombinations(), [[], ["hasProduct"]]);
	});

	test("checkFn's item type is narrowed by what `when` proved", () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => {
					// No `?.` needed — this only compiles if `listing.product` is
					// `Product`, not `Product | undefined`.
					type Debug = typeof listing.product;
					type _Narrowed = Expect<Equal<Debug, Product>>;
					return listing.product.weightKg !== null;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, ["hasProduct", "hasWeight"]);
	});

	test("a value-position AND/OR/NOT `when` narrows too, unlike the callback form", () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "isActive",
				checkFn: (listing) => listing.product?.active === true,
			})
			.defineCondition({
				name: "hasWeight",
				// AND imported and called directly, not destructured from a
				// callback parameter — this is what makes it narrow.
				when: AND("hasProduct", "isActive"),
				checkFn: (listing) => {
					type Debug = typeof listing.product;
					type _Narrowed = Expect<Equal<Debug, Product>>;
					return listing.product.weightKg !== null;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, [
			"hasProduct",
			"isActive",
			"hasWeight",
		]);
	});

	test("checkFn as a second argument narrows too, with the callback form's autocomplete", async () => {
		let calls = 0;
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "isActive",
				checkFn: (listing) => listing.product?.active === true,
			})
			// `when` and `checkFn` as two arguments instead of one object: the
			// destructured `{ AND }` here is bound to this engine's real
			// condition names (autocomplete/typo-checking, unlike the imported
			// standalone `AND`), and — unlike that same destructured form inside
			// one object — it still narrows `checkFn`'s `listing`.
			.defineCondition(
				{
					name: "hasWeight",
					when: ({ AND }) => AND("hasProduct", "isActive"),
				},
				(listing) => {
					calls += 1;
					type Debug = typeof listing.product;
					type _Narrowed = Expect<Equal<Debug, Product>>;
					return listing.product.weightKg !== null;
				},
			)
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		const report = await engine.process(LISTINGS);

		// Only L1 has hasProduct AND isActive both true — same skip guarantee
		// as every other form of `when`.
		assert.strictEqual(calls, 1);
		assert.deepStrictEqual(
			report.buckets.weighed.map((l) => l.id),
			["L1"],
		);
	});

	test("an AND/OR/NOT `when` still skips correctly but doesn't narrow — same as NOT elsewhere", () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "isActive",
				checkFn: (listing) => listing.product?.active === true,
			})
			.defineCondition({
				name: "hasWeight",
				when: ({ AND }) => AND("hasProduct", "isActive"),
				checkFn: (listing) => {
					// Unlike a bare name, an AND-built `when` leaves `item` at the
					// plain input type — `listing.product` is still optional here.
					type Debug = typeof listing.product;
					type _NotNarrowed = Expect<Equal<Debug, Product | undefined>>;
					return listing.product?.weightKg !== null;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, [
			"hasProduct",
			"isActive",
			"hasWeight",
		]);
	});

	test("the plain, ungated form still requires optional chaining — no regression", () => {
		const engine = new BucketEngine().defineInput<Listing>().defineCondition({
			name: "hasProduct",
			checkFn: (listing): listing is Listing & { product: Product } =>
				listing.product !== undefined,
		});

		engine.defineCondition({
			name: "hasWeightUnguarded",
			// @ts-expect-error no `when`, so `listing.product` is still optional.
			checkFn: (listing) => listing.product.weightKg !== null,
		});
	});

	test("a when referring to an unknown condition is rejected at runtime", () => {
		const engine = new BucketEngine().defineInput<Listing>().defineCondition({
			name: "hasProduct",
			checkFn: (listing): listing is Listing & { product: Product } =>
				listing.product !== undefined,
		});

		assert.throws(
			() =>
				engine.defineCondition({
					name: "hasWeight",
					// Cast past the compiler the same way the rest of the suite
					// reaches this guard — real callers hit it via `any`/JS, not by
					// writing code TypeScript would ever accept.
					when: () => "nope" as "hasProduct",
					checkFn: () => true,
				}),
			(error: unknown) =>
				error instanceof BucketError &&
				/refers to unknown condition "nope"/.test(error.message),
		);
	});

	test("checkFn still needs to be a function", () => {
		const engine = new BucketEngine().defineInput<Listing>().defineCondition({
			name: "hasProduct",
			checkFn: (listing): listing is Listing & { product: Product } =>
				listing.product !== undefined,
		});

		assert.throws(
			() =>
				engine.defineCondition({
					name: "hasWeight",
					when: () => "hasProduct",
					// biome-ignore lint/suspicious/noExplicitAny: forcing the runtime guard
					checkFn: null as any,
				}),
			(error: unknown) =>
				error instanceof BucketError &&
				/Condition "hasWeight" needs a checkFn/.test(error.message),
		);
	});

	test("a throwing gated checkFn still lands in errors, not classified", async () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (listing): listing is Listing & { product: Product } =>
					listing.product !== undefined,
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (): boolean => {
					throw new Error("boom");
				},
			})
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		const report = await engine.process([LISTINGS[0] as Listing]);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.condition, "hasWeight");
	});

	test("a gated condition's guard always includes what its precondition proved, even if its own predicate doesn't mention it", () => {
		interface Alt {
			readonly id: string;
			readonly product?: Product;
			readonly alternate?: Product;
		}

		const engine = new BucketEngine()
			.defineInput<Alt>()
			.defineCondition({
				name: "hasProduct",
				checkFn: (item): item is Alt & { product: Product } =>
					item.product !== undefined,
			})
			.defineCondition({
				name: "hasAlternate",
				when: () => "hasProduct",
				// `definedIn<Alt>()` is typed against the bare input, `Alt` — a
				// function built independently of this call site, with no way to
				// know `hasProduct` already ran. On its own it says nothing about
				// `product`. `hasAlternate`'s own guard still includes it, because
				// `when` already proved it before this ever ran.
				checkFn: definedIn<Alt>()("alternate"),
			})
			.defineCondition({
				name: "hasBoth",
				// Gated on "hasAlternate" alone — never names "hasProduct".
				when: () => "hasAlternate",
				checkFn: (item) => {
					// Only compiles if `item.product` is `Product`, not
					// `Product | undefined` — proof the chain carried through
					// automatically, with no discipline required from
					// `hasAlternate`'s own predicate.
					type Debug = typeof item.product;
					type _Narrowed = Expect<Equal<Debug, Product>>;
					return item.product.sku.length > 0 && item.alternate.sku.length > 0;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, [
			"hasProduct",
			"hasAlternate",
			"hasBoth",
		]);
	});
});
