import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BucketEngine } from "../main.ts";
import { schema } from "./support.ts";

/* -------------------------------------------------------------------------- */
/* The domain                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The five fields a channel cares about. The channel manager holds one copy as
 * the master record, and the channel holds its own copy of the same five —
 * which is the whole reason this is interesting: they can disagree.
 */
export interface ChannelDetails {
	readonly title: string | null;
	readonly description: string | null;
	readonly priceCents: number | null;
	readonly weightGrams: number | null;
	readonly photoUrls: readonly string[];
}

/**
 * One product as it sits in the channel manager, alongside what the one
 * ecommerce channel is currently showing for it. A `channel` of `null` means
 * the listing has never been pushed — there is nothing out there at all.
 */
export interface Listing extends ChannelDetails {
	readonly sku: string;
	readonly channel: ChannelDetails | null;
}

/** A listing that really is live on the channel — see `isOnChannel`. */
export type SyncedListing = Listing & { readonly channel: ChannelDetails };

/* -------------------------------------------------------------------------- */
/* The schema the channel manager's export is validated against                */
/* -------------------------------------------------------------------------- */

function detailIssues(
	value: Record<string, unknown>,
	at: readonly string[],
): StandardSchemaV1.Issue[] {
	const issues: StandardSchemaV1.Issue[] = [];
	const path = (key: string) => [...at, key];

	for (const key of ["title", "description"] as const) {
		if (typeof value[key] !== "string" && value[key] !== null) {
			issues.push({ message: "expected a string or null", path: path(key) });
		}
	}
	for (const key of ["priceCents", "weightGrams"] as const) {
		if (typeof value[key] !== "number" && value[key] !== null) {
			issues.push({ message: "expected a number or null", path: path(key) });
		}
	}
	const photoUrls = value.photoUrls;
	if (
		!Array.isArray(photoUrls) ||
		!photoUrls.every((url) => typeof url === "string")
	) {
		issues.push({
			message: "expected an array of strings",
			path: path("photoUrls"),
		});
	}

	return issues;
}

/** Rejects a row the channel manager's export should never have produced. */
export const listingSchema = schema<Listing>((value) => {
	if (typeof value !== "object" || value === null) {
		return { issues: [{ message: "expected a listing object" }] };
	}

	const record = value as Record<string, unknown>;
	const issues: StandardSchemaV1.Issue[] = [];

	if (typeof record.sku !== "string" || record.sku.length === 0) {
		issues.push({ message: "expected a non-empty string", path: ["sku"] });
	}
	issues.push(...detailIssues(record, []));

	const channel = record.channel;
	if (
		channel === undefined ||
		(channel !== null && typeof channel !== "object")
	) {
		issues.push({ message: "expected an object or null", path: ["channel"] });
	} else if (channel !== null) {
		issues.push(
			...detailIssues(channel as Record<string, unknown>, ["channel"]),
		);
	}

	return issues.length > 0 ? { issues } : { value: value as Listing };
});

/* -------------------------------------------------------------------------- */
/* The names, written out once so the expectation tables can be exhaustive     */
/* -------------------------------------------------------------------------- */

export type PlainConditionName =
	| "hasTitle"
	| "hasDescription"
	| "hasPrice"
	| "hasWeight"
	| "hasPhotos"
	| "isOnChannel"
	| "correctTitle"
	| "correctDescription"
	| "correctPrice"
	| "correctWeight"
	| "correctPhotos";

export type ComputedConditionName =
	| "hasAllRequiredDataForChannel"
	| "allDetailsInChannelAreCorrect"
	| "channelIsStale";

export type ConditionName = PlainConditionName | ComputedConditionName;

export type BucketName =
	| "listedProperly"
	| "needsData"
	| "needsSync"
	| "neverPushed"
	| "missingTitle"
	| "missingDescription"
	| "missingPrice"
	| "missingWeight"
	| "missingPhotos"
	| "wrongTitle"
	| "wrongDescription"
	| "wrongPrice"
	| "wrongWeight"
	| "wrongPhotos"
	| "readyButNeverPushed"
	| "blank";

/** Definition order — asserted against the engine itself. */
export const PLAIN_CONDITION_NAMES: readonly PlainConditionName[] = [
	"hasTitle",
	"hasDescription",
	"hasPrice",
	"hasWeight",
	"hasPhotos",
	"isOnChannel",
	"correctTitle",
	"correctDescription",
	"correctPrice",
	"correctWeight",
	"correctPhotos",
];

export const COMPUTED_CONDITION_NAMES: readonly ComputedConditionName[] = [
	"hasAllRequiredDataForChannel",
	"allDetailsInChannelAreCorrect",
	"channelIsStale",
];

export const BUCKET_NAMES: readonly BucketName[] = [
	"listedProperly",
	"needsData",
	"needsSync",
	"neverPushed",
	"missingTitle",
	"missingDescription",
	"missingPrice",
	"missingWeight",
	"missingPhotos",
	"wrongTitle",
	"wrongDescription",
	"wrongPrice",
	"wrongWeight",
	"wrongPhotos",
	"readyButNeverPushed",
	"blank",
];

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

function samePhotos(
	master: readonly string[],
	onChannel: readonly string[],
): boolean {
	return (
		master.length === onChannel.length &&
		master.every((url, index) => url === onChannel[index])
	);
}

/**
 * Half the model: eleven facts about a listing and the three combinations
 * worth naming, with no rules on top yet. Kept separate so a test can put a
 * different set of buckets on the same facts.
 *
 * `onCheck` is test instrumentation and nothing else — every condition reports
 * its own name through it, which is how the suite counts what actually ran.
 */
export function catalogueConditions(
	onCheck: (name: PlainConditionName) => void = () => {},
) {
	return (
		new BucketEngine()
			.defineInput(listingSchema)

			/* --- Does the channel manager hold what the channel demands? ------- */

			.defineCondition({
				name: "hasTitle",
				checkFn: (listing) => {
					onCheck("hasTitle");
					return listing.title !== null && listing.title.trim() !== "";
				},
			})
			.defineCondition({
				name: "hasDescription",
				checkFn: (listing) => {
					onCheck("hasDescription");
					return (
						listing.description !== null && listing.description.trim() !== ""
					);
				},
			})
			.defineCondition({
				name: "hasPrice",
				checkFn: (listing) => {
					onCheck("hasPrice");
					return listing.priceCents !== null;
				},
			})
			.defineCondition({
				name: "hasWeight",
				checkFn: (listing) => {
					onCheck("hasWeight");
					return listing.weightGrams !== null;
				},
			})
			.defineCondition({
				name: "hasPhotos",
				checkFn: (listing) => {
					onCheck("hasPhotos");
					return listing.photoUrls.length > 0;
				},
			})

			/* --- Is there a listing on the channel at all? --------------------- *
			 * Written as a type predicate, so the buckets that require it hand
			 * back a listing whose `channel` is known to be there — the team
			 * fixing a live listing never has to null-check the thing they are
			 * looking at.                                                         */

			.defineCondition({
				name: "isOnChannel",
				checkFn: (listing): listing is SyncedListing => {
					onCheck("isOnChannel");
					return listing.channel !== null;
				},
			})

			/* --- Does the channel show what the channel manager holds? --------- *
			 * A listing that was never pushed shows nothing, so every one of
			 * these is false for it. Where both sides are empty they agree, which
			 * is why "correct" and "complete" are genuinely separate questions.   */

			.defineCondition({
				name: "correctTitle",
				checkFn: (listing) => {
					onCheck("correctTitle");
					return (
						listing.channel !== null && listing.channel.title === listing.title
					);
				},
			})
			.defineCondition({
				name: "correctDescription",
				checkFn: (listing) => {
					onCheck("correctDescription");
					return (
						listing.channel !== null &&
						listing.channel.description === listing.description
					);
				},
			})
			.defineCondition({
				name: "correctPrice",
				checkFn: (listing) => {
					onCheck("correctPrice");
					return (
						listing.channel !== null &&
						listing.channel.priceCents === listing.priceCents
					);
				},
			})
			.defineCondition({
				name: "correctWeight",
				checkFn: (listing) => {
					onCheck("correctWeight");
					return (
						listing.channel !== null &&
						listing.channel.weightGrams === listing.weightGrams
					);
				},
			})
			.defineCondition({
				name: "correctPhotos",
				checkFn: (listing) => {
					onCheck("correctPhotos");
					return (
						listing.channel !== null &&
						samePhotos(listing.photoUrls, listing.channel.photoUrls)
					);
				},
			})

			/* --- The two phrases the whole model turns on, and one that layers - */

			.defineComputedCondition({
				name: "hasAllRequiredDataForChannel",
				checkFn: ({ AND }) =>
					AND(
						"hasTitle",
						"hasDescription",
						"hasPrice",
						"hasWeight",
						"hasPhotos",
					),
			})
			.defineComputedCondition({
				name: "allDetailsInChannelAreCorrect",
				checkFn: ({ AND }) =>
					AND(
						"correctTitle",
						"correctDescription",
						"correctPrice",
						"correctWeight",
						"correctPhotos",
					),
			})
			.defineComputedCondition({
				name: "channelIsStale",
				checkFn: ({ AND, NOT }) =>
					AND(
						"hasAllRequiredDataForChannel",
						NOT("allDetailsInChannelAreCorrect"),
					),
			})
	);
}

/**
 * The whole model: the eleven facts, the three named combinations, and the
 * sixteen rules the two teams actually read.
 */
export function catalogueEngine(
	onCheck: (name: PlainConditionName) => void = () => {},
) {
	return (
		catalogueConditions(onCheck)

			/* --- Triage: three rules that cover every listing exactly once ----- */

			.defineBucket({
				name: "listedProperly",
				checkFn: ({ AND }) =>
					AND("hasAllRequiredDataForChannel", "allDetailsInChannelAreCorrect"),
			})
			.defineBucket({
				name: "needsData",
				checkFn: ({ NOT }) => NOT("hasAllRequiredDataForChannel"),
			})
			.defineBucket({ name: "needsSync", checkFn: () => "channelIsStale" })

			/* --- The work queues the listing team actually pulls from ---------- */

			.defineBucket({
				name: "neverPushed",
				checkFn: ({ NOT }) => NOT("isOnChannel"),
			})
			.defineBucket({
				name: "missingTitle",
				checkFn: ({ NOT }) => NOT("hasTitle"),
			})
			.defineBucket({
				name: "missingDescription",
				checkFn: ({ NOT }) => NOT("hasDescription"),
			})
			.defineBucket({
				name: "missingPrice",
				checkFn: ({ NOT }) => NOT("hasPrice"),
			})
			.defineBucket({
				name: "missingWeight",
				checkFn: ({ NOT }) => NOT("hasWeight"),
			})
			.defineBucket({
				name: "missingPhotos",
				checkFn: ({ NOT }) => NOT("hasPhotos"),
			})

			/* A field is only *wrong* when we hold the value, the listing exists,
			 * and the channel is showing something else. Anything weaker puts
			 * never-pushed drafts in all five queues, which is noise.            */

			.defineBucket({
				name: "wrongTitle",
				checkFn: ({ AND, NOT }) =>
					AND("hasTitle", "isOnChannel", NOT("correctTitle")),
			})
			.defineBucket({
				name: "wrongDescription",
				checkFn: ({ AND, NOT }) =>
					AND("hasDescription", "isOnChannel", NOT("correctDescription")),
			})
			.defineBucket({
				name: "wrongPrice",
				checkFn: ({ AND, NOT }) =>
					AND("hasPrice", "isOnChannel", NOT("correctPrice")),
			})
			.defineBucket({
				name: "wrongWeight",
				checkFn: ({ AND, NOT }) =>
					AND("hasWeight", "isOnChannel", NOT("correctWeight")),
			})
			.defineBucket({
				name: "wrongPhotos",
				checkFn: ({ AND, NOT }) =>
					AND("hasPhotos", "isOnChannel", NOT("correctPhotos")),
			})

			/* --- Two strict readings, which is what ONLY is for ---------------- */

			.defineBucket({
				name: "readyButNeverPushed",
				checkFn: ({ ONLY }) =>
					ONLY(
						"hasTitle",
						"hasDescription",
						"hasPrice",
						"hasWeight",
						"hasPhotos",
					),
			})
			.defineBucket({ name: "blank", checkFn: ({ ONLY }) => ONLY() })
	);
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

export const SKUS = [
	"beanie-perfect",
	"socks-perfect",
	"mug-stale-price",
	"tee-stale-photos",
	"lamp-stale-title-and-weight",
	"rug-wrong-everything",
	"poster-no-price",
	"charger-no-photos",
	"candle-ready-never-pushed",
	"hat-ready-never-pushed",
	"vase-partial-never-pushed",
	"ghost-blank",
] as const;

export type Sku = (typeof SKUS)[number];

const COMPLETE: ChannelDetails = {
	title: "Merino Wool Beanie",
	description: "Ribbed knit beanie in 100% merino wool. One size.",
	priceCents: 2499,
	weightGrams: 120,
	photoUrls: ["front.jpg", "back.jpg"],
};

/**
 * Builds one listing. `channel` is `"mirror"` for a channel showing exactly
 * what we hold, `null` for one that was never pushed, or the fields the
 * channel disagrees on.
 */
function listing(
	sku: Sku,
	master: Partial<ChannelDetails> = {},
	channel: "mirror" | null | Partial<ChannelDetails> = "mirror",
): Listing {
	const held: ChannelDetails = { ...COMPLETE, ...master };

	return {
		sku,
		...held,
		channel:
			channel === null
				? null
				: { ...held, ...(channel === "mirror" ? {} : channel) },
	};
}

export const LISTINGS: readonly Listing[] = [
	// Complete, and the channel is showing all of it.
	listing("beanie-perfect"),
	listing("socks-perfect", { title: "Alpaca Hiking Socks" }),

	// Complete, but the channel is behind on something.
	listing(
		"mug-stale-price",
		{ title: "Enamel Camp Mug" },
		{ priceCents: 1999 },
	),
	listing(
		"tee-stale-photos",
		{ title: "Organic Cotton Tee" },
		{ photoUrls: ["front.jpg"] },
	),
	listing(
		"lamp-stale-title-and-weight",
		{ title: "Brass Desk Lamp" },
		{ title: "Brass Desk Lamp (2023)", weightGrams: 900 },
	),
	listing(
		"rug-wrong-everything",
		{ title: "Jute Area Rug" },
		{
			title: "Jute Rug",
			description: "Rug.",
			priceCents: 100,
			weightGrams: 9000,
			photoUrls: [],
		},
	),

	// Incomplete, and the channel faithfully mirrors the gap — every detail
	// out there is correct, and the listing still is not fit to sell.
	listing("poster-no-price", { title: "Letterpress Poster", priceCents: null }),
	listing("charger-no-photos", { title: "Braided USB-C Cable", photoUrls: [] }),

	// Never pushed at all.
	listing("candle-ready-never-pushed", { title: "Beeswax Candle" }, null),
	listing("hat-ready-never-pushed", { title: "Waxed Canvas Cap" }, null),
	listing(
		"vase-partial-never-pushed",
		{
			title: "Stoneware Vase",
			description: null,
			priceCents: null,
			weightGrams: null,
		},
		null,
	),
	listing(
		"ghost-blank",
		{
			title: null,
			description: null,
			priceCents: null,
			weightGrams: null,
			photoUrls: [],
		},
		null,
	),
];

/* -------------------------------------------------------------------------- */
/* What we expect — written by hand, from the catalogue above                  */
/* -------------------------------------------------------------------------- */

/**
 * Every condition true of each listing, computed ones included. Anything not
 * listed here is expected to be false, and `Record<Sku, ...>` means forgetting
 * a listing outright is a compile error rather than a silent gap.
 */
export const EXPECTED_TRUE_CONDITIONS: Readonly<
	Record<Sku, readonly ConditionName[]>
> = {
	"beanie-perfect": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctPrice",
		"correctWeight",
		"correctPhotos",
		"hasAllRequiredDataForChannel",
		"allDetailsInChannelAreCorrect",
	],
	"socks-perfect": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctPrice",
		"correctWeight",
		"correctPhotos",
		"hasAllRequiredDataForChannel",
		"allDetailsInChannelAreCorrect",
	],
	"mug-stale-price": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctWeight",
		"correctPhotos",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"tee-stale-photos": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctPrice",
		"correctWeight",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"lamp-stale-title-and-weight": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctDescription",
		"correctPrice",
		"correctPhotos",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"rug-wrong-everything": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"poster-no-price": [
		"hasTitle",
		"hasDescription",
		"hasWeight",
		"hasPhotos",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctPrice",
		"correctWeight",
		"correctPhotos",
		"allDetailsInChannelAreCorrect",
	],
	"charger-no-photos": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"isOnChannel",
		"correctTitle",
		"correctDescription",
		"correctPrice",
		"correctWeight",
		"correctPhotos",
		"allDetailsInChannelAreCorrect",
	],
	"candle-ready-never-pushed": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"hat-ready-never-pushed": [
		"hasTitle",
		"hasDescription",
		"hasPrice",
		"hasWeight",
		"hasPhotos",
		"hasAllRequiredDataForChannel",
		"channelIsStale",
	],
	"vase-partial-never-pushed": ["hasTitle", "hasPhotos"],
	"ghost-blank": [],
};

/** Every bucket each listing lands in, in bucket definition order. */
export const EXPECTED_BUCKETS: Readonly<Record<Sku, readonly BucketName[]>> = {
	"beanie-perfect": ["listedProperly"],
	"socks-perfect": ["listedProperly"],
	"mug-stale-price": ["needsSync", "wrongPrice"],
	"tee-stale-photos": ["needsSync", "wrongPhotos"],
	"lamp-stale-title-and-weight": ["needsSync", "wrongTitle", "wrongWeight"],
	"rug-wrong-everything": [
		"needsSync",
		"wrongTitle",
		"wrongDescription",
		"wrongPrice",
		"wrongWeight",
		"wrongPhotos",
	],
	"poster-no-price": ["needsData", "missingPrice"],
	"charger-no-photos": ["needsData", "missingPhotos"],
	"candle-ready-never-pushed": [
		"needsSync",
		"neverPushed",
		"readyButNeverPushed",
	],
	"hat-ready-never-pushed": ["needsSync", "neverPushed", "readyButNeverPushed"],
	"vase-partial-never-pushed": [
		"needsData",
		"neverPushed",
		"missingDescription",
		"missingPrice",
		"missingWeight",
	],
	"ghost-blank": [
		"needsData",
		"neverPushed",
		"missingTitle",
		"missingDescription",
		"missingPrice",
		"missingWeight",
		"missingPhotos",
		"blank",
	],
};

/**
 * How big each bucket should be. Counted independently of
 * {@link EXPECTED_BUCKETS} on purpose: two hand-written tables that agree are
 * worth far more than one, and the suite checks them against each other as
 * well as against the engine.
 */
export const EXPECTED_BUCKET_COUNTS: Readonly<Record<BucketName, number>> = {
	listedProperly: 2,
	needsData: 4,
	needsSync: 6,
	neverPushed: 4,
	missingTitle: 1,
	missingDescription: 2,
	missingPrice: 3,
	missingWeight: 2,
	missingPhotos: 2,
	wrongTitle: 2,
	wrongDescription: 1,
	wrongPrice: 2,
	wrongWeight: 2,
	wrongPhotos: 2,
	readyButNeverPushed: 2,
	blank: 1,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function skus(listings: readonly Listing[]): string[] {
	return listings.map((entry) => entry.sku);
}

/** The listings expected in one bucket, in catalogue order. */
export function expectedMembers(bucket: BucketName): Sku[] {
	return SKUS.filter((sku) => EXPECTED_BUCKETS[sku].includes(bucket));
}

/** Expands a true-list into the full verdict record the report carries. */
export function expectedConditionReport(
	sku: Sku,
): Record<ConditionName, boolean> {
	const trueOnes = new Set<ConditionName>(EXPECTED_TRUE_CONDITIONS[sku]);
	const report = {} as Record<ConditionName, boolean>;

	for (const name of [...PLAIN_CONDITION_NAMES, ...COMPUTED_CONDITION_NAMES]) {
		report[name] = trueOnes.has(name);
	}

	return report;
}

export function findListing(sku: Sku): Listing {
	const found = LISTINGS.find((entry) => entry.sku === sku);
	if (found === undefined) throw new Error(`no fixture for ${sku}`);
	return found;
}
