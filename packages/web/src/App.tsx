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

	const [viewer, setViewer] = useState<Viewer | null>(null);
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
			<Header viewer={viewer} pendingCount={pending} onSignOut={signOut} />

			<main style={{ flex: 1 }}>
				{path === "/" && <Catalogue />}
				{path.startsWith("/e/") && <Detail id={decodeURIComponent(path.slice(3))} />}
				{path === "/submit" && <Submit viewer={viewer} />}
				{path === "/mine" && <Mine viewer={viewer} />}
				{path === "/admin" && <Admin viewer={viewer} />}
				{path === "/console" && <Console viewer={viewer} />}
				{/*
				 * A non-admin on an admin path gets the 404, not a "no permission" page.
				 *
				 * Telling somebody they lack permission confirms the page exists and is worth coming
				 * back for. The API refuses them regardless; this is about not advertising.
				 */}
				{(!isKnown(path) || (isAdminPath(path) && !viewer?.isAdmin)) && (
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
				)}
			</main>

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

function isKnown(path: string): boolean {
	return (
		path === "/" ||
		path === "/submit" ||
		path === "/mine" ||
		isAdminPath(path) ||
		path.startsWith("/e/")
	);
}

function isAdminPath(path: string): boolean {
	return path === "/admin" || path === "/console";
}
