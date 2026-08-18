import { BucketEngine, definedIn, pathIn } from "../main.ts";

interface Product {
	readonly sku: string;
	readonly weightKg: number | null;
	readonly active: boolean;
}

interface Listing {
	readonly id: string;
	// Draft listings haven't picked a product yet.
	readonly product?: Product;
	readonly alternate?: Product;
}

const LISTINGS: Listing[] = [
	{ id: "L1", product: { sku: "mug-01", weightKg: 0.4, active: true } },
	{ id: "L2", product: { sku: "lamp-01", weightKg: null, active: true } },
	{
		id: "L3",
		product: { sku: "vapour-01", weightKg: null, active: false },
		alternate: { sku: "vapour-02", weightKg: null, active: false },
	},
	{ id: "L4" }, // still a draft — no product at all
	{ id: "L5" },
];

/* -------------------------------------------------------------------------- */
/* 1. Type narrowing: no `?.` inside a condition that has already been told   */
/*    the product exists.                                                     */
/* -------------------------------------------------------------------------- */

let fraudChecks = 0;

const listings = new BucketEngine()
	.defineInput<Listing>()
	// `definedIn` fits here because `product` is genuinely optional on `Listing`.
	.defineCondition({
		name: "hasProduct",
		checkFn: definedIn<Listing>()("product"),
	})
	.defineCondition({
		name: "hasAlternate",
		checkFn: definedIn<Listing>()("alternate"),
	})
	.defineCondition({
		name: "hasWeight",
		when: () => "hasProduct",
		// `pathIn` walks straight to `product.weightKg` and produces the
		// predicate itself — no hand-written `(listing): listing is typeof
		// listing & { product: { weightKg: number } } => ...` needed.
		//
		// `.isPresent`, not `.isDefined`: weightKg is `number | null`, and a
		// `null` weight is not a real weight — `.isDefined` alone would let it
		// through, since it only rejects `undefined`.
		checkFn: pathIn<Listing>().at("product").isPresent("weightKg"),
	})
	.defineCondition({
		name: "hasAltWeight",
		when: () => "hasAlternate",
		checkFn: pathIn<Listing>().at("alternate").isPresent("weightKg"),
	})
	.defineCondition({
		name: "isActive",
		when: () => "hasProduct",
		checkFn: (listing) => listing.product.active,
	})
	.defineCondition(
		{
			name: "passesFraudCheck",
			when: ({ AND }) =>
				AND(
					// "hasProduct",
					"hasWeight", 
					"hasAlternate",
					"hasAltWeight"
				),
		},
		async (listing) => {
			fraudChecks += 1;
			// Standing in for an expensive call — a real one might hit a
			// third-party API keyed on `listing.product.sku`.
			console.log(listing.alternate.weightKg);
			console.log(listing.product.weightKg);
			await new Promise((resolve) => setTimeout(resolve, 5));
			return listing.product.sku.length > 3;
		},
	)
	.defineBucket({ name: "shippable", checkFn: () => "hasWeight" })
	.defineBucket({
		name: "readyToSell",
		checkFn: ({ AND }) => AND("isActive", "passesFraudCheck"),
	})
	.defineBucket({
		name: "drafts",
		checkFn: ({ NOT }) => NOT("hasProduct"),
	});

const report = await listings.process(LISTINGS);

console.log(
	"shippable   ",
	report.buckets.shippable.map((l) => l.id),
);
console.log(
	"readyToSell ",
	report.buckets.readyToSell.map((l) => l.id),
);
console.log(
	"drafts      ",
	report.buckets.drafts.map((l) => l.id),
);

// Of 5 listings, only 2 have a product with a weight — L3 has a null weight,
// L4/L5 fail hasProduct — so the expensive check ran twice, not five times.
console.log(`passesFraudCheck's checkFn actually ran ${fraudChecks} time(s)`);

// The report still carries a verdict for every condition, skipped ones
// included — `hasWeight`/`isActive`/`passesFraudCheck` all read `false` for a
// draft listing, exactly as if they'd run and failed.
const draft = await listings.processOne(LISTINGS[3] as Listing);
console.log("L4's conditions:", draft.conditions);

/* -------------------------------------------------------------------------- */
/* 2. What `when` buys the type checker.                                      */

/* -------------------------------------------------------------------------- */

/**
 * Never called — see {@link file://./narrowing.ts} for why this pattern is
 * used to demonstrate compile errors without a build step failing.
 */
function rejectedAtCompileTime(): void {
	new BucketEngine()
		.defineInput<Listing>()
		.defineCondition({
			name: "hasProduct",
			checkFn: definedIn<Listing>()("product"),
		})
		.defineCondition({
			name: "hasWeightUnguarded",
			// No `when` this time.
			// @ts-expect-error product is `Product | undefined` here — nothing
			// told the checker `hasProduct` already ruled out `undefined`.
			checkFn: (listing) => listing.product.weightKg !== null,
		})
		.defineCondition({
			name: "isActiveUnguarded",
			// `AND` wrapped in a callback, instead of called as a value — still
			// skips correctly at runtime, but this is the one case `when` can't
			// carry narrowing through, so it's typed exactly like no `when` at all.
			when: ({ AND }) => AND("hasProduct"),
			// @ts-expect-error same as above — the callback form doesn't narrow.
			checkFn: (listing) => listing.product.active,
		});
}

void rejectedAtCompileTime;

/* -------------------------------------------------------------------------- */
/* 3. missingCombinations() only enumerates what's actually reachable.        */
/* -------------------------------------------------------------------------- */

// Without `when`, this would also list combinations like
// ["hasWeight"] — true without "hasProduct" — which no item can ever produce,
// since hasWeight's checkFn never even runs when hasProduct is false. `when`
// prunes those before they're reported.
console.log("uncovered:", listings.missingCombinations());
