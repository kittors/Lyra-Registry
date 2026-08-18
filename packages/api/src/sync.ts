/**
 * The nightly refresh.
 *
 * This replaces the GitHub Action that used to regenerate `registry.json` every day. The job is
 * the same — notice that an upstream moved and rebuild — but the cost is not: the old one cloned
 * or fetched every source unconditionally, and this asks a 40-byte question first.
 *
 *     resolveCommit() -> unchanged? -> done, no download
 *
 * That matters because the alternative is downloading tens of repositories a night to discover
 * that none of them changed, which is both slow and a good way to get rate-limited by GitHub.
 *
 * A failure is per-entry. One repository that was deleted overnight must not stop the other forty
 * from refreshing, so every step is caught and recorded rather than thrown.
 */

import { parseRepo } from "@lyra/registry-shared";

import { build, isSubmitterError, resolveCommit } from "./build/pipeline.ts";
import { saveVersion, upsertEntry } from "./db/writes.ts";
import type { Env } from "./env.ts";

/** How many entries one nightly run will rebuild. See `refreshAll` for why there is a cap at all. */
const MAX_REBUILDS_PER_RUN = 20;

interface Refreshable {
	id: string;
	kind: string;
	name: string;
	description: string | null;
	category: string | null;
	repository: string;
	subpath: string;
	publisher_id: number | null;
	status: string;
	latest_commit: string | null;
}

export interface RefreshReport {
	checked: number;
	rebuilt: string[];
	unchanged: number;
	failed: { id: string; error: string }[];
	/** Entries that were due a rebuild but hit the per-run cap. Never silently dropped. */
	deferred: string[];
}

export async function refreshAll(env: Env): Promise<RefreshReport> {
	const report: RefreshReport = { checked: 0, rebuilt: [], unchanged: 0, failed: [], deferred: [] };

	const { results } = await env.DB.prepare(
		`SELECT e.id, e.kind, e.name, e.description, e.category, e.repository, e.subpath,
		        e.publisher_id, e.status, v.commit_sha AS latest_commit
		 FROM entries e
		 LEFT JOIN versions v ON v.entry_id = e.id AND v.version = e.latest_version
		 WHERE e.status IN ('approved', 'pending')
		 ORDER BY e.updated_at ASC`,
	).all<Refreshable>();

	for (const entry of results) {
		report.checked += 1;
		const repo = parseRepo(entry.repository);
		if (!repo) {
			report.failed.push({ id: entry.id, error: "仓库地址无法解析" });
			continue;
		}

		try {
			const commit = await resolveCommit(repo, "HEAD", env.GITHUB_TOKEN);
			/*
			 * An empty answer means GitHub would not say, not that nothing changed.
			 *
			 * Treating it as "unchanged" would be right most of the time and wrong exactly when the
			 * platform is rate-limited — which is when the most entries look unchanged at once.
			 */
			if (!commit) {
				report.failed.push({ id: entry.id, error: "拿不到上游 commit（可能被限流）" });
				continue;
			}
			if (commit === entry.latest_commit) {
				report.unchanged += 1;
				continue;
			}

			if (report.rebuilt.length >= MAX_REBUILDS_PER_RUN) {
				report.deferred.push(entry.id);
				continue;
			}

			await rebuild(env, entry, repo, commit);
			report.rebuilt.push(entry.id);
		} catch (error) {
			report.failed.push({
				id: entry.id,
				error: isSubmitterError(error) ? error.message : "构建失败",
			});
		}
	}

	console.warn(
		`refresh: checked=${report.checked} rebuilt=${report.rebuilt.length} unchanged=${report.unchanged}` +
			` failed=${report.failed.length} deferred=${report.deferred.length}`,
	);
	return report;
}

async function rebuild(
	env: Env,
	entry: Refreshable,
	repo: NonNullable<ReturnType<typeof parseRepo>>,
	commit: string,
): Promise<void> {
	const built = await build({
		repo,
		ref: "HEAD",
		subpath: entry.subpath,
		declared: entry.kind as never,
		token: env.GITHUB_TOKEN,
		commit,
	});

	const version =
		built.manifest.version && /^[\w.+-]{1,32}$/.test(built.manifest.version)
			? built.manifest.version
			: `0.0.0-${commit.slice(0, 7)}`;

	const key = `bundles/${entry.id}/${version}.tar.gz`;
	await env.BUCKET.put(key, built.archive as unknown as ArrayBuffer, {
		httpMetadata: { contentType: "application/gzip" },
		customMetadata: { entryId: entry.id, version, sha256: built.sha256 },
	});

	const author = typeof built.manifest.author === "string" ? built.manifest.author : built.manifest.author?.name;
	await upsertEntry(env.DB, {
		id: entry.id,
		kind: built.kind,
		/*
		 * The stored label wins over the manifest's.
		 *
		 * A refresh must not rename something under its publisher because upstream edited a JSON
		 * field. What a refresh updates is the archive; what it leaves alone is everything a person
		 * chose. `description` and `category` follow the same rule, falling back to the manifest
		 * only where nothing was ever set.
		 */
		name: entry.name,
		description: entry.description ?? built.manifest.interface?.shortDescription ?? built.manifest.description,
		category: entry.category ?? built.manifest.interface?.category,
		repository: repo.url,
		subpath: entry.subpath,
		homepage: built.manifest.homepage || built.manifest.interface?.websiteURL || repo.homepage,
		author: author || built.manifest.interface?.developerName || repo.owner,
		logo: built.manifest.interface?.logo || `https://github.com/${repo.owner}.png?size=128`,
		brandColor: built.manifest.interface?.brandColor,
		license: built.manifest.license,
		publisherId: entry.publisher_id ?? undefined,
		status: entry.status as "approved",
		readme: built.readme,
	});

	await saveVersion(env.DB, entry.id, version, built, key);
}
