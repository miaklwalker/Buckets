/**
 * Rules that deliberately overlap, and how to tell what nothing covers.
 *
 * Buckets are independent questions about the same item, not a partition. A
 * listing can be simultaneously "needs a photo", "needs a price" and "close to
 * ready" — each is a separate work queue, and each wants the listing.
 *
 * Run with:
 *   node --experimental-transform-types examples/overlapping.ts
 */
import { BucketEngine, NOT, OR } from "../main.ts";

interface Listing {
	readonly id: string;
	readonly photos: number;
	readonly description: string;
	readonly price: number | null;
}

const LISTINGS: Listing[] = [
	{ id: "l-1", photos: 4, description: "A".repeat(200), price: 30 },
	{ id: "l-2", photos: 0, description: "A".repeat(200), price: 30 },
	{ id: "l-3", photos: 4, description: "short", price: null },
	{ id: "l-4", photos: 0, description: "short", price: null },
];

/**
 * Hoisted because two rules need it: an expression is plain data, so it can be
 * built once, named, and negated. `checkFn` just returns it.
 */
const missingSomething = OR(
	NOT("hasPhotos"),
	NOT("hasDescription"),
	NOT("hasPrice"),
);

const quality = new BucketEngine()
	.defineInput<Listing>()
	.defineCondition({ name: "hasPhotos", checkFn: (l) => l.photos > 0 })
	.defineCondition({
		name: "hasDescription",
		checkFn: (l) => l.description.length >= 100,
	})
	.defineCondition({ name: "hasPrice", checkFn: (l) => l.price !== null })
	// Three work queues. A listing missing two things is in two of them.
	.defineBucket({ name: "needsPhotos", checkFn: ({ NOT }) => NOT("hasPhotos") })
	.defineBucket({
		name: "needsDescription",
		checkFn: ({ NOT }) => NOT("hasDescription"),
	})
	.defineBucket({ name: "needsPrice", checkFn: ({ NOT }) => NOT("hasPrice") })
	// And two summary rules over the same conditions.
	.defineBucket({
		name: "readyToPublish",
		checkFn: () => NOT(missingSomething),
	})
	.defineBucket({
		name: "almostReady",
		// Photographed, but still missing text or a price.
		checkFn: ({ AND, OR, NOT }) =>
			AND("hasPhotos", OR(NOT("hasDescription"), NOT("hasPrice"))),
	});

const report = await quality.process(LISTINGS);

for (const [bucket, listings] of Object.entries(report.buckets)) {
	console.log(`${bucket}: ${listings.map((l) => l.id).join(", ") || "—"}`);
}

// Membership double-counts on purpose: l-4 is missing all three.
const placements = Object.values(report.buckets).flat().length;
console.log(`${placements} placements across ${LISTINGS.length} listings`);

// Every combination satisfies at least one rule here, so nothing is unmatched.
console.log("uncovered combinations:", quality.missingCombinations());
console.log("unmatched:", report.unmatched.length);
