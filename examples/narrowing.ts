/**
 * A bucket per JavaScript type — and each one knows what's in it.
 *
 * Declare a condition with a **type predicate** instead of a plain boolean and
 * the engine records what that condition proves. The combinators then carry it
 * through the expression, so `report.buckets.strings` is `string[]`, not
 * `unknown[]`, and calling `.toUpperCase()` on one compiles.
 *
 * Run with:
 *   node --experimental-transform-types examples/narrowing.ts
 */
import { BucketEngine } from "../main.ts";

const MESS: unknown[] = [
	"hello",
	42,
	true,
	null,
	undefined,
	[1, 2, 3],
	new Date("2026-07-31"),
	{ name: "walker" },
	() => "callable",
	Number.NaN,
	"",
	0,
];

const sorter = new BucketEngine()
	.defineInput<unknown>()
	// Each of these is `(v): v is X`, so the engine learns what it proves.
	.defineCondition({
		name: "isString",
		checkFn: (v): v is string => typeof v === "string",
	})
	.defineCondition({
		name: "isNumber",
		checkFn: (v): v is number => typeof v === "number",
	})
	.defineCondition({
		name: "isBoolean",
		checkFn: (v): v is boolean => typeof v === "boolean",
	})
	.defineCondition({
		name: "isNull",
		checkFn: (v): v is null => v === null,
	})
	.defineCondition({
		name: "isUndefined",
		checkFn: (v): v is undefined => v === undefined,
	})
	.defineCondition({
		name: "isArray",
		checkFn: (v): v is unknown[] => Array.isArray(v),
	})
	.defineCondition({
		name: "isDate",
		checkFn: (v): v is Date => v instanceof Date,
	})
	.defineCondition({
		name: "isFunction",
		checkFn: (v): v is (...args: unknown[]) => unknown =>
			typeof v === "function",
	})
	// Deliberately NOT a type predicate — it proves nothing about the type.
	.defineCondition({ name: "isTruthy", checkFn: (v) => Boolean(v) })
	// One bucket per type. A bare name is the whole rule.
	.defineBucket({ name: "strings", checkFn: () => "isString" })
	.defineBucket({ name: "numbers", checkFn: () => "isNumber" })
	.defineBucket({ name: "booleans", checkFn: () => "isBoolean" })
	.defineBucket({ name: "arrays", checkFn: () => "isArray" })
	.defineBucket({ name: "dates", checkFn: () => "isDate" })
	.defineBucket({ name: "functions", checkFn: () => "isFunction" })
	// OR gives you the union of what its branches prove.
	.defineBucket({
		name: "nullish",
		checkFn: ({ OR }) => OR("isNull", "isUndefined"),
	})
	.defineBucket({
		name: "primitives",
		checkFn: ({ OR }) => OR("isString", "isNumber", "isBoolean"),
	})
	// AND gives you the intersection. `isTruthy` proves nothing, so it narrows
	// the *set* without widening the type: still string[].
	.defineBucket({
		name: "nonEmptyStrings",
		checkFn: ({ AND }) => AND("isString", "isTruthy"),
	})
	// NOT can't narrow — knowing something isn't a string says nothing about
	// what it is — so this one is honestly typed as unknown[].
	.defineBucket({
		name: "notStrings",
		checkFn: ({ NOT }) => NOT("isString"),
	});

const report = await sorter.process(MESS);

/* -------------------------------------------------------------------------- */
/* The point: none of these need a cast or a guard.                            */
/* -------------------------------------------------------------------------- */

const shouted = report.buckets.strings.map((s) => s.toUpperCase());
const doubled = report.buckets.numbers.map((n) => n * 2);
const lengths = report.buckets.arrays.map((a) => a.length);
const years = report.buckets.dates.map((d) => d.getFullYear());
const called = report.buckets.functions.map((f) => f());
const flipped = report.buckets.booleans.map((b) => !b);
const trimmed = report.buckets.nonEmptyStrings.map((s) => s.trim().length);

console.log("strings         ", report.buckets.strings, "->", shouted);
console.log("numbers         ", report.buckets.numbers, "->", doubled);
console.log("booleans        ", report.buckets.booleans, "->", flipped);
console.log("arrays          ", report.buckets.arrays, "->", lengths);
console.log("dates           ", report.buckets.dates, "->", years);
console.log("functions       ", report.buckets.functions.length, "->", called);
console.log("nullish         ", report.buckets.nullish);
console.log("primitives      ", report.buckets.primitives);
console.log("nonEmptyStrings ", report.buckets.nonEmptyStrings, "->", trimmed);
console.log("notStrings      ", report.buckets.notStrings.length, "items");
console.log("unmatched       ", report.unmatched.length);

/* -------------------------------------------------------------------------- */
/* And the mistakes the compiler catches.                                      */
/* -------------------------------------------------------------------------- */

/**
 * Never called. `@ts-expect-error` only silences the compiler — the line still
 * runs — so these live somewhere nothing executes. Each one fails to compile if
 * you delete its comment, which is the actual demonstration.
 */
function rejectedAtCompileTime(): void {
	// @ts-expect-error strings is string[], never number[].
	const wrongType: number[] = report.buckets.strings;

	// @ts-expect-error a union of primitives has no .toUpperCase().
	report.buckets.primitives.map((p) => p.toUpperCase());

	// @ts-expect-error NOT proves nothing, so these stay unknown.
	report.buckets.notStrings.map((v) => v.length);

	// @ts-expect-error the bucket name has to exist.
	report.buckets.symbols;

	void wrongType;
}

void rejectedAtCompileTime;
