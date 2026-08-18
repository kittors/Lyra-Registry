/**
 * The worker: an API, a site, and a nightly refresh, in one deployment.
 *
 * One Worker rather than a Worker plus a Pages project, for two reasons that happen to agree. The
 * account's token cannot create Pages projects, and same-origin means the site calls its own API
 * without a preflight and with the session cookie already attached.
 *
 * Routing order matters here: `/v1` and `/auth` are claimed by the worker, and everything else
 * falls through to the static assets, where an unmatched path becomes `index.html` so the site's
 * client-side routes survive a reload.
 */

import { Hono } from "hono";

import type { Env } from "./env.ts";
import { errorResponse, PUBLIC_CORS } from "./lib/http.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { catalogue } from "./routes/catalogue.ts";
import { download } from "./routes/download.ts";
import { icon } from "./routes/icon.ts";
import { publish } from "./routes/publish.ts";
import { refreshAll } from "./sync.ts";

const app = new Hono<{ Bindings: Env }>();

/** Every error becomes the same JSON shape. Anything unrecognised becomes a 500 with no detail. */
app.onError((error) => errorResponse(error));

// Preflight for the public API. Answered here rather than per-route so a new route cannot forget.
app.options("/v1/*", () => new Response(null, { status: 204, headers: PUBLIC_CORS }));

app.route("/v1", catalogue);
app.route("/v1", download);
app.route("/v1", icon);
app.route("/v1", publish);
app.route("/v1/admin", admin);
app.route("/auth", auth);
app.route("/v1", auth);

/** Liveness, and enough detail to tell a broken binding from a broken deploy. */
app.get("/v1/health", async (context) => {
	const database = await context.env.DB.prepare("SELECT 1 AS ok")
		.first<{ ok: number }>()
		.then((row) => row?.ok === 1)
		.catch(() => false);
	return Response.json(
		{ ok: database, database, oauth: Boolean(context.env.GITHUB_CLIENT_ID && context.env.GITHUB_CLIENT_SECRET) },
		{ status: database ? 200 : 503, headers: { "cache-control": "no-store" } },
	);
});

app.notFound((context) => {
	// An unmatched API path is a 404 in JSON; anything else is the site's problem to route.
	if (context.req.path.startsWith("/v1/") || context.req.path.startsWith("/auth/")) {
		return Response.json({ code: "not_found", message: "没有这个接口" }, { status: 404 });
	}
	return context.env.ASSETS.fetch(context.req.raw);
});

export default {
	fetch: app.fetch,

	/**
	 * The nightly refresh.
	 *
	 * Replaces the GitHub Action that used to rewrite `registry.json` on a schedule. It is cheap
	 * because it asks for a commit sha before it asks for anything else: an entry whose upstream
	 * has not moved costs one 40-byte request and no build at all.
	 */
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(refreshAll(env));
	},
} satisfies ExportedHandler<Env>;
