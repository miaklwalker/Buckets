import { BucketError } from "./types.ts";

/**
 * Enumerating every combination of conditions is exponential, so the one place
 * that does it stops here rather than hanging. 16 conditions is 65,536
 * combinations, already well past the point where a rule set is readable.
 *
 * Nothing on the hot path enumerates: sorting an item evaluates each bucket's
 * expression against that item's results, so the cap only ever applies to
 * `missingCombinations()`.
 */
export const MAX_ENUMERABLE_CONDITIONS = 16;

/**
 * Every possible assignment of verdicts over `conditionNames`, each as the set
 * of conditions that are true.
 */
export function allAssignments(
	conditionNames: readonly string[],
	what: string,
): Set<string>[] {
	if (conditionNames.length > MAX_ENUMERABLE_CONDITIONS) {
		throw new BucketError(
			`${what} enumerates 2^n combinations and refuses to do so for ${conditionNames.length} conditions.`,
		);
	}

	const assignments: Set<string>[] = [];
	for (let mask = 0; mask < 2 ** conditionNames.length; mask += 1) {
		const truths = new Set<string>();
		for (const [index, name] of conditionNames.entries()) {
			if (mask & (1 << index)) truths.add(name);
		}
		assignments.push(truths);
	}
	return assignments;
}
