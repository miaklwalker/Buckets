import type { ConditionBatchReport, ConditionSummary } from "./types.ts";

/** Per-call knobs for {@link formatConditionReport}. */
export interface ConditionReportOptions {
	/**
	 * How many characters wide the distribution bar is. Defaults to `20`.
	 */
	readonly barWidth?: number;
}

const FILLED = "█";
const EMPTY = "░";

const HEADERS = [
	"Group",
	"Condition",
	"Passing",
	"Failing",
	"Distribution",
] as const;

function bar(passing: number, total: number, width: number): string {
	if (total === 0) return EMPTY.repeat(width);
	const filled = Math.round((passing / total) * width);
	return FILLED.repeat(filled) + EMPTY.repeat(width - filled);
}

function padEnd(value: string, width: number): string {
	return value.length >= width
		? value
		: value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
	return value.length >= width
		? value
		: " ".repeat(width - value.length) + value;
}

/**
 * Rows sorted so entries sharing a `group` sit together, in the order each
 * group was first seen; entries with no `group` sort last. Within a group,
 * definition order — {@link ConditionSummary} arrives in that order already,
 * and `Array.prototype.sort` is stable — so this only ever reorders across
 * groups, never within one.
 */
function sortByGroup<TConditions extends string>(
	summary: readonly ConditionSummary<TConditions>[],
): readonly ConditionSummary<TConditions>[] {
	const firstSeenAt = new Map<string | undefined, number>();
	for (const entry of summary) {
		if (!firstSeenAt.has(entry.group))
			firstSeenAt.set(entry.group, firstSeenAt.size);
	}
	const rank = (group: string | undefined) =>
		group === undefined
			? Number.POSITIVE_INFINITY
			: (firstSeenAt.get(group) ?? 0);

	return [...summary].sort((a, b) => rank(a.group) - rank(b.group));
}

/**
 * Renders a {@link ConditionBatchReport}'s `summary` as a table — one row per
 * condition, grouped by {@link ConditionSummary.group}, with a block-drawn
 * bar showing what fraction of the batch passed:
 *
 * ```
 * ┌───────────┬────────────┬─────────┬─────────┬──────────────────────┐
 * │ Group     │ Condition  │ Passing │ Failing │ Distribution         │
 * ├───────────┼────────────┼─────────┼─────────┼──────────────────────┤
 * │ Existence │ hasProduct │     150 │     150 │ ██████████░░░░░░░░░░ │
 * │ Existence │ hasBrand   │     300 │       0 │ ████████████████████ │
 * └───────────┴────────────┴─────────┴─────────┴──────────────────────┘
 * ```
 *
 * A condition given no `group` prints `—` and sorts after every grouped one.
 * Pure string building — nothing here writes to the console; pass the result
 * to `console.log` yourself, or use {@link printConditionReport}.
 */
export function formatConditionReport<TInput, TConditions extends string>(
	report: ConditionBatchReport<TInput, TConditions>,
	options: ConditionReportOptions = {},
): string {
	const barWidth = options.barWidth ?? 20;
	if (!Number.isInteger(barWidth) || barWidth < 1) {
		throw new RangeError("barWidth must be a positive integer.");
	}

	const rows = sortByGroup(report.summary).map((entry) => ({
		group: entry.group ?? "—",
		name: entry.name,
		passing: String(entry.passing),
		failing: String(entry.failing),
		bar: bar(entry.passing, entry.passing + entry.failing, barWidth),
	}));

	const widths = [
		Math.max(HEADERS[0].length, ...rows.map((r) => r.group.length)),
		Math.max(HEADERS[1].length, ...rows.map((r) => r.name.length)),
		Math.max(HEADERS[2].length, ...rows.map((r) => r.passing.length)),
		Math.max(HEADERS[3].length, ...rows.map((r) => r.failing.length)),
		barWidth,
	];

	const border = (left: string, mid: string, right: string) =>
		left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

	const line = (
		cells: readonly string[],
		align: readonly ("start" | "end")[],
	) =>
		`│ ${cells.map((cell, i) => (align[i] === "end" ? padStart(cell, widths[i] ?? 0) : padEnd(cell, widths[i] ?? 0))).join(" │ ")} │`;

	const lines = [
		border("┌", "┬", "┐"),
		line(HEADERS, ["start", "start", "end", "end", "start"]),
		border("├", "┼", "┤"),
		...rows.map((row) =>
			line(
				[row.group, row.name, row.passing, row.failing, row.bar],
				["start", "start", "end", "end", "start"],
			),
		),
		border("└", "┴", "┘"),
	];

	return lines.join("\n");
}

/**
 * {@link formatConditionReport}, written straight to `console.log`.
 */
export function printConditionReport<TInput, TConditions extends string>(
	report: ConditionBatchReport<TInput, TConditions>,
	options?: ConditionReportOptions,
): void {
	console.log(formatConditionReport(report, options));
}
