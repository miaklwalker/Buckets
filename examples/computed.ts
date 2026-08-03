/**
 * Naming a combination of conditions, so the rules read like the sentences you
 * use to talk about them.
 *
 * "Listed correctly" is not a fact you check against a product — it's the three
 * facts you already check, taken together. `defineComputedCondition` gives that
 * combination a name once, and the name is then a condition everywhere after:
 * in other computed conditions, in buckets, and in the report.
 *
 * Run with:
 *   node --experimental-transform-types examples/computed.ts
 */
import { BucketEngine } from "../main.ts";

interface Listing {
	readonly sku: string;
	readonly priceCents: number | null;
	readonly weightKg: number | null;
	readonly category: string | null;
	readonly stock: number;
}

const LISTINGS: Listing[] = [
	{
		sku: "mug-01",
		priceCents: 1200,
		weightKg: 0.4,
		category: "kitchen",
		stock: 8,
	},
	{
		sku: "mug-02",
		priceCents: 1200,
		weightKg: 0.4,
		category: "kitchen",
		stock: 0,
	},
	{
		sku: "lamp-01",
		priceCents: 4500,
		weightKg: null,
		category: "home",
		stock: 3,
	},
	{
		sku: "draft-01",
		priceCents: null,
		weightKg: null,
		category: null,
		stock: 0,
	},
];

const catalogue = new BucketEngine()
	.defineInput<Listing>()
	// The facts. Small, boring, checked once per item.
	.defineCondition({
		name: "hasPrice",
		checkFn: (listing) => listing.priceCents !== null,
	})
	.defineCondition({
		name: "hasWeight",
		checkFn: (listing) => listing.weightKg !== null,
	})
	.defineCondition({
		name: "hasCategory",
		checkFn: (listing) => listing.category !== null,
	})
	.defineCondition({ name: "inStock", checkFn: (listing) => listing.stock > 0 })
	// The vocabulary. Same combinators a bucket gets, no per-item cost — these
	// read verdicts that have already been collected.
	.defineComputedCondition({
		name: "listedCorrectly",
		checkFn: ({ AND }) => AND("hasPrice", "hasWeight", "hasCategory"),
	})
	// Computed conditions layer, so this one is built from the last.
	.defineComputedCondition({
		name: "sellable",
		checkFn: ({ AND }) => AND("listedCorrectly", "inStock"),
	})
	.defineComputedCondition({
		name: "started",
		checkFn: ({ OR }) => OR("hasPrice", "hasWeight", "hasCategory"),
	})
	// The rules, now written in those terms.
	.defineBucket({ name: "sellable", checkFn: () => "sellable" })
	.defineBucket({
		name: "backorder",
		checkFn: ({ AND, NOT }) => AND("listedCorrectly", NOT("inStock")),
	})
	.defineBucket({
		name: "needsWork",
		checkFn: ({ AND, NOT }) => AND("started", NOT("listedCorrectly")),
	})
	// ONLY still counts the plain conditions only — a computed condition restates
	// them rather than adding another. So this is "nothing filled in at all".
	.defineBucket({ name: "untouched", checkFn: ({ ONLY }) => ONLY() });

const report = await catalogue.process(LISTINGS);

for (const [bucket, listings] of Object.entries(report.buckets)) {
	console.log(`${bucket}: ${listings.map((l) => l.sku).join(", ") || "—"}`);
}

// The report carries the computed verdicts too, which is the point: "why is this
// unmatched" is easier to read in the terms you named than in raw predicates.
const one = await catalogue.processOne(LISTINGS[2] as Listing);
console.log(`lamp-01 -> [${one.buckets.join(", ")}]`, one.conditions);

// Still enumerated over the plain conditions, since those are the free
// variables; a computed condition is derived from them.
console.log("conditions:", catalogue.conditionNames);
console.log("computed:", catalogue.computedConditionNames);
console.log("uncovered:", catalogue.missingCombinations());
