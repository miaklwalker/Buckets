import assert from "node:assert";
import test, { describe } from "node:test";
import {
	BucketEngine,
	type ConditionBatchReport,
	formatConditionReport,
	printConditionReport,
} from "../main.ts";
import { PRODUCTS, productSchema } from "./support.ts";

async function report(): Promise<
	ConditionBatchReport<unknown, "hasWeight" | "isDigital" | "isCheap">
> {
	return new BucketEngine()
		.defineInput(productSchema)
		.defineCondition({
			name: "hasWeight",
			group: "existence check",
			checkFn: (product) => product.weight !== null,
		})
		.defineCondition({
			name: "isDigital",
			checkFn: (product) => product.digital,
		})
		.defineCondition({
			name: "isCheap",
			group: "validity check",
			checkFn: () => true,
		})
		.processConditions(PRODUCTS) as Promise<
		ConditionBatchReport<unknown, "hasWeight" | "isDigital" | "isCheap">
	>;
}

describe("formatConditionReport", () => {
	test("one row per condition, with the header and box-drawing border", async () => {
		const table = formatConditionReport(await report());
		const lines = table.split("\n");

		assert.match(lines[0] ?? "", /^┌.*┐$/);
		assert.match(lines[lines.length - 1] ?? "", /^└.*┘$/);
		assert.match(
			lines[1] ?? "",
			/Group.*Condition.*Passing.*Failing.*Distribution/,
		);
		// top border + header + separator + 3 conditions + bottom border
		assert.strictEqual(lines.length, 7);
	});

	test("rows sort by group, in first-seen order; ungrouped conditions sort last", async () => {
		const table = formatConditionReport(await report());
		const order = table
			.split("\n")
			.slice(3, -1)
			.map((line) => line.split("│")[2]?.trim());

		assert.deepStrictEqual(order, ["hasWeight", "isCheap", "isDigital"]);
	});

	test("an ungrouped condition prints an em dash for its group", async () => {
		const table = formatConditionReport(await report());
		const isDigitalRow = table
			.split("\n")
			.find((line) => line.includes("isDigital"));
		assert.match(isDigitalRow ?? "", /│ — /);
	});

	test("the bar is proportional to passing / (passing + failing)", async () => {
		const table = formatConditionReport(await report(), { barWidth: 10 });
		const isCheapRow = table
			.split("\n")
			.find((line) => line.includes("isCheap"));
		// isCheap always passes, so its bar is fully filled.
		assert.match(isCheapRow ?? "", /██████████/);

		const isDigitalRow = table
			.split("\n")
			.find((line) => line.includes("isDigital"));
		// 2 of 4 products are digital — half filled, half empty.
		assert.match(isDigitalRow ?? "", /█████░░░░░/);
	});

	test("an all-failing condition renders an empty bar", async () => {
		const empty: ConditionBatchReport<unknown, "neverTrue"> = {
			results: [],
			errors: [],
			summary: [
				{ name: "neverTrue", group: undefined, passing: 0, failing: 5 },
			],
		};
		const table = formatConditionReport(empty, { barWidth: 8 });
		const row = table.split("\n").find((line) => line.includes("neverTrue"));
		assert.match(row ?? "", /░░░░░░░░/);
	});

	test("a condition with no verdicts at all renders an empty bar, not a crash", async () => {
		const empty: ConditionBatchReport<unknown, "untouched"> = {
			results: [],
			errors: [],
			summary: [
				{ name: "untouched", group: undefined, passing: 0, failing: 0 },
			],
		};
		const table = formatConditionReport(empty, { barWidth: 4 });
		const row = table.split("\n").find((line) => line.includes("untouched"));
		assert.match(row ?? "", /░░░░/);
	});

	test("rejects a barWidth that isn't a positive integer", async () => {
		const data = await report();
		assert.throws(
			() => formatConditionReport(data, { barWidth: 0 }),
			RangeError,
		);
		assert.throws(
			() => formatConditionReport(data, { barWidth: 2.5 }),
			RangeError,
		);
	});
});

describe("printConditionReport", () => {
	test("writes the formatted table to console.log", async () => {
		const data = await report();
		const calls: string[] = [];
		const original = console.log;
		console.log = (message: string) => {
			calls.push(message);
		};
		try {
			printConditionReport(data);
		} finally {
			console.log = original;
		}
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0], formatConditionReport(data));
	});
});
