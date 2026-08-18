/**
 * Submitting something, and rebuilding it.
 *
 * A submission is a repository URL and an optional sub-path. Everything else — the name, the kind,
 * how many skills it has, whether it is installable at all — is read out of the repository, because
 * a form field is a claim and the archive is a fact. The build runs synchronously so the author
 * finds out now rather than in an email.
 *
 * Nothing published here is visible until an admin approves it. That is the whole moderation
 * model: the platform will build anything, and shows nothing it has not been told to show.
 */

import { isBundleKind, isValidId, normalisePath, parseRepo, slugOf, type BuildResult } from "@lyra/registry-shared";
import { Hono } from "hono";

import { build, isSubmitterError, resolveCommit } from "../build/pipeline.ts";
import { getEntry, listEntries } from "../db/entries.ts";
import { toSummary, toVersion } from "../db/rows.ts";
import { recordSubmission, saveVersion, upsertEntry, upsertPublisher } from "../db/writes.ts";
import { urlsFor, type Env } from "../env.ts";
import { fail, json, NO_STORE, readToken } from "../lib/http.ts";
import { requireViewer } from "./auth.ts";

export const publish = new Hono<{ Bindings: Env }>();

/** What a submitted entry is built from when nobody says otherwise. */
const DEFAULT_REF = "HEAD";

/**
 * Make sure the session's owner exists as a row before anything points at them.
 *
 * `entries.publisher_id` is a foreign key, and a session outlives the request that created it by a
 * week. Relying on the OAuth callback having written the row means a submission fails with a
 * constraint violation — a 500, with nothing the author can do — whenever the two have got out of
 * step: a database restored from before they signed up, a row removed, a token still valid.
 *
 * The session already carries everything the table needs, so the fix is to stop treating sign-in
 * as the only moment that can write it. Found by submitting with a hand-signed token, which is
 * exactly the state a week-old session is in.
 */
async function ensurePublisher(env: Env, viewer: { id: number; login: string; name?: string; avatarUrl?: string }) {
	await upsertPublisher(env.DB, {
		id: viewer.id,
		login: viewer.login,
		name: viewer.name,
		avatarUrl: viewer.avatarUrl,
	});
}

publish.get("/mine", async (context) => {
	const viewer = await requireViewer(context.env, readToken(context));
	const page = await listEntries(
		context.env.DB,
		{
			statuses: ["pending", "approved", "rejected", "delisted"],
			publisherId: viewer.id,
			sort: "updated",
			pageSize: 100,
		},
		urlsFor(context.env, context.req.raw),
	);
	return json(page, NO_STORE);
});

publish.post("/entries", async (context) => {
	const viewer = await requireViewer(context.env, readToken(context));
	const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) fail("invalid", "请求体不是 JSON");

	const repo = parseRepo(String(body.repository ?? ""));
	if (!repo) fail("invalid", "仓库地址必须是一个 GitHub 仓库，例如 https://github.com/owner/name");

	const subpath = normalisePath(typeof body.path === "string" ? body.path : undefined);
	if (subpath === null) fail("invalid", "子路径不合法");

	await ensurePublisher(context.env, viewer);

	const declared = isBundleKind(body.kind) ? body.kind : undefined;
	const id = pickId(body.id, repo.repo, subpath);
	if (!isValidId(id)) fail("invalid", "id 只能是小写字母、数字、点、下划线和短横线");

	/*
	 * An id already taken by somebody else is refused before anything is built.
	 *
	 * Not after: a build takes seconds and downloads a repository, and doing that only to discard
	 * it is rude to GitHub and to the submitter. Re-submitting your own entry is an update.
	 */
	const existing = await getEntry(context.env.DB, id);
	if (existing && existing.row.publisher_id !== viewer.id && !viewer.isAdmin) {
		fail("conflict", `${id} 已经被别人用了，换一个 id`);
	}

	const result = await buildAndStore(context.env, {
		id,
		repo,
		subpath,
		declared,
		ref: typeof body.ref === "string" && body.ref ? body.ref : DEFAULT_REF,
		publisherId: viewer.id,
		// An update keeps whatever status it had; a new one starts in the queue.
		status: existing ? (existing.row.status as "pending" | "approved" | "rejected" | "delisted") : "pending",
		overrides: {
			name: str(body.name),
			description: str(body.description),
			category: str(body.category),
		},
	});

	if (!result.ok) return json(result, NO_STORE);
	if (!existing) await recordSubmission(context.env.DB, id, viewer.id);
	return json(result, NO_STORE);
});

/** Rebuild from upstream. The author's "I pushed a fix" button, and what the cron job calls. */
publish.post("/entries/:id/refresh", async (context) => {
	const viewer = await requireViewer(context.env, readToken(context));
	const id = context.req.param("id");

	const found = await getEntry(context.env.DB, id);
	if (!found) fail("not_found", `没有找到 ${id}`);
	if (found.row.publisher_id !== viewer.id && !viewer.isAdmin) fail("forbidden", "这不是你的条目");

	const repo = parseRepo(found.row.repository);
	if (!repo) fail("invalid", "这条记录的仓库地址已经不可用了");

	// The row's publisher may be null (a seeded entry), in which case the refresher becomes its
	// publisher — and has to exist as a row first, for the same reason as on submission.
	await ensurePublisher(context.env, viewer);

	return json(
		await buildAndStore(context.env, {
			id,
			repo,
			subpath: found.row.subpath,
			declared: found.row.kind as never,
			ref: DEFAULT_REF,
			publisherId: found.row.publisher_id ?? viewer.id,
			status: found.row.status as "pending" | "approved" | "rejected" | "delisted",
			overrides: {
				name: found.row.name,
				description: found.row.description ?? undefined,
				category: found.row.category ?? undefined,
			},
		}),
		NO_STORE,
	);
});

/** An entry as its own publisher sees it: including the review note and its unapproved state. */
publish.get("/entries/:id/mine", async (context) => {
	const viewer = await requireViewer(context.env, readToken(context));
	const id = context.req.param("id");
	const found = await getEntry(context.env.DB, id);
	if (!found) fail("not_found", `没有找到 ${id}`);
	if (found.row.publisher_id !== viewer.id && !viewer.isAdmin) fail("forbidden", "这不是你的条目");

	const summary = toSummary(found.row, urlsFor(context.env, context.req.raw));
	return json(
		{
			...summary,
			readme: found.row.readme ?? undefined,
			reviewNote: found.row.review_note ?? undefined,
			versions: found.versions.map((v) => toVersion(v, urlsFor(context.env, context.req.raw).tarball(id, v.version))),
		},
		NO_STORE,
	);
});

interface BuildAndStore {
	id: string;
	repo: ReturnType<typeof parseRepo> & object;
	subpath: string;
	declared?: "plugin" | "mcp" | "skill";
	ref: string;
	publisherId: number;
	status: "pending" | "approved" | "rejected" | "delisted";
	overrides: { name?: string; description?: string; category?: string };
}

/**
 * Build it, put the archive in R2, write the rows.
 *
 * R2 first, then D1. The reverse would leave a row whose `tarball_key` names an object that does
 * not exist — a download that 404s for a version the catalogue says is there. An orphaned object
 * costs storage and nothing else.
 */
async function buildAndStore(env: Env, input: BuildAndStore): Promise<BuildResult> {
	try {
		const commit = await resolveCommit(input.repo, input.ref, env.GITHUB_TOKEN);
		const built = await build({
			repo: input.repo,
			ref: input.ref,
			subpath: input.subpath,
			declared: input.declared,
			token: env.GITHUB_TOKEN,
			commit,
		});

		const version = versionOf(built.manifest.version, commit);
		const key = `bundles/${input.id}/${version}.tar.gz`;
		await env.BUCKET.put(key, built.archive as unknown as ArrayBuffer, {
			httpMetadata: { contentType: "application/gzip" },
			// Stored beside the object so a bucket audit can answer "what is this" without D1.
			customMetadata: { entryId: input.id, version, sha256: built.sha256 },
		});

		const author = typeof built.manifest.author === "string" ? built.manifest.author : built.manifest.author?.name;
		await upsertEntry(env.DB, {
			id: input.id,
			kind: built.kind,
			// The submitter's label wins over the manifest's, and the manifest's over the directory.
			name: input.overrides.name || built.manifest.interface?.displayName || built.manifest.name || input.id,
			description:
				input.overrides.description || built.manifest.interface?.shortDescription || built.manifest.description,
			category: input.overrides.category || built.manifest.interface?.category,
			repository: input.repo.url,
			subpath: input.subpath,
			homepage: built.manifest.homepage || built.manifest.interface?.websiteURL || input.repo.homepage,
			author: author || built.manifest.interface?.developerName || input.repo.owner,
			// Every GitHub owner has an avatar and it never 404s, which is more than can be said for
			// a logo URL in a manifest.
			logo: built.manifest.interface?.logo || `https://github.com/${input.repo.owner}.png?size=128`,
			brandColor: built.manifest.interface?.brandColor,
			license: built.manifest.license,
			publisherId: input.publisherId,
			status: input.status,
			readme: built.readme,
		});
		await saveVersion(env.DB, input.id, version, built, key);

		return {
			ok: true,
			entryId: input.id,
			version,
			warnings: built.warnings,
			skillCount: built.skillCount,
			serverCount: built.serverCount,
		};
	} catch (error) {
		// A submitter's mistake comes back as a sentence they can act on; ours comes back as a 500.
		if (isSubmitterError(error)) return { ok: false, error: error.message };
		throw error;
	}
}

/**
 * What to call this build.
 *
 * The manifest's version when it has one, because that is what the author calls it. Otherwise the
 * commit, short — a version string has to be unique per build, and a repository with no version
 * field still changes. Falling back to a timestamp would make two builds of the same commit two
 * different versions.
 */
function versionOf(declared: string | undefined, commit: string): string {
	if (declared && /^[\w.+-]{1,32}$/.test(declared)) return declared;
	return commit ? `0.0.0-${commit.slice(0, 7)}` : "0.0.0";
}

function pickId(given: unknown, repoName: string, subpath: string): string {
	if (typeof given === "string" && given.trim()) return slugOf(given.trim());
	// The sub-path's last segment names the bundle far better than the repository does when one
	// repository ships many: `plugins/context7` is Context7, not Lyra-Plugins.
	const tail = subpath.split("/").findLast(Boolean);
	return slugOf(tail || repoName);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}
