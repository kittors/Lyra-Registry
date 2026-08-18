/**
 * Session tokens.
 *
 * The happy path is one test; the rest are the forgeries. A JWT implementation that only proves it
 * can verify its own signatures is the one that accepts `alg: none`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { randomState, sign, verify, SESSION_TTL_SECONDS } from "../src/lib/jwt.ts";

const SECRET = "a-test-secret-that-is-long-enough";
const CLAIMS = { sub: 12345, login: "kittors", name: "Kittors", avatar: "https://github.com/kittors.png" };

test("a token signed here verifies here, with its claims intact", async () => {
	const claims = await verify(await sign(CLAIMS, SECRET), SECRET);
	assert.equal(claims?.sub, 12345);
	assert.equal(claims?.login, "kittors");
	assert.equal(claims?.name, "Kittors");
});

test("an expiry is set, and it is the one we intend", async () => {
	const claims = await verify(await sign(CLAIMS, SECRET), SECRET);
	const lifetime = (claims?.exp ?? 0) - (claims?.iat ?? 0);
	assert.equal(lifetime, SESSION_TTL_SECONDS);
});

test("a token signed with another secret is refused", async () => {
	const token = await sign(CLAIMS, "some-other-secret");
	assert.equal(await verify(token, SECRET), null);
});

test("a tampered payload is refused, even though it is valid JSON", async () => {
	const token = await sign(CLAIMS, SECRET);
	const [header, , signature] = token.split(".") as [string, string, string];
	// Promote yourself to somebody else's account, keeping the original signature.
	const forged = btoa(JSON.stringify({ ...CLAIMS, sub: 1, login: "admin", exp: 9_999_999_999, iat: 0 }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	assert.equal(await verify(`${header}.${forged}.${signature}`, SECRET), null);
});

test("`alg: none` is refused rather than treated as unsigned-and-therefore-fine", async () => {
	// The canonical JWT forgery. An implementation that reads the header's algorithm and obeys it
	// accepts a token with an empty signature.
	const b64 = (value: unknown) =>
		btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const header = b64({ alg: "none", typ: "JWT" });
	const body = b64({ ...CLAIMS, exp: 9_999_999_999, iat: 0 });
	assert.equal(await verify(`${header}.${body}.`, SECRET), null);
	assert.equal(await verify(`${header}.${body}.anything`, SECRET), null);
});

test("an expired token is refused", async () => {
	// Signed properly, but issued in the past — the signature is valid and the token is not.
	const b64 = (value: unknown) =>
		btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const header = b64({ alg: "HS256", typ: "JWT" });
	const body = b64({ ...CLAIMS, iat: 1, exp: 2 });

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
	let binary = "";
	for (const byte of raw) binary += String.fromCharCode(byte);
	const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

	assert.equal(await verify(`${header}.${body}.${signature}`, SECRET), null);
});

test("malformed input is refused rather than thrown at the caller", async () => {
	for (const bad of ["", "not-a-token", "a.b", "a.b.c.d", "...", "�.�.�"]) {
		assert.equal(await verify(bad, SECRET), null, bad);
	}
});

test("state values are unguessable and do not repeat", () => {
	const seen = new Set(Array.from({ length: 200 }, () => randomState()));
	assert.equal(seen.size, 200);
	// base64url of 24 bytes: long enough that guessing is not a strategy.
	assert.ok((seen.values().next().value as string).length >= 32);
});
