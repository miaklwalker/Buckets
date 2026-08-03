/**
 * Triaging support tickets, where deciding a condition means an async call.
 *
 * Shows the three things that matter once conditions leave pure-function land:
 * a Standard Schema validating what arrives, `concurrency` so a large batch
 * doesn't open one connection per item, and `report.errors` collecting the
 * items whose lookups failed instead of losing the batch to one bad ticket.
 *
 * Run with:
 *   node --experimental-transform-types examples/triage.ts
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BucketEngine } from "../main.ts";

interface Ticket {
	readonly id: string;
	readonly accountId: string;
	readonly body: string;
}

/**
 * A Standard Schema written by hand so the example has no dependencies — Zod,
 * Valibot, ArkType and friends all satisfy this same interface, so in real code
 * this is `z.object({ ... })`.
 */
const ticketSchema: StandardSchemaV1<unknown, Ticket> = {
	"~standard": {
		version: 1,
		vendor: "example",
		validate: (value) => {
			const ticket = value as Partial<Ticket>;
			if (typeof ticket?.id !== "string") {
				return { issues: [{ message: "id must be a string", path: ["id"] }] };
			}
			// Schemas may transform; the trimmed body is what conditions receive.
			return {
				value: {
					id: ticket.id,
					accountId: String(ticket.accountId),
					body: (ticket.body ?? "").trim(),
				},
			};
		},
	},
};

/** Stands in for the billing service. Throws for an account it cannot find. */
async function isPaidAccount(accountId: string): Promise<boolean> {
	await new Promise((resolve) => setTimeout(resolve, 10));
	if (accountId === "acct-missing") {
		throw new Error(`no such account: ${accountId}`);
	}
	return accountId.endsWith("-pro");
}

const triage = new BucketEngine()
	.defineInput(ticketSchema)
	.defineCondition({
		name: "payingCustomer",
		checkFn: (ticket) => isPaidAccount(ticket.accountId),
	})
	.defineCondition({
		name: "mentionsOutage",
		checkFn: (ticket) => /outage|down|500/i.test(ticket.body),
	})
	// Paging and queueing are separate decisions, so a paying customer reporting
	// an outage lands in both — no rule has to exclude the other.
	.defineBucket({
		name: "pageOnCall",
		checkFn: ({ AND }) => AND("payingCustomer", "mentionsOutage"),
	})
	.defineBucket({ name: "priorityQueue", checkFn: () => "payingCustomer" })
	.defineBucket({
		name: "communityForum",
		checkFn: ({ AND, NOT }) => AND("mentionsOutage", NOT("payingCustomer")),
	});

const report = await triage.process(
	[
		{ id: "t-1", accountId: "acct-1-pro", body: "  everything is down  " },
		{ id: "t-2", accountId: "acct-2-pro", body: "how do I export?" },
		{ id: "t-3", accountId: "acct-3-free", body: "site returns 500" },
		{ id: "t-4", accountId: "acct-4-free", body: "love the product" },
		{ id: "t-5", accountId: "acct-missing", body: "billing question" },
		{
			id: 42,
			accountId: "acct-6-pro",
			body: "typed wrong",
		} as unknown as Ticket,
	],
	{ concurrency: 4 },
);

for (const [queue, tickets] of Object.entries(report.buckets)) {
	console.log(`${queue}: ${tickets.map((t) => t.id).join(", ") || "—"}`);
}

// t-5's lookup threw and t-6 failed validation. Neither stopped the other four.
for (const failure of report.errors) {
	const where = failure.condition ?? failure.stage;
	console.log(`failed (${where}): ${failure.error.message}`);
}

// t-4 is a free user with no outage, so no rule claims it. Ask up front which
// combinations that will be true of, rather than waiting for the data to say.
console.log(
	"unmatched:",
	report.unmatched.map((entry) => entry.item.id),
);
console.log("uncovered combinations:", triage.missingCombinations());
