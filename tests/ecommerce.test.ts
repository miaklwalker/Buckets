import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine, BucketError } from "../main.ts";
import {
	BUCKET_NAMES,
	type BucketName,
	COMPUTED_CONDITION_NAMES,
	type ComputedConditionName,
	catalogueConditions,
	catalogueEngine,
	EXPECTED_BUCKET_COUNTS,
	EXPECTED_BUCKETS,
	EXPECTED_TRUE_CONDITIONS,
	expectedConditionReport,
	expectedMembers,
	findListing,
	LISTINGS,
	type Listing,
	listingSchema,
	PLAIN_CONDITION_NAMES,
	type PlainConditionName,
	SKUS,
	type SyncedListing,
	skus,
} from "./ecommerce-support.ts";
import type { Equal, Expect } from "./support.ts";

/* -------------------------------------------------------------------------- */
/* The model itself                                                            */
/* -------------------------------------------------------------------------- */

describe("the catalogue engine's shape", () => {
	test("the plain conditions are the facts, in definition order", () => {
		assert.deepStrictEqual(
			catalogueEngine().conditionNames,
			PLAIN_CONDITION_NAMES,
		);
	});

	test("the computed conditions are named separately", () => {
		assert.deepStrictEqual(
			catalogueEngine().computedConditionNames,
			COMPUTED_CONDITION_NAMES,
		);
	});

	test("the buckets are the rules the two teams read", () => {
		assert.deepStrictEqual(catalogueEngine().bucketNames, BUCKET_NAMES);
	});

	test("the fixtures cover every sku exactly once, in order", () => {
		assert.deepStrictEqual(skus(LISTINGS), [...SKUS]);
		assert.strictEqual(new Set(skus(LISTINGS)).size, LISTINGS.length);
	});
});

/* -------------------------------------------------------------------------- */
/* The facts, per listing                                                      */
/* -------------------------------------------------------------------------- */

describe("the conditions each listing answers", () => {
	for (const sku of SKUS) {
		test(`${sku} answers every condition the way we expect`, async () => {
			const assignment = await catalogueEngine().processOne(findListing(sku));

			assert.deepStrictEqual(
				assignment.conditions,
				expectedConditionReport(sku),
			);
		});
	}

	test("a listing that was never pushed has no correct details at all", async () => {
		const assignment = await catalogueEngine().processOne(
			findListing("candle-ready-never-pushed"),
		);

		// Nothing is on the channel, so nothing on the channel is right — which
		// is what keeps `allDetailsInChannelAreCorrect` honest without having to
		// mention `isOnChannel`.
		assert.deepStrictEqual(
			{
				correctTitle: assignment.conditions.correctTitle,
				correctDescription: assignment.conditions.correctDescription,
				correctPrice: assignment.conditions.correctPrice,
				correctWeight: assignment.conditions.correctWeight,
				correctPhotos: assignment.conditions.correctPhotos,
				isOnChannel: assignment.conditions.isOnChannel,
			},
			{
				correctTitle: false,
				correctDescription: false,
				correctPrice: false,
				correctWeight: false,
				correctPhotos: false,
				isOnChannel: false,
			},
		);
	});

	test("every condition runs exactly once per listing", async () => {
		const calls = new Map<PlainConditionName, number>();

		await catalogueEngine((name) =>
			calls.set(name, (calls.get(name) ?? 0) + 1),
		).process(LISTINGS);

		for (const name of PLAIN_CONDITION_NAMES) {
			assert.strictEqual(calls.get(name), LISTINGS.length, name);
		}
	});

	test("the three computed conditions cost nothing extra", async () => {
		let total = 0;

		await catalogueEngine(() => {
			total += 1;
		}).process(LISTINGS);

		// Eleven predicates, twelve listings. The computed conditions read
		// verdicts that were already collected, so they add none of their own.
		assert.strictEqual(total, PLAIN_CONDITION_NAMES.length * LISTINGS.length);
	});
});

/* -------------------------------------------------------------------------- */
/* The named combinations                                                      */
/* -------------------------------------------------------------------------- */

describe("hasAllRequiredDataForChannel and allDetailsInChannelAreCorrect", () => {
	test("they are separate questions: a listing can be correct and still not sellable", async () => {
		// The channel manager has no price for this poster, and the channel is
		// faithfully showing no price. Everything out there is right, and the
		// listing is still not fit to sell.
		const assignment = await catalogueEngine().processOne(
			findListing("poster-no-price"),
		);

		assert.strictEqual(
			assignment.conditions.allDetailsInChannelAreCorrect,
			true,
		);
		assert.strictEqual(
			assignment.conditions.hasAllRequiredDataForChannel,
			false,
		);
		assert.ok(!assignment.buckets.includes("listedProperly"));
		assert.ok(assignment.buckets.includes("needsData"));
	});

	test("and complete data is no use if the channel is showing something else", async () => {
		const assignment = await catalogueEngine().processOne(
			findListing("rug-wrong-everything"),
		);

		assert.strictEqual(
			assignment.conditions.hasAllRequiredDataForChannel,
			true,
		);
		assert.strictEqual(
			assignment.conditions.allDetailsInChannelAreCorrect,
			false,
		);
		assert.ok(!assignment.buckets.includes("listedProperly"));
		assert.ok(assignment.buckets.includes("needsSync"));
	});

	test("listedProperly is exactly the two of them together", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		assert.deepStrictEqual(skus(report.buckets.listedProperly), [
			"beanie-perfect",
			"socks-perfect",
		]);

		for (const sku of SKUS) {
			const conditions = expectedConditionReport(sku);
			assert.strictEqual(
				EXPECTED_BUCKETS[sku].includes("listedProperly"),
				conditions.hasAllRequiredDataForChannel &&
					conditions.allDetailsInChannelAreCorrect,
				sku,
			);
		}
	});

	test("they roll up to the counts we expect across the catalogue", async () => {
		const engine = catalogueEngine();
		const counts: Record<ComputedConditionName, number> = {
			hasAllRequiredDataForChannel: 0,
			allDetailsInChannelAreCorrect: 0,
			channelIsStale: 0,
		};

		for (const sku of SKUS) {
			const { conditions } = await engine.processOne(findListing(sku));
			for (const name of COMPUTED_CONDITION_NAMES) {
				if (conditions[name]) counts[name] += 1;
			}
		}

		assert.deepStrictEqual(counts, {
			hasAllRequiredDataForChannel: 8,
			allDetailsInChannelAreCorrect: 4,
			channelIsStale: 6,
		});

		// The same three numbers fall out of the hand-written fact table.
		for (const name of COMPUTED_CONDITION_NAMES) {
			assert.strictEqual(
				SKUS.filter((sku) => EXPECTED_TRUE_CONDITIONS[sku].includes(name))
					.length,
				counts[name],
				name,
			);
		}
	});

	test("channelIsStale layers on top of both of them", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		// A computed condition built from two other computed conditions, used as
		// a bucket rule by name alone.
		assert.deepStrictEqual(skus(report.buckets.needsSync), [
			"mug-stale-price",
			"tee-stale-photos",
			"lamp-stale-title-and-weight",
			"rug-wrong-everything",
			"candle-ready-never-pushed",
			"hat-ready-never-pushed",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* Bucket membership and counts                                                */
/* -------------------------------------------------------------------------- */

describe("what lands in each bucket", () => {
	test("the two expectation tables agree with each other", () => {
		const counted = {} as Record<BucketName, number>;
		for (const name of BUCKET_NAMES) counted[name] = 0;
		for (const sku of SKUS) {
			for (const bucket of EXPECTED_BUCKETS[sku]) counted[bucket] += 1;
		}

		assert.deepStrictEqual(counted, EXPECTED_BUCKET_COUNTS);
	});

	test("every expected bucket list is in definition order", () => {
		for (const sku of SKUS) {
			const expected = EXPECTED_BUCKETS[sku];
			const ordered = BUCKET_NAMES.filter((name) => expected.includes(name));
			assert.deepStrictEqual([...expected], ordered, sku);
		}
	});

	test("every bucket holds exactly the listings we expect", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		for (const name of BUCKET_NAMES) {
			assert.deepStrictEqual(
				skus(report.buckets[name]),
				expectedMembers(name),
				name,
			);
		}
	});

	test("every bucket is the size we expect", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const sizes = {} as Record<BucketName, number>;

		for (const name of BUCKET_NAMES) sizes[name] = report.buckets[name].length;

		assert.deepStrictEqual(sizes, EXPECTED_BUCKET_COUNTS);
	});

	test("every listing lands in exactly the buckets we expect", async () => {
		const engine = catalogueEngine();

		for (const sku of SKUS) {
			const assignment = await engine.processOne(findListing(sku));
			assert.deepStrictEqual(
				assignment.buckets,
				[...EXPECTED_BUCKETS[sku]],
				sku,
			);
		}
	});

	test("processOne and process put a listing in the same places", async () => {
		const engine = catalogueEngine();
		const report = await engine.process(LISTINGS);

		for (const sku of SKUS) {
			const fromBatch = BUCKET_NAMES.filter((name) =>
				skus(report.buckets[name]).includes(sku),
			);
			const { buckets } = await engine.processOne(findListing(sku));

			assert.deepStrictEqual(buckets, fromBatch, sku);
		}
	});

	test("a listing keeps its catalogue position inside a bucket", async () => {
		const shuffled = [...LISTINGS].reverse();
		const report = await catalogueEngine().process(shuffled, {
			concurrency: 3,
		});

		assert.deepStrictEqual(
			skus(report.buckets.needsSync),
			expectedMembers("needsSync").reverse(),
		);
	});

	test("the buckets deliberately overlap, so they sum to more than the batch", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const placements = Object.values(report.buckets).flat().length;

		assert.strictEqual(placements, 38);
		assert.ok(placements > LISTINGS.length);
	});

	test("one badly broken listing shows up in five detail buckets at once", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const appearances = BUCKET_NAMES.filter((name) =>
			skus(report.buckets[name]).includes("rug-wrong-everything"),
		);

		assert.deepStrictEqual(appearances, [
			"needsSync",
			"wrongTitle",
			"wrongDescription",
			"wrongPrice",
			"wrongWeight",
			"wrongPhotos",
		]);
	});

	test("no listing is lost: every one is bucketed, unmatched, or an error", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const accounted = new Set([
			...skus(Object.values(report.buckets).flat()),
			...report.unmatched.map((entry) => entry.item.sku),
			...report.errors.map((failure) => failure.item.sku),
		]);

		assert.strictEqual(accounted.size, LISTINGS.length);
		assert.deepStrictEqual(report.errors, []);
	});
});

/* -------------------------------------------------------------------------- */
/* Triage                                                                      */
/* -------------------------------------------------------------------------- */

describe("the triage buckets partition the catalogue", () => {
	const TRIAGE = ["listedProperly", "needsData", "needsSync"] as const;

	test("each listing is in exactly one of the three", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		for (const sku of SKUS) {
			const hits = TRIAGE.filter((name) =>
				skus(report.buckets[name]).includes(sku),
			);
			assert.deepStrictEqual(
				hits.length,
				1,
				`${sku} was in ${hits.join(", ")}`,
			);
		}
	});

	test("their counts add up to the batch exactly", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const total = TRIAGE.reduce(
			(sum, name) => sum + report.buckets[name].length,
			0,
		);

		assert.strictEqual(total, LISTINGS.length);
		assert.strictEqual(report.buckets.listedProperly.length, 2);
		assert.strictEqual(report.buckets.needsData.length, 4);
		assert.strictEqual(report.buckets.needsSync.length, 6);
	});

	test("so nothing can ever go unmatched", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		assert.deepStrictEqual(report.unmatched, []);
		// And not just for this catalogue: no combination of the eleven facts
		// escapes the three rules.
		assert.deepStrictEqual(catalogueEngine().missingCombinations(), []);
	});

	test("drop needsData and the gap is exactly the listings we could not sell", async () => {
		const incomplete = catalogueConditions()
			.defineBucket({
				name: "listedProperly",
				checkFn: ({ AND }) =>
					AND("hasAllRequiredDataForChannel", "allDetailsInChannelAreCorrect"),
			})
			.defineBucket({ name: "needsSync", checkFn: () => "channelIsStale" });

		const report = await incomplete.process(LISTINGS);

		assert.deepStrictEqual(skus(report.unmatched.map((entry) => entry.item)), [
			"poster-no-price",
			"charger-no-photos",
			"vase-partial-never-pushed",
			"ghost-blank",
		]);

		// An unmatched entry explains itself in the names we chose.
		assert.strictEqual(
			report.unmatched[0]?.conditions.hasAllRequiredDataForChannel,
			false,
		);
		assert.strictEqual(
			report.unmatched[0]?.conditions.allDetailsInChannelAreCorrect,
			true,
		);
	});

	test("missingCombinations names that gap before the data does", () => {
		const incomplete = catalogueConditions()
			.defineBucket({
				name: "listedProperly",
				checkFn: ({ AND }) =>
					AND("hasAllRequiredDataForChannel", "allDetailsInChannelAreCorrect"),
			})
			.defineBucket({ name: "needsSync", checkFn: () => "channelIsStale" });

		const missing = incomplete.missingCombinations();

		// Both rules require complete data, so every combination missing any one
		// of the five presence facts is uncovered: 2^11 total, less the 2^6 that
		// have all five.
		assert.strictEqual(missing.length, 2 ** 11 - 2 ** 6);
		for (const combination of missing) {
			assert.ok(
				!(
					combination.includes("hasTitle") &&
					combination.includes("hasDescription") &&
					combination.includes("hasPrice") &&
					combination.includes("hasWeight") &&
					combination.includes("hasPhotos")
				),
				combination.join(", "),
			);
		}
		// It reports the plain facts only — a computed name is derived, not free.
		for (const combination of missing) {
			for (const name of combination) {
				assert.ok(
					(PLAIN_CONDITION_NAMES as readonly string[]).includes(name),
					name,
				);
			}
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The listing team's work queue                                               */
/* -------------------------------------------------------------------------- */

describe("the queues the listing team pulls from", () => {
	const DETAIL_BUCKETS = [
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
	] as const satisfies readonly BucketName[];

	test("each failing listing carries the exact fields to fix", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const queue: Record<string, string[]> = {};

		for (const sku of SKUS) {
			if (EXPECTED_BUCKETS[sku].includes("listedProperly")) continue;
			queue[sku] = DETAIL_BUCKETS.filter((name) =>
				skus(report.buckets[name]).includes(sku),
			);
		}

		assert.deepStrictEqual(queue, {
			"mug-stale-price": ["wrongPrice"],
			"tee-stale-photos": ["wrongPhotos"],
			"lamp-stale-title-and-weight": ["wrongTitle", "wrongWeight"],
			"rug-wrong-everything": [
				"wrongTitle",
				"wrongDescription",
				"wrongPrice",
				"wrongWeight",
				"wrongPhotos",
			],
			"poster-no-price": ["missingPrice"],
			"charger-no-photos": ["missingPhotos"],
			// Nothing is wrong with these two — they have simply never been sent.
			"candle-ready-never-pushed": [],
			"hat-ready-never-pushed": [],
			"vase-partial-never-pushed": [
				"missingDescription",
				"missingPrice",
				"missingWeight",
			],
			"ghost-blank": [
				"missingTitle",
				"missingDescription",
				"missingPrice",
				"missingWeight",
				"missingPhotos",
			],
		});
	});

	test("the detail queues alone would lose the never-pushed drafts", async () => {
		const report = await catalogueEngine().process(LISTINGS);
		const inADetailQueue = new Set(
			DETAIL_BUCKETS.flatMap((name) => skus(report.buckets[name])),
		);

		assert.ok(!inADetailQueue.has("candle-ready-never-pushed"));
		assert.deepStrictEqual(skus(report.buckets.neverPushed), [
			"candle-ready-never-pushed",
			"hat-ready-never-pushed",
			"vase-partial-never-pushed",
			"ghost-blank",
		]);
	});

	test("a field is only wrong when we hold the value and the channel disagrees", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		// poster-no-price has no price to be wrong about, and the never-pushed
		// drafts have nothing on the channel to disagree with.
		assert.deepStrictEqual(skus(report.buckets.wrongPrice), [
			"mug-stale-price",
			"rug-wrong-everything",
		]);
		assert.deepStrictEqual(skus(report.buckets.missingPrice), [
			"poster-no-price",
			"vase-partial-never-pushed",
			"ghost-blank",
		]);
	});

	test("the two halves of a queue never overlap for one field", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		for (const field of ["Title", "Description", "Price", "Weight", "Photos"]) {
			const missing = new Set(
				skus(report.buckets[`missing${field}` as BucketName]),
			);
			const wrong = skus(report.buckets[`wrong${field}` as BucketName]);

			assert.deepStrictEqual(
				wrong.filter((sku) => missing.has(sku)),
				[],
				field,
			);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* ONLY                                                                        */
/* -------------------------------------------------------------------------- */

describe("the strict rules", () => {
	test("readyButNeverPushed is the complete drafts and nothing else", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		// rug-wrong-everything has the same five presence facts, but it is on the
		// channel, so ONLY rules it out.
		assert.deepStrictEqual(skus(report.buckets.readyButNeverPushed), [
			"candle-ready-never-pushed",
			"hat-ready-never-pushed",
		]);
	});

	test("ONLY counts the facts, not the names we gave to combinations", async () => {
		const assignment = await catalogueEngine().processOne(
			findListing("candle-ready-never-pushed"),
		);

		// Two computed conditions are true of this listing. If ONLY counted
		// those as well, "exactly these five and nothing else" could never hold.
		assert.strictEqual(
			assignment.conditions.hasAllRequiredDataForChannel,
			true,
		);
		assert.strictEqual(assignment.conditions.channelIsStale, true);
		assert.ok(assignment.buckets.includes("readyButNeverPushed"));
	});

	test("blank is the listing nobody has touched", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		assert.deepStrictEqual(skus(report.buckets.blank), ["ghost-blank"]);
	});

	test("ONLY refuses a computed condition", () => {
		const engine = catalogueConditions();

		assert.throws(
			() => {
				engine.defineBucket({
					name: "strict",
					// @ts-expect-error ONLY takes plain condition names only.
					checkFn: ({ ONLY }) => ONLY("hasAllRequiredDataForChannel"),
				});
			},
			(error: unknown) =>
				error instanceof BucketError &&
				error.message.includes(
					'computed condition "hasAllRequiredDataForChannel"',
				),
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Narrowing                                                                   */
/* -------------------------------------------------------------------------- */

describe("buckets that require a live listing know it", () => {
	test("a wrong-field queue hands back a listing whose channel is there", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		type _Items = Expect<
			Equal<typeof report.buckets.wrongPrice, SyncedListing[]>
		>;

		// No null check, no cast: `isOnChannel` is a type predicate, and AND
		// carried what it proved through to the bucket.
		assert.deepStrictEqual(
			report.buckets.wrongPrice.map((listing) => listing.channel.priceCents),
			[1999, 100],
		);
	});

	test("knowing a listing is *not* on the channel proves nothing", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		type _Items = Expect<Equal<typeof report.buckets.neverPushed, Listing[]>>;

		assert.strictEqual(report.buckets.neverPushed[0]?.channel, null);
	});

	test("a rule built from plain booleans keeps the engine's input type", async () => {
		const report = await catalogueEngine().process(LISTINGS);

		type _Items = Expect<
			Equal<typeof report.buckets.listedProperly, Listing[]>
		>;

		assert.strictEqual(report.buckets.listedProperly.length, 2);
	});
});

/* -------------------------------------------------------------------------- */
/* Bad data                                                                    */
/* -------------------------------------------------------------------------- */

describe("rows the channel manager should never have exported", () => {
	const broken = {
		sku: "",
		title: 42,
		description: null,
		priceCents: "24.99",
		weightGrams: null,
		photoUrls: "front.jpg",
	} as unknown as Listing;

	test("one unparseable row does not cost the other twelve", async () => {
		const report = await catalogueEngine().process([...LISTINGS, broken]);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "input");
		assert.strictEqual(report.errors[0]?.condition, undefined);
		assert.strictEqual(report.errors[0]?.item, broken);

		for (const name of BUCKET_NAMES) {
			assert.deepStrictEqual(
				skus(report.buckets[name]),
				expectedMembers(name),
				name,
			);
		}
	});

	test("the failure carries the schema's own issues, one per bad field", async () => {
		const report = await catalogueEngine().process([broken]);
		const error = report.errors[0]?.error;

		assert.ok(error instanceof BucketError);
		assert.deepStrictEqual(
			error.issues?.map((issue) => (issue.path ?? []).join(".")),
			["sku", "title", "priceCents", "photoUrls", "channel"],
		);
		assert.match(
			error.message,
			/^Input validation failed: sku: expected a non-empty string/,
		);
	});

	test("a nested channel field is reported at its own path", async () => {
		const report = await catalogueEngine().process([
			{
				...findListing("beanie-perfect"),
				channel: { ...findListing("beanie-perfect"), priceCents: "2499" },
			} as unknown as Listing,
		]);

		const error = report.errors[0]?.error;

		assert.ok(error instanceof BucketError);
		assert.deepStrictEqual(
			error.issues?.map((issue) => (issue.path ?? []).join(".")),
			["channel.priceCents"],
		);
	});

	test("processOne throws instead, because there is no batch to protect", async () => {
		await assert.rejects(() => catalogueEngine().processOne(broken), {
			name: "BucketError",
			message: /Input validation failed/,
		});
	});
});

describe("a condition that cannot answer", () => {
	/** One condition asks the channel's API, and the API is having a day. */
	function liveEngine() {
		return new BucketEngine()
			.defineInput(listingSchema)
			.defineCondition({
				name: "hasPrice",
				checkFn: (listing) => listing.priceCents !== null,
			})
			.defineCondition({
				name: "channelConfirmsPrice",
				checkFn: async (listing) => {
					if (listing.sku === "rug-wrong-everything") {
						throw new Error("channel API responded 503");
					}
					return (
						listing.channel !== null &&
						listing.channel.priceCents === listing.priceCents
					);
				},
			})
			.defineBucket({
				name: "confirmed",
				checkFn: ({ AND }) => AND("hasPrice", "channelConfirmsPrice"),
			})
			.defineBucket({
				name: "unconfirmed",
				checkFn: ({ NOT }) => NOT("channelConfirmsPrice"),
			});
	}

	test("the listing lands in errors, named by the condition that threw", async () => {
		const report = await liveEngine().process(LISTINGS);

		assert.strictEqual(report.errors.length, 1);
		assert.strictEqual(report.errors[0]?.stage, "condition");
		assert.strictEqual(report.errors[0]?.condition, "channelConfirmsPrice");
		assert.strictEqual(report.errors[0]?.item.sku, "rug-wrong-everything");
		assert.match(report.errors[0]?.error.message ?? "", /503/);
	});

	test("it is in no bucket at all, not even the negative one", async () => {
		const report = await liveEngine().process(LISTINGS);
		const placed = skus(Object.values(report.buckets).flat());

		assert.ok(!placed.includes("rug-wrong-everything"));
		assert.ok(
			!report.unmatched.some(
				(entry) => entry.item.sku === "rug-wrong-everything",
			),
		);
	});

	test("the rest of the catalogue is classified as usual", async () => {
		const report = await liveEngine().process(LISTINGS);
		const accounted = new Set([
			...skus(Object.values(report.buckets).flat()),
			...report.unmatched.map((entry) => entry.item.sku),
			...report.errors.map((failure) => failure.item.sku),
		]);

		assert.strictEqual(accounted.size, LISTINGS.length);
		assert.deepStrictEqual(skus(report.buckets.confirmed), [
			"beanie-perfect",
			"socks-perfect",
			"tee-stale-photos",
			"lamp-stale-title-and-weight",
			// poster-no-price has no price for the channel to confirm.
			"charger-no-photos",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* Conditions that call the channel                                            */
/* -------------------------------------------------------------------------- */

describe("conditions that go out to the channel's API", () => {
	function probe(delayMs = 5) {
		let inFlight = 0;
		const state = { peak: 0, calls: 0 };

		return {
			state,
			checkFn: async (listing: Listing): Promise<boolean> => {
				inFlight += 1;
				state.calls += 1;
				state.peak = Math.max(state.peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				inFlight -= 1;
				return listing.channel !== null;
			},
		};
	}

	function apiEngine(checkFn: (listing: Listing) => Promise<boolean>) {
		return new BucketEngine()
			.defineInput(listingSchema)
			.defineCondition({ name: "channelResponds", checkFn })
			.defineBucket({ name: "live", checkFn: () => "channelResponds" })
			.defineBucket({
				name: "dark",
				checkFn: ({ NOT }) => NOT("channelResponds"),
			});
	}

	test("concurrency caps how many listings are in flight", async () => {
		const api = probe();
		await apiEngine(api.checkFn).process(LISTINGS, { concurrency: 3 });

		assert.strictEqual(api.state.peak, 3);
		assert.strictEqual(api.state.calls, LISTINGS.length);
	});

	test("one at a time is available for an API that asks for it", async () => {
		const api = probe(1);
		await apiEngine(api.checkFn).process(LISTINGS, { concurrency: 1 });

		assert.strictEqual(api.state.peak, 1);
	});

	test("a catalogue smaller than the default runs in one wave", async () => {
		const api = probe(1);
		await apiEngine(api.checkFn).process(LISTINGS);

		assert.strictEqual(api.state.peak, LISTINGS.length);
	});

	test("the report is in catalogue order however it was scheduled", async () => {
		const api = probe(1);
		const report = await apiEngine(api.checkFn).process(LISTINGS, {
			concurrency: 2,
		});

		assert.deepStrictEqual(skus(report.buckets.live), [
			"beanie-perfect",
			"socks-perfect",
			"mug-stale-price",
			"tee-stale-photos",
			"lamp-stale-title-and-weight",
			"rug-wrong-everything",
			"poster-no-price",
			"charger-no-photos",
		]);
		assert.deepStrictEqual(skus(report.buckets.dark), [
			"candle-ready-never-pushed",
			"hat-ready-never-pushed",
			"vase-partial-never-pushed",
			"ghost-blank",
		]);
	});

	test("a nonsensical limit is rejected rather than deadlocking the sync", async () => {
		const api = probe(0);

		await assert.rejects(
			() => apiEngine(api.checkFn).process(LISTINGS, { concurrency: 0 }),
			{ name: "BucketError", message: /positive integer/ },
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Mistakes in the model itself                                                */
/* -------------------------------------------------------------------------- */

describe("mistakes this model invites", () => {
	test("a fact added after the phrases built on them is refused", () => {
		const engine = catalogueConditions();

		assert.throws(() => {
			// @ts-expect-error every condition comes before the first computed one.
			engine.defineCondition({ name: "hasBrand", checkFn: () => true });
		}, BucketError);
	});

	test("a phrase added after the first rule is refused", () => {
		const engine = catalogueEngine();
		const tooLate = {
			name: "sellable",
			checkFn: () => "hasAllRequiredDataForChannel",
		} as const;

		assert.throws(() => {
			// @ts-expect-error ONLY depends on the complete set of conditions.
			engine.defineComputedCondition(tooLate);
		}, BucketError);
	});

	test("a rule naming a condition that does not exist is refused", () => {
		const engine = catalogueConditions();

		assert.throws(
			() => {
				engine.defineBucket({
					name: "typo",
					// @ts-expect-error there is no "hasPhotoes".
					checkFn: ({ NOT }) => NOT("hasPhotoes"),
				});
			},
			(error: unknown) =>
				error instanceof BucketError &&
				error.message.includes('unknown condition "hasPhotoes"'),
		);
	});

	test("two buckets cannot share a name", () => {
		const engine = catalogueEngine();
		const duplicate = {
			name: "needsSync",
			checkFn: () => "channelIsStale",
		} as const;

		assert.throws(() => {
			// @ts-expect-error "needsSync" is already a bucket.
			engine.defineBucket(duplicate);
		}, BucketError);
	});

	test("a rule that can never match is legal, and simply stays empty", async () => {
		const report = await catalogueConditions()
			.defineBucket({
				name: "impossible",
				checkFn: ({ AND, NOT }) =>
					AND("hasAllRequiredDataForChannel", NOT("hasTitle")),
			})
			.process(LISTINGS);

		assert.deepStrictEqual(report.buckets.impossible, []);
		assert.strictEqual(report.unmatched.length, LISTINGS.length);
	});
});
