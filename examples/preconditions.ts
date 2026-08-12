import { BucketEngine, definedIn, presentIn } from "../main.ts";

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
		checkFn: presentIn<Listing>()("alternate"),
	})
	// `when` names the precondition. Inside `checkFn`, `listing.product` is
	// `Product` — not `Product | undefined` — because `hasProduct` already
	// proved it before this ever runs.
	//
	// `weightKg` is `number | null`, one level *into* `product` rather than a
	// property of `listing` itself, so `definedIn`/`presentIn` — which check a
	// property of whatever `checkFn`'s own parameter is — don't fit directly:
	// there's no `definedIn<Listing>()("product.weightKg")`, because `Listing`
	// doesn't have a `weightKg` of its own to check.
	//
	// Delegating the call to `presentIn<Product>()("weightKg")` still reuses
	// its real runtime logic (the property-descriptor check, the null check)
	// on `listing.product` — but the *predicate* that narrows `hasWeight`
	// itself has to be written on `listing`, explicitly: TypeScript's own
	// predicate inference (the thing that made `isActive` below need no
	// annotation) only reaches one property deep. A checkFn whose body is
	// `listing.product.weightKg !== null` gets inferred fine *as a boolean* —
	// it runs correctly either way — but the inference stops short of also
	// making `hasWeight` itself a predicate, so nothing downstream would ever
	// see `weightKg` as narrowed. Delegating to another function call (as
	// `presentIn(...)(...)` here) has the same limit, for the same reason:
	// inference only follows a return expression written out directly, not a
	// call to something else that happens to be a predicate.
	.defineCondition({
		name: "hasWeight",
		when: () => "hasProduct",
		checkFn: (
			listing,
		): listing is typeof listing & { product: Record<"weightKg", number> } =>
			presentIn<Product>()("weightKg")(listing.product),
	})
	.defineCondition({
		name: "hasAltWeight",
		when: () => "hasAlternate",
		checkFn: (
			listing,
		): listing is typeof listing & { alternate: Record<"weightKg", number> } =>
			presentIn<Product>()("weightKg")(listing.alternate),
	})
	.defineCondition({
		name: "isActive",
		when: () => "hasProduct",
		checkFn: (listing) => listing.product.active,
	})
	// A precondition can be a combination, not just one name. `checkFn` as a
	// second argument, instead of a property alongside `when`, is what gets
	// you both things at once here: `AND` is the real, destructured
	// combinator — so `"hasAlternate"`/`"hasProduct"`/`"hasAltWeight"`
	// autocomplete against this engine's actual condition names — and the
	// result still narrows `checkFn`'s `listing`, same as the value-position
	// form does. (The one-object form with `when: AND(...)` as a value also
	// narrows, but `AND` there has no engine in scope yet to complete against.)
	.defineCondition(
		{
			name: "passesFraudCheck",
			when: ({ AND }) => AND(
				"hasAlternate", "hasProduct",
				"hasAltWeight", 'hasWeight'
			),
		},
		async (listing) => {
			fraudChecks += 1;
			// Standing in for an expensive call — a real one might hit a
			// third-party API keyed on `listing.product.sku`.
			console.log(listing.alternate.weightKg);
			console.log(listing.product.weightKg)
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
