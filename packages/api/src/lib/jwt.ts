/**
 * Session tokens, signed with Web Crypto.
 *
 * A JWT rather than a session table because there is nothing to look up: the token carries the
 * GitHub id and login, and everything else about a request is a fresh database read anyway. That
 * keeps sign-in from being a write and keeps the auth path from touching D1 at all.
 *
 * HS256 with a secret, not RS256: there is one issuer and one verifier and they are the same
 * worker, so asymmetric keys would be ceremony without a second party to justify them.
 *
 * The parts nobody should get wrong are done properly here — `timingSafeEqual` on the signature,
 * an explicit algorithm check on the header so a token claiming `alg: none` is rejected rather
 * than accepted, and an expiry that is verified rather than merely present.
 */

export interface SessionClaims {
	/** GitHub's numeric user id. */
	sub: number;
	login: string;
	name?: string;
	avatar?: string;
	/** Seconds since the epoch, as JWT defines it. */
	exp: number;
	iat: number;
}

/** A week. Long enough not to interrupt someone mid-submission, short enough to bound a leak. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function sign(claims: Omit<SessionClaims, "exp" | "iat">, secret: string): Promise<string> {
	const issued = Math.floor(Date.now() / 1000);
	const payload: SessionClaims = { ...claims, iat: issued, exp: issued + SESSION_TTL_SECONDS };

	const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await hmac(`${header}.${body}`, secret);
	return `${header}.${body}.${base64url(signature)}`;
}

/**
 * Verify a token and return its claims, or null.
 *
 * Null for every kind of failure — malformed, wrong signature, expired, wrong algorithm. The
 * caller has one thing to do in all four cases, and distinguishing them in the response is how an
 * attacker learns which half of a forged token was wrong.
 */
export async function verify(token: string, secret: string): Promise<SessionClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [header, body, signature] = parts as [string, string, string];

	try {
		const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(header))) as { alg?: string };
		// `alg: none` is the classic forgery; anything but the one algorithm we sign with is refused.
		if (decoded.alg !== "HS256") return null;

		const expected = await hmac(`${header}.${body}`, secret);
		if (!timingSafeEqual(fromBase64url(signature), expected)) return null;

		const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as SessionClaims;
		if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
		if (typeof claims.sub !== "number" || typeof claims.login !== "string") return null;
		return claims;
	} catch {
		return null;
	}
}

async function hmac(data: string, secret: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return new Uint8Array(signature);
}

/**
 * Compare without leaking where the difference is.
 *
 * The length check short-circuits, which is fine: the length of a SHA-256 signature is not a
 * secret. The bytes are compared in full regardless of where they first differ, which is.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

/** base64url: base64 with two characters swapped and the padding dropped, as JWT requires. */
function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * A random string for the OAuth `state` parameter.
 *
 * Its only job is to be unguessable and to come back unchanged, which is what proves the callback
 * belongs to a flow this site started rather than one an attacker linked the user into.
 */
export function randomState(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(24)));
}
