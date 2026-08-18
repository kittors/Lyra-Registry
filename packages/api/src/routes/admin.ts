/**
 * Moderation.
 *
 * Four verbs and an audit trail. Every one of them is recorded in `reviews` including the ones
 * that reverse an earlier decision, because "who un-rejected this and when" is precisely the
 * question asked after something goes wrong.
 *
 * Who counts as an admin is read from configuration on every request rather than from a claim in
 * the session token — see `currentViewer`. Removing someone from `ADMIN_LOGINS` takes effect
 * immediately rather than whenever their week-long session runs out.
 */

import { Hono } from "hono";

import { listEntries } from "../db/entries.ts";
import { getStats, reviewEntry, yankVersion } from "../db/writes.ts";
import { urlsFor, type Env } from "../env.ts";
import { fail, intParam, json, NO_STORE, readToken } from "../lib/http.ts";
import { requireAdmin } from "./auth.ts";

export const admin = new Hono<{ Bindings: Env }>();

const ACTIONS = new Set(["approve", "reject", "delist", "restore"]);

/** Everything awaiting a decision, oldest first — a queue, not a catalogue. */
admin.get("/queue", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const page = await listEntries(
		context.env.DB,
		{ statuses: ["pending"], sort: "created", page: intParam(context.req.query("page"), 0), pageSize: 50 },
		urlsFor(context.env, context.req.raw),
	);
	return json(page, NO_STORE);
});

/** Every entry regardless of status, for finding something that is already live. */
admin.get("/entries", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const page = await listEntries(
		context.env.DB,
		{
			statuses: ["pending", "approved", "rejected", "delisted"],
			q: context.req.query("q"),
			sort: "updated",
			page: intParam(context.req.query("page"), 0),
			pageSize: 50,
		},
		urlsFor(context.env, context.req.raw),
	);
	return json(page, NO_STORE);
});

admin.post("/entries/:id/review", async (context) => {
	const viewer = await requireAdmin(context.env, readToken(context));
	const id = context.req.param("id");
	const body = (await context.req.json().catch(() => null)) as { action?: string; note?: string } | null;

	if (!body?.action || !ACTIONS.has(body.action)) fail("invalid", "action 必须是 approve / reject / delist / restore");

	/*
	 * A rejection without a reason is refused.
	 *
	 * The note is the only thing the author receives. "Rejected" with no sentence attached is a
	 * dead end for them and a support question for us.
	 */
	const note = body.note?.trim().slice(0, 1000);
	if ((body.action === "reject" || body.action === "delist") && !note) {
		fail("invalid", "驳回或下架要写明原因，作者只能看到这句话");
	}

	const exists = await context.env.DB.prepare("SELECT 1 FROM entries WHERE id = ?").bind(id).first();
	if (!exists) fail("not_found", `没有找到 ${id}`);

	await reviewEntry(context.env.DB, id, body.action as "approve", viewer.id, note);
	return json({ ok: true }, NO_STORE);
});

/** Withdraw one version without touching the entry. See `VersionInfo.yanked`. */
admin.post("/entries/:id/versions/:version/yank", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const body = (await context.req.json().catch(() => null)) as { reason?: string } | null;
	await yankVersion(
		context.env.DB,
		context.req.param("id"),
		context.req.param("version"),
		body?.reason?.trim().slice(0, 500),
	);
	return json({ ok: true }, NO_STORE);
});

admin.get("/stats", async (context) => {
	await requireAdmin(context.env, readToken(context));
	return json(await getStats(context.env.DB), NO_STORE);
});

/** The audit trail for one entry, newest first. */
admin.get("/entries/:id/reviews", async (context) => {
	await requireAdmin(context.env, readToken(context));
	const { results } = await context.env.DB.prepare(
		`SELECT r.action, r.note, r.created_at, p.login AS reviewer
		 FROM reviews r LEFT JOIN publishers p ON p.id = r.reviewer_id
		 WHERE r.entry_id = ? ORDER BY r.created_at DESC LIMIT 100`,
	)
		.bind(context.req.param("id"))
		.all();
	return json(results, NO_STORE);
});
