/**
 * Signing in with GitHub.
 *
 * GitHub is the only identity provider and that is not a shortcut: everything publishable here
 * lives in a GitHub repository, so the account that can prove it owns the repository is exactly
 * the account that should be able to list it. A separate password would be a second thing to lose.
 *
 * The `state` parameter is kept in a short-lived cookie rather than in KV. It has one job — come
 * back unchanged — and a cookie the browser already round-trips does that without a write, a read,
 * and a TTL to get wrong. It is `HttpOnly` so the page cannot read or forge it.
 */

import type { Viewer } from "@lyra/registry-shared";
import { Hono } from "hono";

import { upsertPublisher } from "../db/writes.ts";
import { isAdmin, type Env } from "../env.ts";
import {
	clearSessionCookie,
	fail,
	json,
	NO_STORE,
	readToken,
	sessionCookie,
} from "../lib/http.ts";
import { randomState, sign, verify, SESSION_TTL_SECONDS } from "../lib/jwt.ts";

export const auth = new Hono<{ Bindings: Env }>();

/** Long enough to finish signing in, short enough that a stale one is never lying around. */
const STATE_TTL_SECONDS = 600;
const STATE_COOKIE = "lyra_oauth_state";

/**
 * `read:user` and nothing else.
 *
 * The platform needs an id, a login and an avatar. It never reads private repositories, never
 * writes, and asking for a scope that would let it is how a sign-in button becomes a decision the
 * user has to think about.
 */
const SCOPE = "read:user";

auth.get("/github", (context) => {
	if (!context.env.GITHUB_CLIENT_ID || !context.env.GITHUB_CLIENT_SECRET) {
		fail("invalid", "这个部署还没有配置 GitHub 登录");
	}

	const state = randomState();
	const redirect = new URL("https://github.com/login/oauth/authorize");
	redirect.searchParams.set("client_id", context.env.GITHUB_CLIENT_ID);
	redirect.searchParams.set("redirect_uri", `${context.env.PUBLIC_URL.replace(/\/$/, "")}/auth/callback`);
	redirect.searchParams.set("scope", SCOPE);
	redirect.searchParams.set("state", state);

	return new Response(null, {
		status: 302,
		headers: {
			location: redirect.toString(),
			"set-cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
			"cache-control": NO_STORE,
		},
	});
});

auth.get("/callback", async (context) => {
	const secret = context.env.GITHUB_CLIENT_SECRET;
	const sessionSecret = context.env.SESSION_SECRET;
	if (!secret || !sessionSecret) fail("invalid", "这个部署还没有配置 GitHub 登录");

	const code = context.req.query("code");
	const state = context.req.query("state");
	if (!code) fail("invalid", "GitHub 没有返回授权码");

	/*
	 * The state has to match the cookie this flow set.
	 *
	 * Without it, an attacker can link someone into a callback carrying the attacker's code, and
	 * the victim ends up signed in as them — quietly, with anything they publish attributed to
	 * somebody else's account.
	 */
	const expected = readCookie(context.req.header("cookie"), STATE_COOKIE);
	if (!state || !expected || state !== expected) fail("forbidden", "登录状态校验失败，请重新登录");

	const token = await exchangeCode(context.env, code);
	const user = await fetchUser(token);

	await upsertPublisher(context.env.DB, {
		id: user.id,
		login: user.login,
		name: user.name,
		avatarUrl: user.avatar_url,
	});

	const session = await sign(
		{ sub: user.id, login: user.login, name: user.name ?? undefined, avatar: user.avatar_url ?? undefined },
		sessionSecret,
	);

	// Back to the site, not to a JSON body: this endpoint is reached by a browser redirect.
	return new Response(null, {
		status: 302,
		headers: [
			["location", "/"],
			["set-cookie", sessionCookie(session, SESSION_TTL_SECONDS)],
			// Same name, zero age: the state has done its job and should not outlive it.
			["set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`],
			["cache-control", NO_STORE],
		],
	});
});

auth.get("/me", async (context) => {
	const viewer = await currentViewer(context.env, readToken(context));
	if (!viewer) fail("unauthorized", "还没有登录");
	return json(viewer, NO_STORE);
});

auth.post("/logout", () => {
	return new Response(null, {
		status: 204,
		headers: { "set-cookie": clearSessionCookie(), "cache-control": NO_STORE },
	});
});

/** Who this token belongs to, or null. The one place a session becomes an identity. */
export async function currentViewer(env: Env, token: string | null): Promise<Viewer | null> {
	if (!token || !env.SESSION_SECRET) return null;
	const claims = await verify(token, env.SESSION_SECRET);
	if (!claims) return null;
	return {
		id: claims.sub,
		login: claims.login,
		name: claims.name,
		avatarUrl: claims.avatar,
		// Read from configuration on every request rather than baked into the token: revoking an
		// admin should take effect now, not when their week-long session happens to expire.
		isAdmin: isAdmin(env, claims.login),
	};
}

/** The viewer, or a 401. For routes where being signed in is the whole precondition. */
export async function requireViewer(env: Env, token: string | null): Promise<Viewer> {
	const viewer = await currentViewer(env, token);
	if (!viewer) fail("unauthorized", "请先登录");
	return viewer;
}

export async function requireAdmin(env: Env, token: string | null): Promise<Viewer> {
	const viewer = await requireViewer(env, token);
	if (!viewer.isAdmin) fail("forbidden", "只有管理员可以做这个操作");
	return viewer;
}

async function exchangeCode(env: Env, code: string): Promise<string> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json", "user-agent": "lyra-registry" },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${env.PUBLIC_URL.replace(/\/$/, "")}/auth/callback`,
		}),
		signal: AbortSignal.timeout(10_000),
	});

	const body = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
	// GitHub answers 200 with an `error` field rather than a status, so `response.ok` proves nothing.
	if (!body?.access_token) fail("upstream_failed", body?.error_description ?? "GitHub 拒绝了这次登录");
	return body.access_token;
}

interface GitHubUser {
	id: number;
	login: string;
	name?: string;
	avatar_url?: string;
}

async function fetchUser(token: string): Promise<GitHubUser> {
	const response = await fetch("https://api.github.com/user", {
		headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "lyra-registry" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) fail("upstream_failed", "读取 GitHub 用户信息失败");

	const user = (await response.json()) as GitHubUser;
	if (typeof user.id !== "number" || typeof user.login !== "string") fail("upstream_failed", "GitHub 返回的用户信息不对");
	return user;
}

function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}
