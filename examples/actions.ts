/**
 * Dispatching effects for orders, where an action is a predicate and the
 * effect that runs when it matches — collapsed into one step, unlike
 * BucketEngine's separate defineCondition/defineBucket.
 *
 * Actions are independent, so an order that is both paid and risky triggers
 * both "notifyWarehouse" and "flagForReview" — nothing had to be enumerated
 * to say so. And because they're independent, one action failing on an order
 * never stops another action from running on that same order: see how
 * "chargeFraudFee" failing for order-3 doesn't touch "flagForReview" below.
 *
 * Run with:
 *   node --experimental-transform-types examples/actions.ts
 */
import { ActionEngine } from "../main.ts";

interface Order {
	readonly id: string;
	readonly status: "paid" | "pending" | "refunded";
	readonly riskScore: number;
}

const ORDERS: Order[] = [
	{ id: "order-1", status: "paid", riskScore: 10 },
	{ id: "order-2", status: "pending", riskScore: 5 },
	{ id: "order-3", status: "paid", riskScore: 92 },
	{ id: "order-4", status: "refunded", riskScore: 0 },
];

async function chargeFraudFee(orderId: string): Promise<string> {
	if (orderId === "order-3") throw new Error("payment gateway timed out");
	return `fee charged: ${orderId}`;
}

const dispatch = new ActionEngine()
	.defineInput<Order>()
	.defineAction({
		name: "notifyWarehouse",
		checkFn: (order) => order.status === "paid",
		actionFn: (order) => `dispatched: ${order.id}`,
	})
	.defineAction({
		name: "flagForReview",
		checkFn: (order) => order.riskScore > 80,
		actionFn: (order) => `flagged: ${order.id} (score ${order.riskScore})`,
	})
	.defineAction({
		name: "chargeFraudFee",
		checkFn: (order) => order.riskScore > 80,
		actionFn: (order) => chargeFraudFee(order.id),
	});

const report = await dispatch.process(ORDERS);

for (const [action, runs] of Object.entries(report.results)) {
	console.log(`${action}: ${runs.map((run) => run.result).join(", ") || "—"}`);
}

// order-3's chargeFraudFee threw, but flagForReview still ran for it — the
// two actions share a checkFn, not a fate.
for (const failure of report.errors) {
	console.log(`failed (${failure.action}): ${failure.error.message}`);
}

// order-4 is refunded and low-risk, so no action claims it.
console.log(
	"unmatched:",
	report.unmatched.map((entry) => entry.item.id),
);

// A single item, for the request-handler case.
const one = await dispatch.processOne({
	id: "order-5",
	status: "paid",
	riskScore: 15,
});
console.log(`order-5 -> [${one.matched.join(", ")}]`, one.checks);
