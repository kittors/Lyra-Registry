/**
 * Routing, in about sixty lines.
 *
 * There are five screens and none of them nest. A router library would be a dependency, a bundle
 * and a set of concepts to learn, in exchange for solving a problem this site does not have.
 *
 * What it does have to get right is the part people notice: a link that does not reload the page,
 * a back button that works, and a URL that can be pasted to someone else. That is `pushState`, a
 * `popstate` listener, and intercepting clicks on internal links.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function snapshot(): string {
	return `${window.location.pathname}${window.location.search}`;
}

if (typeof window !== "undefined") {
	window.addEventListener("popstate", notify);
}

/** The current path and search, re-rendering whatever reads it when either changes. */
export function useRoute(): string {
	return useSyncExternalStore(subscribe, snapshot, () => "/");
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
	if (to === snapshot()) return;
	window.history[options.replace ? "replaceState" : "pushState"]({}, "", to);
	notify();
	// A new screen starts at its top. Without this, following a link from halfway down the
	// catalogue opens a detail page already scrolled into its version history.
	if (!options.replace) window.scrollTo(0, 0);
}

/**
 * Intercept clicks on internal links so they navigate rather than reload.
 *
 * Delegated from the document rather than wired into a `<Link>` component: it means a plain `<a
 * href>` anywhere on the page — including inside rendered markdown — behaves correctly, and there
 * is no way to forget to use the special component.
 *
 * Every escape hatch a real link has is preserved: modified clicks, non-left buttons, `target`,
 * `download`, and anything pointing off-site all fall through to the browser.
 */
export function useLinkInterception(): void {
	useEffect(() => {
		function onClick(event: MouseEvent): void {
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

			const anchor = (event.target as Element | null)?.closest?.("a");
			if (!anchor) return;

			const href = anchor.getAttribute("href");
			if (!href || anchor.hasAttribute("download") || anchor.getAttribute("target")) return;
			// `/auth/github` and `/v1/download/…` are the server's, not the site's.
			if (!href.startsWith("/") || href.startsWith("/auth/") || href.startsWith("/v1/")) return;

			event.preventDefault();
			navigate(href);
		}

		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, []);
}

/** A setter for one query parameter that leaves the others alone. */
export function useQueryParam(name: string): [string, (value: string) => void] {
	const route = useRoute();
	const value = new URLSearchParams(route.split("?")[1] ?? "").get(name) ?? "";

	const set = useCallback(
		(next: string) => {
			const [path, search] = snapshot().split("?");
			const params = new URLSearchParams(search ?? "");
			if (next) params.set(name, next);
			else params.delete(name);
			// Filtering is not a navigation: replacing keeps the back button meaning "the previous
			// screen" rather than "the previous keystroke".
			navigate(`${path}${params.toString() ? `?${params}` : ""}`, { replace: true });
		},
		[name],
	);

	return [value, set];
}
