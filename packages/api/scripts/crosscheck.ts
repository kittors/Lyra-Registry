/**
 * The platform's verdict against the app's, on the same bundle.
 *
 * `inspect` here and `inspectBundle` in `@lyra/core` answer the same question from opposite sides:
 * one reads a tar member list, the other reads a directory. If they ever disagree, the catalogue
 * advertises a plugin that installs as an MCP server — a failure no unit test on either side can
 * see, because each would be testing its own idea of the rules.
 *
 * So this builds a real bundle, unpacks it the way the app would, and reads it with the app's own
 * code. It needs network and a GitHub token, which is why it is a script rather than a test:
 *
 *     GH_TOKEN=$(gh auth token) LYRA_REPO=../Lyra node --experimental-strip-types scripts/crosscheck.ts
 *
 * `LYRA_REPO` points at a checkout of the app. It lives in a different repository — this one is
 * the platform — so the import is resolved at runtime rather than written as a path that would
 * only work on one person's machine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepo } from "@lyra/registry-shared";
import { build } from "../src/build/pipeline.ts";
/**
 * The half of `inspectBundle`'s result this script reads.
 *
 * Declared here rather than imported from the app: the app is a different repository, and a type
 * import would be a path that only resolves on a machine that happens to have both checked out
 * side by side. What matters is the verdict and the two counts, and those are the contract.
 */
type InspectBundle = (
	dir: string,
) => Promise<{ kind: "plugin" | "mcp"; skills: unknown[]; servers: unknown[] } | { kind: "none"; error?: string }>;

const LYRA_REPO = process.env.LYRA_REPO;
if (!LYRA_REPO) {
	console.log("跳过：设置 LYRA_REPO 指向 Lyra 应用的 checkout 才能做交叉验证");
	console.log("  例如 LYRA_REPO=../Lyra GH_TOKEN=$(gh auth token) node --experimental-strip-types scripts/crosscheck.ts");
	process.exit(0);
}
const { inspectBundle } = (await import(
	new URL(`${LYRA_REPO.replace(/\/$/, "")}/packages/core/src/plugins/loader.ts`, `file://${process.cwd()}/`).href
)) as { inspectBundle: InspectBundle };

const cases = [
	{ label: "context7", repo: "kittors/Lyra-Plugins", subpath: "plugins/context7" },
	{ label: "agent-browser-cli", repo: "kittors/Lyra-Plugins", subpath: "plugins/agent-browser-cli" },
	{ label: "playwright", repo: "kittors/Lyra-Plugins", subpath: "plugins/playwright" },
	{ label: "memory", repo: "kittors/Lyra-Plugins", subpath: "plugins/memory" },
];

let agreed = 0;
for (const c of cases) {
	const dir = mkdtempSync(join(tmpdir(), "lyra-xcheck-"));
	try {
		const out = await build({ repo: parseRepo(c.repo)!, ref: "main", subpath: c.subpath, token: process.env.GH_TOKEN });

		// 把平台产出的包按客户端的方式落到磁盘上
		const archive = join(dir, "bundle.tar.gz");
		writeFileSync(archive, out.archive);
		execFileSync("tar", ["-xzf", archive, "-C", dir]);

		// 用客户端自己的代码读它
		const client = await inspectBundle(dir);
		const clientKind = client.kind;
		const clientSkills = client.kind === "none" ? 0 : client.skills.length;
		const clientServers = client.kind === "none" ? 0 : client.servers.length;

		const ok = clientKind === out.kind && clientSkills === out.skillCount && clientServers === out.serverCount;
		if (ok) agreed++;
		console.log(`${ok ? "✅" : "❌"} ${c.label}`);
		console.log(`   平台:   kind=${out.kind} skills=${out.skillCount} servers=${out.serverCount}`);
		console.log(`   客户端: kind=${clientKind} skills=${clientSkills} servers=${clientServers}`);
		if (client.kind === "none") console.log(`   客户端拒绝原因: ${client.error ?? "(无清单)"}`);
	} catch (error) {
		console.log(`❌ ${c.label}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`\n一致: ${agreed}/${cases.length}`);
