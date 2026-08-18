/**
 * Turning a repository tarball into the archive we actually publish.
 *
 * GitHub hands back the whole repository under a top-level directory named `<repo>-<sha>`, which
 * is a fact about the download rather than about the bundle. What we store has to be the bundle
 * and nothing else: rooted at the sub-path, stripped of history and build output, capped so that
 * one submission cannot fill a bucket, and ordered so that building the same commit twice gives
 * the same bytes.
 *
 * That last one is what makes the SHA-256 worth recording. A hash that changes between two builds
 * of identical content cannot distinguish a stale cache from a tampered one, which is the only
 * question it exists to answer.
 */

import type { TarEntry } from "./tar.ts";

/** One file this large is not documentation or a skill; it is something that should not be here. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Everything together. Generous for markdown, far below what a checkout of a real project weighs. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
/** A bundle with more files than this is a repository somebody pointed at by mistake. */
const MAX_FILES = 5_000;

/**
 * Directories that are never part of a bundle, at any depth.
 *
 * `.git` is the big one: GitHub's tarball does not include it, but an archive built from anywhere
 * else might, and a bundle carrying a full object database is both enormous and pointless. The
 * others are a dependency tree and an artefact of how macOS writes archives.
 *
 * `.github` is deliberately *not* here. It is small, and dropping it would be us deciding on the
 * author's behalf that their issue templates are not part of what they published.
 */
const EXCLUDED_DIRS = new Set([".git", "node_modules", "__MACOSX"]);
/** Files that are never part of one either, wherever they appear. */
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** Matched on whole path segments: `.DS_Store` is excluded, `.DS_Storefoo` is somebody's file. */
function isExcluded(path: string): boolean {
	const parts = path.split("/");
	if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
	return EXCLUDED_FILES.has(parts[parts.length - 1] ?? "");
}

export class BundleTooBig extends Error {}
export class BundleEmpty extends Error {}

/**
 * Extract the bundle from a repository archive.
 *
 * `subpath` is relative to the repository root and has already been checked by `normalisePath`;
 * it is checked again on every path here anyway, because the cost is a comparison and the failure
 * mode is writing outside the extraction root on somebody's machine.
 */
export function extractBundle(entries: TarEntry[], subpath: string): TarEntry[] {
	/*
	 * Hostile paths go before anything reads them — `commonRoot` included.
	 *
	 * It decides there is no shared root the moment one entry disagrees, so a single `/etc/passwd`
	 * in the archive would leave the `<repo>-<sha>` wrapper on every real file: the traversal
	 * attempt fails, and takes the extraction with it. Dropping them first means one bad entry
	 * costs that entry.
	 */
	const safe = entries.filter((entry) => isSafe(entry.path));
	const root = commonRoot(safe);
	const prefix = subpath ? `${root}${subpath}/` : root;

	const kept: TarEntry[] = [];
	let total = 0;

	for (const entry of safe) {
		if (!entry.path.startsWith(prefix)) continue;
		const path = entry.path.slice(prefix.length);
		if (!path || !isSafe(path) || isExcluded(path)) continue;
		if (entry.data.length > MAX_FILE_BYTES) {
			throw new BundleTooBig(`${path} 有 ${Math.round(entry.data.length / 1024 / 1024)}MB，单个文件不能超过 5MB`);
		}
		total += entry.data.length;
		if (total > MAX_BUNDLE_BYTES) throw new BundleTooBig("这个目录超过 20MB，装的东西不该有这么大");
		if (kept.length >= MAX_FILES) throw new BundleTooBig(`文件超过 ${MAX_FILES} 个，这看起来是整个仓库而不是一个插件`);

		kept.push({ path, data: entry.data, mode: entry.mode & 0o111 ? 0o755 : 0o644 });
	}

	if (kept.length === 0) {
		throw new BundleEmpty(subpath ? `仓库里没有 ${subpath} 这个目录，或者它是空的` : "这个仓库是空的");
	}

	// Sorted by path, so the archive is a function of its contents and nothing else.
	kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return kept;
}

/**
 * The single directory every path in a GitHub tarball sits under.
 *
 * Returned with its trailing slash, or `""` when the entries do not share one — an archive that
 * was not built this way still works, it just has nothing to strip. Guessing wrong in the second
 * case would silently drop the first path segment of every file.
 */
export function commonRoot(entries: TarEntry[]): string {
	if (entries.length === 0) return "";
	const first = entries[0]!.path.split("/")[0];
	if (!first) return "";
	const prefix = `${first}/`;
	return entries.every((entry) => entry.path.startsWith(prefix)) ? prefix : "";
}

/**
 * Whether a path may be written when this archive is unpacked.
 *
 * The source is GitHub, so none of this should ever trigger. It is here because "should never" is
 * not a security property: the archive is unpacked by the app onto a user's disk, and the check
 * that it cannot escape belongs on the side that produces it as well as the side that consumes it.
 */
function isSafe(path: string): boolean {
	if (path.startsWith("/") || path.includes("\\")) return false;
	if (/^[a-zA-Z]:/.test(path)) return false; // a Windows drive letter is an absolute path
	return !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

/** Bytes of a built bundle, for the size a client is told before it downloads. */
export function bundleSize(entries: TarEntry[]): number {
	let total = 0;
	for (const entry of entries) total += entry.data.length;
	return total;
}
