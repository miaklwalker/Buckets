import assert from "node:assert";
import test, { describe } from "node:test";
import {
	BucketEngine,
	type ConditionBatchReport,
	type ConditionProgress,
	formatConditionReport,
	liveConditionReport,
	printConditionReport,
} from "../main.ts";
import { PRODUCTS, productSchema } from "./support.ts";

/** A stand-in for `process.stdout` that records every chunk written to it. */
function fakeStream(isTTY: boolean) {
	const writes: string[] = [];
	return {
		writes,
		isTTY,
		write(chunk: string) {
			writes.push(chunk);
			return true;
		},
	};
}

/** A fresh, unrun engine with the same conditions `report()` resolves from. */
function engine() {
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
		});
}

async function report(): Promise<
	ConditionBatchReport<unknown, "hasWeight" | "isDigital" | "isCheap">
> {
	return engine().processConditions(PRODUCTS) as Promise<
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

describe("liveConditionReport", () => {
	test("on a TTY, redraws in place with cursor-movement escapes", async () => {
		const out = fakeStream(true);
		await engine().processConditions(PRODUCTS, {
			onProgress: liveConditionReport({ stream: out, minIntervalMs: 0 }),
		});

		// One redraw per item, and every redraw after the first moves the
		// cursor back up before writing the next frame.
		assert.strictEqual(out.writes.length, PRODUCTS.length * 2 - 1);
		assert.ok(out.writes[0]?.startsWith("Processed 1 / 4"));
		// "\x1b[<N>A\x1b[0J" — cursor up N lines, then clear to end of screen.
		const eraseChunk = out.writes[1] ?? "";
		assert.ok(eraseChunk.startsWith("\x1b["));
		assert.ok(eraseChunk.endsWith("A\x1b[0J"));
	});

	test("on a non-TTY, prints one frame per redraw instead of overwriting", async () => {
		const out = fakeStream(false);
		await engine().processConditions(PRODUCTS, {
			onProgress: liveConditionReport({ stream: out, minIntervalMs: 0 }),
		});

		assert.strictEqual(out.writes.length, PRODUCTS.length);
		assert.ok(out.writes.every((chunk) => !chunk.includes("\x1b[")));
	});

	test("the last frame always matches processConditions()'s own summary", async () => {
		const out = fakeStream(false);
		const result = await engine().processConditions(PRODUCTS, {
			onProgress: liveConditionReport({ stream: out, minIntervalMs: 0 }),
		});

		const lastFrame = out.writes[out.writes.length - 1] ?? "";
		assert.strictEqual(
			lastFrame.trim(),
			`Processed 4 / 4\n${formatConditionReport(result)}`,
		);
	});

	test("throttles mid-batch redraws, but always draws the final frame", async () => {
		const out = fakeStream(true);
		const total = 50;
		let completed = 0;
		const draw = liveConditionReport<"always">({
			stream: out,
			minIntervalMs: 10_000, // effectively "never" mid-batch
		});
		for (let i = 0; i < total; i++) {
			completed += 1;
			draw({
				completed,
				total,
				summary: [
					{ name: "always", group: undefined, passing: completed, failing: 0 },
				],
			} satisfies ConditionProgress<"always">);
		}

		// The very first call always draws (nothing to throttle against yet, so
		// just the frame — no prior frame to erase), and the final call
		// (completed === total) always draws regardless of the throttle (frame
		// plus the erase-before-redraw); everything in between is suppressed.
		assert.strictEqual(out.writes.length, 3);
		assert.ok(out.writes[out.writes.length - 1]?.includes("Processed 50 / 50"));
	});

	test("two concurrent live reports don't share redraw state", async () => {
		const outA = fakeStream(true);
		const outB = fakeStream(true);
		await Promise.all([
			engine().processConditions(PRODUCTS, {
				onProgress: liveConditionReport({ stream: outA, minIntervalMs: 0 }),
			}),
			engine().processConditions(PRODUCTS, {
				onProgress: liveConditionReport({ stream: outB, minIntervalMs: 0 }),
			}),
		]);

		assert.strictEqual(outA.writes.length, PRODUCTS.length * 2 - 1);
		assert.strictEqual(outB.writes.length, PRODUCTS.length * 2 - 1);
	});
});
