import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine, BucketError } from "../main.ts";
import {
	type Equal,
	type Expect,
	PRODUCTS,
	type Product,
	productSchema,
} from "./support.ts";

/** The chain every test here starts from — two plain conditions, no buckets. */
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

describe("defineComputedCondition", () => {
	test("the name works as a condition in a bucket", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({ name: "listed", checkFn: () => "listedCorrectly" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.listed.map((product) => product.sku),
			["hybrid-1"],
		);
	});

	test("it is a full operand, not just a shorthand for a whole rule", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({
				name: "needsWork",
				checkFn: ({ NOT }) => NOT("listedCorrectly"),
			})
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.needsWork.map((product) => product.sku),
			["physical-1", "download-1", "vapour-1"],
		);
	});

	test("a bare condition name is a legal expression here too", async () => {
		const report = await products()
			.defineComputedCondition({ name: "alias", checkFn: () => "hasWeight" })
			.defineBucket({ name: "weighted", checkFn: () => "alias" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.weighted.map((product) => product.sku),
			["physical-1", "hybrid-1"],
		);
	});

	test("they layer: one may be built from another", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "shippable",
				checkFn: () => "hasWeight",
			})
			.defineComputedCondition({
				name: "dualFormat",
				checkFn: ({ AND }) => AND("shippable", "isDigital"),
			})
			.defineBucket({ name: "both", checkFn: () => "dualFormat" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.both.map((product) => product.sku),
			["hybrid-1"],
		);
	});

	test("its verdict shows up in the report's conditions", async () => {
		const assignment = await products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({ name: "listed", checkFn: () => "listedCorrectly" })
			.processOne({ sku: "hybrid-1", weight: 1, digital: true });

		assert.deepStrictEqual(assignment.conditions, {
			hasWeight: true,
			isDigital: true,
			listedCorrectly: true,
		});
	});

	test("an unmatched item reports it too", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({ name: "listed", checkFn: () => "listedCorrectly" })
			.process([{ sku: "vapour-1", weight: null, digital: false }]);

		assert.deepStrictEqual(report.unmatched[0]?.conditions, {
			hasWeight: false,
			isDigital: false,
			listedCorrectly: false,
		});
	});

	test("it costs no extra checkFn calls", async () => {
		let calls = 0;

		await new BucketEngine()
			.defineInput<Product>()
			.defineCondition({
				name: "hasWeight",
				checkFn: (product) => {
					calls += 1;
					return product.weight !== null;
				},
			})
			.defineComputedCondition({ name: "a", checkFn: () => "hasWeight" })
			.defineComputedCondition({ name: "b", checkFn: () => "a" })
			.defineBucket({ name: "weighted", checkFn: ({ AND }) => AND("a", "b") })
			.process(PRODUCTS);

		assert.strictEqual(calls, PRODUCTS.length);
	});

	test("both name lists are exposed separately, in definition order", () => {
		const engine = products()
			.defineComputedCondition({ name: "alias", checkFn: () => "hasWeight" })
			.defineComputedCondition({
				name: "other",
				checkFn: () => "isDigital",
			});

		assert.deepStrictEqual(engine.conditionNames, ["hasWeight", "isDigital"]);
		assert.deepStrictEqual(engine.computedConditionNames, ["alias", "other"]);
	});
});

describe("ONLY and computed conditions", () => {
	test("ONLY still counts the plain conditions only", async () => {
		const report = await products()
			// True for physical-1, which is exactly what ONLY("hasWeight") matches.
			// If ONLY counted it as another true condition, nothing would match.
			.defineComputedCondition({
				name: "physicalOnly",
				checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isDigital")),
			})
			.defineBucket({
				name: "weightOnly",
				checkFn: ({ ONLY }) => ONLY("hasWeight"),
			})
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.weightOnly.map((product) => product.sku),
			["physical-1"],
		);
	});

	test("ONLY() means no plain condition is true, whatever is derived", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "nothingKnown",
				checkFn: ({ AND, NOT }) => AND(NOT("hasWeight"), NOT("isDigital")),
			})
			.defineBucket({ name: "blank", checkFn: ({ ONLY }) => ONLY() })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.blank.map((product) => product.sku),
			["vapour-1"],
		);
	});

	test("ONLY inside a computed condition means the same thing", async () => {
		const report = await products()
			.defineComputedCondition({
				name: "purelyPhysical",
				checkFn: ({ ONLY }) => ONLY("hasWeight"),
			})
			.defineBucket({ name: "warehouse", checkFn: () => "purelyPhysical" })
			.process(PRODUCTS);

		assert.deepStrictEqual(
			report.buckets.warehouse.map((product) => product.sku),
			["physical-1"],
		);
	});

	test("ONLY refuses a computed name", () => {
		const engine = products().defineComputedCondition({
			name: "listedCorrectly",
			checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
		});

		assert.throws(
			() => {
				engine.defineBucket({
					name: "strict",
					// @ts-expect-error ONLY takes plain condition names only.
					checkFn: ({ ONLY }) => ONLY("listedCorrectly"),
				});
			},
			(error: unknown) =>
				error instanceof BucketError &&
				error.message.includes('computed condition "listedCorrectly"'),
		);
	});

	test("it refuses one nested anywhere in the expression", () => {
		const engine = products().defineComputedCondition({
			name: "listedCorrectly",
			checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
		});

		assert.throws(() => {
			engine.defineBucket({
				name: "strict",
				checkFn: ({ OR, NOT, ONLY }) =>
					// @ts-expect-error nested operands are checked at any depth.
					OR("hasWeight", NOT(ONLY("listedCorrectly"))),
			});
		}, BucketError);
	});
});

describe("missingCombinations with computed conditions", () => {
	test("a computed rule covers the combinations it satisfies", () => {
		const engine = products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ OR }) => OR("hasWeight", "isDigital"),
			})
			.defineBucket({ name: "listed", checkFn: () => "listedCorrectly" });

		// Only the all-false combination is left over.
		assert.deepStrictEqual(engine.missingCombinations(), [[]]);
	});

	test("it reports the plain conditions, not the derived ones", () => {
		const engine = products()
			.defineComputedCondition({
				name: "listedCorrectly",
				checkFn: ({ AND }) => AND("hasWeight", "isDigital"),
			})
			.defineBucket({ name: "listed", checkFn: () => "listedCorrectly" });

		assert.deepStrictEqual(engine.missingCombinations(), [
			[],
			["hasWeight"],
			["isDigital"],
		]);
	});
});

describe("rejected computed conditions", () => {
	test("a plain condition cannot follow a computed one", () => {
		const engine = products().defineComputedCondition({
			name: "alias",
			checkFn: () => "hasWeight",
		});

		assert.throws(() => {
			// @ts-expect-error a computed condition is built from what already exists.
			engine.defineCondition({ name: "isFragile", checkFn: () => true });
		}, BucketError);
	});

	test("a computed condition cannot follow a bucket", () => {
		const engine = products().defineBucket({
			name: "weighted",
			checkFn: () => "hasWeight",
		});
		const tooLate = { name: "alias", checkFn: () => "hasWeight" } as const;

		assert.throws(() => {
			// @ts-expect-error ONLY() depends on the complete set of conditions.
			engine.defineComputedCondition(tooLate);
		}, BucketError);
	});

	test("it cannot reuse a plain condition's name", () => {
		const engine = products();
		const duplicate = {
			name: "hasWeight",
			checkFn: () => "isDigital",
		} as const;

		assert.throws(() => {
			// @ts-expect-error "hasWeight" is already a condition.
			engine.defineComputedCondition(duplicate);
		}, BucketError);
	});

	test("it cannot reuse another computed condition's name", () => {
		const engine = products().defineComputedCondition({
			name: "alias",
			checkFn: () => "hasWeight",
		});
		const duplicate = { name: "alias", checkFn: () => "isDigital" } as const;

		assert.throws(() => {
			// @ts-expect-error "alias" is already a computed condition.
			engine.defineComputedCondition(duplicate);
		}, BucketError);
	});

	test("a plain condition cannot reuse a computed one's name either", () => {
		const engine = products().defineComputedCondition({
			name: "alias",
			checkFn: () => "hasWeight",
		});

		assert.throws(() => {
			// @ts-expect-error the two share one namespace.
			engine.defineCondition({ name: "alias", checkFn: () => true });
		}, BucketError);
	});

	test("it cannot reference a condition that does not exist", () => {
		const engine = products();

		assert.throws(
			() => {
				engine.defineComputedCondition({
					name: "typo",
					// @ts-expect-error "hasWieght" was never defined.
					checkFn: ({ NOT }) => NOT("hasWieght"),
				});
			},
			(error: unknown) =>
				error instanceof BucketError &&
				error.message.startsWith('Computed condition "typo"'),
		);
	});

	test("it cannot reference itself", () => {
		const engine = products();

		assert.throws(() => {
			// @ts-expect-error a name is only in scope after it is defined.
			engine.defineComputedCondition({ name: "loop", checkFn: () => "loop" });
		}, BucketError);
	});

	test("it needs a name and a checkFn", () => {
		assert.throws(
			() =>
				products().defineComputedCondition({
					name: "",
					checkFn: () => "hasWeight",
				}),
			BucketError,
		);

		assert.throws(
			// @ts-expect-error checkFn is required.
			() => products().defineComputedCondition({ name: "alias" }),
			BucketError,
		);
	});
});

describe("computed conditions and narrowing", () => {
	function sorter() {
		return new BucketEngine()
			.defineInput<unknown>()
			.defineCondition({
				name: "isString",
				checkFn: (value): value is string => typeof value === "string",
			})
			.defineCondition({
				name: "isLong",
				checkFn: (value) => String(value).length > 3,
			});
	}

	test("a computed condition carries what its expression proved", async () => {
		const report = await sorter()
			.defineComputedCondition({
				name: "isLongString",
				checkFn: ({ AND }) => AND("isString", "isLong"),
			})
			.defineBucket({ name: "verbose", checkFn: () => "isLongString" })
			.process(["hello", "hi", 12345]);

		type _Items = Expect<Equal<(typeof report.buckets)["verbose"], string[]>>;

		assert.deepStrictEqual(report.buckets.verbose, ["hello"]);
		assert.deepStrictEqual(
			report.buckets.verbose.map((value) => value.toUpperCase()),
			["HELLO"],
		);
	});

	test("narrowing survives a layer of naming", async () => {
		const report = await sorter()
			.defineComputedCondition({ name: "stringy", checkFn: () => "isString" })
			.defineComputedCondition({
				name: "reallyStringy",
				checkFn: () => "stringy",
			})
			.defineBucket({ name: "strings", checkFn: () => "reallyStringy" })
			.process(["hello", 1]);

		type _Items = Expect<Equal<(typeof report.buckets)["strings"], string[]>>;

		assert.deepStrictEqual(report.buckets.strings, ["hello"]);
	});

	test("a computed condition that proves nothing keeps the input type", async () => {
		const report = await sorter()
			.defineComputedCondition({
				name: "notAString",
				checkFn: ({ NOT }) => NOT("isString"),
			})
			.defineBucket({ name: "others", checkFn: () => "notAString" })
			.process(["hello", 1]);

		type _Items = Expect<Equal<(typeof report.buckets)["others"], unknown[]>>;

		assert.deepStrictEqual(report.buckets.others, [1]);
	});
});
