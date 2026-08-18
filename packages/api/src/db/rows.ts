/**
 * The shape D1 hands back, and the shape the API promises.
 *
 * These are two different things and the translation is written out once, here, rather than at
 * every call site. SQLite columns are snake_case and store booleans as integers; the contract in
 * `@lyra/registry-shared` is camelCase and typed. Doing this conversion inline in each query is
 * how one endpoint comes to answer `skill_count` while another answers `skillCount`.
 *
 * Pure — no bindings, no D1 — so the mapping is testable under `node --test` without a database.
 */

import type { BundleKind, EntryStatus, EntrySummary, VersionInfo } from "@lyra/registry-shared";

/** A row of `entries`, optionally joined with its publisher. */
export interface EntryRow {
	id: string;
	kind: string;
	name: string;
	description: string | null;
	category: string | null;
	repository: string;
	subpath: string;
	homepage: string | null;
	author: string | null;
	logo: string | null;
	brand_color: string | null;
	license: string | null;
	package: string | null;
	publisher_id: number | null;
	status: string;
	latest_version: string | null;
	downloads: number;
	readme: string | null;
	review_note: string | null;
	created_at: string;
	updated_at: string;
	published_at: string | null;
	/* Joined, so a catalogue row can show who published it without a second query. */
	publisher_login?: string | null;
	publisher_avatar?: string | null;
	/* From the latest version, likewise joined. */
	sha256?: string | null;
	size?: number | null;
	skill_count?: number | null;
	server_count?: number | null;
	commit_sha?: string | null;
	/* From a window over `download_stats`; absent on queries that did not ask for it. */
	recent_downloads?: number | null;
}

export interface VersionRow {
	version: string;
	tarball_key: string;
	sha256: string;
	size: number;
	commit_sha: string | null;
	skill_count: number | null;
	server_count: number | null;
	yanked: number;
	yanked_reason: string | null;
	created_at: string;
}

/**
 * How to address the things this deployment serves.
 *
 * An interface here and an implementation in `env.ts`, so that mapping a row does not need to know
 * what a `Env` is — and so the eight call sites that each built these URLs by hand became one.
 */
export interface Urls {
	tarball(id: string, version: string): string;
	icon(id: string): string;
}

/** A row as the catalogue shows it. */
export function toSummary(row: EntryRow, urls: Urls): EntrySummary {
	return {
		id: row.id,
		kind: row.kind as BundleKind,
		name: row.name,
		description: row.description ?? undefined,
		category: row.category ?? undefined,
		repository: row.repository,
		path: row.subpath || undefined,
		homepage: row.homepage ?? undefined,
		author: row.author ?? undefined,
		/*
		 * Our URL, not the upstream one.
		 *
		 * The upstream is kept in the row — it is what the icon route goes and fetches — but what
		 * goes out to a client is always ours, so that displaying a catalogue never depends on the
		 * viewer being able to reach github.com. Measured: in a browser with no route to GitHub,
		 * every card in the grid was a grey square.
		 */
		logo: urls.icon(row.id),
		brandColor: row.brand_color ?? undefined,
		license: row.license ?? undefined,
		package: row.package ?? undefined,
		version: row.latest_version ?? undefined,
		status: row.status as EntryStatus,
		publisher: row.publisher_login ?? undefined,
		publisherAvatar: row.publisher_avatar ?? undefined,
		downloads: row.downloads,
		recentDownloads: row.recent_downloads ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		// Only present once something has been built; an entry still in the queue has no archive.
		tarball: row.latest_version ? urls.tarball(row.id, row.latest_version) : undefined,
		sha256: row.sha256 ?? undefined,
		size: row.size ?? undefined,
		skillCount: row.skill_count ?? undefined,
		serverCount: row.server_count ?? undefined,
		commit: row.commit_sha ?? undefined,
	};
}

export function toVersion(row: VersionRow, tarball: string): VersionInfo {
	return {
		version: row.version,
		createdAt: row.created_at,
		tarball,
		sha256: row.sha256,
		size: row.size,
		commit: row.commit_sha ?? undefined,
		skillCount: row.skill_count ?? undefined,
		serverCount: row.server_count ?? undefined,
		// SQLite has no boolean; `0` and `1` are what the column actually holds.
		yanked: row.yanked === 1 ? true : undefined,
		yankedReason: row.yanked_reason ?? undefined,
	};
}

/**
 * Columns a caller may sort by, and the SQL for each.
 *
 * A map rather than a string built from the query: `sort` arrives from a URL, and the only safe
 * way to put user input in an ORDER BY — which cannot be a bound parameter — is to never put it
 * there. What goes into the query is the value looked up here.
 */
export const SORT_SQL = {
	downloads: "downloads DESC, updated_at DESC",
	updated: "updated_at DESC",
	created: "created_at DESC",
	name: "name COLLATE NOCASE ASC",
} as const;

/** ISO 8601, to the second. What every timestamp column in this schema holds. */
export function now(): string {
	return new Date().toISOString();
}

/** Today, as `download_stats.day` records it. */
export function today(): string {
	return new Date().toISOString().slice(0, 10);
}
