import assert from "node:assert";
import test, { describe } from "node:test";
import {
	BucketEngine,
	definedIn,
	isPropertyDefined,
	isPropertyPresent,
	presentIn,
} from "../main.ts";
import type { Equal, Expect } from "./support.ts";

interface Product {
	readonly sku: string;
	readonly weightKg: number | null;
}

interface Listing {
	readonly id: string;
	readonly product?: Product;
}

describe("isPropertyDefined", () => {
	const hasSku = isPropertyDefined("sku");

	test("true when the property is there with a real value", () => {
		assert.strictEqual(hasSku({ sku: "a" }), true);
	});

	test("false when the property's value is explicitly undefined", () => {
		assert.strictEqual(hasSku({ sku: undefined }), false);
	});

	test("false when the property is entirely absent", () => {
		assert.strictEqual(hasSku({}), false);
	});

	test("null counts as defined, unlike isPropertyPresent", () => {
		assert.strictEqual(hasSku({ sku: null }), true);
	});

	test("false for null and for non-object primitives", () => {
		assert.strictEqual(hasSku(null), false);
		assert.strictEqual(hasSku(undefined), false);
		assert.strictEqual(hasSku("sku"), false);
		assert.strictEqual(hasSku(42), false);
	});

	test("a function can carry the property too", () => {
		const fn = () => {};
		(fn as { sku?: string }).sku = "a";
		assert.strictEqual(hasSku(fn), true);
	});

	test("__proto__ and constructor are rejected, not read off the prototype chain", () => {
		assert.strictEqual(isPropertyDefined("__proto__")({}), false);
		assert.strictEqual(isPropertyDefined("constructor")({}), false);
	});

	test("a real property-descriptor check, not `in`", () => {
		// `in` would see this as present; the descriptor check looks at the
		// actual value, which is what "defined" means here.
		const withUndefinedValue = { sku: undefined };
		assert.strictEqual("sku" in withUndefinedValue, true);
		assert.strictEqual(hasSku(withUndefinedValue), false);
	});
});

describe("isPropertyPresent", () => {
	const hasWeight = isPropertyPresent("weightKg");

	test("true when the property is there with a non-null, non-undefined value", () => {
		assert.strictEqual(hasWeight({ weightKg: 2 }), true);
	});

	test("false when the value is null", () => {
		assert.strictEqual(hasWeight({ weightKg: null }), false);
	});

	test("false when the value is undefined or the property is absent", () => {
		assert.strictEqual(hasWeight({ weightKg: undefined }), false);
		assert.strictEqual(hasWeight({}), false);
	});
});

describe("definedIn", () => {
	test("delegates to isPropertyDefined's real runtime check", () => {
		const predicate = definedIn<{ a?: string }>()("a");
		assert.strictEqual(predicate({ a: "x" }), true);
		assert.strictEqual(predicate({ a: undefined }), false);
		assert.strictEqual(predicate({}), false);
	});

	test("narrows checkFn's item, used directly as a condition", async () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: definedIn<Listing>()("product"),
			})
			.defineBucket({ name: "withProduct", checkFn: () => "hasProduct" });

		const report = await engine.process([
			{ id: "L1", product: { sku: "a", weightKg: 1 } },
			{ id: "L2" },
		]);

		// No `?.`, no cast: `withProduct`'s item type is `Listing & { product:
		// Product }`, proven by `definedIn`, not the plain input type.
		assert.deepStrictEqual(
			report.buckets.withProduct.map((l) => l.product.sku),
			["a"],
		);
	});

	test("checkFn's item type is Listing & { product: Product }", () => {
		const engine = new BucketEngine()
			.defineInput<Listing>()
			.defineCondition({
				name: "hasProduct",
				checkFn: definedIn<Listing>()("product"),
			})
			.defineCondition({
				name: "hasWeight",
				when: () => "hasProduct",
				checkFn: (listing) => {
					// Only compiles if `listing.product` is `Product`, not
					// `Product | undefined` — proof `definedIn` really narrowed
					// `hasProduct`, the same as an inline predicate would have.
					type Debug = typeof listing.product;
					type _Narrowed = Expect<Equal<Debug, Product>>;
					return listing.product.weightKg !== null;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, ["hasProduct", "hasWeight"]);
	});

	test("rejects a key that isn't actually on the object", () => {
		const definedInListing = definedIn<Listing>();
		// @ts-expect-error "nope" is not a key of Listing
		definedInListing("nope");
	});
});

describe("presentIn", () => {
	test("used as a gate on a nullable field, via when", async () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({
				name: "hasWeight",
				checkFn: presentIn<Product>()("weightKg"),
			})
			.defineBucket({ name: "weighed", checkFn: () => "hasWeight" });

		const report = await engine.process([
			{ sku: "a", weightKg: 2 },
			{ sku: "b", weightKg: null },
		]);

		// weightKg is `number`, not `number | null`, inside the bucket item —
		// `.toFixed()` only compiles because presentIn narrowed it.
		assert.deepStrictEqual(
			report.buckets.weighed.map((p) => p.weightKg.toFixed(1)),
			["2.0"],
		);
	});

	test("checkFn's item type is Product & { weightKg: number }", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({
				name: "hasWeight",
				checkFn: (product) => {
					const isWeighed = presentIn<Product>()("weightKg")(product);
					return isWeighed;
				},
			})
			.defineCondition({
				name: "hasWeightNarrowed",
				checkFn: presentIn<Product>()("weightKg"),
			})
			.defineCondition({
				name: "hasWeightGated",
				when: () => "hasWeightNarrowed",
				checkFn: (product) => {
					// Only compiles if `weightKg` is `number`, not `number | null` —
					// proof `presentIn` narrowed `hasWeightNarrowed`.
					type Debug = typeof product.weightKg;
					type _Narrowed = Expect<Equal<Debug, number>>;
					return product.weightKg > 0;
				},
			});

		assert.deepStrictEqual(engine.conditionNames, [
			"hasWeight",
			"hasWeightNarrowed",
			"hasWeightGated",
		]);
	});

	test("rejects a key that isn't actually on the object", () => {
		const presentInProduct = presentIn<Product>();
		// @ts-expect-error "nope" is not a key of Product
		presentInProduct("nope");
	});
});
