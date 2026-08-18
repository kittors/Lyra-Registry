/**
 * Everything that changes the database.
 *
 * Kept apart from the read queries because the rules are different: a read may be served from a
 * cache and be a little stale, a write may not. Anything here that has to happen together happens
 * in a `batch`, which D1 runs as one transaction.
 */

import { serialiseClients, type BundleKind, type ClientId, type EntryStatus, type RegistryStats } from "@lyra/registry-shared";

import type { BuiltBundle } from "../build/pipeline.ts";
import { now, today } from "./rows.ts";

export interface PublisherInput {
	id: number;
	login: string;
	name?: string;
	avatarUrl?: string;
}

/** Record whoever just signed in, updating what GitHub now says about them. */
export async function upsertPublisher(db: D1Database, input: PublisherInput): Promise<void> {
	const stamp = now();
	await db
		.prepare(
			`INSERT INTO publishers (id, login, name, avatar_url, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   login = excluded.login,
			   name = excluded.name,
			   avatar_url = excluded.avatar_url,
			   last_seen_at = excluded.last_seen_at`,
		)
		.bind(input.id, input.login, input.name ?? null, input.avatarUrl ?? null, stamp, stamp)
		.run();
}

export interface EntryInput {
	id: string;
	kind: BundleKind;
	name: string;
	description?: string;
	category?: string;
	repository: string;
	subpath: string;
	homepage?: string;
	author?: string;
	logo?: string;
	brandColor?: string;
	license?: string;
	package?: string;
	publisherId?: number;
	status: EntryStatus;
	readme?: string;
	clients: ClientId[];
}

/**
 * Fields a maintainer may set by hand, and which a rebuild must then leave alone.
 *
 * The list is closed on purpose. Everything outside it is a fact about the archive — how many
 * skills, what kind, which clients — and a fact is not something to override; if it is wrong, the
 * bundle is wrong.
 */
export const CURATABLE = ["name", "description", "category", "logo", "brandColor", "weight"] as const;
export type CuratableField = (typeof CURATABLE)[number];

/**
 * Create or update the listing itself, leaving versions alone.
 *
 * `created_at` and `published_at` survive an update — an entry that has been approved before does
 * not go back into the queue because its author fixed a typo in the description, and the day it
 * first appeared is not the day it was last edited.
 */
export async function upsertEntry(db: D1Database, input: EntryInput): Promise<void> {
	/*
	 * A rebuild refreshes what it derived and leaves what a person chose.
	 *
	 * `curated` records which columns were set by hand. Without consulting it, a nightly refresh
	 * either always overwrites — silently undoing every edit the moment upstream pushes a commit —
	 * or never does, which freezes an entry at whatever its first build said. Neither is a rule
	 * anybody can hold in their head; "derived refreshes, edited does not" is.
	 *
	 * The comparison wraps both sides in commas so it matches a whole field name. Plain `instr`
	 * would make a curated `brandColor` also protect `name` as soon as any two field names shared
	 * a substring — which the current six do not, and which the seventh would.
	 */
	await db
		.prepare(
			`INSERT INTO entries (
				id, kind, name, description, category, repository, subpath, homepage, author,
				logo, brand_color, license, package, publisher_id, status, readme, clients, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   kind = excluded.kind,
			   name = CASE WHEN instr(',' || entries.curated || ',', ',name,') > 0 THEN entries.name ELSE excluded.name END,
			   description = CASE WHEN instr(',' || entries.curated || ',', ',description,') > 0
			                      THEN entries.description ELSE excluded.description END,
			   category = CASE WHEN instr(',' || entries.curated || ',', ',category,') > 0
			                   THEN entries.category ELSE excluded.category END,
			   repository = excluded.repository,
			   subpath = excluded.subpath,
			   homepage = excluded.homepage,
			   author = excluded.author,
			   logo = CASE WHEN instr(',' || entries.curated || ',', ',logo,') > 0 THEN entries.logo ELSE excluded.logo END,
			   brand_color = CASE WHEN instr(',' || entries.curated || ',', ',brandColor,') > 0
			                      THEN entries.brand_color ELSE excluded.brand_color END,
			   license = excluded.license,
			   package = excluded.package,
			   readme = excluded.readme,
			   clients = excluded.clients,
			   updated_at = excluded.updated_at`,
		)
		.bind(
			input.id,
			input.kind,
			input.name,
			input.description ?? null,
			input.category ?? null,
			input.repository,
			input.subpath,
			input.homepage ?? null,
			input.author ?? null,
			input.logo ?? null,
			input.brandColor ?? null,
			input.license ?? null,
			input.package ?? null,
			input.publisherId ?? null,
			input.status,
			input.readme ?? null,
			serialiseClients(input.clients),
			now(),
			now(),
		)
		.run();
}

/**
 * Record a build, and point the entry at it.
 *
 * Both statements or neither: an entry whose `latest_version` names a row that does not exist
 * joins to nothing, and every catalogue query would then show it with no size, no hash and no
 * download link — visibly broken, in a way that only appears under a specific interleaving.
 */
export async function saveVersion(
	db: D1Database,
	entryId: string,
	version: string,
	built: BuiltBundle,
	tarballKey: string,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO versions (
					entry_id, version, tarball_key, sha256, size, commit_sha, skill_count, server_count, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (entry_id, version) DO UPDATE SET
				   tarball_key = excluded.tarball_key,
				   sha256 = excluded.sha256,
				   size = excluded.size,
				   commit_sha = excluded.commit_sha,
				   skill_count = excluded.skill_count,
				   server_count = excluded.server_count,
				   created_at = excluded.created_at`,
			)
			.bind(
				entryId,
				version,
				tarballKey,
				built.sha256,
				built.size,
				built.commit || null,
				built.skillCount,
				built.serverCount,
				now(),
			),
		db.prepare("UPDATE entries SET latest_version = ?, updated_at = ? WHERE id = ?").bind(version, now(), entryId),
	]);
}

/** Apply a moderation decision and record that it happened. */
export async function reviewEntry(
	db: D1Database,
	entryId: string,
	action: "approve" | "reject" | "delist" | "restore",
	reviewerId: number | null,
	note?: string,
): Promise<void> {
	const status: EntryStatus =
		action === "approve" || action === "restore" ? "approved" : action === "reject" ? "rejected" : "delisted";

	await db.batch([
		db
			.prepare(
				`UPDATE entries SET status = ?, review_note = ?, updated_at = ?,
				   published_at = COALESCE(published_at, CASE WHEN ? = 'approved' THEN ? END)
				 WHERE id = ?`,
			)
			.bind(status, note ?? null, now(), status, now(), entryId),
		db
			.prepare("INSERT INTO reviews (entry_id, reviewer_id, action, note, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind(entryId, reviewerId, action, note ?? null, now()),
	]);
}

/** Note a submission in the audit trail, so the queue shows when something arrived. */
export async function recordSubmission(db: D1Database, entryId: string, publisherId: number | null): Promise<void> {
	await db
		.prepare("INSERT INTO reviews (entry_id, reviewer_id, action, note, created_at) VALUES (?, ?, 'submit', NULL, ?)")
		.bind(entryId, publisherId, now())
		.run();
}

/**
 * Count one install, in both places it is counted.
 *
 * The cumulative total lives on the entry because every catalogue row shows it; the daily row is
 * what makes "popular this week" answerable. Writing both in a batch keeps them from drifting,
 * and the caller runs this inside `waitUntil` so the download is not waiting on it.
 */
export async function recordDownload(db: D1Database, entryId: string): Promise<void> {
	await db.batch([
		db.prepare("UPDATE entries SET downloads = downloads + 1 WHERE id = ?").bind(entryId),
		db
			.prepare(
				`INSERT INTO download_stats (entry_id, day, count) VALUES (?, ?, 1)
				 ON CONFLICT (entry_id, day) DO UPDATE SET count = count + 1`,
			)
			.bind(entryId, today()),
	]);
}

/**
 * A maintainer's edit.
 *
 * Only the fields in `CURATABLE`, and each one edited is added to `curated` so that no later
 * rebuild undoes it. Passing an empty string clears a field *and* releases it back to the derived
 * value, which is the only way to change your mind about an override.
 */
export async function curateEntry(
	db: D1Database,
	id: string,
	edits: Partial<Record<CuratableField, string | number | null>>,
): Promise<void> {
	const columns: Record<CuratableField, string> = {
		name: "name",
		description: "description",
		category: "category",
		logo: "logo",
		brandColor: "brand_color",
		weight: "weight",
	};

	const sets: string[] = [];
	const params: unknown[] = [];
	const claimed: CuratableField[] = [];
	const released: CuratableField[] = [];

	for (const field of CURATABLE) {
		const value = edits[field];
		if (value === undefined) continue;
		// An empty value means "stop overriding this", not "override it with nothing".
		const cleared = value === null || value === "";
		sets.push(`${columns[field]} = ?`);
		params.push(cleared ? (field === "weight" ? 0 : null) : value);
		(cleared ? released : claimed).push(field);
	}

	if (sets.length === 0) return;

	/*
	 * `curated` is rebuilt from the row's current value in SQL rather than read and written back,
	 * so two edits arriving at once cannot lose one another's claim.
	 */
	const existing = await db.prepare("SELECT curated FROM entries WHERE id = ?").bind(id).first<{ curated: string }>();
	const set = new Set((existing?.curated ?? "").split(",").filter(Boolean));
	for (const field of claimed) set.add(field);
	for (const field of released) set.delete(field);

	sets.push("curated = ?", "updated_at = ?");
	params.push([...set].join(","), now(), id);

	await db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
}

/** Point an entry at an icon uploaded to R2, and record that its picture is now a human's choice. */
export async function setIconKey(db: D1Database, id: string, key: string | null): Promise<void> {
	const existing = await db.prepare("SELECT curated FROM entries WHERE id = ?").bind(id).first<{ curated: string }>();
	const set = new Set((existing?.curated ?? "").split(",").filter(Boolean));
	if (key) set.add("logo");
	else set.delete("logo");

	await db
		.prepare("UPDATE entries SET icon_key = ?, curated = ?, updated_at = ? WHERE id = ?")
		.bind(key, [...set].join(","), now(), id)
		.run();
}

/** Mark a version withdrawn without deleting it. See `VersionInfo.yanked`. */
export async function yankVersion(db: D1Database, entryId: string, version: string, reason?: string): Promise<void> {
	await db
		.prepare("UPDATE versions SET yanked = 1, yanked_reason = ? WHERE entry_id = ? AND version = ?")
		.bind(reason ?? null, entryId, version)
		.run();
}

/** The numbers the front page and the admin dashboard show. One query, because it is one screen. */
export async function getStats(db: D1Database): Promise<RegistryStats> {
	const { results } = await db
		.prepare(
			`SELECT
			   COUNT(*) FILTER (WHERE status = 'approved') AS entries,
			   COUNT(*) FILTER (WHERE status = 'approved' AND kind = 'plugin') AS plugins,
			   COUNT(*) FILTER (WHERE status = 'approved' AND kind = 'mcp') AS mcp,
			   COUNT(*) FILTER (WHERE status = 'approved' AND kind = 'skill') AS skill,
			   COUNT(*) FILTER (WHERE status = 'pending') AS pending,
			   COALESCE(SUM(downloads) FILTER (WHERE status = 'approved'), 0) AS downloads,
			   (SELECT COUNT(*) FROM publishers) AS publishers,
			   (SELECT COALESCE(SUM(v.skill_count), 0) FROM versions v
			      JOIN entries e ON e.id = v.entry_id AND e.latest_version = v.version
			      WHERE e.status = 'approved') AS skills,
			   (SELECT COALESCE(SUM(v.server_count), 0) FROM versions v
			      JOIN entries e ON e.id = v.entry_id AND e.latest_version = v.version
			      WHERE e.status = 'approved') AS servers
			 FROM entries`,
		)
		.all<Record<string, number>>();

	const row = results[0] ?? {};
	return {
		entries: row.entries ?? 0,
		byKind: { plugin: row.plugins ?? 0, mcp: row.mcp ?? 0, skill: row.skill ?? 0 },
		skills: row.skills ?? 0,
		servers: row.servers ?? 0,
		downloads: row.downloads ?? 0,
		pending: row.pending ?? 0,
		publishers: row.publishers ?? 0,
	};
}
