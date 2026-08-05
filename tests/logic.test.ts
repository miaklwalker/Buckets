import assert from "node:assert";
import test, { describe } from "node:test";
import {
	AND,
	BucketEngine,
	evaluate,
	NOT,
	ONLY,
	OR,
	referencedNames,
	toExpr,
} from "../main.ts";
import type { Product } from "./support.ts";

/** Three conditions, so expressions have something to nest over. */
function listings() {
	return new BucketEngine()
		.defineInput<Product>()
		.defineCondition({
			name: "hasWeight",
			checkFn: (product) => product.weight !== null,
		})
		.defineCondition({
			name: "isDigital",
			checkFn: (product) => product.digital,
		})
		.defineCondition({
			name: "hasSku",
			checkFn: (product) => product.sku !== "",
		});
}

const PHYSICAL: Product = { sku: "a", weight: 1, digital: false };
const DIGITAL: Product = { sku: "b", weight: null, digital: true };
const BOTH: Product = { sku: "c", weight: 1, digital: true };
const NEITHER: Product = { sku: "", weight: null, digital: false };
const ALL = [PHYSICAL, DIGITAL, BOTH, NEITHER];

describe("expressions as data", () => {
	test("a bare name is lifted into a condition node", () => {
		assert.deepStrictEqual(toExpr("hasWeight"), {
			kind: "condition",
			name: "hasWeight",
		});
		const expr = NOT("hasWeight");
		assert.strictEqual(toExpr(expr), expr);
	});

	test("evaluate answers each combinator against a set of true conditions", () => {
		const truths = new Set(["hasWeight", "hasSku"]);

		assert.strictEqual(evaluate(toExpr("hasWeight"), truths), true);
		assert.strictEqual(evaluate(NOT("isDigital"), truths), true);
		assert.strictEqual(evaluate(AND("hasWeight", "hasSku"), truths), true);
		assert.strictEqual(evaluate(AND("hasWeight", "isDigital"), truths), false);
		assert.strictEqual(evaluate(OR("isDigital", "hasSku"), truths), true);
		assert.strictEqual(evaluate(ONLY("hasWeight", "hasSku"), truths), true);
		assert.strictEqual(evaluate(ONLY("hasWeight"), truths), false);
		assert.strictEqual(evaluate(ONLY(), new Set()), true);
	});

	test("referencedNames finds every condition an expression depends on", () => {
		const expr = OR(AND("hasWeight", NOT("isDigital")), ONLY("hasSku"));

		assert.deepStrictEqual([...referencedNames(expr)].sort(), [
			"hasSku",
			"hasWeight",
			"isDigital",
		]);
	});

	test("an expression can be hoisted, shared and negated", async () => {
		const incomplete = OR(NOT("hasWeight"), NOT("hasSku"));

		const report = await listings()
			.defineBucket({ name: "incomplete", checkFn: () => incomplete })
			.defineBucket({ name: "complete", checkFn: ({ NOT }) => NOT(incomplete) })
			.process(ALL);

		assert.deepStrictEqual(
			report.buckets.complete.map((product) => product.sku),
			["a", "c"],
		);
		assert.deepStrictEqual(
			report.buckets.incomplete.map((product) => product.sku),
			["b", ""],
		);
		assert.deepStrictEqual(report.unmatched, []);
	});
});

describe("rules over conditions", () => {
	test("OR of negations flags anything missing either field", async () => {
		const report = await listings()
			.defineBucket({
				name: "incomplete",
				checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), NOT("hasSku")),
			})
			.process(ALL);

		assert.deepStrictEqual(
			report.buckets.incomplete.map((product) => product.sku),
			["b", ""],
		);
	});

	test("nesting AND inside OR works to arbitrary depth", async () => {
		const report = await listings()
			.defineBucket({
				name: "sellable",
				checkFn: ({ AND, OR, NOT }) =>
					OR(AND("hasWeight", "hasSku"), AND("isDigital", NOT("hasWeight"))),
			})
			.process(ALL);

		assert.deepStrictEqual(
			report.buckets.sellable.map((product) => product.sku),
			["a", "b", "c"],
		);
	});

	test("rules deliberately overlap and every match counts", async () => {
		const report = await listings()
			.defineBucket({ name: "weighted", checkFn: () => "hasWeight" })
			.defineBucket({ name: "digital", checkFn: () => "isDigital" })
			.defineBucket({
				name: "both",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.process([BOTH]);

		assert.deepStrictEqual(report.buckets.weighted, [BOTH]);
		assert.deepStrictEqual(report.buckets.digital, [BOTH]);
		assert.deepStrictEqual(report.buckets.both, [BOTH]);
		assert.deepStrictEqual(report.unmatched, []);
	});

	test("ONLY and a bare name differ exactly where another condition is true", async () => {
		const report = await listings()
			.defineBucket({ name: "anyWeight", checkFn: () => "hasWeight" })
			.defineBucket({
				name: "weightOnly",
				checkFn: ({ ONLY }) => ONLY("hasWeight"),
			})
			.process([PHYSICAL, BOTH]);

		// PHYSICAL also has a sku, so nothing satisfies ONLY("hasWeight") here.
		assert.deepStrictEqual(
			report.buckets.anyWeight.map((product) => product.sku),
			["a", "c"],
		);
		assert.deepStrictEqual(report.buckets.weightOnly, []);
	});

	test("a contradictory rule is allowed — it just never matches", async () => {
		const report = await listings()
			.defineBucket({
				name: "impossible",
				checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("hasWeight")),
			})
			.process(ALL);

		assert.deepStrictEqual(report.buckets.impossible, []);
		assert.strictEqual(report.unmatched.length, ALL.length);
	});

	test("a rule matching everything leaves unmatched empty", async () => {
		const report = await listings()
			.defineBucket({
				name: "everything",
				checkFn: ({ OR, NOT }) => OR("hasWeight", NOT("hasWeight")),
			})
			.process(ALL);

		assert.strictEqual(report.buckets.everything.length, ALL.length);
		assert.deepStrictEqual(report.unmatched, []);
		assert.deepStrictEqual(
			listings()
				.defineBucket({
					name: "everything",
					checkFn: ({ OR, NOT }) => OR("hasWeight", NOT("hasWeight")),
				})
				.missingCombinations(),
			[],
		);
	});
});

describe("the named two-input operators", () => {
	/** The four rows of a two-variable truth table, in README order. */
	const ROWS = [
		{ a: true, b: true },
		{ a: true, b: false },
		{ a: false, b: true },
		{ a: false, b: false },
	];

	/** Every operator the README spells out, against its textbook column. */
	function pair() {
		return new BucketEngine()
			.defineInput<{ a: boolean; b: boolean }>()
			.defineCondition({ name: "condOne", checkFn: (item) => item.a })
			.defineCondition({ name: "condTwo", checkFn: (item) => item.b })
			.defineBucket({
				name: "and",
				checkFn: ({ AND }) => AND("condOne", "condTwo"),
			})
			.defineBucket({
				name: "or",
				checkFn: ({ OR }) => OR("condOne", "condTwo"),
			})
			.defineBucket({
				name: "xor",
				checkFn: ({ AND, OR, NOT }) =>
					AND(OR("condOne", "condTwo"), NOT(AND("condOne", "condTwo"))),
			})
			.defineBucket({
				name: "xorLongForm",
				checkFn: ({ AND, OR, NOT }) =>
					OR(AND("condOne", NOT("condTwo")), AND(NOT("condOne"), "condTwo")),
			})
			.defineBucket({
				name: "nand",
				checkFn: ({ AND, NOT }) => NOT(AND("condOne", "condTwo")),
			})
			.defineBucket({
				name: "nor",
				checkFn: ({ OR, NOT }) => NOT(OR("condOne", "condTwo")),
			})
			.defineBucket({
				name: "xnor",
				checkFn: ({ AND, OR, NOT }) =>
					OR(AND("condOne", "condTwo"), AND(NOT("condOne"), NOT("condTwo"))),
			})
			.defineBucket({
				name: "implies",
				checkFn: ({ OR, NOT }) => OR(NOT("condOne"), "condTwo"),
			})
			.defineBucket({ name: "onlyOne", checkFn: ({ ONLY }) => ONLY("condOne") })
			.defineBucket({ name: "onlyNone", checkFn: ({ ONLY }) => ONLY() });
	}

	/** One column of the table, top row first. */
	const COLUMNS = {
		and: [true, false, false, false],
		or: [true, true, true, false],
		xor: [false, true, true, false],
		xorLongForm: [false, true, true, false],
		nand: [false, true, true, true],
		nor: [false, false, false, true],
		xnor: [true, false, false, true],
		implies: [true, false, true, true],
		onlyOne: [false, true, false, false],
		onlyNone: [false, false, false, true],
	} as const;

	test("each one matches the column the README documents", async () => {
		const engine = pair();

		for (const [name, expected] of Object.entries(COLUMNS)) {
			const actual = await Promise.all(
				ROWS.map(async (row) =>
					(await engine.processOne(row)).buckets.includes(
						name as keyof typeof COLUMNS,
					),
				),
			);
			assert.deepStrictEqual(actual, expected, `${name} column`);
		}
	});

	test("NAND is not NOR — the mixed rows are the difference", async () => {
		const engine = pair();
		const mixed = await engine.processOne({ a: true, b: false });

		// NOT(AND(a, b)) is "not both", which the mixed rows satisfy.
		assert.ok(mixed.buckets.includes("nand"));
		// NOT(OR(a, b)) is "neither", which they do not.
		assert.ok(!mixed.buckets.includes("nor"));
	});

	test("ONLY is the column a third condition changes", async () => {
		// ONLY(A) coincides with AND(A, NOT(B)) while those are the only two
		// conditions. Add a third and ONLY narrows while AND stays put — which is
		// the whole reason conditions come before rules.
		const engine = new BucketEngine()
			.defineInput<{ a: boolean; b: boolean; c: boolean }>()
			.defineCondition({ name: "condOne", checkFn: (item) => item.a })
			.defineCondition({ name: "condTwo", checkFn: (item) => item.b })
			.defineCondition({ name: "condThree", checkFn: (item) => item.c })
			.defineBucket({ name: "onlyOne", checkFn: ({ ONLY }) => ONLY("condOne") })
			.defineBucket({
				name: "oneNotTwo",
				checkFn: ({ AND, NOT }) => AND("condOne", NOT("condTwo")),
			});

		const withThird = await engine.processOne({ a: true, b: false, c: true });
		assert.deepStrictEqual(withThird.buckets, ["oneNotTwo"]);

		const withoutThird = await engine.processOne({
			a: true,
			b: false,
			c: false,
		});
		assert.deepStrictEqual(withoutThird.buckets, ["onlyOne", "oneNotTwo"]);
	});
});
