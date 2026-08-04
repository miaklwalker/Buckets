import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine, BucketError } from "../main.ts";
import type {
	BucketsOf,
	ConditionsOf,
	Equal,
	Expect,
	InputOf,
	Product,
} from "./support.ts";

/** The fully configured engine most assertions below are made against. */
function configured() {
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
		.defineBucket({ name: "shippable", checkFn: () => "hasWeight" })
		.defineBucket({
			name: "download",
			checkFn: ({ AND, NOT }) => AND("isDigital", NOT("hasWeight")),
		});
}

describe("inference", () => {
	test("defineInput infers the item type", () => {
		const engine = configured();
		type _Input = Expect<Equal<InputOf<typeof engine>, Product>>;

		assert.deepStrictEqual(engine.conditionNames, ["hasWeight", "isDigital"]);
	});

	test("each condition widens the union of known names", () => {
		const engine = configured();
		type _Conditions = Expect<
			Equal<ConditionsOf<typeof engine>, "hasWeight" | "isDigital">
		>;

		assert.deepStrictEqual(engine.conditionNames, ["hasWeight", "isDigital"]);
	});

	test("each bucket widens the union of bucket names", () => {
		const engine = configured();
		type _Buckets = Expect<
			Equal<BucketsOf<typeof engine>, "shippable" | "download">
		>;

		assert.deepStrictEqual(engine.bucketNames, ["shippable", "download"]);
	});

	test("clone hands back the same type it was called on", () => {
		const engine = configured();
		const copy = engine.clone();

		type _Same = Expect<Equal<typeof copy, typeof engine>>;

		// So a branch keeps completing the same names, and adding to one of them
		// widens only that one.
		const branched = copy.defineBucket({
			name: "everything",
			checkFn: ({ OR }) => OR("hasWeight", "isDigital"),
		});
		type _Branched = Expect<
			Equal<BucketsOf<typeof branched>, "shippable" | "download" | "everything">
		>;
		type _Untouched = Expect<
			Equal<BucketsOf<typeof engine>, "shippable" | "download">
		>;

		assert.deepStrictEqual(engine.bucketNames, ["shippable", "download"]);
	});

	test("the report is keyed by the bucket names and holds the item type", async () => {
		const report = await configured().process([]);

		type Keys = keyof typeof report.buckets;
		type _Keys = Expect<Equal<Keys, "shippable" | "download">>;
		type _Items = Expect<
			Equal<(typeof report.buckets)["shippable"], Product[]>
		>;
		type _Unmatched = Expect<
			Equal<(typeof report.unmatched)[number]["item"], Product>
		>;

		assert.deepStrictEqual(Object.keys(report.buckets), [
			"shippable",
			"download",
		]);
	});

	test("an assignment lists bucket names, not one name", async () => {
		const assignment = await configured().processOne({
			sku: "a",
			weight: 1,
			digital: false,
		});

		type _Buckets = Expect<
			Equal<typeof assignment.buckets, ("shippable" | "download")[]>
		>;
		type _Report = Expect<
			Equal<
				typeof assignment.conditions,
				Readonly<Record<"hasWeight" | "isDigital", boolean>>
			>
		>;

		assert.deepStrictEqual(assignment.buckets, ["shippable"]);
	});

	test("an unconfigured engine accepts nothing but an empty batch", async () => {
		const engine = new BucketEngine();
		type Items = Parameters<typeof engine.process>[0];
		type _Items = Expect<Equal<Items, readonly never[]>>;

		await assert.rejects(() => engine.process([]), BucketError);
	});
});

describe("rejected at compile time", () => {
	test("the checkFn combinators only accept this engine's condition names", () => {
		const engine = configured();

		assert.throws(() => {
			engine.defineBucket({
				name: "typo",
				// @ts-expect-error "hasWieght" was never defined.
				checkFn: ({ NOT }) => NOT("hasWieght"),
			});
		}, BucketError);
	});

	test("a bare returned name is checked just as strictly", () => {
		const engine = configured();

		assert.throws(() => {
			// @ts-expect-error "nope" is not a condition.
			engine.defineBucket({ name: "typo", checkFn: () => "nope" });
		}, BucketError);
	});

	test("every combinator checks the names it is given", () => {
		const engine = configured();

		assert.throws(() => {
			engine.defineBucket({
				name: "typo",
				// @ts-expect-error ONLY takes condition names too.
				checkFn: ({ ONLY }) => ONLY("hasWeight", "nope"),
			});
		}, BucketError);

		assert.throws(() => {
			engine.defineBucket({
				name: "typo2",
				// @ts-expect-error nested operands are checked at any depth.
				checkFn: ({ AND, OR }) => OR("hasWeight", AND("isDigital", "nope")),
			});
		}, BucketError);
	});

	test("a bucket name cannot be reused", () => {
		const engine = configured();

		assert.throws(() => {
			// @ts-expect-error "shippable" is already a bucket.
			engine.defineBucket({ name: "shippable", checkFn: () => "hasWeight" });
		}, BucketError);
	});

	test("a condition name cannot be reused", () => {
		const engine = new BucketEngine()
			.defineInput<Product>()
			.defineCondition({ name: "hasWeight", checkFn: () => true });

		assert.throws(() => {
			// @ts-expect-error "hasWeight" is already a condition.
			engine.defineCondition({ name: "hasWeight", checkFn: () => true });
		}, BucketError);
	});

	test("no condition may be added once a bucket exists", () => {
		const engine = configured();

		assert.throws(() => {
			// @ts-expect-error ONLY() depends on the complete set of conditions.
			engine.defineCondition({ name: "isFragile", checkFn: () => true });
		}, BucketError);
	});

	test("a condition checkFn sees the item type from defineInput", () => {
		new BucketEngine().defineInput<Product>().defineCondition({
			name: "heavy",
			// @ts-expect-error `wieght` is not a property of Product.
			checkFn: (product) => product.wieght !== null,
		});
	});

	test("process only accepts the declared item type", async () => {
		const engine = configured();

		// @ts-expect-error a string is not a Product.
		await engine.process(["not a product"]);
	});

	test("overlapping rules are no longer a type error", () => {
		// The old exclusivity constraint is gone: two buckets may match the same
		// item, and neither the compiler nor the runtime objects.
		const engine = configured()
			.defineBucket({ name: "alsoShippable", checkFn: () => "hasWeight" })
			.defineBucket({ name: "everythingDigital", checkFn: () => "isDigital" });

		assert.deepStrictEqual(engine.bucketNames, [
			"shippable",
			"download",
			"alsoShippable",
			"everythingDigital",
		]);
	});
});
