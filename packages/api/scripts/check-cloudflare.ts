/**
 * Whether a Cloudflare token can actually deploy this.
 *
 * `wrangler deploy` fails one resource at a time and reports whichever it hit first, so a token
 * missing two permissions takes two failed deploys to diagnose. This asks about every resource up
 * front and prints the permission to add for each one that answers no.
 *
 *     CLOUDFLARE_API_TOKEN=… node --experimental-strip-types scripts/check-cloudflare.ts
 *
 * Read-only: it lists resources and never creates, changes or deletes anything.
 */

const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
if (!token) {
	console.error("需要 CLOUDFLARE_API_TOKEN 环境变量");
	console.error("  CLOUDFLARE_API_TOKEN=… node --experimental-strip-types scripts/check-cloudflare.ts");
	process.exit(2);
}

const API = "https://api.cloudflare.com/client/v4";

interface Check {
	label: string;
	/** Path under the account, or `null` for the account list itself. */
	path: string | null;
	/** What to tick in the dashboard when this one fails. */
	permission: string;
	/** Whether a deploy is impossible without it. */
	required: boolean;
}

const CHECKS: Check[] = [
	{ label: "Workers 脚本", path: "workers/scripts", permission: "Workers Scripts : Edit", required: true },
	{ label: "D1 数据库", path: "d1/database", permission: "D1 : Edit", required: true },
	{ label: "R2 存储桶", path: "r2/buckets", permission: "Workers R2 Storage : Edit", required: true },
	{ label: "KV 命名空间", path: "storage/kv/namespaces", permission: "Workers KV Storage : Edit", required: true },
	{
		label: "workers.dev 子域",
		path: "workers/subdomain",
		permission: "Workers Scripts : Edit",
		required: false,
	},
];

async function call(path: string): Promise<{ ok: boolean; message?: string }> {
	try {
		const response = await fetch(`${API}/${path}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.json()) as { success?: boolean; errors?: { message?: string }[] };
		return body.success ? { ok: true } : { ok: false, message: body.errors?.[0]?.message };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

const verified = await call("user/tokens/verify");
if (!verified.ok) {
	console.error(`❌ token 无效：${verified.message ?? "未知原因"}`);
	process.exit(1);
}
console.log("✅ token 有效\n");

const accounts = (await (
	await fetch(`${API}/accounts`, { headers: { authorization: `Bearer ${token}` } })
).json()) as { result?: { id: string; name: string }[] };

const account = accounts.result?.[0];
if (!account) {
	console.error("❌ 这个 token 读不到任何账号，至少需要 Account Settings : Read");
	process.exit(1);
}
console.log(`账号：${account.name}`);
console.log(`ID：  ${account.id}\n`);

const missing: Check[] = [];
for (const check of CHECKS) {
	const result = await call(check.path ? `accounts/${account.id}/${check.path}` : "accounts");
	const mark = result.ok ? "✅" : check.required ? "❌" : "⚠️ ";
	console.log(`${mark} ${check.label}`);
	if (!result.ok) missing.push(check);
}

if (missing.length === 0) {
	console.log("\n全部就绪，可以部署：");
	console.log("  npx wrangler d1 create lyra-registry");
	console.log("  npx wrangler r2 bucket create lyra-registry");
	console.log("  npx wrangler kv namespace create CACHE");
	process.exit(0);
}

console.log("\n── 还缺这些权限 ──\n");
console.log("Cloudflare Dashboard → 右上角头像 → My Profile → API Tokens");
console.log("找到这个 token → Edit → 在 Permissions 里补上：\n");
for (const check of [...new Set(missing.map((m) => m.permission))]) {
	console.log(`  Account   ${check}`);
}
console.log("\n每一行都是 Account 级别（不是 User，也不是 Zone）。");

if (missing.some((m) => m.label.includes("R2"))) {
	console.log("\nR2 还需要先开通一次：Dashboard → R2 → Overview → 按提示绑定支付方式。");
	console.log("免费额度 10GB 存储 / 每月一百万次读，这个平台的用量远在额度内，但不开通就没有 R2 这个产品。");
}

process.exit(1);
