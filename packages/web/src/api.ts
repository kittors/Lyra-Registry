/**
 * Talking to the API.
 *
 * Same origin in production — the site is served by the Worker that answers these — so there are
 * no base URLs, no CORS and no tokens to attach: the session cookie rides along on its own. In
 * development Vite proxies `/v1` to `wrangler dev`, so the same relative paths work there too.
 *
 * Every function returns the parsed body or throws an `ApiFailure` carrying the message the server
 * wrote. The site shows that message directly; it is written for a person to read, in the language
 * the rest of the interface is in.
 */

import type {
	BuildResult,
	EntryDetail,
	EntryQuery,
	EntrySummary,
	Page,
	RegistryStats,
	SubmitRequest,
	Viewer,
} from "@lyra/registry-shared";

export class ApiFailure extends Error {
	code: string;
	status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			accept: "application/json",
			// Only for bodies we serialised ourselves. A File carries its own type, and overriding it
			// would make every icon upload arrive as JSON.
			...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
		// The session is a cookie; without this it is not sent on a same-origin fetch either.
		credentials: "same-origin",
	});

	if (response.status === 204) return undefined as T;

	const body = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		const error = body as { code?: string; message?: string } | null;
		throw new ApiFailure(error?.code ?? "internal", error?.message ?? `请求失败（${response.status}）`, response.status);
	}
	return body as T;
}

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

export const api = {
	entries: (options: EntryQuery = {}) =>
		request<Page<EntrySummary>>(
			`/v1/entries${query({
				q: options.q,
				kind: options.kind,
				category: options.category,
				author: options.author,
				sort: options.sort,
				page: options.page,
				pageSize: options.pageSize,
			})}`,
		),

	entry: (id: string) => request<EntryDetail>(`/v1/entries/${encodeURIComponent(id)}`),

	categories: () => request<{ category: string; count: number }[]>("/v1/categories"),

	stats: () => request<RegistryStats>("/v1/stats"),

	me: () => request<Viewer>("/v1/me"),

	logout: () => request<void>("/v1/logout", { method: "POST" }),

	mine: () => request<Page<EntrySummary>>("/v1/mine"),

	mineOne: (id: string) => request<EntryDetail>(`/v1/entries/${encodeURIComponent(id)}/mine`),

	submit: (input: SubmitRequest) => request<BuildResult>("/v1/entries", { method: "POST", body: JSON.stringify(input) }),

	refresh: (id: string) => request<BuildResult>(`/v1/entries/${encodeURIComponent(id)}/refresh`, { method: "POST" }),

	admin: {
		queue: () => request<Page<EntrySummary>>("/v1/admin/queue"),
		all: (q?: string) => request<Page<EntrySummary>>(`/v1/admin/entries${query({ q })}`),
		review: (id: string, action: string, note?: string) =>
			request<{ ok: true }>(`/v1/admin/entries/${encodeURIComponent(id)}/review`, {
				method: "POST",
				body: JSON.stringify({ action, note }),
			}),
		patch: (id: string, edits: Record<string, string | number | null>) =>
			request<{ ok: true; curated: string[] }>(`/v1/admin/entries/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: JSON.stringify(edits),
			}),

		/*
		 * Raw bytes with the file's own content type, not multipart.
		 *
		 * There is one file and no other fields, so multipart would be a format to encode and parse
		 * for no benefit. `body: File` sends the bytes; the type header is set explicitly because
		 * `fetch` would otherwise send whatever the browser guessed.
		 */
		uploadIcon: (id: string, file: File) =>
			request<{ ok: true; key: string }>(`/v1/admin/entries/${encodeURIComponent(id)}/icon`, {
				method: "PUT",
				body: file,
				headers: { "content-type": file.type },
			}),

		clearIcon: (id: string) =>
			request<{ ok: true }>(`/v1/admin/entries/${encodeURIComponent(id)}/icon`, { method: "DELETE" }),

		history: (id: string) =>
			request<{ action: string; note: string | null; created_at: string; reviewer: string | null }[]>(
				`/v1/admin/entries/${encodeURIComponent(id)}/reviews`,
			),
	},
};

/** Where the browser goes to sign in. A full navigation, because OAuth is a redirect flow. */
export const SIGN_IN_URL = "/auth/github";
