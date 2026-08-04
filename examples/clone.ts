/**
 * Trying two rule sets over one set of conditions.
 *
 * The `define*` methods mutate and return the same object — that's what makes
 * the chain read the way it does, and it's why branching off a shared variable
 * does not do what it looks like. Both branches are the same engine, holding
 * every bucket either of them defined, while the types still claim one each.
 *
 * `clone()` is how you say what that was trying to say: an independent engine
 * with everything defined so far, at the same type. The useful shape is a
 * proposed rule change — run the old rules and the new ones over the same
 * catalogue and diff them, without declaring the conditions twice.
 *
 * Run with:
 *   node --experimental-transform-types examples/clone.ts
 */
import { BucketEngine } from "../main.ts";

interface Parcel {
	readonly sku: string;
	readonly weightKg: number | null;
	readonly fragile: boolean;
	readonly hazardous: boolean;
	readonly longestSideCm: number;
}

const PARCELS: Parcel[] = [
	{
		sku: "book-01",
		weightKg: 0.5,
		fragile: false,
		hazardous: false,
		longestSideCm: 25,
	},
	{
		sku: "vase-01",
		weightKg: 2,
		fragile: true,
		hazardous: false,
		longestSideCm: 40,
	},
	{
		sku: "sofa-01",
		weightKg: 45,
		fragile: false,
		hazardous: false,
		longestSideCm: 210,
	},
	{
		sku: "mirror-01",
		weightKg: 8,
		fragile: true,
		hazardous: false,
		longestSideCm: 150,
	},
	{
		sku: "paint-01",
		weightKg: 12,
		fragile: false,
		hazardous: true,
		longestSideCm: 30,
	},
	{
		sku: "mystery-01",
		weightKg: null,
		fragile: false,
		hazardous: false,
		longestSideCm: 10,
	},
];

/** The facts. Declared once, and the only part worth not repeating. */
const parcels = new BucketEngine()
	.defineInput<Parcel>()
	.defineCondition({
		name: "hasWeight",
		checkFn: (parcel) => parcel.weightKg !== null,
	})
	.defineCondition({ name: "isFragile", checkFn: (parcel) => parcel.fragile })
	.defineCondition({
		name: "isHazardous",
		checkFn: (parcel) => parcel.hazardous,
	})
	.defineCondition({
		name: "isOversized",
		checkFn: (parcel) => parcel.longestSideCm > 120,
	});

/* -------------------------------------------------------------------------- */
/* First, the thing that looks right and isn't                                 */
/* -------------------------------------------------------------------------- */

// On a clone, so the demonstration doesn't spoil the base for the real work.
const shared = parcels.clone();

const looksLikeCourier = shared.defineBucket({
	name: "courier",
	checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isHazardous")),
});
const looksLikeFreight = shared.defineBucket({
	name: "freight",
	checkFn: ({ AND }) => AND("hasWeight", "isOversized"),
});

console.log("--- branching off a shared variable ---");
console.log("same object:", Object.is(looksLikeCourier, looksLikeFreight));
console.log("courier engine holds:", looksLikeCourier.bucketNames);
// Its type says `{ courier }`, so `report.buckets.freight` is a compile error —
// on a rule that was evaluated for every parcel anyway.

/* -------------------------------------------------------------------------- */
/* What clone() is for                                                         */
/* -------------------------------------------------------------------------- */

const today = parcels
	.clone()
	.defineBucket({
		name: "courier",
		checkFn: ({ AND, NOT }) => AND("hasWeight", NOT("isHazardous")),
	})
	.defineBucket({
		name: "freight",
		checkFn: ({ AND }) => AND("hasWeight", "isOversized"),
	})
	.defineBucket({
		name: "blocked",
		checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), "isHazardous"),
	});

// The proposal: fragile goes freight too, and courier stops overlapping it.
const proposed = parcels
	.clone()
	.defineBucket({
		name: "courier",
		checkFn: ({ AND, NOT }) =>
			AND(
				"hasWeight",
				NOT("isHazardous"),
				NOT("isFragile"),
				NOT("isOversized"),
			),
	})
	.defineBucket({
		name: "freight",
		checkFn: ({ AND, NOT, OR }) =>
			AND("hasWeight", NOT("isHazardous"), OR("isOversized", "isFragile")),
	})
	.defineBucket({
		name: "blocked",
		checkFn: ({ OR, NOT }) => OR(NOT("hasWeight"), "isHazardous"),
	});

console.log("\n--- three independent engines ---");
console.log("base:    ", parcels.bucketNames);
console.log("today:   ", today.bucketNames);
console.log("proposed:", proposed.bucketNames);

const before = await today.process(PARCELS);
const after = await proposed.process(PARCELS);

console.log("\n--- today ---");
for (const [bucket, parcelsIn] of Object.entries(before.buckets)) {
	console.log(`${bucket}: ${parcelsIn.map((p) => p.sku).join(", ") || "—"}`);
}

console.log("\n--- proposed ---");
for (const [bucket, parcelsIn] of Object.entries(after.buckets)) {
	console.log(`${bucket}: ${parcelsIn.map((p) => p.sku).join(", ") || "—"}`);
}

/* -------------------------------------------------------------------------- */
/* The question you cloned in order to answer                                  */
/* -------------------------------------------------------------------------- */

const courierToday = new Set(
	before.buckets.courier.map((parcel) => parcel.sku),
);
const courierAfter = new Set(after.buckets.courier.map((parcel) => parcel.sku));

console.log("\n--- what the change moves ---");
console.log(
	"leaving courier:",
	[...courierToday].filter((sku) => !courierAfter.has(sku)).join(", ") || "—",
);
console.log(
	"joining courier:",
	[...courierAfter].filter((sku) => !courierToday.has(sku)).join(", ") || "—",
);

// Overlap is the design, so this is worth watching too: today a parcel can be
// courier *and* freight, and the proposal is written to stop that.
const both = (report: typeof before) =>
	report.buckets.courier
		.filter((parcel) =>
			report.buckets.freight.some((other) => other.sku === parcel.sku),
		)
		.map((parcel) => parcel.sku);

console.log(
	"in both courier and freight, today:   ",
	both(before).join(", ") || "—",
);
console.log(
	"in both courier and freight, proposed:",
	both(after).join(", ") || "—",
);

// And the base is still exactly what it was, ready for the next branch.
console.log("\nbase conditions:", parcels.conditionNames);
console.log("base buckets:", parcels.bucketNames);
