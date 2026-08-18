/**
 * From a repository URL to an archive in R2, without a shell.
 *
 * The whole build is one pass over bytes: fetch the tarball, gunzip it, read the members, keep the
 * ones belonging to this bundle, decide what it is, write a normalised archive back out, hash it.
 * Nothing is written to disk because there is no disk, and nothing shells out to `git` because
 * there is no process to shell into — which turns out to be a smaller constraint than it sounds,
 * since a shallow clone was only ever a slow way to get this same tarball.
 *
 * Everything here is standard Web platform API: `fetch`, `DecompressionStream`, `crypto.subtle`.
 * That is deliberate — it means this module runs unchanged under `node --test`, so the pipeline can
 * be exercised against real repositories without a Workers runtime.
 */

import type { BundleKind, RepoRef } from "@lyra/registry-shared";
import { tarballUrl } from "@lyra/registry-shared";

import { BundleEmpty, BundleTooBig, bundleSize, commonRoot, extractBundle, MAX_BUNDLE_BYTES } from "./bundle.ts";
import { inspect, UnusableBundle, type Manifest } from "./inspect.ts";
import { concat, readTar, writeTar, type TarEntry } from "./tar.ts";

/**
 * The compressed download is capped well above the unpacked cap.
 *
 * A repository whose tarball exceeds this is not one anybody meant to publish as a plugin, and
 * refusing early costs one comparison instead of decompressing a bomb.
 */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** How long the whole fetch has. GitHub is normally under a second; this is for when it is not. */
const FETCH_TIMEOUT_MS = 30_000;

export interface BuildInput {
	repo: RepoRef;
	/** Branch, tag or commit. Whatever the submitter named; resolved by GitHub, not by us. */
	ref: string;
	subpath: string;
	/** What the submitter said it is. Corrected by `inspect` except for skill collections. */
	declared?: BundleKind;
	/**
	 * A GitHub token, when one is configured.
	 *
	 * Not for private repositories — the platform only ever builds public ones. It is for the rate
	 * limit: unauthenticated requests are counted per IP, and a Worker's egress IP is shared with
	 * every other tenant at that colo, so the anonymous budget is effectively somebody else's.
	 */
	token?: string;
	/**
	 * A commit already resolved by the caller.
	 *
	 * The refresh job asks for it first to decide whether to build at all; passing it back avoids
	 * asking twice, and pins the build to the sha the decision was made about rather than to
	 * whatever the branch points at a second later.
	 */
	commit?: string;
}

export interface BuiltBundle {
	kind: BundleKind;
	/** gzipped tar, ready to put in R2. */
	archive: Uint8Array;
	/** Of the gzipped bytes — the thing a client downloads is the thing it checks. */
	sha256: string;
	size: number;
	/** Uncompressed, so a client can say how much disk this will take. */
	unpackedSize: number;
	skillCount: number;
	serverCount: number;
	manifest: Manifest;
	readme?: string;
	warnings: string[];
	/** The commit this was built from, read off the archive rather than asked for separately. */
	commit: string;
}

/** A build that failed for a reason the submitter can act on. */
export class BuildFailed extends Error {}

export async function build(input: BuildInput): Promise<BuiltBundle> {
	/*
	 * The commit is resolved first, and separately.
	 *
	 * It cannot be read off the archive: codeload names the top-level directory `<repo>-<ref>`,
	 * echoing whatever ref was asked for, so a build from `main` yields `Lyra-Plugins-main/` and no
	 * sha anywhere. Measured, not assumed — the first version of this parsed that directory for a
	 * sha and recorded an empty string for every build.
	 *
	 * Resolving it costs one request returning exactly 40 bytes, and it is what makes the daily
	 * refresh nearly free: `resolveCommit` alone tells the caller whether anything changed, so an
	 * unchanged entry never downloads a tarball at all.
	 */
	const commit = input.commit ?? (await resolveCommit(input.repo, input.ref, input.token));

	const downloaded = await download(input);
	const members = readTar(await gunzip(downloaded));
	const files = extractBundle(members, input.subpath);
	const found = inspect(files, input.declared);

	/*
	 * Where the prose comes from when the bundle itself has none.
	 *
	 * A bundle in a sub-directory usually has no README: `plugins/context7/` is two JSON files. The
	 * obvious fix — fall back to the repository's root README — is wrong for exactly the case that
	 * motivates it. `kittors/Lyra-Plugins` holds eight bundles, and its root README describes *the
	 * index*, so Context7's page came back reading "Lyra Plugins: 一份索引，一个格式说明". A
	 * confidently wrong description is worse than an absent one.
	 *
	 * What separates the two cases is the manifest. A declared manifest speaks for this bundle and
	 * carries `longDescription` for precisely this purpose. A collection has no manifest by
	 * definition — which is also why its repository is the collection, so its root README does
	 * describe it, and `tw93/Waza` is correctly served by falling back.
	 */
	const readme =
		found.readme ??
		found.manifest.interface?.longDescription ??
		(found.hasManifest ? undefined : rootReadme(members));

	const archive = await gzip(writeTar(files));
	if (archive.length > MAX_BUNDLE_BYTES) throw new BuildFailed("打包后仍然超过 20MB");

	return {
		kind: found.kind,
		archive,
		sha256: await sha256(archive),
		size: archive.length,
		unpackedSize: bundleSize(files),
		skillCount: found.skillCount,
		serverCount: found.serverCount,
		manifest: found.manifest,
		readme,
		warnings: found.warnings,
		commit,
	};
}

/** The repository's own README, for bundles that live in a sub-directory and have none. */
function rootReadme(members: TarEntry[]): string | undefined {
	const root = commonRoot(members);
	for (const name of ["README.md", "readme.md", "README", "README.markdown"]) {
		const found = members.find((member) => member.path === `${root}${name}`);
		if (found) return new TextDecoder().decode(found.data).slice(0, 64_000);
	}
	return undefined;
}

/** Fetch the tarball, refusing anything implausible before it is all in memory. */
async function download(input: BuildInput): Promise<Uint8Array> {
	const url = tarballUrl(input.repo, input.ref);
	const headers: Record<string, string> = {
		accept: "application/x-gzip",
		// GitHub rejects requests with no user agent, and a named one makes our traffic legible to them.
		"user-agent": "lyra-registry",
	};
	if (input.token) headers.authorization = `Bearer ${input.token}`;

	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (cause) {
		throw new BuildFailed(`拉取失败：${cause instanceof Error ? cause.message : String(cause)}`);
	}

	if (response.status === 404) throw new BuildFailed(`仓库或分支不存在：${input.repo.homepage} @ ${input.ref}`);
	if (response.status === 403 || response.status === 429) throw new BuildFailed("GitHub 限流了，请稍后再试");
	if (!response.ok) throw new BuildFailed(`GitHub 返回 ${response.status}`);
	if (!response.body) throw new BuildFailed("GitHub 没有返回内容");

	// Counted while reading rather than trusted from content-length, which codeload does not send.
	return await readCapped(response.body, MAX_DOWNLOAD_BYTES, "仓库压缩包超过 64MB");
}

/**
 * Which commit a ref points at right now.
 *
 * `Accept: application/vnd.github.sha` makes the commits endpoint answer with the bare sha as text
 * — 40 bytes, no JSON to parse. Cheap enough that the daily refresh can ask about every entry and
 * only build the ones whose answer changed.
 *
 * A failure here is not fatal to a build: the sha is provenance, and a version recorded without one
 * is worse than a version not published. Callers doing change detection care about the difference,
 * so it returns "" rather than throwing.
 */
export async function resolveCommit(repo: RepoRef, ref: string, token?: string): Promise<string> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github.sha",
		"user-agent": "lyra-registry",
	};
	if (token) headers.authorization = `Bearer ${token}`;

	try {
		const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`;
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return "";
		const sha = (await response.text()).trim();
		return /^[a-f0-9]{40}$/i.test(sha) ? sha.toLowerCase() : "";
	} catch {
		return "";
	}
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	// The unpacked cap is enforced here as well: a 64MB download can expand to far more than 20MB,
	// and `extractBundle` would not see it until every byte was already resident.
	return await readCapped(through(data, new DecompressionStream("gzip")), MAX_BUNDLE_BYTES * 4, "解压后体积过大");
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	return await readCapped(through(data, new CompressionStream("gzip")), MAX_BUNDLE_BYTES, "压缩后体积过大");
}

/**
 * Push bytes through a compression stream.
 *
 * The cast is the one place two type worlds disagree about a thing both runtimes do. `lib.dom`
 * declares `DecompressionStream.writable` as `WritableStream<BufferSource>` and `workers-types` as
 * `WritableStream<ArrayBuffer | ArrayBufferView>`; `pipeThrough` on a `ReadableStream<Uint8Array>`
 * asks for `WritableStream<Uint8Array>`, which neither is, although a `Uint8Array` is exactly what
 * both accept at runtime. Confined to this function so it is not repeated at each call site — and
 * so that if it ever stops being true, it stops being true in one place.
 */
function through(data: Uint8Array, stream: { readable: unknown; writable: unknown }): ReadableStream<Uint8Array> {
	return bodyOf(data).pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Bytes as a stream, via `Response` — the one BodyInit that both runtimes accept unchanged. */
function bodyOf(data: Uint8Array): ReadableStream<Uint8Array> {
	const body = new Response(data as BufferSource).body;
	if (!body) throw new BuildFailed("无法读取数据流");
	return body as ReadableStream<Uint8Array>;
}

/** Read a stream into memory, giving up the moment it goes over budget. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, message: string): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) throw new BuildFailed(message);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return concat(chunks);
}

export async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether an error is one the submitter caused and can fix, as opposed to ours. */
export function isSubmitterError(error: unknown): error is Error {
	return (
		error instanceof BuildFailed ||
		error instanceof UnusableBundle ||
		error instanceof BundleTooBig ||
		error instanceof BundleEmpty
	);
}
