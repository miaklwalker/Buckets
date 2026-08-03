import assert from "node:assert";
import test, { describe } from "node:test";
import { BucketEngine } from "../main.ts";
import type { Equal, Expect, ItemsOf } from "./support.ts";

/** A guard-heavy engine over `unknown`, the extreme case for narrowing. */
function typeSorter() {
	return (
		new BucketEngine()
			.defineInput<unknown>()
			.defineCondition({
				name: "isString",
				checkFn: (v): v is string => typeof v === "string",
			})
			.defineCondition({
				name: "isNumber",
				checkFn: (v): v is number => typeof v === "number",
			})
			.defineCondition({
				name: "isArray",
				checkFn: (v): v is unknown[] => Array.isArray(v),
			})
			// Not a type predicate: proves nothing about the type.
			.defineCondition({ name: "isTruthy", checkFn: (v) => Boolean(v) })
	);
}

const MESS: unknown[] = ["hello", "", 42, 0, [1], null];

describe("type predicates narrow their bucket", () => {
	test("a bare guarded name gives the guarded type", async () => {
		const engine = typeSorter().defineBucket({
			name: "strings",
			checkFn: () => "isString",
		});

		type _Items = Expect<Equal<ItemsOf<typeof engine, "strings">, string>>;

		const report = await engine.process(MESS);
		// The type says string[]; the runtime had better agree.
		assert.deepStrictEqual(
			report.buckets.strings.map((s) => s.toUpperCase()),
			["HELLO", ""],
		);
	});

	test("OR gives the union of what its branches prove", async () => {
		const engine = typeSorter().defineBucket({
			name: "scalars",
			checkFn: ({ OR }) => OR("isString", "isNumber"),
		});

		type _Items = Expect<
			Equal<ItemsOf<typeof engine, "scalars">, string | number>
		>;

		const report = await engine.process(MESS);
		assert.strictEqual(report.buckets.scalars.length, 4);
	});

	test("AND gives the intersection", () => {
		const engine = typeSorter().defineBucket({
			name: "impossible",
			checkFn: ({ AND }) => AND("isString", "isNumber"),
		});

		// `string & number` is uninhabited, so the bucket's type says nothing can
		// ever be in it — which is exactly true of a contradictory rule. The
		// phantom that carries the narrowing is wrapped in a tuple precisely so
		// this stays `never` instead of collapsing to `undefined`.
		type Item = ItemsOf<typeof engine, "impossible">;
		type _Items = Expect<Equal<Item, never>>;

		assert.deepStrictEqual(engine.bucketNames, ["impossible"]);
	});

	test("a non-predicate condition narrows the set without widening the type", async () => {
		const engine = typeSorter().defineBucket({
			name: "truthyStrings",
			checkFn: ({ AND }) => AND("isString", "isTruthy"),
		});

		// The killer case: `isTruthy` contributes `unknown`, and if the operands
		// were folded through a union that would collapse the whole thing to
		// unknown. Intersecting keeps it as string.
		type _Items = Expect<
			Equal<ItemsOf<typeof engine, "truthyStrings">, string>
		>;

		const report = await engine.process(MESS);
		assert.deepStrictEqual(report.buckets.truthyStrings, ["hello"]);
	});

	test("NOT proves nothing, so the bucket falls back to the input type", async () => {
		const engine = typeSorter().defineBucket({
			name: "notStrings",
			checkFn: ({ NOT }) => NOT("isString"),
		});

		type _Items = Expect<Equal<ItemsOf<typeof engine, "notStrings">, unknown>>;

		const report = await engine.process(MESS);
		assert.strictEqual(report.buckets.notStrings.length, 4);
	});

	test("ONLY intersects the names it lists", () => {
		const engine = typeSorter().defineBucket({
			name: "justAString",
			checkFn: ({ ONLY }) => ONLY("isString"),
		});

		type _Items = Expect<Equal<ItemsOf<typeof engine, "justAString">, string>>;

		assert.deepStrictEqual(engine.bucketNames, ["justAString"]);
	});
});

describe("narrowing over a discriminated union", () => {
	interface Message<TKind extends string, TChannel extends string, TPayload> {
		readonly kind: TKind;
		readonly channel: TChannel;
		readonly payload: TPayload;
	}

	/**
	 * Both discriminants are literal *per variant*. Writing `channel:
	 * "email" | "sms"` inside one variant instead would make
	 * `Extract<Envelope, { channel: "email" }>` empty, since no member of the
	 * union extends it — a modelling trap that has nothing to do with buckets.
	 */
	type Envelope =
		| Message<"welcome", "email", { name: string }>
		| Message<"welcome", "sms", { name: string }>
		| Message<"receipt", "email", { total: number }>
		| Message<"receipt", "sms", { total: number }>;

	function messages() {
		return new BucketEngine()
			.defineInput<Envelope>()
			.defineCondition({
				name: "isWelcome",
				checkFn: (m): m is Extract<Envelope, { kind: "welcome" }> =>
					m.kind === "welcome",
			})
			.defineCondition({
				name: "isEmail",
				checkFn: (m): m is Extract<Envelope, { channel: "email" }> =>
					m.channel === "email",
			});
	}

	test("intersecting two narrowed unions reduces to the shared variant", async () => {
		const engine = messages().defineBucket({
			name: "welcomeEmails",
			checkFn: ({ AND }) => AND("isWelcome", "isEmail"),
		});

		type Item = ItemsOf<typeof engine, "welcomeEmails">;
		type _Payload = Expect<Equal<Item["payload"], { name: string }>>;

		const report = await engine.process([
			{ kind: "welcome", channel: "email", payload: { name: "Ada" } },
			{ kind: "receipt", channel: "email", payload: { total: 12 } },
			{ kind: "welcome", channel: "sms", payload: { name: "Grace" } },
		]);

		assert.deepStrictEqual(
			report.buckets.welcomeEmails.map((m) => m.payload.name),
			["Ada"],
		);
	});

	test("a predicate TypeScript infers for itself narrows just the same", async () => {
		// No `m is ...` written anywhere. TypeScript infers the type predicate
		// from the body (5.5+), and the engine picks it up for free.
		const engine = new BucketEngine()
			.defineInput<Envelope>()
			.defineCondition({
				name: "isEmail",
				checkFn: (m) => m.channel === "email",
			})
			.defineBucket({ name: "emails", checkFn: () => "isEmail" });

		type _Items = Expect<
			Equal<
				ItemsOf<typeof engine, "emails">,
				Extract<Envelope, { channel: "email" }>
			>
		>;

		const report = await engine.process([
			{ kind: "welcome", channel: "email", payload: { name: "Ada" } },
		]);
		assert.strictEqual(report.buckets.emails.length, 1);
	});

	test("a checkFn that narrows nothing falls back to the input type", async () => {
		const engine = new BucketEngine()
			.defineInput<Envelope>()
			.defineCondition({
				name: "hasLongKind",
				checkFn: (m) => m.kind.length > 3,
			})
			.defineBucket({ name: "verbose", checkFn: () => "hasLongKind" });

		type _Items = Expect<Equal<ItemsOf<typeof engine, "verbose">, Envelope>>;

		const report = await engine.process([
			{ kind: "welcome", channel: "email", payload: { name: "Ada" } },
		]);
		assert.strictEqual(report.buckets.verbose.length, 1);
	});

	test("unmatched and errors keep the full input type, not a narrowed one", async () => {
		const engine = messages().defineBucket({
			name: "welcomeEmails",
			checkFn: ({ AND }) => AND("isWelcome", "isEmail"),
		});

		const report = await engine.process([
			{ kind: "receipt", channel: "sms", payload: { total: 5 } },
		]);

		type _Unmatched = Expect<
			Equal<(typeof report.unmatched)[number]["item"], Envelope>
		>;

		assert.strictEqual(report.unmatched.length, 1);
	});
});
