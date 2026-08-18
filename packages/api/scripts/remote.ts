/**
 * Talking to the deployed platform from a laptop, with retries.
 *
 * Every call here goes over a link that drops requests — during setup, `wrangler` and `curl` both
 * failed intermittently against the same endpoints a plain `fetch` had just succeeded on. One-shot
 * commands turn that into "the deploy is broken" when it is not, so anything scripted retries a
 * few times before believing a failure.
 *
 * Two things it does:
 *
 *     node --experimental-strip-types scripts/remote.ts sql "SELECT count(*) FROM entries"
 *     node --experimental-strip-types scripts/remote.ts seed <base-url> <session>
 *
 * `sql` goes through Cloudflare's D1 HTTP API and needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 * and D1_DATABASE_ID. `seed` posts submissions to a deployed instance and needs only its URL and a
 * session token — it is the same path a person uses, so it exercises the real build pipeline.
 */

const RETRIES = 5;

/** Retry on transport failures only. A 4xx is an answer, and repeating it will not change it. */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
	let last: unknown;
	for (let attempt = 1; attempt <= RETRIES; attempt++) {
		try {
			return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
		} catch (error) {
			last = error;
			const cause = (error as { cause?: { code?: string } }).cause?.code ?? "";
			console.error(`  ${label}：第 ${attempt} 次失败${cause ? `（${cause}）` : ""}，${attempt < RETRIES ? "重试…" : "放弃"}`);
			if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
		}
	}
	throw last;
}

async function sql(statement: string): Promise<void> {
	const token = required("CLOUDFLARE_API_TOKEN");
	const account = required("CLOUDFLARE_ACCOUNT_ID");
	const database = required("D1_DATABASE_ID");

	const response = await fetchWithRetry(
		`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ sql: statement }),
		},
		"D1",
	);

	const body = (await response.json()) as {
		success?: boolean;
		errors?: { message?: string }[];
		result?: { results?: unknown[] }[];
	};
	if (!body.success) {
		console.error("查询失败：", body.errors?.map((error) => error.message).join("; "));
		process.exit(1);
	}
	console.log(JSON.stringify(body.result?.[0]?.results ?? [], null, 2));
}

/** One submission, as the site would send it. */
interface Seed {
	repository: string;
	path?: string;
	kind?: "plugin" | "mcp" | "skill";
	id?: string;
	name?: string;
	category?: string;
}

/**
 * The catalogue this instance starts with.
 *
 * These are the entries the file-based registry already published, plus the two skill collections.
 * Submitted rather than inserted: going through `/v1/entries` means each one is fetched, inspected,
 * built and hashed exactly as a stranger's submission would be — so a seeded catalogue is not a
 * special case that only works because we wrote the rows ourselves.
 */
const SEEDS: Seed[] = [
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/context7" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/playwright" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/chrome-devtools" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/filesystem" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/memory" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/sequential-thinking" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/desktop-commander" },
	{ repository: "https://github.com/kittors/Lyra-Plugins", path: "plugins/agent-browser-cli" },
	{ repository: "https://github.com/tw93/Waza", path: "skills", kind: "skill", id: "waza", name: "Waza", category: "工作流" },
	{
		repository: "https://github.com/anthropics/skills",
		path: "skills",
		kind: "skill",
		id: "anthropic-skills",
		name: "Anthropic Skills",
		category: "官方",
	},
];

async function seed(base: string, session: string): Promise<void> {
	const root = base.replace(/\/$/, "");
	let built = 0;
	let failed = 0;

	for (const entry of SEEDS) {
		const label = entry.id ?? entry.path?.split("/").pop() ?? entry.repository;
		process.stdout.write(`  ${label.padEnd(22)}`);

		const response = await fetchWithRetry(
			`${root}/v1/entries`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
				body: JSON.stringify(entry),
			},
			label,
		);

		const result = (await response.json()) as {
			ok?: boolean;
			entryId?: string;
			version?: string;
			error?: string;
			message?: string;
			skillCount?: number;
			serverCount?: number;
			warnings?: string[];
		};

		if (result.ok) {
			built += 1;
			const counts = [
				result.skillCount ? `${result.skillCount} 技能` : "",
				result.serverCount ? `${result.serverCount} 服务` : "",
			]
				.filter(Boolean)
				.join(" · ");
			console.log(`✅ v${result.version}  ${counts}`);
			for (const warning of result.warnings ?? []) console.log(`     ⚠️  ${warning}`);
		} else {
			failed += 1;
			console.log(`❌ ${result.error ?? result.message ?? `HTTP ${response.status}`}`);
		}
	}

	console.log(`\n  成功 ${built}，失败 ${failed}`);
	if (failed > 0) process.exit(1);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`缺少环境变量 ${name}`);
		process.exit(2);
	}
	return value;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "sql" && rest[0]) {
	await sql(rest.join(" "));
} else if (command === "seed" && rest[0] && rest[1]) {
	await seed(rest[0], rest[1]);
} else {
	console.error("用法：");
	console.error('  remote.ts sql "SELECT …"');
	console.error("  remote.ts seed <base-url> <session>");
	process.exit(2);
}
