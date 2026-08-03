import { BucketError, DEFAULT_CONCURRENCY } from "./types.ts";

/**
 * Runs `worker` over `items` with at most `limit` in flight, resolving to the
 * results **in input order** — the whole point, since a bucketed report that
 * reshuffled itself depending on how fast each predicate resolved would be
 * miserable to diff or snapshot.
 *
 * Not exported from the package barrel: it exists so `.process()` can honour
 * `concurrency` without pulling in a dependency.
 */
export async function mapWithConcurrency<TItem, TResult>(
	items: readonly TItem[],
	limit: number,
	worker: (item: TItem, index: number) => Promise<TResult>,
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
				results[index] = await worker(items[index] as TItem, index);
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
