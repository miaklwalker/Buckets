/**
 * Watching the pass/fail bars fill in live as a batch runs, instead of only
 * seeing the table once everything has finished.
 *
 * `processConditions()`'s `onProgress` fires once per item as it completes;
 * `liveConditionReport()` turns that into a redraw loop, using ANSI
 * cursor-movement escapes to overwrite the previous frame in place — the
 * same trick a build tool's progress line uses. Piped to a file instead of a
 * terminal, it falls back to printing one frame per redraw rather than
 * corrupting the output with escape codes a file can't interpret.
 *
 * The condition below sleeps a random handful of milliseconds so the fill-in
 * is visible instead of instantaneous — a stand-in for a real check that
 * hits a database or an API.
 *
 * Run with:
 *   node --experimental-transform-types examples/liveConditionReport.ts
 */
import { BucketEngine } from "../main.ts";
import { liveConditionReport } from "../modules/report.ts";

interface Row {
	readonly id: number;
}

const ROWS: Row[] = Array.from({ length: 500 }, (_, id) => ({ id }));

async function slowCheck(passRate: number): Promise<boolean> {
	await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
	return Math.random() < passRate;
}

const checks = new BucketEngine()
	.defineInput<Row>()
	.defineCondition({
		name: "recordExists",
		group: "existence check",
		checkFn: () => slowCheck(0.9),
	})
	.defineCondition({
		name: "recordIsValid",
		group: "validity check",
		when: () => "recordExists",
		checkFn: () => slowCheck(0.7),
	});

const report = await checks.processConditions(ROWS, {
	concurrency: 32,
	onProgress: liveConditionReport(),
});

console.log(
	`\ndone: ${report.results.length} processed, ${report.errors.length} errors`,
);
