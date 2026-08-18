/**
 * What a bundle turns out to be.
 *
 * The fixtures here are the shapes actually found in `kittors/Lyra-Plugins` and in the collections
 * it syncs from — a `.lyra-plugin/plugin.json` pointing at a `.mcp.json`, a bare `skills/` tree
 * with no manifest at all, a Claude Code `marketplace.json`. Inventing simpler ones would test a
 * format nobody publishes.
 *
 * The verdicts have to match `inspectBundle` in `@lyra/core` exactly. Where they differ, the
 * catalogue advertises one thing and the installer produces another.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { inspect, UnusableBundle } from "../src/build/inspect.ts";
import type { TarEntry } from "../src/build/tar.ts";

const encoder = new TextEncoder();

function file(path: string, text: string): TarEntry {
	return { path, data: encoder.encode(text), mode: 0o644 };
}

function json(path: string, value: unknown): TarEntry {
	return file(path, JSON.stringify(value));
}

/** The exact shape of `plugins/context7` in the live registry. */
const CONTEXT7: TarEntry[] = [
	json(".lyra-plugin/plugin.json", {
		name: "context7",
		version: "4.0.2",
		description: "取库的当前文档，而不是模型记忆里那个版本的。",
		author: { name: "Upstash" },
		homepage: "https://github.com/upstash/context7",
		interface: { displayName: "Context7", category: "开发", brandColor: "#8b5cf6" },
		mcpServers: ".mcp.json",
	}),
	json(".mcp.json", { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } } }),
];

test("a manifest pointing at a .mcp.json with no skills is an MCP server", () => {
	const result = inspect(CONTEXT7);
	assert.equal(result.kind, "mcp");
	assert.equal(result.serverCount, 1);
	assert.equal(result.skillCount, 0);
	assert.equal(result.manifest.interface?.displayName, "Context7");
});

test("servers are counted, not assumed to be one", () => {
	const many = [
		json(".lyra-plugin/plugin.json", { name: "multi", mcpServers: ".mcp.json" }),
		json(".mcp.json", { mcpServers: { a: { command: "x" }, b: { command: "y" }, c: { command: "z" } } }),
	];
	assert.equal(inspect(many).serverCount, 3);
});

test("a skills directory with no manifest is a plugin anyway", () => {
	// Almost nothing in the wild ships our manifest; `skills/<name>/SKILL.md` is the real convention.
	const bare = [
		file("skills/review/SKILL.md", "---\nname: review\n---\n"),
		file("skills/hunt/SKILL.md", "---\nname: hunt\n---\n"),
		file("skills/hunt/scripts/run.sh", "#!/bin/sh"),
		file("README.md", "# Waza"),
	];
	const result = inspect(bare);
	assert.equal(result.kind, "plugin");
	assert.equal(result.skillCount, 2, "one per SKILL.md, not one per file");
	assert.equal(result.readme, "# Waza");
});

test("skills are counted one level down, which is what the app loads", () => {
	// A SKILL.md nested deeper is not a skill the app will find, so it is not one here either.
	const nested = [
		file("skills/real/SKILL.md", "x"),
		file("skills/deeper/inner/SKILL.md", "x"),
		file("skills/SKILL.md", "x"),
	];
	assert.equal(inspect(nested).skillCount, 1);
});

test("a manifest may point the skills directory somewhere else", () => {
	const custom = [
		json("plugin.json", { name: "custom", skills: "./lib/skills/" }),
		file("lib/skills/one/SKILL.md", "x"),
		file("skills/decoy/SKILL.md", "x"),
	];
	const result = inspect(custom);
	assert.equal(result.skillCount, 1);
	assert.equal(result.kind, "plugin");
});

test("a marketplace.json supplies the label an inferred bundle would otherwise lack", () => {
	const claude = [
		json(".claude-plugin/marketplace.json", {
			name: "anthropics-marketplace",
			owner: { name: "Anthropic" },
			plugins: [{ name: "anthropic-skills", description: "18 个技能", version: "1.2.0", category: "官方" }],
		}),
		file("skills/docx/SKILL.md", "x"),
	];
	const result = inspect(claude);
	// The plugin's own entry, not the marketplace's name — the latter is the publishing account.
	assert.equal(result.manifest.name, "anthropic-skills");
	assert.equal(result.manifest.version, "1.2.0");
	assert.equal((result.manifest.author as { name: string }).name, "Anthropic");
	assert.equal(result.manifest.interface?.category, "官方");
});

test("a skill collection is honoured when declared, and counted from the root", () => {
	const collection = [
		file("check/SKILL.md", "x"),
		file("hunt/SKILL.md", "x"),
		file("learn/SKILL.md", "x"),
		file("README.md", "# Waza"),
	];
	const result = inspect(collection, "skill");
	assert.equal(result.kind, "skill");
	assert.equal(result.skillCount, 3);
});

test("a collection that holds no skills is a wrong claim, not a fact", () => {
	// The index pointing at the wrong sub-path used to install an empty directory and report success.
	assert.throws(() => inspect([file("docs/readme.md", "x")], "skill"), UnusableBundle);
});

test("the declared kind loses to what the archive actually holds", () => {
	// Seven of the nine entries in the original registry called themselves plugins and were not.
	const result = inspect(CONTEXT7, "plugin");
	assert.equal(result.kind, "mcp");
	assert.ok(
		result.warnings.some((w) => w.includes("已按实际内容归类")),
		"the correction has to be visible to whoever submitted it",
	);
});

test("a bundle holding both is a plugin, and says the servers will not load", () => {
	const both = [
		json(".lyra-plugin/plugin.json", { name: "both", mcpServers: ".mcp.json" }),
		json(".mcp.json", { mcpServers: { a: { command: "x" } } }),
		file("skills/one/SKILL.md", "x"),
	];
	const result = inspect(both);
	assert.equal(result.kind, "plugin");
	assert.ok(result.warnings.some((w) => w.includes("MCP")));
});

test("a bundle with nothing installable is refused with a sentence", () => {
	assert.throws(() => inspect([file("README.md", "# just docs")]), UnusableBundle);
	assert.throws(() => inspect([]), UnusableBundle);
});

test("a manifest that declares nothing loadable is refused, not shipped empty", () => {
	// It has a manifest, so inference never runs; without this it would install and do nothing.
	assert.throws(() => inspect([json("plugin.json", { name: "hollow" })]), /既没有技能也没有 MCP/);
});

test("a manifest that is not JSON fails the build rather than being ignored", () => {
	assert.throws(() => inspect([file(".lyra-plugin/plugin.json", "{ not json")]), /不是合法 JSON/);
});

test("a manifest with no name is refused, matching the app", () => {
	assert.throws(() => inspect([json("plugin.json", { description: "nameless" })]), /缺少 name/);
});

test("an mcpServers path that climbs out of the bundle is refused, not followed", () => {
	const escaping = [json("plugin.json", { name: "evil", mcpServers: "../../../etc/passwd" }), file("skills/a/SKILL.md", "x")];
	const result = inspect(escaping);
	assert.equal(result.serverCount, 0);
	assert.ok(result.warnings.some((w) => w.includes("逃出")));
});

test("a broken .mcp.json costs its servers, not the build", () => {
	const broken = [json("plugin.json", { name: "b", mcpServers: ".mcp.json", skills: "skills" }), file(".mcp.json", "{oops"), file("skills/a/SKILL.md", "x")];
	const result = inspect(broken);
	assert.equal(result.kind, "plugin");
	assert.equal(result.serverCount, 0);
	assert.ok(result.warnings.some((w) => w.includes("不是合法 JSON")));
});

test("a README is found under any of the names people use", () => {
	assert.equal(inspect([file("skills/a/SKILL.md", "x"), file("readme.md", "lower")]).readme, "lower");
	assert.equal(inspect([file("skills/a/SKILL.md", "x")]).readme, undefined);
});

test("an enormous README is truncated rather than stored whole", () => {
	const huge = "x".repeat(200_000);
	const result = inspect([file("skills/a/SKILL.md", "x"), file("README.md", huge)]);
	assert.equal(result.readme?.length, 64_000);
});

test("a collection pointed at the wrong level is told where the skills actually are", () => {
	/*
	 * `anthropics/skills` submitted without a path: the root holds one `template/SKILL.md` while
	 * nineteen real skills sit under `skills/`. The count of 1 is correct and the entry is useless,
	 * and without this the author has no way to know a field was missing.
	 */
	const repo = [
		file("template/SKILL.md", "x"),
		file("skills/docx/SKILL.md", "x"),
		file("skills/xlsx/SKILL.md", "x"),
		file("skills/pdf/SKILL.md", "x"),
	];
	const result = inspect(repo, "skill");
	assert.equal(result.skillCount, 1, "still counts one level, same as the app loads");
	assert.ok(
		result.warnings.some((w) => w.includes("skills/") && w.includes("3")),
		`expected a hint naming skills/, got ${JSON.stringify(result.warnings)}`,
	);
});

test("a collection with nothing at this level says where to look instead of just refusing", () => {
	const repo = [file("collection/a/SKILL.md", "x"), file("collection/b/SKILL.md", "x")];
	assert.throws(() => inspect(repo, "skill"), /collection\/ 下面有 2 个/);
});

test("no suggestion when this level is already the best one", () => {
	const flat = [file("a/SKILL.md", "x"), file("b/SKILL.md", "x"), file("nested/deep/SKILL.md", "x")];
	const result = inspect(flat, "skill");
	assert.equal(result.skillCount, 2);
	assert.deepEqual(result.warnings, [], "a hint that does not improve anything is noise");
});
