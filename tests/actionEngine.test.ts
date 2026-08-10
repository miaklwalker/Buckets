import assert from "node:assert";
import test, { describe } from "node:test";
import { ActionEngine } from "../main.ts";
import { PRODUCTS, type Product, productSchema } from "./action-support.ts";

/** The chain every behavioural test starts from. */
function products() {
	return new ActionEngine().defineInput(productSchema);
}

describe("process", () => {
	test("an item lands in every action it matches", async () => {
		const shipped: string[] = [];
		const digitized: string[] = [];

		const report = await products()
			.defineAction({
				name: "ship",
				checkFn: (product) => product.weight !== null,
				actionFn: (product) => {
					shipped.push(product.sku);
					return product.sku;
				},
			})
			.defineAction({
				name: "deliverDigitally",
				checkFn: (product) => product.digital,
				actionFn: (product) => {
					digitized.push(product.sku);
					return product.sku;
				},
			})
			.process(PRODUCTS);

		// hybrid-1 has a weight AND is digital, so both actions run for it.
		assert.deepStrictEqual(shipped, ["physical-1", "hybrid-1"]);
		assert.deepStrictEqual(digitized, ["download-1", "hybrid-1"]);
		assert.deepStrictEqual(
			report.results.ship.map((run) => run.item.sku),
			["physical-1", "hybrid-1"],
		);
		assert.deepStrictEqual(
			report.results.deliverDigitally.map((run) => run.result),
			["download-1", "hybrid-1"],
		);
	});

	test("results carry actionFn's return value, not just the item", async () => {
		const report = await products()
			.defineAction({
				name: "priceTag",
				checkFn: (product) => product.weight !== null,
				actionFn: (product) => `${product.sku}:${product.weight}kg`,
			})
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.results.priceTag.map((run) => run.result),
			["physical-1:2kg", "hybrid-1:1kg"],
		);
	});

	test("actionFn can be async", async () => {
		const report = await products()
			.defineAction({
				name: "ship",
				checkFn: (product) => product.weight !== null,
				actionFn: async (product) => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return product.sku;
				},
			})
			.process(PRODUCTS);

		assert.strictEqual(report.results.ship.length, 2);
	});

	test("an item satisfying no action lands in unmatched with every check", async () => {
		const report = await products()
			.defineAction({
				name: "ship",
				checkFn: (product) => product.weight !== null,
				actionFn: () => undefined,
			})
			.defineAction({
				name: "deliverDigitally",
				checkFn: (product) => product.digital,
				actionFn: () => undefined,
			})
			.process(PRODUCTS);

		assert.strictEqual(report.unmatched.length, 1);
		assert.strictEqual(report.unmatched[0]?.item.sku, "vapour-1");
		assert.deepStrictEqual(report.unmatched[0]?.checks, {
			ship: false,
			deliverDigitally: false,
		});
	});

	test("a throwing checkFn fails only that action, not the rest of the item", async () => {
		const report = await products()
			.defineAction({
				name: "flaky",
				checkFn: (product): boolean => {
					if (product.sku === "hybrid-1") throw new Error("boom");
					return true;
				},
				actionFn: (product) => product.sku,
			})
			.defineAction({
				name: "steady",
				checkFn: () => true,
				actionFn: (product) => product.sku,
			})
			.process(PRODUCTS);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "check");
		assert.strictEqual(report.errors[0]?.action, "flaky");
		assert.strictEqual(report.errors[0]?.item.sku, "hybrid-1");
		// steady still ran for every item, hybrid-1 included.
		assert.strictEqual(report.results.steady.length, PRODUCTS.length);
		// flaky still ran (and matched) for everything except hybrid-1.
		assert.strictEqual(report.results.flaky.length, PRODUCTS.length - 1);
	});

	test("a throwing actionFn is reported without touching other actions", async () => {
		const report = await products()
			.defineAction({
				name: "explodes",
				checkFn: () => true,
				actionFn: (product): string => {
					if (product.sku === "hybrid-1") throw new Error("kaboom");
					return product.sku;
				},
			})
			.defineAction({
				name: "steady",
				checkFn: () => true,
				actionFn: (product) => product.sku,
			})
			.process(PRODUCTS);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "action");
		assert.strictEqual(report.errors[0]?.action, "explodes");
		assert.strictEqual(report.results.explodes.length, PRODUCTS.length - 1);
		assert.strictEqual(report.results.steady.length, PRODUCTS.length);
	});

	test("an item with a failing action is not also reported as unmatched", async () => {
		const report = await products()
			.defineAction({
				name: "onlyOne",
				checkFn: (product): boolean => {
					if (product.sku === "vapour-1") throw new Error("nope");
					return false;
				},
				actionFn: () => undefined,
			})
			.process(PRODUCTS);

		assert.strictEqual(
			report.unmatched.some((entry) => entry.item.sku === "vapour-1"),
			false,
		);
		assert.strictEqual(
			report.errors.some((entry) => entry.item.sku === "vapour-1"),
			true,
		);
	});

	test("a schema rejection lands in errors with stage input, not unmatched", async () => {
		const report = await products()
			.defineAction({
				name: "ship",
				checkFn: () => true,
				actionFn: () => undefined,
			})
			.process([null as unknown as Product]);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "input");
		assert.strictEqual(report.unmatched.length, 0);
		assert.strictEqual(report.results.ship.length, 0);
	});

	test("output order matches input order", async () => {
		const report = await products()
			.defineAction({
				name: "ship",
				checkFn: (product) => product.weight !== null,
				actionFn: (product) => product.sku,
			})
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.results.ship.map((run) => run.item.sku),
			["physical-1", "hybrid-1"],
		);
	});
});

describe("processOne", () => {
	function shippable() {
		return products().defineAction({
			name: "ship",
			checkFn: (product) => product.weight !== null,
			actionFn: (product) => product.sku,
		});
	}

	test("matched lists every action that ran, results carries actionFn's value", async () => {
		const assignment = await shippable().processOne(PRODUCTS[0] as Product);

		assert.deepStrictEqual(assignment.matched, ["ship"]);
		assert.strictEqual(assignment.results.ship, "physical-1");
		assert.deepStrictEqual(assignment.checks, { ship: true });
		assert.deepStrictEqual(assignment.errors, []);
	});

	test("an empty matched array is the single-item equivalent of unmatched", async () => {
		const assignment = await shippable().processOne(PRODUCTS[1] as Product);

		assert.deepStrictEqual(assignment.matched, []);
		assert.deepStrictEqual(assignment.checks, { ship: false });
	});

	test("throws on input validation failure", async () => {
		await assert.rejects(
			() => shippable().processOne(null as unknown as Product),
			{ name: "ActionError" },
		);
	});

	test("does not throw when an action fails — it reports the failure instead", async () => {
		const assignment = await products()
			.defineAction({
				name: "flaky",
				checkFn: (): boolean => {
					throw new Error("boom");
				},
				actionFn: () => undefined,
			})
			.defineAction({
				name: "steady",
				checkFn: () => true,
				actionFn: (product) => product.sku,
			})
			.processOne(PRODUCTS[0] as Product);

		assert.deepStrictEqual(assignment.matched, ["steady"]);
		assert.strictEqual(assignment.errors.length, 1);
		assert.strictEqual(assignment.errors[0]?.stage, "check");
		assert.strictEqual(assignment.errors[0]?.action, "flaky");
		// flaky threw, so it never gets a verdict recorded in checks.
		assert.strictEqual("flaky" in assignment.checks, false);
	});
});

describe("clone", () => {
	test("branching off a clone leaves the original untouched", async () => {
		const base = products().defineAction({
			name: "ship",
			checkFn: (product) => product.weight !== null,
			actionFn: (product) => product.sku,
		});

		const withDigital = base.clone().defineAction({
			name: "deliverDigitally",
			checkFn: (product) => product.digital,
			actionFn: (product) => product.sku,
		});

		assert.deepStrictEqual(base.actionNames, ["ship"]);
		assert.deepStrictEqual(withDigital.actionNames, [
			"ship",
			"deliverDigitally",
		]);
	});
});

describe("actionNames", () => {
	test("reflects definition order", () => {
		const engine = products()
			.defineAction({
				name: "b",
				checkFn: () => true,
				actionFn: () => undefined,
			})
			.defineAction({
				name: "a",
				checkFn: () => true,
				actionFn: () => undefined,
			});

		assert.deepStrictEqual(engine.actionNames, ["b", "a"]);
	});
});
