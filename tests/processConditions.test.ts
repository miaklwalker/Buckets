import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine, BucketError } from "../main.ts";
import { PRODUCTS, productSchema } from "./support.ts";

/** Conditions only — no bucket, which is the whole point of processConditions(). */
function products() {
	return new BucketEngine()
		.defineInput(productSchema)
		.defineCondition({
			name: "hasWeight",
			group: "existence check",
			checkFn: (product) => product.weight !== null,
		})
		.defineCondition({
			name: "isDigital",
			group: "existence check",
			checkFn: (product) => product.digital,
		});
}

describe("processConditions", () => {
	test("runs without a single bucket having been defined", async () => {
		const report = await products().processConditions(PRODUCTS);
		assert.strictEqual(report.results.length, PRODUCTS.length);
	});

	test("process() and processOne() still require a bucket", async () => {
		await assert.rejects(() => products().process(PRODUCTS), BucketError);
		await assert.rejects(
			() => products().processOne(PRODUCTS[0] as never),
			BucketError,
		);
	});

	test("throws when no input has been defined", async () => {
		await assert.rejects(
			() => new BucketEngine().processConditions([]),
			/No input defined/,
		);
	});

	test("results carries every item's own verdicts, in input order", async () => {
		const report = await products().processConditions(PRODUCTS);
		assert.deepStrictEqual(
			report.results.map((r) => r.conditions),
			[
				{ hasWeight: true, isDigital: false }, // physical-1
				{ hasWeight: false, isDigital: true }, // download-1
				{ hasWeight: true, isDigital: true }, // hybrid-1
				{ hasWeight: false, isDigital: false }, // vapour-1
			],
		);
	});

	test("summary tallies passing/failing per condition across the batch", async () => {
		const report = await products().processConditions(PRODUCTS);
		assert.deepStrictEqual(report.summary, [
			{ name: "hasWeight", group: "existence check", passing: 2, failing: 2 },
			{ name: "isDigital", group: "existence check", passing: 2, failing: 2 },
		]);
	});

	test("a condition given no group summarizes with group: undefined", async () => {
		const report = await new BucketEngine()
			.defineInput(productSchema)
			.defineCondition({
				name: "hasWeight",
				checkFn: (product) => product.weight !== null,
			})
			.processConditions(PRODUCTS);

		assert.deepStrictEqual(report.summary, [
			{ name: "hasWeight", group: undefined, passing: 2, failing: 2 },
		]);
	});

	test("a computed condition appears in the summary with group: undefined", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "both",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.processConditions(PRODUCTS);

		const both = report.summary.find((entry) => entry.name === "both");
		assert.deepStrictEqual(both, {
			name: "both",
			group: undefined,
			passing: 1, // hybrid-1 only
			failing: 3,
		});
	});

	test("an item whose checkFn throws lands in errors, not the summary", async () => {
		const report = await new BucketEngine()
			.defineInput(productSchema)
			.defineCondition({
				name: "hasWeight",
				checkFn: (product) => product.weight !== null,
			})
			.defineCondition({
				name: "explodes",
				checkFn: (product) => {
					if (product.sku === "physical-1") throw new Error("boom");
					return true;
				},
			})
			.processConditions(PRODUCTS);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.condition, "explodes");
		assert.strictEqual(report.results.length, PRODUCTS.length - 1);
		// physical-1's hasWeight verdict (true) is excluded along with the rest
		// of that item — the failure takes the whole item out, not just the
		// condition that threw.
		const hasWeight = report.summary.find(
			(entry) => entry.name === "hasWeight",
		);
		assert.deepStrictEqual(hasWeight, {
			name: "hasWeight",
			group: undefined,
			passing: 1,
			failing: 2,
		});
	});

	test("rejects a non-array batch", async () => {
		await assert.rejects(
			() => products().processConditions("nope" as never),
			/expects an array/,
		);
	});

	test("group must be a string when given", () => {
		assert.throws(() => {
			new BucketEngine().defineInput(productSchema).defineCondition({
				name: "hasWeight",
				// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard past the type
				group: 42 as any,
				checkFn: (product) => product.weight !== null,
			});
		}, /"group" needs to be a string/);
	});
});
