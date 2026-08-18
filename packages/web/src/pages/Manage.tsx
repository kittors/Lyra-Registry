/**
 * Two lists that are almost the same list: what I published, and what is waiting for review.
 *
 * Kept in one file because they share every part except which endpoint they read and which buttons
 * they show. Splitting them would duplicate the row.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import type { EntrySummary, Viewer } from "@lyra/registry-shared";

import { api, SIGN_IN_URL } from "../api.ts";
import { formatDate, Icon, KIND_LABEL, StatusBadge } from "../components/bits.tsx";

export function Mine({ viewer }: { viewer: Viewer | null }): JSX.Element {
	const [items, setItems] = useState<EntrySummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(() => {
		api
			.mine()
			.then((page) => setItems(page.items))
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载失败"));
	}, []);

	useEffect(() => {
		if (viewer) load();
	}, [viewer, load]);

	if (!viewer) return <SignInPrompt what="你发布的东西" />;

	async function refresh(id: string): Promise<void> {
		setBusy(id);
		setError(null);
		try {
			const result = await api.refresh(id);
			if (!result.ok) setError(result.error ?? "刷新失败");
			else load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "刷新失败");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="page detail">
			<h1 className="detail__title" style={{ marginBottom: 8 }}>
				我发布的
			</h1>
			<p className="hero__subtitle" style={{ margin: "0 0 26px", textAlign: "left" }}>
				上游有更新时点「重新拉取」，会按最新的 commit 重建一次。平台每天也会自动查一遍。
			</p>

			{error && <div className="notice notice--error" style={{ marginBottom: 16 }}>{error}</div>}

			{items === null && <div className="skeleton" style={{ height: 120 }} />}
			{items?.length === 0 && (
				<div className="empty">
					<p className="empty__title">还没有发布过</p>
					<p>
						<a href="/submit" style={{ color: "var(--accent)" }}>
							提交第一个
						</a>
					</p>
				</div>
			)}

			{items && items.length > 0 && (
				<div className="rows">
					{items.map((item) => (
						<div className="row" key={item.id}>
							<div className="row__main">
								<div className="row__title">
									{item.status === "approved" ? <a href={`/e/${item.id}`}>{item.name}</a> : item.name}
									<StatusBadge status={item.status} />
									<span className="badge">{KIND_LABEL[item.kind]}</span>
								</div>
								<div className="row__sub">
									{item.id} · v{item.version ?? "—"} · {formatDate(item.updatedAt)}
									{item.skillCount ? ` · ${item.skillCount} 个技能` : ""}
									{item.serverCount ? ` · ${item.serverCount} 个服务` : ""}
								</div>
							</div>
							<div className="row__actions">
								<button
									type="button"
									className="btn btn--sm"
									disabled={busy === item.id}
									onClick={() => void refresh(item.id)}
								>
									<Icon name="refresh" size={13} />
									{busy === item.id ? "构建中…" : "重新拉取"}
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function Admin({ viewer }: { viewer: Viewer | null }): JSX.Element | null {
	const [items, setItems] = useState<EntrySummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(() => {
		api
			.admin.queue()
			.then((page) => setItems(page.items))
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载失败"));
	}, []);

	useEffect(() => {
		if (viewer?.isAdmin) load();
	}, [viewer, load]);

	// Unreachable while signed out or non-admin: `screen()` answers those with the 404 instead, so
	// that neither the page nor its purpose is ever named to somebody who cannot use it.
	if (!viewer?.isAdmin) return null;

	async function review(id: string, action: "approve" | "reject"): Promise<void> {
		/*
		 * A rejection needs a reason, and the server refuses one without it.
		 *
		 * Asking here rather than letting the request fail means the admin types the sentence once,
		 * in the moment they decided — not after an error tells them they have to.
		 */
		let note: string | undefined;
		if (action === "reject") {
			const typed = window.prompt("驳回原因（作者只能看到这句话）：");
			if (!typed?.trim()) return;
			note = typed.trim();
		}

		setBusy(id);
		setError(null);
		try {
			await api.admin.review(id, action, note);
			load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="page detail">
			<h1 className="detail__title" style={{ marginBottom: 8 }}>
				审核队列
			</h1>
			<p className="hero__subtitle" style={{ margin: "0 0 26px", textAlign: "left" }}>
				这里的东西已经构建成功了——通过与否只关乎它该不该出现在目录里。
			</p>

			{error && <div className="notice notice--error" style={{ marginBottom: 16 }}>{error}</div>}

			{items === null && <div className="skeleton" style={{ height: 120 }} />}
			{items?.length === 0 && (
				<div className="empty">
					<p className="empty__title">队列是空的</p>
					<p>没有待审核的提交。</p>
				</div>
			)}

			{items && items.length > 0 && (
				<div className="rows">
					{items.map((item) => (
						<div className="row" key={item.id}>
							<div className="row__main">
								<div className="row__title">
									{item.name}
									<span className="badge">{KIND_LABEL[item.kind]}</span>
								</div>
								<div className="row__sub">
									{item.id} · v{item.version ?? "—"}
									{item.skillCount ? ` · ${item.skillCount} 个技能` : ""}
									{item.serverCount ? ` · ${item.serverCount} 个服务` : ""}
									{item.publisher ? ` · @${item.publisher}` : ""}
									<br />
									<a href={item.homepage ?? item.repository} target="_blank" rel="noreferrer noopener">
										{item.repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}
										{item.path ? ` / ${item.path}` : ""}
										<Icon name="external" size={11} />
									</a>
								</div>
							</div>
							<div className="row__actions">
								<button
									type="button"
									className="btn btn--sm btn--primary"
									disabled={busy === item.id}
									onClick={() => void review(item.id, "approve")}
								>
									<Icon name="check" size={13} />
									通过
								</button>
								<button
									type="button"
									className="btn btn--sm btn--danger"
									disabled={busy === item.id}
									onClick={() => void review(item.id, "reject")}
								>
									驳回
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function SignInPrompt({ what }: { what: string }): JSX.Element {
	return (
		<div className="page detail">
			<div className="empty">
				<p className="empty__title">要先登录</p>
				<p style={{ marginBottom: 18 }}>登录之后才能看到{what}。</p>
				<a className="btn btn--primary" href={SIGN_IN_URL}>
					<Icon name="github" size={15} />
					用 GitHub 登录
				</a>
			</div>
		</div>
	);
}
