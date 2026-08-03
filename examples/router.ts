/**
 * An HTTP router, where the buckets are endpoints.
 *
 * Requests arrive as one big union. Conditions are type predicates over the
 * pieces of a request — method, path — and a route is just `AND` of the two.
 * Because TypeScript reduces the intersection of two narrowed unions down to
 * the single variant they have in common, `report.buckets.createUser` is
 * exactly the POST /users shape: reading `.body.email` compiles, and reading
 * `.body.sku` doesn't.
 *
 * The two leftovers map onto things a router already has names for:
 * `unmatched` is a 404, and `errors` is a 500.
 *
 * Run with:
 *   node --experimental-transform-types examples/router.ts
 */
import { BucketEngine } from "../main.ts";

interface Request<TMethod extends string, TPath extends string, TBody> {
	readonly method: TMethod;
	readonly path: TPath;
	readonly body: TBody;
	readonly authorization: string | null;
}

type IncomingRequest =
	| Request<"GET", "/users", undefined>
	| Request<"POST", "/users", { name: string; email: string }>
	| Request<"DELETE", "/users", undefined>
	| Request<"GET", "/orders", undefined>
	| Request<"POST", "/orders", { sku: string; quantity: number }>
	| Request<"GET", "/health", undefined>;

const TRAFFIC: IncomingRequest[] = [
	{
		method: "GET",
		path: "/users",
		body: undefined,
		authorization: "Bearer ok",
	},
	{
		method: "POST",
		path: "/users",
		body: { name: "Ada", email: "ADA@example.com" },
		authorization: "Bearer ok",
	},
	{
		method: "POST",
		path: "/orders",
		body: { sku: "vinyl-01", quantity: 3 },
		authorization: "Bearer ok",
	},
	{ method: "DELETE", path: "/users", body: undefined, authorization: null },
	{ method: "GET", path: "/orders", body: undefined, authorization: null },
	// No rule covers this one — a 404.
	{ method: "GET", path: "/health", body: undefined, authorization: null },
	// The auth lookup throws on this one — a 500.
	{
		method: "POST",
		path: "/users",
		body: { name: "Grace", email: "grace@example.com" },
		authorization: "Bearer corrupt",
	},
];

/** Stands in for a session store. Rejects a token it cannot parse. */
async function isValidToken(header: string | null): Promise<boolean> {
	await new Promise((resolve) => setTimeout(resolve, 1));
	if (header === "Bearer corrupt") throw new Error("session store unreachable");
	return header !== null;
}

const router = new BucketEngine()
	.defineInput<IncomingRequest>()
	.defineCondition({
		name: "isGET",
		checkFn: (r): r is Extract<IncomingRequest, { method: "GET" }> =>
			r.method === "GET",
	})
	.defineCondition({
		name: "isPOST",
		checkFn: (r): r is Extract<IncomingRequest, { method: "POST" }> =>
			r.method === "POST",
	})
	.defineCondition({
		name: "isDELETE",
		checkFn: (r): r is Extract<IncomingRequest, { method: "DELETE" }> =>
			r.method === "DELETE",
	})
	// Path predicates, likewise.
	.defineCondition({
		name: "toUsers",
		checkFn: (r): r is Extract<IncomingRequest, { path: "/users" }> =>
			r.path === "/users",
	})
	.defineCondition({
		name: "toOrders",
		checkFn: (r): r is Extract<IncomingRequest, { path: "/orders" }> =>
			r.path === "/orders",
	})
	// Async, and deliberately not a predicate: being authenticated says nothing
	// about a request's shape, so it narrows the set without touching the type.
	.defineCondition({
		name: "isAuthenticated",
		checkFn: (r) => isValidToken(r.authorization),
	})
	// A route is method AND path. The intersection reduces to one variant.
	.defineBucket({
		name: "listUsers",
		checkFn: ({ AND }) => AND("isGET", "toUsers"),
	})
	.defineBucket({
		name: "createUser",
		checkFn: ({ AND }) => AND("isPOST", "toUsers"),
	})
	.defineBucket({
		name: "deleteUser",
		checkFn: ({ AND }) => AND("isDELETE", "toUsers"),
	})
	.defineBucket({
		name: "listOrders",
		checkFn: ({ AND }) => AND("isGET", "toOrders"),
	})
	.defineBucket({
		name: "createOrder",
		checkFn: ({ AND }) => AND("isPOST", "toOrders"),
	})
	// Cross-cutting rules live alongside the routes, because buckets overlap.
	.defineBucket({
		name: "unauthenticatedWrites",
		checkFn: ({ AND, OR, NOT }) =>
			AND(OR("isPOST", "isDELETE"), NOT("isAuthenticated")),
	});

const report = await router.process(TRAFFIC);

/* -------------------------------------------------------------------------- */
/* Dispatch. No casts, no re-checking the method, no `as`.                     */
/* -------------------------------------------------------------------------- */

for (const request of report.buckets.createUser) {
	// body is { name: string; email: string } — the other five variants are gone.
	console.log(
		`201 created ${request.body.name} <${request.body.email.toLowerCase()}>`,
	);
}

for (const request of report.buckets.createOrder) {
	// A different body, on a bucket declared exactly the same way.
	const { sku, quantity } = request.body;
	console.log(`201 ordered ${quantity} x ${sku}`);
}

for (const request of report.buckets.listUsers) {
	console.log(`200 listing users (body is ${String(request.body)})`);
}

for (const request of report.buckets.listOrders) {
	console.log(`200 listing orders for path ${request.path}`);
}

for (const request of report.buckets.deleteUser) {
	console.log(`204 deleted a user via ${request.method}`);
}

// Overlapping rule: these requests were also dispatched above.
for (const request of report.buckets.unauthenticatedWrites) {
	console.log(`401 would reject ${request.method} ${request.path}`);
}

// The leftovers, under their usual names.
for (const { item } of report.unmatched) {
	console.log(`404 no route for ${item.method} ${item.path}`);
}

for (const failure of report.errors) {
	console.log(
		`500 ${failure.item.method} ${failure.item.path} — ${failure.error.message}`,
	);
}

console.log("\nroutes with no rule:", router.missingCombinations().length);

/* -------------------------------------------------------------------------- */
/* What the compiler refuses.                                                  */
/* -------------------------------------------------------------------------- */

/** Never called — `@ts-expect-error` silences the compiler, not the runtime. */
function rejectedAtCompileTime(): void {
	for (const request of report.buckets.createUser) {
		// @ts-expect-error a user body has no sku — that's the order route.
		request.body.sku;
	}

	for (const request of report.buckets.listUsers) {
		// @ts-expect-error a GET body is undefined.
		request.body.name;
	}

	for (const request of report.buckets.unauthenticatedWrites) {
		// @ts-expect-error POST and DELETE bodies are a union until you discriminate.
		request.body.quantity;

		// Discriminating by hand still works, because it's an ordinary union.
		if (request.method === "POST" && request.path === "/orders") {
			void request.body.quantity;
		}
	}
}

void rejectedAtCompileTime;
