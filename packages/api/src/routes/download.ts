/**
 * Handing over the bytes, and counting that it happened.
 *
 * The archive is streamed from R2 through the worker rather than redirected to. A redirect would
 * be one fewer hop, but it would also mean a public bucket URL, no counting, and a link that keeps
 * working after an entry is taken down. Streaming keeps the platform as the only door.
 *
 * The count is deliberately not on the critical path: `waitUntil` lets the response start while
 * the write happens behind it. A download that succeeded and was not counted is a wrong number; a
 * download that waited on a database write to begin is a wrong product.
 */

import { Hono } from "hono";

import { recordDownload } from "../db/writes.ts";
import type { Env } from "../env.ts";
import { CACHE_IMMUTABLE, fail, PUBLIC_CORS } from "../lib/http.ts";

export const download = new Hono<{ Bindings: Env }>();

interface VersionLookup {
	tarball_key: string;
	sha256: string;
	size: number;
	yanked: number;
	status: string;
}

download.get("/download/:id/:version", async (context) => {
	const id = context.req.param("id");
	const version = context.req.param("version");

	const row = await context.env.DB.prepare(
		`SELECT v.tarball_key, v.sha256, v.size, v.yanked, e.status
		 FROM versions v JOIN entries e ON e.id = v.entry_id
		 WHERE v.entry_id = ? AND v.version = ?`,
	)
		.bind(id, version)
		.first<VersionLookup>();

	if (!row) fail("not_found", `没有 ${id}@${version}`);

	/*
	 * A delisted entry still serves its archives.
	 *
	 * People have it installed. Breaking their machine is not how disapproval is expressed — the
	 * entry is gone from the catalogue, which is what "delisted" means. Only `rejected` refuses,
	 * because a rejected entry was never published and nobody can have it.
	 */
	if (row.status === "rejected") fail("not_found", `${id} 不可用`);

	const object = await context.env.BUCKET.get(row.tarball_key);
	if (!object) fail("not_found", "这个版本的文件不在了");

	context.executionCtx.waitUntil(
		recordDownload(context.env.DB, id).catch((error: unknown) => {
			// A failed count is not a failed download. Logged, because a count that silently stops
			// working looks exactly like nobody installing anything.
			console.error("download count failed", id, error);
		}),
	);

	return new Response(object.body, {
		headers: {
			...PUBLIC_CORS,
			"content-type": "application/gzip",
			"content-length": String(row.size),
			"cache-control": CACHE_IMMUTABLE,
			// The client checks this before unpacking. Named `x-` because there is no standard header
			// that means "SHA-256 of this body" that caches will not rewrite.
			"x-lyra-sha256": row.sha256,
			"content-disposition": `attachment; filename="${id}-${version}.tar.gz"`,
			...(row.yanked === 1 ? { "x-lyra-yanked": "1" } : {}),
		},
	});
});

/**
 * The current version's archive, without having to ask which version that is.
 *
 * One request instead of two for the common case. It is a redirect rather than the bytes so that
 * the versioned URL — the one that is immutable and cacheable forever — is what actually gets
 * cached, at the edge and by the client.
 */
download.get("/download/:id", async (context) => {
	const id = context.req.param("id");
	const row = await context.env.DB.prepare("SELECT latest_version FROM entries WHERE id = ? AND status = 'approved'")
		.bind(id)
		.first<{ latest_version: string | null }>();

	if (!row?.latest_version) fail("not_found", `${id} 还没有可下载的版本`);
	return context.redirect(`/v1/download/${encodeURIComponent(id)}/${encodeURIComponent(row.latest_version)}`, 302);
});
