/**
 * The shapes every handler answers in.
 *
 * Two things live here that would otherwise be repeated in a dozen places and drift: how an error
 * becomes a response, and how a response says it may be cached. Both are contracts with callers we
 * do not control — the desktop app caches on these headers — so they are stated once.
 */

import { ERROR_STATUS, type ApiError, type ApiErrorCode } from "@lyra/registry-shared";
import type { Context } from "hono";

/**
 * An error a caller is meant to see.
 *
 * Thrown rather than returned so that a handler can give up mid-way without every function on the
 * path having to return a union. Anything else that escapes a handler is a bug, and is answered
 * with `internal` and no detail — a stack trace in a response body tells an attacker about the
 * code and tells a user nothing.
 */
export class HttpError extends Error {
	code: ApiErrorCode;

	constructor(code: ApiErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function fail(code: ApiErrorCode, message: string): never {
	throw new HttpError(code, message);
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		const body: ApiError = { code: error.code, message: error.message };
		return Response.json(body, { status: ERROR_STATUS[error.code] });
	}
	console.error("unhandled", error);
	const body: ApiError = { code: "internal", message: "服务器出错了" };
	return Response.json(body, { status: 500 });
}

/**
 * How long the edge and the client may keep an answer.
 *
 * The catalogue is allowed to be a minute stale — nobody is harmed by seeing a listing a minute
 * after it was approved, and the alternative is every browse hitting D1. `stale-while-revalidate`
 * is what makes the minute invisible: the edge serves the old copy and refreshes behind it.
 *
 * The index the app polls gets longer, because it is polled on a timer by every install rather
 * than by a person waiting for it.
 */
export const CACHE_CATALOGUE = "public, max-age=60, stale-while-revalidate=600";
export const CACHE_INDEX = "public, max-age=300, stale-while-revalidate=3600";
/** An archive at a fixed version never changes. This is the one case where a year is correct. */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** Anything about the person making the request. */
export const NO_STORE = "private, no-store";

export function json(data: unknown, cache: string, extra?: HeadersInit): Response {
	const headers = new Headers(extra);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", cache);
	return new Response(JSON.stringify(data), { headers });
}

/**
 * Cross-origin access to the public API.
 *
 * The desktop app is an Electron renderer, whose origin is `file://` or a custom scheme and
 * arrives here as `null` or something we have never heard of. There is no useful allow-list for
 * that, and none is needed: everything CORS protects here is public and unauthenticated. The
 * endpoints that are not — anything reading a session — are same-origin from the site and say so
 * by not being listed here.
 */
export const PUBLIC_CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, HEAD, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "86400",
};

/** Read a positive integer from a query string, or the fallback. Never NaN, never negative. */
export function intParam(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The bearer token or session cookie on this request, whichever it used. */
export function readToken(context: Context): string | null {
	const header = context.req.header("authorization");
	if (header?.startsWith("Bearer ")) return header.slice(7);

	const cookie = context.req.header("cookie");
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "lyra_session") return decodeURIComponent(rest.join("="));
	}
	return null;
}

/**
 * The session cookie.
 *
 * `HttpOnly` so a script cannot read it, `Secure` because everything here is https, `SameSite=Lax`
 * so it survives the OAuth redirect back from GitHub — `Strict` would drop it on exactly that
 * navigation and log the user straight back out.
 */
export function sessionCookie(token: string, maxAge: number): string {
	return `lyra_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
	return "lyra_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}
