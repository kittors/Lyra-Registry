/**
 * One entry, in full.
 *
 * The sidebar is where the platform earns its existence: the hash, the size, the commit and the
 * counted skills are things a list of links in a GitHub repository cannot tell you. They are shown
 * as facts about the archive, because that is what they are — every one was measured at build time
 * rather than copied from a manifest.
 */

import { useEffect, useState, type JSX } from "react";

import type { EntryDetail } from "@lyra/registry-shared";

import { api } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { formatDate, formatSize, Icon, KIND_LABEL, KindIcon } from "../components/bits.tsx";

export function Detail({ id }: { id: string }): JSX.Element {
	const [entry, setEntry] = useState<EntryDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEntry(null);
		setError(null);
		api
			.entry(id)
			.then((found) => !cancelled && setEntry(found))
			.catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : "加载失败"));
		return () => {
			cancelled = true;
		};
	}, [id]);

	if (error) {
		return (
			<div className="page detail">
				<a className="detail__back" href="/">
					<Icon name="arrow-left" size={14} /> 返回目录
				</a>
				<div className="notice notice--error">{error}</div>
			</div>
		);
	}

	if (!entry) {
		return (
			<div className="page detail">
				<div className="skeleton" style={{ height: 92, marginBottom: 28 }} />
				<div className="skeleton" style={{ height: 280 }} />
			</div>
		);
	}

	const current = entry.versions.find((version) => version.version === entry.version) ?? entry.versions[0];

	return (
		<div className="page detail">
			<a className="detail__back" href="/">
				<Icon name="arrow-left" size={14} /> 返回目录
			</a>

			<header className="detail__head">
				{entry.logo ? (
					<img className="detail__logo" src={entry.logo} alt="" width={60} height={60} />
				) : (
					<div className="detail__logo" />
				)}
				<div style={{ minWidth: 0, flex: 1 }}>
					<h1 className="detail__title">{entry.name}</h1>
					{entry.description && <p className="detail__desc">{entry.description}</p>}
					<div className="detail__meta">
						<span className={`badge badge--${entry.kind}`}>
							<KindIcon kind={entry.kind} />
							{KIND_LABEL[entry.kind]}
						</span>
						{entry.category && <span className="badge">{entry.category}</span>}
						{entry.version && <span className="badge">v{entry.version}</span>}
						{entry.license && <span className="badge">{entry.license}</span>}
					</div>
				</div>
			</header>

			<div className="detail__body">
				<main>
					{entry.readme ? (
						<Markdown source={entry.readme} />
					) : (
						<div className="empty" style={{ padding: "40px 0", textAlign: "left" }}>
							<p className="empty__title">这个条目没有 README</p>
							<p>作者在仓库里加一个 README.md，下次刷新就会出现在这里。</p>
						</div>
					)}
				</main>

				<aside className="side">
					<div className="side__block">
						<h3>安装</h3>
						<div className="install">
							<p className="install__label">在 Lyra 的「市场」里搜索它，或者直接下载：</p>
							<div className="install__cmd">
								<a className="btn btn--primary btn--sm" href={`/v1/download/${encodeURIComponent(entry.id)}`}>
									<Icon name="download" size={14} />
									下载 {formatSize(entry.size)}
								</a>
							</div>
						</div>
					</div>

					<div className="side__block">
						<h3>这个包里有什么</h3>
						<dl className="side__rows">
							{entry.skillCount ? (
								<div className="side__row">
									<dt>技能</dt>
									<dd>{entry.skillCount} 个</dd>
								</div>
							) : null}
							{entry.serverCount ? (
								<div className="side__row">
									<dt>MCP 服务</dt>
									<dd>{entry.serverCount} 个</dd>
								</div>
							) : null}
							<div className="side__row">
								<dt>体积</dt>
								<dd>{formatSize(entry.size)}</dd>
							</div>
							<div className="side__row">
								<dt>安装次数</dt>
								<dd>{entry.downloads ?? 0}</dd>
							</div>
							<div className="side__row">
								<dt>更新于</dt>
								<dd>{formatDate(entry.updatedAt)}</dd>
							</div>
						</dl>
					</div>

					<div className="side__block">
						<h3>来源</h3>
						<dl className="side__rows">
							<div className="side__row">
								<dt>仓库</dt>
								<dd>
									<a
										href={entry.homepage ?? entry.repository.replace(/\.git$/, "")}
										target="_blank"
										rel="noreferrer noopener"
										style={{ color: "var(--accent)" }}
									>
										GitHub <Icon name="external" size={11} />
									</a>
								</dd>
							</div>
							{entry.path && (
								<div className="side__row">
									<dt>子路径</dt>
									<dd className="hash">{entry.path}</dd>
								</div>
							)}
							{entry.author && (
								<div className="side__row">
									<dt>作者</dt>
									<dd>{entry.author}</dd>
								</div>
							)}
							{entry.publisher && (
								<div className="side__row">
									<dt>发布者</dt>
									<dd>@{entry.publisher}</dd>
								</div>
							)}
							{entry.commit && (
								<div className="side__row">
									<dt>构建自</dt>
									<dd className="hash">{entry.commit.slice(0, 10)}</dd>
								</div>
							)}
						</dl>
					</div>

					{current && (
						<div className="side__block">
							<h3>校验</h3>
							<p className="field__hint" style={{ marginBottom: 6 }}>
								下载后比对这个哈希，对得上才是我们构建的那份。
							</p>
							<p className="hash" style={{ overflowWrap: "anywhere", margin: 0 }}>
								sha256:{current.sha256}
							</p>
						</div>
					)}

					{entry.versions.length > 1 && (
						<div className="side__block">
							<h3>版本</h3>
							<dl className="side__rows">
								{entry.versions.slice(0, 8).map((version) => (
									<div className="side__row" key={version.version}>
										<dt>
											{version.version}
											{version.yanked && <span className="badge badge--rejected" style={{ marginLeft: 6 }}>已撤回</span>}
										</dt>
										<dd>{formatDate(version.createdAt)}</dd>
									</div>
								))}
							</dl>
						</div>
					)}
				</aside>
			</div>
		</div>
	);
}
