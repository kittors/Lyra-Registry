/**
 * Turning a repository tarball into the archive we publish.
 *
 * The fixture shape is GitHub's: everything under one `<repo>-<sha>/` directory. Getting the strip
 * wrong in either direction is silent — too little leaves a stray path segment on every file, too
 * much eats the first real directory — so it is the thing checked hardest here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BundleEmpty, BundleTooBig, bundleSize, commonRoot, extractBundle } from "../src/build/bundle.ts";
import type { TarEntry } from "../src/build/tar.ts";

const encoder = new TextEncoder();

function file(path: string, text = "x", mode = 0o644): TarEntry {
	return { path, data: encoder.encode(text), mode };
}

/** What `codeload.github.com/kittors/Lyra-Plugins/tar.gz/main` actually unpacks to. */
const REPO: TarEntry[] = [
	file("Lyra-Plugins-a1b2c3d/README.md", "# Lyra Plugins"),
	file("Lyra-Plugins-a1b2c3d/registry.json", "{}"),
	file("Lyra-Plugins-a1b2c3d/plugins/context7/.lyra-plugin/plugin.json", '{"name":"context7"}'),
	file("Lyra-Plugins-a1b2c3d/plugins/context7/.mcp.json", '{"mcpServers":{}}'),
	file("Lyra-Plugins-a1b2c3d/plugins/memory/.mcp.json", "{}"),
];

test("the download's top-level directory is stripped", () => {
	const bundle = extractBundle(REPO, "");
	assert.ok(
		bundle.every((entry) => !entry.path.startsWith("Lyra-Plugins-")),
		"the <repo>-<sha> wrapper is a fact about the download, not about the bundle",
	);
	assert.ok(bundle.some((entry) => entry.path === "README.md"));
});

test("a sub-path becomes the root of what we publish", () => {
	const bundle = extractBundle(REPO, "plugins/context7");
	assert.deepEqual(
		bundle.map((entry) => entry.path),
		[".lyra-plugin/plugin.json", ".mcp.json"],
	);
});

test("a sub-path that is not in the repository is refused with a sentence", () => {
	assert.throws(() => extractBundle(REPO, "plugins/nonexistent"), BundleEmpty);
});

test("a sibling directory sharing a name prefix is not swept in", () => {
	// `plugins/memory` must not match a request for `plugins/mem`.
	const entries = [file("r-sha/plugins/mem/a.md"), file("r-sha/plugins/memory/b.md")];
	assert.deepEqual(
		extractBundle(entries, "plugins/mem").map((entry) => entry.path),
		["a.md"],
	);
});

test("an archive with no shared top level is left alone", () => {
	// Not every archive comes from GitHub; stripping a root that is not there eats a real directory.
	const flat = [file("SKILL.md"), file("scripts/run.sh")];
	assert.equal(commonRoot(flat), "");
	assert.deepEqual(
		extractBundle(flat, "").map((entry) => entry.path),
		["SKILL.md", "scripts/run.sh"],
	);
});

test("the output is sorted, so the same commit builds to the same bytes", () => {
	const shuffled = [file("root/z.md"), file("root/a.md"), file("root/m/n.md")];
	assert.deepEqual(
		extractBundle(shuffled, "").map((entry) => entry.path),
		["a.md", "m/n.md", "z.md"],
	);
});

test("history and dependency trees are dropped at any depth", () => {
	const noisy = [
		file("r-sha/SKILL.md"),
		file("r-sha/.git/config"),
		file("r-sha/nested/.git/objects/ab/cdef"),
		file("r-sha/node_modules/left-pad/index.js"),
		file("r-sha/.DS_Store"),
		file("r-sha/skills/.DS_Store"),
	];
	assert.deepEqual(
		extractBundle(noisy, "").map((entry) => entry.path),
		["SKILL.md"],
	);
});

test("a file that merely starts with an excluded name is kept", () => {
	// Segment matching, not prefix matching: `.gitignore` is a file people mean to publish.
	const entries = [file("r-sha/.gitignore"), file("r-sha/.DS_Storefoo"), file("r-sha/node_modules_notes.md")];
	assert.deepEqual(
		extractBundle(entries, "").map((entry) => entry.path).sort(),
		[".DS_Storefoo", ".gitignore", "node_modules_notes.md"],
	);
});

test(".github survives, because dropping it is deciding on the author's behalf", () => {
	const entries = [file("r-sha/SKILL.md"), file("r-sha/.github/ISSUE_TEMPLATE.md")];
	assert.ok(extractBundle(entries, "").some((entry) => entry.path === ".github/ISSUE_TEMPLATE.md"));
});

test("a path that could write outside the extraction root never reaches the archive", () => {
	// The source is GitHub so this should be unreachable — which is not a security property.
	const hostile = [
		file("r-sha/ok.md"),
		file("r-sha/../../../etc/passwd"),
		file("/absolute/path"),
		file("r-sha/win\\path.md"),
	];
	assert.deepEqual(
		extractBundle(hostile, "").map((entry) => entry.path),
		["ok.md"],
	);
});

test("the executable bit is preserved but normalised to one of two modes", () => {
	const entries = [file("r-sha/run.sh", "#!/bin/sh", 0o750), file("r-sha/a.md", "x", 0o600)];
	const bundle = extractBundle(entries, "");
	assert.equal(bundle.find((e) => e.path === "run.sh")?.mode, 0o755);
	assert.equal(bundle.find((e) => e.path === "a.md")?.mode, 0o644);
});

test("one oversized file stops the build rather than being silently dropped", () => {
	const big: TarEntry = { path: "r-sha/huge.bin", data: new Uint8Array(6 * 1024 * 1024), mode: 0o644 };
	assert.throws(() => extractBundle([file("r-sha/a.md"), big], ""), BundleTooBig);
});

test("a repository pointed at by mistake is refused on total size", () => {
	const chunk = new Uint8Array(1024 * 1024);
	const many = Array.from({ length: 25 }, (_, i) => ({ path: `r-sha/f${i}.bin`, data: chunk, mode: 0o644 }));
	assert.throws(() => extractBundle(many, ""), BundleTooBig);
});

test("size is the sum of the files, which is what a client is told before downloading", () => {
	assert.equal(bundleSize([file("a", "12345"), file("b", "123")]), 8);
});
