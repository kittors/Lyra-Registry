/**
 * What a bundle turns out to be, decided by reading it.
 *
 * This is the platform's copy of a judgement the app already makes in `inspectBundle` — and it has
 * to reach the same verdict, every time, or the catalogue advertises a plugin that installs as an
 * MCP server. The rules are therefore restated here rather than reinvented:
 *
 *   1. a manifest at `.lyra-plugin/plugin.json`, `.codex-plugin/plugin.json` or `plugin.json`
 *   2. failing that, a `skills/` directory or a `.mcp.json` is itself the declaration
 *   3. skills are `<skills-dir>/<name>/SKILL.md`, one level down
 *   4. no skills and at least one server means `mcp`; anything else with content is `plugin`
 *   5. a skill collection is a directory of `<name>/SKILL.md` and is never inferred — the index
 *      has to say so, because nothing in the layout distinguishes it from a plugin's skills dir
 *
 * The reason it cannot simply import the app's version is that the app's version reads a
 * filesystem. Here there is no filesystem: there is a list of paths and bytes that came out of a
 * tarball, and every question has to be asked of that list.
 */

import { clientsFor, type BundleKind, type ClientId } from "@lyra/registry-shared";

import type { TarEntry } from "./tar.ts";

/** Where a manifest may live, in the order the app looks. First hit wins. */
const MANIFEST_LOCATIONS = [".lyra-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];

export interface Manifest {
	name?: string;
	version?: string;
	description?: string;
	author?: { name?: string } | string;
	homepage?: string;
	license?: string;
	skills?: string;
	mcpServers?: string;
	interface?: {
		displayName?: string;
		shortDescription?: string;
		longDescription?: string;
		category?: string;
		brandColor?: string;
		logo?: string;
		developerName?: string;
		websiteURL?: string;
	};
}

export interface Inspection {
	kind: BundleKind;
	/** Counted from the archive, never taken from a manifest's claim about itself. */
	skillCount: number;
	serverCount: number;
	manifest: Manifest;
	/**
	 * Whether the bundle actually declared a manifest, as opposed to one being inferred from its shape.
	 *
	 * The difference decides where a description may come from. A declared manifest speaks for this
	 * bundle; an inferred one is a guess made from a directory listing.
	 */
	hasManifest: boolean;
	/**
	 * Which agents can install this, read off the archive rather than claimed.
	 *
	 * `SKILL.md` is portable across every agent that reads it; a plugin manifest is one product's
	 * format. Deriving this is the same decision as deriving `kind` and has the same justification:
	 * a submission form would let somebody tick every box.
	 */
	clients: ClientId[];
	/** Raw markdown, for the detail page. The first README found at the root of the bundle. */
	readme?: string;
	/** Things worth telling the author that are not reasons to refuse the build. */
	warnings: string[];
}

/** A bundle that cannot be installed, with the sentence explaining why. */
export class UnusableBundle extends Error {}

/**
 * Decide what this archive is.
 *
 * `declared` is the kind the submitter claimed. It is honoured only for `skill`, because a skill
 * collection genuinely cannot be told apart from a plugin's skills directory by looking — and it
 * is checked even then: a collection with no `SKILL.md` anywhere is a wrong claim, not a fact.
 */
export function inspect(entries: TarEntry[], declared?: BundleKind): Inspection {
	if (entries.length === 0) throw new UnusableBundle("这个目录是空的");

	const files = new Map(entries.map((entry) => [entry.path, entry.data]));
	const warnings: string[] = [];

	if (declared === "skill") return inspectCollection(entries, files, warnings);

	const declared_ = readManifest(files);
	const manifest = declared_ ?? inferManifest(entries, files, warnings);
	if (!manifest) {
		throw new UnusableBundle("这个仓库里没有可安装的技能或 MCP 服务（需要 skills/ 目录、.mcp.json 或 plugin.json）");
	}

	// `./skills/` is the app's default when a manifest names no directory; keep the same default.
	const skillsDir = trimDir(manifest.skills ?? "skills");
	const skillCount = skillsDir === null ? 0 : countSkills(entries, skillsDir);
	const serverCount = manifest.mcpServers ? countServers(files, manifest.mcpServers, warnings) : 0;

	if (skillCount === 0 && serverCount === 0) {
		throw new UnusableBundle("清单在，但既没有技能也没有 MCP 服务——装上去不会有任何变化");
	}

	/*
	 * Skills decide it. A bundle with both is a plugin and says so, which is the app's rule and
	 * exists because the alternative — dropping the servers in silence — is the ambiguity the
	 * plugin/MCP split was introduced to remove.
	 */
	if (skillCount > 0 && serverCount > 0) {
		warnings.push(`同时声明了 ${serverCount} 个 MCP 服务，安装后不会自动加载——请在设置 › MCP 里单独添加`);
	}
	const kind: BundleKind = skillCount === 0 ? "mcp" : "plugin";

	if (declared && declared !== kind) {
		// Not an error: the index's word is a claim, and this is the correction. Saying it out loud
		// is what stops a submitter wondering why their "plugin" is filed under MCP.
		warnings.push(`索引声明为 ${declared}，实际内容是 ${kind}，已按实际内容归类`);
	}

	return {
		kind,
		skillCount,
		serverCount,
		manifest,
		hasManifest: declared_ !== null,
		clients: clientsFor(kind, {
			skills: skillCount > 0,
			mcp: serverCount > 0,
			claudePlugin: hasPrefix(entries, ".claude-plugin/"),
			lyraPlugin: hasPrefix(entries, ".lyra-plugin/"),
			codexPlugin: hasPrefix(entries, ".codex-plugin/"),
		}),
		readme: readReadme(files),
		warnings,
	};
}

/** A skill collection: a directory of `<name>/SKILL.md` and nothing else required. */
function inspectCollection(entries: TarEntry[], files: Map<string, Uint8Array>, warnings: string[]): Inspection {
	const skillCount = countSkills(entries, "");
	if (skillCount === 0) {
		throw new UnusableBundle("这个目录里没有技能（应当是一层含 SKILL.md 的子目录）");
	}
	// A collection has no manifest and needs none — its name comes from the submission.
	const manifest = readManifest(files);
	return {
		kind: "skill",
		skillCount,
		serverCount: 0,
		manifest: manifest ?? {},
		hasManifest: manifest !== null,
		// A collection is nothing but `SKILL.md` directories, which is the portable case.
		clients: clientsFor("skill", { skills: true, mcp: false, claudePlugin: false, lyraPlugin: false, codexPlugin: false }),
		readme: readReadme(files),
		warnings,
	};
}

/**
 * How many skills live one level under a directory.
 *
 * One level, because that is what `loadSkills` reads. Counting recursively would report a number
 * the app will not reproduce, and a collection that claims eight and loads six is exactly the
 * discrepancy this count exists to catch.
 */
function countSkills(entries: TarEntry[], dir: string): number {
	const prefix = dir ? `${dir}/` : "";
	const found = new Set<string>();
	for (const entry of entries) {
		if (!entry.path.startsWith(prefix)) continue;
		const rest = entry.path.slice(prefix.length).split("/");
		if (rest.length === 2 && rest[1] === "SKILL.md") found.add(rest[0]!);
	}
	return found.size;
}

/** How many servers a `.mcp.json` declares. A file that is not one costs a warning, not the build. */
function countServers(files: Map<string, Uint8Array>, relative: string, warnings: string[]): number {
	const path = trimFile(relative);
	if (path === null) {
		warnings.push(`mcpServers 路径逃出了插件目录：${relative}`);
		return 0;
	}
	const raw = files.get(path);
	if (!raw) {
		warnings.push(`清单指向的 ${relative} 不在仓库里`);
		return 0;
	}
	try {
		const parsed = JSON.parse(decode(raw)) as { mcpServers?: Record<string, unknown> };
		const servers = parsed?.mcpServers;
		if (!servers || typeof servers !== "object") {
			warnings.push(`${relative} 里没有 mcpServers 字段`);
			return 0;
		}
		return Object.keys(servers).length;
	} catch (error) {
		warnings.push(`${relative} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}

function readManifest(files: Map<string, Uint8Array>): Manifest | null {
	for (const location of MANIFEST_LOCATIONS) {
		const raw = files.get(location);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(decode(raw)) as Manifest;
			if (!parsed.name || typeof parsed.name !== "string") {
				throw new UnusableBundle(`${location} 缺少 name 字段`);
			}
			return parsed;
		} catch (error) {
			if (error instanceof UnusableBundle) throw error;
			throw new UnusableBundle(`${location} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return null;
}

/**
 * A bundle that never declared itself one.
 *
 * The manifest is our format and almost nothing in the wild ships it; what the good collections do
 * ship is `skills/<name>/SKILL.md`. So the shape is the declaration. `.claude-plugin/marketplace.json`
 * is read for what it says rather than for permission — collections published for Claude Code carry
 * their real name and description there, and taking them means an inferred bundle arrives labelled.
 */
function inferManifest(entries: TarEntry[], files: Map<string, Uint8Array>, warnings: string[]): Manifest | null {
	const hasSkills = entries.some((entry) => entry.path.startsWith("skills/"));
	const hasMcp = files.has(".mcp.json");
	if (!hasSkills && !hasMcp) return null;

	const manifest: Manifest = {};
	if (hasMcp) manifest.mcpServers = ".mcp.json";

	const raw = files.get(".claude-plugin/marketplace.json");
	if (!raw) return manifest;

	try {
		const parsed = JSON.parse(decode(raw)) as {
			name?: string;
			description?: string;
			owner?: { name?: string };
			plugins?: { name?: string; description?: string; version?: string; category?: string; homepage?: string }[];
		};
		/*
		 * The plugin's own entry, not the file's top level.
		 *
		 * The top level describes the *marketplace*, which for a repository publishing one thing is
		 * usually the owner's handle. Taking it named a plugin after the account that publishes it.
		 */
		const head = parsed.plugins?.[0];
		manifest.name = firstString(head?.name, parsed.name);
		manifest.description = firstString(head?.description, parsed.description);
		if (typeof parsed.owner?.name === "string") manifest.author = { name: parsed.owner.name };
		if (head) {
			manifest.version = firstString(head.version);
			manifest.homepage = firstString(head.homepage);
			manifest.interface = {
				displayName: manifest.name,
				shortDescription: manifest.description,
				category: firstString(head.category),
			};
		}
	} catch {
		// A malformed marketplace file costs the labels, not the plugin.
		warnings.push(".claude-plugin/marketplace.json 不是合法 JSON，已忽略其中的名称与描述");
	}
	return manifest;
}

/** The first README at the bundle root, in the order a human would look for one. */
function readReadme(files: Map<string, Uint8Array>): string | undefined {
	for (const name of ["README.md", "readme.md", "README", "README.markdown"]) {
		const raw = files.get(name);
		// Truncated: this is shown on a page, and a 500KB README is a denial of service on the reader.
		if (raw) return decode(raw).slice(0, 64_000);
	}
	return undefined;
}

/** A manifest-relative directory that stays inside the bundle, or null. */
function trimDir(relative: string): string | null {
	const cleaned = relative.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
	if (!cleaned) return "";
	return cleaned.split("/").some((part) => part === ".." || part === "." || part === "") ? null : cleaned;
}

function trimFile(relative: string): string | null {
	const dir = trimDir(relative);
	return dir === null || dir === "" ? null : dir;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}

/** Whether any member sits under this directory. */
function hasPrefix(entries: TarEntry[], prefix: string): boolean {
	return entries.some((entry) => entry.path.startsWith(prefix));
}

function decode(data: Uint8Array): string {
	return new TextDecoder().decode(data);
}
