/**
 * Every query the catalogue makes.
 *
 * Written as SQL against D1's prepared statements. Two rules hold throughout: anything that came
 * from a request is a bound parameter, and anything that cannot be bound — an ORDER BY clause — is
 * looked up in a fixed map rather than assembled from input. There is no third case.
 */

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type EntryQuery, type EntrySummary, type Page } from "@lyra/registry-shared";

import { SORT_SQL, toSummary, toVersion, type EntryRow, type Urls, type VersionRow } from "./rows.ts";

/**
 * Columns every catalogue query selects, including the joins.
 *
 * One string rather than repeated, because the list and the detail page have to agree about what a
 * row contains — a field selected in one and not the other is a field that is `undefined` on some
 * pages and populated on others, which is the sort of thing nobody notices until a user does.
 */
const ENTRY_COLUMNS = `
	e.*,
	p.login AS publisher_login,
	p.avatar_url AS publisher_avatar,
	v.sha256 AS sha256,
	v.size AS size,
	v.skill_count AS skill_count,
	v.server_count AS server_count,
	v.commit_sha AS commit_sha
`;

/** The joins those columns come from. `latest_version` is what makes "the current one" a join. */
const ENTRY_JOINS = `
	FROM entries e
	LEFT JOIN publishers p ON p.id = e.publisher_id
	LEFT JOIN versions v ON v.entry_id = e.id AND v.version = e.latest_version
`;

export interface ListOptions extends EntryQuery {
	/**
	 * Which statuses to include.
	 *
	 * The public catalogue passes `["approved"]`. The admin queue and a publisher's own list pass
	 * more. Defaulting to approved-only would be one forgotten argument away from listing rejected
	 * submissions publicly, so it has no default and every caller states it.
	 */
	statuses: string[];
	/** Restrict to one publisher, for "my entries". */
	publisherId?: number;
}

export async function listEntries(
	db: D1Database,
	options: ListOptions,
	urls: Urls,
): Promise<Page<EntrySummary>> {
	const where: string[] = [];
	const params: unknown[] = [];

	// An empty status list would produce `IN ()`, which is a syntax error in SQLite rather than an
	// empty result. Refusing here makes the caller's mistake visible instead of a 500.
	if (options.statuses.length === 0) throw new Error("listEntries requires at least one status");
	where.push(`e.status IN (${options.statuses.map(() => "?").join(", ")})`);
	params.push(...options.statuses);

	if (options.kind) {
		where.push("e.kind = ?");
		params.push(options.kind);
	}
	if (options.category) {
		where.push("e.category = ?");
		params.push(options.category);
	}
	if (options.author) {
		where.push("(e.author = ? OR p.login = ?)");
		params.push(options.author, options.author);
	}
	if (options.publisherId !== undefined) {
		where.push("e.publisher_id = ?");
		params.push(options.publisherId);
	}
	if (options.q) {
		/*
		 * The same pattern bound three times, rather than once as `?2` referred to three times.
		 *
		 * SQLite allows numbered and anonymous placeholders in one statement but counts them in a
		 * shared sequence, so `?2` means "the second parameter overall" — which is only the pattern
		 * if the caller happens to have built the list in that order. Binding it three times costs
		 * two short strings and cannot be got wrong by adding a filter above this one.
		 */
		const pattern = `%${escapeLike(options.q)}%`;
		where.push("(e.name LIKE ? ESCAPE '\\' OR e.id LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\')");
		params.push(pattern, pattern, pattern);
	}

	const clause = `WHERE ${where.join(" AND ")}`;
	/*
	 * Editorial weight leads every ordering.
	 *
	 * It is zero for everything nobody has touched, so this changes nothing until somebody
	 * deliberately pins an entry — at which point it stays pinned regardless of which sort the
	 * visitor picked, which is the only behaviour that makes pinning worth having.
	 */
	const order = `weight DESC, ${SORT_SQL[options.sort ?? "downloads"] ?? SORT_SQL.downloads}`;
	const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
	const page = Math.max(0, options.page ?? 0);

	/*
	 * Two statements in one round trip.
	 *
	 * The count is needed for pagination and cannot come from the page itself. `batch` sends both
	 * at once, which on D1 — where each statement is a network hop to the primary — is the
	 * difference between one latency and two.
	 */
	const [countResult, pageResult] = await db.batch([
		db.prepare(`SELECT COUNT(*) AS total ${ENTRY_JOINS} ${clause}`).bind(...params),
		db
			.prepare(`SELECT ${ENTRY_COLUMNS} ${ENTRY_JOINS} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
			.bind(...params, pageSize, page * pageSize),
	]);

	const total = ((countResult.results as { total: number }[])[0]?.total ?? 0) as number;
	const rows = pageResult.results as unknown as EntryRow[];

	return {
		items: rows.map((row) => toSummary(row, urls)),
		total,
		page,
		pageSize,
	};
}

export async function getEntry(db: D1Database, id: string): Promise<{ row: EntryRow; versions: VersionRow[] } | null> {
	const [entry, versions] = await db.batch([
		db.prepare(`SELECT ${ENTRY_COLUMNS} ${ENTRY_JOINS} WHERE e.id = ?`).bind(id),
		db.prepare("SELECT * FROM versions WHERE entry_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
	]);

	const row = (entry.results as unknown as EntryRow[])[0];
	if (!row) return null;
	return { row, versions: versions.results as unknown as VersionRow[] };
}

/** The distinct categories in use, for the site's filter chips. Only from visible entries. */
export async function listCategories(db: D1Database): Promise<{ category: string; count: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT category, COUNT(*) AS count FROM entries
			 WHERE status = 'approved' AND category IS NOT NULL AND category != ''
			 GROUP BY category ORDER BY count DESC, category ASC`,
		)
		.all<{ category: string; count: number }>();
	return results;
}

/**
 * A LIKE pattern that means what the user typed.
 *
 * `%` and `_` are wildcards, so a search for `100%` would otherwise match everything starting with
 * `100`. The backslash is declared with ESCAPE in the query itself.
 */
function escapeLike(input: string): string {
	return input.slice(0, 100).replace(/[\\%_]/g, (char) => `\\${char}`);
}

export { toSummary, toVersion };
