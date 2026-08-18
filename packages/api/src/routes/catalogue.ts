/**
 * The public, unauthenticated half: browsing.
 *
 * Everything here is cacheable and anonymous, which is what makes the desktop app's polling cheap
 * and what makes the site fast. No route in this file reads a session.
 *
 * `/v1/index` deserves its own note. It answers in the *file* registry's format — the same
 * `{ name, plugins: [...] }` a `registry.json` in a GitHub repo would — because that is what every
 * copy of the app already in the wild knows how to read. Making the platform speak the old format
 * is what lets it replace `raw.githubusercontent.com` without anyone upgrading first.
 */

import { isBundleKind, isEntrySort, type EntrySummary } from "@lyra/registry-shared";
import { Hono } from "hono";

import { getEntry, listCategories, listEntries } from "../db/entries.ts";
import { toSummary, toVersion } from "../db/rows.ts";
import { getStats } from "../db/writes.ts";
import { urlsFor, type Env } from "../env.ts";
import { CACHE_CATALOGUE, CACHE_INDEX, fail, intParam, json, PUBLIC_CORS } from "../lib/http.ts";

export const catalogue = new Hono<{ Bindings: Env }>();

/** Only what has been approved is visible here. Every other status is a different endpoint. */
const PUBLIC = ["approved"];

catalogue.get("/entries", async (context) => {
	const query = context.req.query();
	const kind = query.kind;
	const sort = query.sort;

	const page = await listEntries(
		context.env.DB,
		{
			statuses: PUBLIC,
			q: query.q,
			kind: isBundleKind(kind) ? kind : undefined,
			category: query.category,
			author: query.author,
			sort: isEntrySort(sort) ? sort : undefined,
			page: intParam(query.page, 0),
			pageSize: intParam(query.pageSize, 24),
		},
		urlsFor(context.env, context.req.raw),
	);

	return json(page, CACHE_CATALOGUE, PUBLIC_CORS);
});

catalogue.get("/entries/:id", async (context) => {
	const id = context.req.param("id");
	const found = await getEntry(context.env.DB, id);
	if (!found || found.row.status !== "approved") fail("not_found", `没有找到 ${id}`);

	const summary = toSummary(found.row, urlsFor(context.env, context.req.raw));

	return json(
		{
			...summary,
			readme: found.row.readme ?? undefined,
			readmeBase: found.row.readme_base,
			versions: found.versions.map((version) => toVersion(version, urlsFor(context.env, context.req.raw).tarball(id, version.version))),
		},
		CACHE_CATALOGUE,
		PUBLIC_CORS,
	);
});

catalogue.get("/categories", async (context) => {
	return json(await listCategories(context.env.DB), CACHE_CATALOGUE, PUBLIC_CORS);
});

catalogue.get("/stats", async (context) => {
	return json(await getStats(context.env.DB), CACHE_CATALOGUE, PUBLIC_CORS);
});

/**
 * The whole catalogue as a registry index, in the format the app already reads.
 *
 * Two shapes come out of one query because the app configures plugin sources and skill sources
 * separately: `?kind=skill` answers with `collections`, everything else with `plugins`. Both are
 * accepted by `readIndex`, so a client that does not care can point at either.
 *
 * Capped at 500. An index is a single document the app holds in memory, and a registry that has
 * outgrown one document needs pagination rather than a bigger document — but a silent truncation
 * would look exactly like a small registry, so the cap is stated in the response.
 */
catalogue.get("/index", async (context) => {
	const kind = context.req.query("kind");
	const wanted = isBundleKind(kind) ? kind : undefined;

	const page = await listEntries(
		context.env.DB,
		{ statuses: PUBLIC, kind: wanted, sort: "downloads", page: 0, pageSize: 500 },
		urlsFor(context.env, context.req.raw),
	);

	const entries = page.items.map(toIndexEntry);
	const body: Record<string, unknown> = {
		name: "Lyra Registry",
		updatedAt: new Date().toISOString().slice(0, 10),
		[wanted === "skill" ? "collections" : "plugins"]: entries,
	};
	if (page.total > entries.length) body.truncated = { shown: entries.length, total: page.total };

	return json(body, CACHE_INDEX, PUBLIC_CORS);
});

/**
 * One catalogue row as an index entry.
 *
 * Deliberately not just the summary: `status`, `publisher` and the daily download figure are
 * platform concepts an index has no field for, and shipping them would put things in a document
 * whose readers include code we do not control. What goes out is what a registry index has always
 * been allowed to say, plus the optional tarball fields.
 */
function toIndexEntry(item: EntrySummary): Record<string, unknown> {
	return {
		id: item.id,
		name: item.name,
		description: item.description,
		category: item.category,
		kind: item.kind,
		repository: item.repository,
		path: item.path,
		homepage: item.homepage,
		author: item.author,
		logo: item.logo,
		brandColor: item.brandColor,
		license: item.license,
		package: item.package,
		version: item.version,
		tarball: item.tarball,
		sha256: item.sha256,
		size: item.size,
		skillCount: item.skillCount,
		serverCount: item.serverCount,
		commit: item.commit,
		downloads: item.downloads,
		updatedAt: item.updatedAt,
	};
}
