/**
 * The maintenance console's write side.
 *
 * Everything here is admin-only, and deliberately narrow: a maintainer may change how an entry is
 * *presented* — its name, description, category, icon, colour, and where it sits in the list — and
 * nothing about what it *is*. Kind, skill counts and client compatibility are read from the archive
 * on every build, and an override for them would be a way to publish a false claim.
 *
 * Every field touched here is recorded in `curated`, so the nightly rebuild leaves it alone. That
 * is what makes editing safe: without it, the next upstream commit silently reverts the work.
 */

import { Hono } from "hono";

import { CURATABLE, curateEntry, setIconKey, type CuratableField } from "../db/writes.ts";
import type { Env } from "../env.ts";
import { fail, json, NO_STORE, readToken } from "../lib/http.ts";
import { requireAdmin } from "./auth.ts";

export const curate = new Hono<{ Bindings: Env }>();

/** An icon is a small square image. Anything bigger is a mistake or an attempt at one. */
const MAX_UPLOAD_BYTES = 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);

curate.patch("/entries/:id", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const id = context.req.param("id");

	const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) fail("invalid", "请求体不是 JSON");

	const edits: Partial<Record<CuratableField, string | number | null>> = {};
	for (const field of CURATABLE) {
		const value = body[field];
		if (value === undefined) continue;
		if (field === "weight") {
			const weight = Number(value);
			if (!Number.isFinite(weight)) fail("invalid", "weight 必须是数字");
			// Bounded so an ordering column cannot become an arbitrary integer store.
			edits.weight = Math.max(-1000, Math.min(1000, Math.trunc(weight)));
			continue;
		}
		if (value === null) {
			edits[field] = null;
			continue;
		}
		if (typeof value !== "string") fail("invalid", `${field} 必须是字符串`);
		if (field === "logo" && value && !/^https:\/\//i.test(value)) {
			fail("invalid", "图标地址必须是 https");
		}
		edits[field] = value.trim().slice(0, 2000);
	}

	if (Object.keys(edits).length === 0) fail("invalid", "没有可以修改的字段");

	const exists = await context.env.DB.prepare("SELECT 1 FROM entries WHERE id = ?").bind(id).first();
	if (!exists) fail("not_found", `没有找到 ${id}`);

	await curateEntry(context.env.DB, id, edits);
	return json({ ok: true, curated: Object.keys(edits) }, NO_STORE);
});

/**
 * Upload an icon.
 *
 * Raw bytes with a `content-type`, not multipart: there is one file and no other fields, and
 * parsing multipart to find that out would be work with no purpose.
 */
curate.put("/entries/:id/icon", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const id = context.req.param("id");

	const type = (context.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
	if (!ALLOWED_TYPES.has(type)) {
		fail("invalid", `图标格式要是 PNG / JPEG / WebP / SVG / GIF，收到的是 ${type || "(空)"}`);
	}

	const bytes = new Uint8Array(await context.req.arrayBuffer());
	if (bytes.length === 0) fail("invalid", "文件是空的");
	if (bytes.length > MAX_UPLOAD_BYTES) fail("invalid", "图标不能超过 1MB");

	const exists = await context.env.DB.prepare("SELECT 1 FROM entries WHERE id = ?").bind(id).first();
	if (!exists) fail("not_found", `没有找到 ${id}`);

	/*
	 * A new key each time, stamped with the size.
	 *
	 * Overwriting one key would leave every cache — the edge's and every browser's — serving the
	 * old picture under an unchanged URL. A fresh key means the icon route hands out different
	 * bytes immediately, and the old object is simply no longer referenced.
	 */
	const key = `icons/uploaded/${id}-${bytes.length}-${await shortHash(bytes)}`;
	await context.env.BUCKET.put(key, bytes as unknown as ArrayBuffer, { httpMetadata: { contentType: type } });
	await setIconKey(context.env.DB, id, key);
	/*
	 * Drop the derived copy, or nothing changes.
	 *
	 * `GET /v1/icon/:id` checks `icons/<id>` before it looks at the database, so leaving that
	 * object in place means every viewer keeps getting the GitHub avatar and the upload appears to
	 * have silently failed.
	 */
	await context.env.BUCKET.delete(`icons/${id}`);

	return json({ ok: true, key }, NO_STORE);
});

/** Drop the uploaded icon and go back to whatever the repository implies. */
curate.delete("/entries/:id/icon", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const id = context.req.param("id");
	await setIconKey(context.env.DB, id, null);
	// Same reason as on upload: the derived object has to be re-fetched, not remembered.
	await context.env.BUCKET.delete(`icons/${id}`);
	return json({ ok: true }, NO_STORE);
});

async function shortHash(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
