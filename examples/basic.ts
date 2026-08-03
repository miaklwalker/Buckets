/**
 * Sorting a product catalogue into fulfilment lanes.
 *
 * Conditions answer questions about one product; buckets are boolean rules over
 * those answers. Rules are independent, so a vinyl record with a download code
 * is in both "warehouse" and "digitalDelivery" — it genuinely needs both, and
 * nothing had to be enumerated to say so.
 *
 * Run with:
 *   node --experimental-transform-types examples/basic.ts
 */
import { BucketEngine } from "../main.ts";

interface Product {
	readonly sku: string;
	readonly weightKg: number | null;
	readonly downloadUrl: string | null;
}

const CATALOGUE: Product[] = [
	{ sku: "mug-01", weightKg: 0.4, downloadUrl: null },
	{ sku: "ebook-01", weightKg: null, downloadUrl: "https://cdn/ebook-01" },
	{ sku: "vinyl-01", weightKg: 0.3, downloadUrl: "https://cdn/vinyl-01" },
	{ sku: "giftcard-01", weightKg: null, downloadUrl: null },
];

const fulfilment = new BucketEngine()
	// No schema here, just the type. See triage.ts for the Standard Schema form.
	.defineInput<Product>()
	.defineCondition({
		name: "hasWeight",
		checkFn: (product) => product.weightKg !== null,
	})
	.defineCondition({
		name: "isDownloadable",
		checkFn: (product) => product.downloadUrl !== null,
	})
	// Returning a bare condition name is the whole rule: anything with a weight,
	// whatever else is true of it.
	.defineBucket({ name: "warehouse", checkFn: () => "hasWeight" })
	.defineBucket({ name: "digitalDelivery", checkFn: () => "isDownloadable" })
	// ONLY is the strict form — a weight and nothing else.
	.defineBucket({
		name: "purelyPhysical",
		checkFn: ({ ONLY }) => ONLY("hasWeight"),
	});

const report = await fulfilment.process(CATALOGUE);

for (const [bucket, products] of Object.entries(report.buckets)) {
	console.log(`${bucket}: ${products.map((p) => p.sku).join(", ") || "—"}`);
}

// giftcard-01 is neither, so no rule claims it.
console.log(
	"unmatched:",
	report.unmatched.map((entry) => entry.item.sku),
);
// The combinations no rule covers — exactly what ends up unmatched.
console.log("uncovered:", fulfilment.missingCombinations());

// A single item, for the request-handler case.
const one = await fulfilment.processOne({
	sku: "poster-01",
	weightKg: 0.1,
	downloadUrl: null,
});
console.log(`poster-01 -> [${one.buckets.join(", ")}]`, one.conditions);
