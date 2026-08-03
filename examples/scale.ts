/**
 * Throughput on a synthetic batch, so you can see what a large run costs.
 *
 * Change ROW_COUNT and re-run. The interesting number is not the total time so
 * much as how it scales: conditions are evaluated once per item and each rule
 * is then a walk over a small expression tree, so the work is linear in
 * (rows x conditions) + (rows x rules), with nothing exponential in it.
 *
 * Run with:
 *   node --experimental-transform-types examples/scale.ts
 */
import { BucketEngine } from "../main.ts";

const startMemory = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;

/** How many rows to generate. */
const ROW_COUNT = 1_000_000;

/**
 * Items evaluated at once. `undefined` uses the default of 256. Try `Infinity`
 * at 500,000 rows to see why that isn't the default — see the note at the
 * bottom.
 */
const CONCURRENCY: number | undefined = undefined;

interface Listing {
	readonly id: number;
	readonly weightKg: number | null;
	readonly photos: number;
	readonly price: number | null;
	readonly digital: boolean;
	readonly flagged: boolean;
}

/**
 * A seeded generator rather than Math.random, so two runs at the same
 * ROW_COUNT produce identical counts and you can compare timings honestly.
 */
function makeRows(count: number): Listing[] {
	let seed = 0x2f6e2b1;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};

	return Array.from({ length: count }, (_, id) => ({
		id,
		weightKg: next() < 0.7 ? Number((next() * 10).toFixed(2)) : null,
		photos: next() < 0.8 ? Math.floor(next() * 8) : 0,
		price: next() < 0.75 ? Math.floor(next() * 500) : null,
		digital: next() < 0.3,
		flagged: next() < 0.05,
	}));
}

const engine = new BucketEngine()
	.defineInput<Listing>()
	.defineCondition({ name: "hasWeight", checkFn: (l) => l.weightKg !== null })
	.defineCondition({ name: "hasPhotos", checkFn: (l) => l.photos > 0 })
	.defineCondition({ name: "hasPrice", checkFn: (l) => l.price !== null })
	.defineCondition({ name: "isDigital", checkFn: (l) => l.digital })
	.defineCondition({ name: "isFlagged", checkFn: (l) => l.flagged })
	.defineBucket({
		name: "shippable",
		checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isDigital")),
	})
	.defineBucket({
		name: "downloadable",
		checkFn: ({ AND }) => AND("isDigital", "hasPrice"),
	})
	.defineBucket({
		name: "sellable",
		checkFn: ({ AND }) => AND("hasPhotos", "hasPrice"),
	})
	.defineBucket({
		name: "needsWork",
		checkFn: ({ OR, NOT }) => OR(NOT("hasPhotos"), NOT("hasPrice")),
	})
	.defineBucket({ name: "review", checkFn: () => "isFlagged" })
	.defineBucket({
		name: "pristine",
		checkFn: ({ ONLY }) => ONLY("hasWeight", "hasPhotos", "hasPrice"),
	});

const engineMemory = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;

const rows = makeRows(ROW_COUNT);
const rowMemory = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;
const startedAt = performance.now();
const report = await engine.process(rows, { concurrency: CONCURRENCY });
const elapsedMs = performance.now() - startedAt;
const processedMemory = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;
const placements = Object.values(report.buckets).flat().length;
console.table({
	startMemory,
	engineMemory,
	rowMemory,
	processedMemory,
});
console.log(
	`${ROW_COUNT.toLocaleString()} rows, ${engine.conditionNames.length} conditions, ${engine.bucketNames.length} rules`,
);
console.log(
	`${elapsedMs.toFixed(0)} ms — ${Math.round(ROW_COUNT / (elapsedMs / 1000)).toLocaleString()} rows/sec`,
);
console.log("");

for (const [bucket, listings] of Object.entries(report.buckets)) {
	const share = ((listings.length / ROW_COUNT) * 100).toFixed(1);
	console.log(
		`  ${bucket.padEnd(14)} ${listings.length.toLocaleString().padStart(9)}  ${share.padStart(5)}%`,
	);
}

console.log("");
console.log(
	`  ${"unmatched".padEnd(14)} ${report.unmatched.length.toLocaleString().padStart(9)}`,
);
console.log(
	`  ${"errors".padEnd(14)} ${report.errors.length.toLocaleString().padStart(9)}`,
);
console.log("");
console.log(
	`${placements.toLocaleString()} placements across ${ROW_COUNT.toLocaleString()} rows — rules overlap, and a row is stored by reference in each bucket it matched, not copied.`,
);
console.log(
	`combinations no rule covers: ${JSON.stringify(engine.missingCombinations())}`,
);
