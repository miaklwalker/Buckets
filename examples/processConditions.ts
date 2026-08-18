/**
 * Trying out a set of conditions before there's a bucket to sort by.
 *
 * `processConditions()` is `process()` without the bucket requirement: it
 * runs every condition over a batch and hands back a pass/fail tally per
 * condition, which `formatConditionReport` renders into a table. `group`
 * (given to `defineCondition`) is what lets the report cluster related
 * conditions — here, "what does this listing have" versus "is what it has
 * actually valid".
 *
 * Run with:
 *   node --experimental-transform-types examples/processConditions.ts
 */
import { BucketEngine } from "../main.ts";
import { formatConditionReport } from "../modules/report.ts";

interface Listing {
	readonly sku: string;
	readonly product: { readonly weightKg: number } | null;
	readonly brand: string | null;
}

function listing(
	sku: string,
	weightKg: number | null,
	brand: string | null,
): Listing {
	return { sku, product: weightKg === null ? null : { weightKg }, brand };
}

const LISTINGS: Listing[] = [
	listing("mug-01", 0.4, "acme"),
	listing("mug-02", -1, "acme"), // has a product, but the weight is nonsense
	listing("ebook-01", null, "acme"),
	listing("giftcard-01", null, null),
];

const checks = new BucketEngine()
	.defineInput<Listing>()
	.defineCondition({
		name: "hasProduct",
		group: "existence check",
		checkFn: (item): item is Listing & { product: { weightKg: number } } =>
			item.product !== null,
	})
	.defineCondition({
		name: "hasBrand",
		group: "existence check",
		checkFn: (item) => item.brand !== null,
	})
	.defineCondition({
		name: "hasPositiveWeight",
		group: "validity check",
		// Gated on hasProduct, so item.product is narrowed here — no `?.`.
		when: () => "hasProduct",
		checkFn: (item) => item.product.weightKg > 0,
	});

const report = await checks.processConditions(LISTINGS);

console.log(formatConditionReport(report));

// Every failure, condition by condition — useful once the table above has
// told you which condition is worth digging into.
for (const entry of report.results) {
	const failed = Object.entries(entry.conditions)
		.filter(([, passed]) => !passed)
		.map(([name]) => name);
	if (failed.length > 0) {
		console.log(`${entry.item.sku}: failed ${failed.join(", ")}`);
	}
}
