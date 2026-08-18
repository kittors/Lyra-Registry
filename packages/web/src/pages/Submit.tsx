/**
 * Publishing something.
 *
 * The form asks for a repository and, if the bundle is not at its root, a sub-path. Everything else
 * is optional, because everything else is read out of the repository — asking for a name and a
 * description that the manifest already states is asking somebody to type a thing twice and then
 * keep the two in sync.
 *
 * The build runs while they wait. It takes a couple of seconds and the alternative — a queue and a
 * notification — means finding out about a typo in a sub-path tomorrow.
 */

import { useState, type FormEvent, type JSX } from "react";

import { BUNDLE_KINDS, type BuildResult, type BundleKind } from "@lyra/registry-shared";

import { api, SIGN_IN_URL } from "../api.ts";
import { KIND_LABEL, Icon } from "../components/bits.tsx";
import type { Viewer } from "@lyra/registry-shared";

export function Submit({ viewer }: { viewer: Viewer | null }): JSX.Element {
	const [repository, setRepository] = useState("");
	const [path, setPath] = useState("");
	const [kind, setKind] = useState<BundleKind | "">("");
	const [id, setId] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<BuildResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!viewer) {
		return (
			<div className="page detail">
				<h1 className="detail__title" style={{ marginBottom: 14 }}>
					发布
				</h1>
				<p className="hero__subtitle" style={{ margin: "0 0 20px", textAlign: "left" }}>
					用 GitHub 登录之后就可以提交。我们只读你的公开信息，不会碰你的仓库。
				</p>
				<a className="btn btn--primary" href={SIGN_IN_URL}>
					<Icon name="github" size={15} />
					用 GitHub 登录
				</a>
			</div>
		);
	}

	async function onSubmit(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			setResult(
				await api.submit({
					repository,
					path: path || undefined,
					kind: kind || undefined,
					id: id || undefined,
				}),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "提交失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="page detail">
			<h1 className="detail__title" style={{ marginBottom: 8 }}>
				发布
			</h1>
			<p className="hero__subtitle" style={{ margin: "0 0 28px", textAlign: "left" }}>
				填仓库地址就行。名称、描述、图标、有多少技能，都从仓库里读——读不出来的才需要你填。
			</p>

			<form className="form" onSubmit={(event) => void onSubmit(event)}>
				<div className="field">
					<label className="field__label" htmlFor="repository">
						GitHub 仓库
					</label>
					<input
						id="repository"
						className="field__input"
						value={repository}
						onChange={(event) => setRepository(event.target.value)}
						placeholder="https://github.com/owner/name"
						required
						autoFocus
					/>
					<span className="field__hint">目前只支持 GitHub 公开仓库。</span>
				</div>

				<div className="field">
					<label className="field__label" htmlFor="path">
						子路径（可选）
					</label>
					<input
						id="path"
						className="field__input"
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="plugins/context7"
					/>
					<span className="field__hint">一个仓库里放了好几个插件时填这里，留空表示整个仓库。</span>
				</div>

				<div className="field">
					<label className="field__label" htmlFor="kind">
						类型（可选）
					</label>
					<select
						id="kind"
						className="field__select"
						value={kind}
						onChange={(event) => setKind(event.target.value as BundleKind | "")}
					>
						<option value="">自动判断</option>
						{BUNDLE_KINDS.map((value) => (
							<option key={value} value={value}>
								{KIND_LABEL[value]}
							</option>
						))}
					</select>
					<span className="field__hint">
						插件和 MCP 服务能从内容判断出来，不用填。<b>技能集合必须选</b>——一层 SKILL.md
						目录和插件的 skills/ 长得一样，光看是分不出来的。
					</span>
				</div>

				<div className="field">
					<label className="field__label" htmlFor="id">
						id（可选）
					</label>
					<input
						id="id"
						className="field__input"
						value={id}
						onChange={(event) => setId(event.target.value)}
						placeholder="留空则用目录名"
					/>
					<span className="field__hint">它会成为安装到本地的目录名，只能用小写字母、数字、点、下划线和短横线。</span>
				</div>

				<div>
					<button className="btn btn--primary" type="submit" disabled={busy || !repository}>
						{busy ? "正在拉取并构建…" : "提交"}
					</button>
				</div>
			</form>

			{error && (
				<div className="notice notice--error" style={{ marginTop: 20, maxWidth: 600 }}>
					{error}
				</div>
			)}

			{result && !result.ok && (
				<div className="notice notice--error" style={{ marginTop: 20, maxWidth: 600 }}>
					{result.error}
				</div>
			)}

			{result?.ok && (
				<div className="notice notice--ok" style={{ marginTop: 20, maxWidth: 600 }}>
					<b>构建成功。</b>
					<br />
					{result.entryId} v{result.version}
					{result.skillCount ? ` · ${result.skillCount} 个技能` : ""}
					{result.serverCount ? ` · ${result.serverCount} 个 MCP 服务` : ""}
					<br />
					已经进入审核队列，通过之后会出现在目录里。你可以在「我的」里看它的状态。
					{result.warnings && result.warnings.length > 0 && (
						<>
							<br />
							<br />
							<b>另外：</b>
							<ul style={{ margin: "6px 0 0", paddingLeft: "1.3em" }}>
								{result.warnings.map((warning, index) => (
									<li key={index}>{warning}</li>
								))}
							</ul>
						</>
					)}
				</div>
			)}
		</div>
	);
}
