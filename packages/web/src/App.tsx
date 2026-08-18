/**
 * The shell: who is signed in, which screen is showing, and the chrome around it.
 *
 * The viewer is fetched once here and passed down. Every screen that needs it would otherwise ask
 * separately, which is several requests for one answer and several chances for them to disagree
 * about it mid-render.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import type { Viewer } from "@lyra/registry-shared";

import { api } from "./api.ts";
import { Header } from "./components/Header.tsx";
import { Catalogue } from "./pages/Catalogue.tsx";
import { Detail } from "./pages/Detail.tsx";
import { Console } from "./pages/Console.tsx";
import { Admin, Mine } from "./pages/Manage.tsx";
import { Submit } from "./pages/Submit.tsx";
import { navigate, useLinkInterception, useRoute } from "./router.ts";

export function App(): JSX.Element {
	useLinkInterception();
	const route = useRoute();
	const path = route.split("?")[0] ?? "/";

	/*
	 * Three states, not two.
	 *
	 * `undefined` means "we have not asked yet", `null` means "asked, nobody is signed in". Merging
	 * them makes an admin loading `/admin` see the 404 for one paint before `/v1/me` answers — a
	 * flash of "no such page" on a page they own.
	 */
	const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);
	const [pending, setPending] = useState(0);

	useEffect(() => {
		// A 401 here is the normal state for a visitor, not an error worth showing anybody.
		api
			.me()
			.then(setViewer)
			.catch(() => setViewer(null));
	}, []);

	useEffect(() => {
		if (!viewer?.isAdmin) return;
		api
			.stats()
			.then((stats) => setPending(stats.pending))
			.catch(() => undefined);
	}, [viewer]);

	const signOut = useCallback(() => {
		void api.logout().finally(() => {
			setViewer(null);
			navigate("/");
		});
	}, []);

	return (
		<div className="shell">
			<Header viewer={viewer ?? null} pendingCount={pending} onSignOut={signOut} />

			<main style={{ flex: 1 }}>{screen(path, viewer)}</main>

			<footer className="footer">
				<div className="page footer__inner">
					<span>Agent 市场</span>
					<a href="https://github.com/kittors/Lyra-Registry" target="_blank" rel="noreferrer noopener">
						平台源码
					</a>
					<a href="https://github.com/kittors/Lyra" target="_blank" rel="noreferrer noopener">
						Lyra
					</a>
					<span style={{ marginLeft: "auto" }}>支持 Claude Code · Codex · Pi · Lyra · 任何 MCP 客户端</span>
				</div>
			</footer>
		</div>
	);
}

/**
 * Which screen this path is, decided once.
 *
 * A chain of `{path === "x" && <X/>}` looks equivalent and is not: the conditions are independent,
 * so two can be true at once. That is exactly what happened — an unauthenticated visitor to
 * `/admin` got the sign-in prompt *and* the 404 stacked on top of each other, and the prompt read
 * "登录之后才能看到审核队列", which announces the existence of the thing the 404 was there to hide.
 *
 * Written as early returns so the cases are mutually exclusive by construction.
 */
function screen(path: string, viewer: Viewer | null | undefined): JSX.Element {
	if (path === "/") return <Catalogue />;
	if (path.startsWith("/e/")) return <Detail id={decodeURIComponent(path.slice(3))} />;
	if (path === "/submit") return <Submit viewer={viewer ?? null} />;
	if (path === "/mine") return <Mine viewer={viewer ?? null} />;

	if (isAdminPath(path)) {
		// Still asking. Render nothing rather than guessing wrong in either direction.
		if (viewer === undefined) return <div style={{ minHeight: "50vh" }} />;
		// To anybody else these pages do not exist, and are not worth coming back to.
		if (!viewer?.isAdmin) return <NotFound />;
		return path === "/admin" ? <Admin viewer={viewer} /> : <Console viewer={viewer} />;
	}

	return <NotFound />;
}

function isAdminPath(path: string): boolean {
	return path === "/admin" || path === "/console";
}

function NotFound(): JSX.Element {
	return (
		<div className="page detail">
			<div className="empty">
				<p className="empty__title">没有这个页面</p>
				<p>
					<a href="/" style={{ color: "var(--accent)" }}>
						回到目录
					</a>
				</p>
			</div>
		</div>
	);
}
