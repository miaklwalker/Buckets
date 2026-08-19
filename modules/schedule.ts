import { BucketError, DEFAULT_CONCURRENCY } from "./types.ts";

/**
 * Runs `worker` over `items` with at most `limit` in flight, resolving to the
 * results **in input order** — the whole point, since a bucketed report that
 * reshuffled itself depending on how fast each predicate resolved would be
 * miserable to diff or snapshot.
 *
 * `onSettled`, if given, fires once per item as soon as *that* item's worker
 * resolves — in completion order, not input order, since that's the only
 * order live progress reporting can honestly claim. Purely an observation
 * hook: nothing about the returned array depends on it.
 *
 * Not exported from the package barrel: it exists so `.process()` can honour
 * `concurrency` without pulling in a dependency.
 */
export async function mapWithConcurrency<TItem, TResult>(
	items: readonly TItem[],
	limit: number,
	worker: (item: TItem, index: number) => Promise<TResult>,
	onSettled?: (result: TResult, index: number) => void,
): Promise<TResult[]> {
	const results = new Array<TResult>(items.length);
	if (items.length === 0) return results;

	let cursor = 0;
	const lanes = Math.min(limit, items.length);

	await Promise.all(
		Array.from({ length: lanes }, async () => {
			while (cursor < items.length) {
				const index = cursor;
				cursor += 1;
				// Guarded by the loop condition above, so the index is in range.
				const result = await worker(items[index] as TItem, index);
				results[index] = result;
				onSettled?.(result, index);
			}
		}),
	);

	return results;
}

/** Rejects the values that would silently turn concurrency into a deadlock. */
export function resolveConcurrency(concurrency: number | undefined): number {
	if (concurrency === undefined) return DEFAULT_CONCURRENCY;
	if (concurrency === Number.POSITIVE_INFINITY) return concurrency;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new BucketError(
			`concurrency must be a positive integer or Infinity, received ${String(concurrency)}.`,
		);
	}
	return concurrency;
}
