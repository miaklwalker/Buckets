import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine, BucketError } from "../main.ts";
import { type Product, PRODUCTS, productSchema, schema } from "./support.ts";

/** The chain every behavioural test starts from. */
function products() {
	return new BucketEngine()
		.defineInput(productSchema)
		.defineCondition({
			name: "hasWeight",
			checkFn: (product) => product.weight !== null,
		})
		.defineCondition({
			name: "isDigital",
			checkFn: (product) => product.digital,
		});
}

describe("process", () => {
	test("an item lands in every bucket whose rule it satisfies", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "digital", checkFn: () => "isDigital" })
			.process(PRODUCTS);

		// hybrid-1 has a weight AND is digital, so it is in both buckets.
		assert.deepStrictEqual(
			report.buckets.weighted.map((product) => product.sku),
			["physical-1", "hybrid-1"],
		);
		assert.deepStrictEqual(
			report.buckets.digital.map((product) => product.sku),
			["download-1", "hybrid-1"],
		);
	});

	test("a bare condition name leaves every other condition free", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.weighted.map((product) => product.sku),
			["physical-1", "hybrid-1"],
		);
	});

	test("ONLY is the strict form: these conditions and no others", async () => {
		const report = await products()
			.defineBucket({
				name: "weightOnly",
				checkFn: ({ ONLY }) => ONLY("hasWeight"),
			})
			.process(PRODUCTS);

		// hybrid-1 has a weight too, but it is also digital, so ONLY excludes it.
		assert.deepStrictEqual(
			report.buckets.weightOnly.map((product) => product.sku),
			["physical-1"],
		);
	});

	test("ONLY with no names matches the item where nothing is true", async () => {
		const report = await products()
			.defineBucket({ name: "blank", checkFn: ({ ONLY }) => ONLY() })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.blank.map((product) => product.sku),
			["vapour-1"],
		);
	});

	test("AND, OR and NOT compose", async () => {
		const report = await products()
			.defineBucket({
				name: "both",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({
				name: "either",
				checkFn: ({ OR }) => OR("hasWeight", "isDigital"),
			})
			.defineBucket({
				name: "physicalOnly",
				checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isDigital")),
			})
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.both.map((product) => product.sku),
			["hybrid-1"],
		);
		assert.deepStrictEqual(
			report.buckets.either.map((product) => product.sku),
			["physical-1", "download-1", "hybrid-1"],
		);
		assert.deepStrictEqual(
			report.buckets.physicalOnly.map((product) => product.sku),
			["physical-1"],
		);
	});

	test("overlapping rules are allowed and both get the item", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "alsoWeighted", checkFn: () => "hasWeight" })
			.process([PRODUCTS[0] as Product]);

		assert.deepStrictEqual(
			report.buckets.weighted,
			report.buckets.alsoWeighted,
		);
		assert.strictEqual(report.buckets.weighted.length, 1);
	});

	test("items satisfying no rule land in unmatched with their combination", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.unmatched.map((entry) => entry.item.sku),
			["download-1", "vapour-1"],
		);
		assert.deepStrictEqual(report.unmatched[0]?.conditions, {
			hasWeight: false,
			isDigital: true,
		});
	});

	test("every bucket key is present even when nothing landed in it", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({
				name: "impossible",
				checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("hasWeight")),
			})
			.process([PRODUCTS[0] as Product]);

		assert.deepStrictEqual(report.buckets.impossible, []);
	});

	test("an empty batch produces empty buckets rather than throwing", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.process([]);

		assert.deepStrictEqual(report.buckets, { weighted: [] });
		assert.deepStrictEqual(report.unmatched, []);
		assert.deepStrictEqual(report.errors, []);
	});

	test("items keep their input order inside a bucket", async () => {
		const many = Array.from({ length: 50 }, (_, index) => ({
			sku: `sku-${index}`,
			weight: 1,
			digital: false,
		}));

		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.process(many, { concurrency: 4 });

		assert.deepStrictEqual(
			report.buckets.weighted.map((product) => product.sku),
			many.map((product) => product.sku),
		);
	});

	test("every item is accounted for somewhere, even if in several places", async () => {
		const report = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "digital", checkFn: () => "isDigital" })
			.process(PRODUCTS);

		const placed = new Set([
			...Object.values(report.buckets)
				.flat()
				.map((product) => product.sku),
			...report.unmatched.map((entry) => entry.item.sku),
			...report.errors.map((failure) => failure.item.sku),
		]);

		assert.strictEqual(placed.size, PRODUCTS.length);
		// And membership really does double-count: hybrid-1 is in two buckets.
		assert.strictEqual(Object.values(report.buckets).flat().length, 4);
	});
});

describe("process error collection", () => {
	test("a throwing checkFn sends one item to errors and keeps the batch going", async () => {
		const report = await new BucketEngine()
			.defineInput(productSchema)
			.defineCondition({
				name: "explodes",
				checkFn: (product) => {
					if (product.sku === "download-1") throw new Error("upstream down");
					return product.weight !== null;
				},
			})
			.defineBucket({ name: "heavy", checkFn: () => "explodes" })
			.process(PRODUCTS);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "condition");
		assert.strictEqual(report.errors[0]?.condition, "explodes");
		assert.strictEqual(report.errors[0]?.error.message, "upstream down");
		assert.strictEqual(report.buckets.heavy.length, 2);
	});

	test("a schema rejection is recorded as an input failure with its issues", async () => {
		const report = await new BucketEngine()
			.defineInput(
				schema<Product>((value) =>
					typeof value === "object" && value !== null && "sku" in value
						? { value: value as Product }
						: { issues: [{ message: "sku is required", path: ["sku"] }] },
				),
			)
			.defineCondition({ name: "always", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "always" })
			.process([{ sku: "ok", weight: 1, digital: false }, {} as Product]);

		assert.strictEqual(report.buckets.all.length, 1);
		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "input");
		assert.ok(report.errors[0]?.error instanceof BucketError);
		assert.match(report.errors[0].error.message, /sku: sku is required/);
		assert.deepStrictEqual(report.errors[0].error.issues, [
			{ message: "sku is required", path: ["sku"] },
		]);
	});

	test("a checkFn that throws a non-Error is still reported as an Error", async () => {
		const report = await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({
				name: "rude",
				checkFn: () => {
					throw "just a string";
				},
			})
			.defineBucket({ name: "any", checkFn: () => "rude" })
			.process([PRODUCTS[0] as Product]);

		assert.ok(report.errors[0]?.error instanceof Error);
		assert.strictEqual(report.errors[0]?.error.message, "just a string");
	});

	test("one failing condition fails the item even when others succeeded", async () => {
		const report = await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "fine", checkFn: () => true })
			.defineCondition({
				name: "broken",
				checkFn: () => {
					throw new Error("nope");
				},
			})
			.defineBucket({ name: "any", checkFn: () => "fine" })
			.process([PRODUCTS[0] as Product]);

		assert.strictEqual(report.buckets.any.length, 0);
		assert.strictEqual(report.unmatched.length, 0);
		assert.strictEqual(report.errors.length, 1);
	});
});

describe("processOne", () => {
	test("returns every matching bucket and every condition verdict", async () => {
		const assignment = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "digital", checkFn: () => "isDigital" })
			.processOne({ sku: "one", weight: 3, digital: true });

		assert.deepStrictEqual(assignment.buckets, ["weighted", "digital"]);
		assert.deepStrictEqual(assignment.conditions, {
			hasWeight: true,
			isDigital: true,
		});
		assert.strictEqual(assignment.item.sku, "one");
	});

	test("matching nothing is an empty array, not an error", async () => {
		const assignment = await products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.processOne({ sku: "one", weight: null, digital: true });

		assert.deepStrictEqual(assignment.buckets, []);
	});

	test("throws instead of collecting when a condition fails", async () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({
				name: "broken",
				checkFn: () => {
					throw new Error("upstream down");
				},
			})
			.defineBucket({ name: "any", checkFn: () => "broken" });

		await assert.rejects(
			() => engine.processOne(PRODUCTS[0] as Product),
			BucketError,
		);
	});

	test("throws the validation error itself when the schema rejects", async () => {
		const engine = new BucketEngine()
			.defineInput(
				schema<Product>(() => ({ issues: [{ message: "bad shape" }] })),
			)
			.defineCondition({ name: "always", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "always" });

		await assert.rejects(() => engine.processOne({} as Product), {
			name: "BucketError",
			message: /bad shape/,
		});
	});
});

describe("input", () => {
	test("the report carries the schema's output, not the raw item", async () => {
		const report = await new BucketEngine()
			.defineInput(
				schema<Product>((value) => ({
					value: { ...(value as Product), sku: "normalised" },
				})),
			)
			.defineCondition({ name: "always", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "always" })
			.process([{ sku: "raw", weight: 1, digital: false }]);

		assert.strictEqual(report.buckets.all[0]?.sku, "normalised");
	});

	test("an async schema is awaited", async () => {
		const report = await new BucketEngine()
			.defineInput(
				schema<Product>(async (value) => ({ value: value as Product })),
			)
			.defineCondition({ name: "always", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "always" })
			.process([PRODUCTS[0] as Product]);

		assert.strictEqual(report.buckets.all.length, 1);
	});

	test("defineInput with no schema skips validation entirely", async () => {
		const report = await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "always", checkFn: () => true })
			.defineBucket({ name: "all", checkFn: () => "always" })
			.process([PRODUCTS[0] as Product]);

		assert.strictEqual(report.buckets.all.length, 1);
	});
});

describe("introspection", () => {
	test("exposes condition and bucket names in definition order", () => {
		const engine = products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "digital", checkFn: () => "isDigital" });

		assert.deepStrictEqual(engine.conditionNames, ["hasWeight", "isDigital"]);
		assert.deepStrictEqual(engine.bucketNames, ["weighted", "digital"]);
	});

	test("missingCombinations lists exactly what would land in unmatched", () => {
		const engine = products().defineBucket({
			name: "weighted",
			checkFn: () => "hasWeight",
		});

		// Anything without a weight satisfies no rule, whatever `isDigital` says.
		assert.deepStrictEqual(engine.missingCombinations(), [[], ["isDigital"]]);
	});

	test("missingCombinations is empty once the rules cover everything", () => {
		const engine = products()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({
				name: "weightless",
				checkFn: ({ NOT }) => NOT("hasWeight"),
			});

		assert.deepStrictEqual(engine.missingCombinations(), []);
	});

	test("missingCombinations agrees with what process actually leaves unmatched", async () => {
		const engine = products().defineBucket({
			name: "both",
			checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
		});

		const report = await engine.process(PRODUCTS);
		const unmatchedCombos = report.unmatched.map((entry) =>
			engine.conditionNames.filter((name) => entry.conditions[name]),
		);

		for (const combination of unmatchedCombos) {
			assert.ok(
				engine
					.missingCombinations()
					.some(
						(missing) =>
							missing.length === combination.length &&
							missing.every((name) => combination.includes(name)),
					),
				`${JSON.stringify(combination)} should be reported as missing`,
			);
		}
	});
});
