/**
 * Icons, served from here rather than from wherever they came from.
 *
 * An entry's logo is almost always `github.com/<owner>.png`. Pointing a catalogue at that directly
 * makes every card depend on the *viewer* being able to reach GitHub — which a great many of them
 * cannot, and which GitHub itself will refuse once enough of them try at once. The failure is
 * silent and total: a grid of grey squares, with nothing in a console and nothing in a type check.
 * The desktop app hit exactly this and moved icons through its main process; this is the same fix
 * on the platform side, so every client gets it rather than each solving it again.
 *
 * Fetched once, kept in R2, served from the edge afterwards. The first viewer pays for it and
 * nobody else does.
 */

import { Hono } from "hono";

import type { Env } from "../env.ts";
import { CACHE_IMMUTABLE, PUBLIC_CORS } from "../lib/http.ts";

export const icon = new Hono<{ Bindings: Env }>();

/** An avatar is a few dozen KB. Anything past this is not an icon. */
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * A neutral placeholder, inline.
 *
 * Deliberately not a colour hashed from the name with a letter in it. That is a *generated*
 * identity — it looks like an icon while telling you nothing, and it makes nine entries into nine
 * meaningless shapes to tell apart. This says "there is no icon here", which is also the prompt to
 * go and add one.
 */
const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
	<rect width="64" height="64" rx="14" fill="#e9ecf1"/>
	<path d="M32 18a14 14 0 0 1 14 14v14H18V32a14 14 0 0 1 14-14Z" fill="#c3cad6"/>
	<circle cx="32" cy="28" r="6" fill="#eef1f5"/>
</svg>`;

function placeholder(): Response {
	return new Response(PLACEHOLDER, {
		headers: {
			...PUBLIC_CORS,
			"content-type": "image/svg+xml; charset=utf-8",
			// Short: an entry that has no icon today may have one tomorrow.
			"cache-control": "public, max-age=3600",
		},
	});
}

icon.get("/icon/:id", async (context) => {
	const id = context.req.param("id");
	const key = `icons/${id}`;

	const cached = await context.env.BUCKET.get(key);
	if (cached) {
		return new Response(cached.body, {
			headers: {
				...PUBLIC_CORS,
				"content-type": cached.httpMetadata?.contentType ?? "image/png",
				"cache-control": CACHE_IMMUTABLE,
			},
		});
	}

	const row = await context.env.DB.prepare("SELECT logo FROM entries WHERE id = ?")
		.bind(id)
		.first<{ logo: string | null }>();

	const source = row?.logo;
	// Only https, and only something we put in the row ourselves. The logo can come from a
	// submitter's manifest, so treating it as a URL to go and fetch needs the scheme pinned.
	if (!source || !/^https:\/\//i.test(source)) return placeholder();

	try {
		const response = await fetch(source, {
			headers: { accept: "image/*", "user-agent": "lyra-registry" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return placeholder();

		const type = response.headers.get("content-type") ?? "";
		// An HTML error page with a 200 is a thing that happens; storing it as an icon is not.
		if (!type.startsWith("image/")) return placeholder();

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return placeholder();

		context.executionCtx.waitUntil(
			context.env.BUCKET.put(key, bytes as unknown as ArrayBuffer, {
				httpMetadata: { contentType: type },
			}).then(
				() => undefined,
				(error: unknown) => console.error("icon cache failed", id, error),
			),
		);

		return new Response(bytes as unknown as BodyInit, {
			headers: { ...PUBLIC_CORS, "content-type": type, "cache-control": CACHE_IMMUTABLE },
		});
	} catch {
		// Upstream unreachable. A placeholder now is better than a broken image forever, and the
		// next request will try again because nothing was cached.
		return placeholder();
	}
});
