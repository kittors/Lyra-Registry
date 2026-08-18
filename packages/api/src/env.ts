/**
 * What the worker is given, and what it is allowed to assume about it.
 *
 * Split into bindings (declared in `wrangler.jsonc`, always present) and secrets (set with
 * `wrangler secret put`, absent until somebody does). The distinction matters: a missing binding is
 * a deployment that cannot start, while a missing secret is a feature that has to degrade — the
 * catalogue must keep serving when nobody has configured OAuth yet.
 */

import type { Urls } from "./db/rows.ts";

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	CACHE: KVNamespace;
	ASSETS: Fetcher;

	/** Public half of the OAuth app; the browser needs it to start the redirect. */
	GITHUB_CLIENT_ID: string;
	/** Comma-separated GitHub logins allowed to review submissions. */
	ADMIN_LOGINS: string;
	/** Where this deployment answers, for OAuth redirects and absolute tarball URLs. */
	PUBLIC_URL: string;

	/** Secret. Absent until `wrangler secret put GITHUB_CLIENT_SECRET`. */
	GITHUB_CLIENT_SECRET?: string;
	/**
	 * Secret. Signs session tokens.
	 *
	 * Rotating it logs everyone out, which is the correct behaviour for a compromised key and the
	 * reason it is not derived from anything else.
	 */
	SESSION_SECRET?: string;
	/**
	 * Secret. A GitHub token used for fetching repositories.
	 *
	 * Not optional in practice. Unauthenticated GitHub allows 60 requests an hour per IP, and a
	 * Worker's egress IP is shared with every other tenant at that colo — measured during
	 * development, where the anonymous budget was already exhausted by someone else before the
	 * first build ran. Without this, refreshes fail in a way that looks like GitHub being down.
	 */
	GITHUB_TOKEN?: string;
}

/** Whether this login may review submissions. Empty config means nobody, never everybody. */
export function isAdmin(env: Env, login: string): boolean {
	if (!login) return false;
	return env.ADMIN_LOGINS.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.includes(login.toLowerCase());
}

/**
 * Where this deployment's things are reachable from outside.
 *
 * R2 keys and upstream logo URLs are internal; these are what a client is given. Icons in
 * particular are always ours — see `routes/icon.ts` for why a catalogue must not send viewers to
 * github.com for its images.
 *
 * The origin comes from the request rather than from `PUBLIC_URL`. On Cloudflare `request.url` is
 * the address the client actually used, so this is correct on a workers.dev subdomain, behind a
 * custom domain, and on `localhost:8787` — where the configured value would otherwise hand every
 * local page a set of production URLs it cannot reach. `PUBLIC_URL` remains the fallback, and
 * remains the one OAuth uses, because a redirect URI has to match what GitHub was told.
 */
export function urlsFor(env: Env, request?: Request): Urls {
	const base = (originOf(request) ?? env.PUBLIC_URL).replace(/\/$/, "");
	return {
		tarball: (id, version) => `${base}/v1/download/${encodeURIComponent(id)}/${encodeURIComponent(version)}`,
		icon: (id) => `${base}/v1/icon/${encodeURIComponent(id)}`,
	};
}

function originOf(request: Request | undefined): string | null {
	if (!request) return null;
	try {
		return new URL(request.url).origin;
	} catch {
		return null;
	}
}
