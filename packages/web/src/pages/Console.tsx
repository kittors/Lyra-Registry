/**
 * The maintenance console.
 *
 * Admin-only, and not linked from anywhere a visitor sees. Everything it can change is
 * *presentation* — name, description, category, icon, colour, ordering. Nothing here can alter what
 * an entry is: kind, skill counts and client compatibility are read from the archive on every
 * build, and an override for those would be a way to publish a false claim about someone's code.
 *
 * Each field edited here is recorded server-side in `curated`, which is what stops the nightly
 * rebuild from quietly reverting the work the next time upstream pushes a commit.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import type { EntrySummary, Viewer } from "@lyra/registry-shared";

import { api } from "../api.ts";
import { formatDate, Icon, KIND_LABEL, StatusBadge } from "../components/bits.tsx";

export function Console({ viewer }: { viewer: Viewer | null }): JSX.Element | null {
	const [items, setItems] = useState<EntrySummary[] | null>(null);
	const [q, setQ] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback((search: string) => {
		api
			.admin.all(search || undefined)
			.then((page) => setItems(page.items))
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载失败"));
	}, []);

	useEffect(() => {
		if (!viewer?.isAdmin) return;
		const timer = setTimeout(() => load(q), 220);
		return () => clearTimeout(timer);
	}, [viewer, q, load]);

	// Not "no permission" — nothing. A page that says "forbidden" has confirmed it exists.
	if (!viewer?.isAdmin) return null;

	return (
		<div className="page detail">
			<h1 className="detail__title" style={{ marginBottom: 8 }}>
				维护
			</h1>
			<p className="hero__subtitle" style={{ margin: "0 0 22px", textAlign: "left" }}>
				改的是展示：名字、描述、分类、图标、排序。类型、技能数、兼容的客户端都从包里读，改不了——那些是事实。
			</p>

			<div className="search" style={{ maxWidth: 420, marginBottom: 20 }}>
				<span className="search__icon">
					<Icon name="search" size={15} />
				</span>
				<input
					className="search__input"
					type="search"
					value={q}
					onChange={(event) => setQ(event.target.value)}
					placeholder="搜索全部条目（含未上架的）…"
					aria-label="搜索条目"
				/>
			</div>

			{error && <div className="notice notice--error" style={{ marginBottom: 16 }}>{error}</div>}
			{items === null && <div className="skeleton" style={{ height: 120 }} />}
			{items?.length === 0 && (
				<div className="empty">
					<p className="empty__title">没有条目</p>
				</div>
			)}

			{items && items.length > 0 && (
				<div className="rows">
					{items.map((item) =>
						editing === item.id ? (
							<EntryEditor
								key={item.id}
								item={item}
								onDone={() => {
									setEditing(null);
									load(q);
								}}
								onCancel={() => setEditing(null)}
							/>
						) : (
							<div className="row" key={item.id}>
								<img
									className="card__logo"
									src={item.logo}
									alt=""
									width={38}
									height={38}
									style={{ width: 38, height: 38 }}
								/>
								<div className="row__main">
									<div className="row__title">
										{item.name}
										<StatusBadge status={item.status} />
										<span className="badge">{KIND_LABEL[item.kind]}</span>
									</div>
									<div className="row__sub">
										{item.id} · v{item.version ?? "—"} · {formatDate(item.updatedAt)}
										{item.clients?.length ? ` · ${item.clients.length} 个客户端` : ""}
									</div>
								</div>
								<div className="row__actions">
									<button type="button" className="btn btn--sm" onClick={() => setEditing(item.id)}>
										编辑
									</button>
								</div>
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}

function EntryEditor({
	item,
	onDone,
	onCancel,
}: {
	item: EntrySummary;
	onDone: () => void;
	onCancel: () => void;
}): JSX.Element {
	const [name, setName] = useState(item.name);
	const [description, setDescription] = useState(item.description ?? "");
	const [category, setCategory] = useState(item.category ?? "");
	const [brandColor, setBrandColor] = useState(item.brandColor ?? "");
	const [weight, setWeight] = useState(String(0));
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const file = useRef<HTMLInputElement>(null);
	// Bumped after an upload so the <img> re-requests rather than showing the cached old icon.
	const [iconVersion, setIconVersion] = useState(0);

	async function save(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await api.admin.patch(item.id, {
				name,
				description,
				category,
				brandColor,
				weight: Number(weight) || 0,
			});
			onDone();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}

	async function upload(chosen: File): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await api.admin.uploadIcon(item.id, chosen);
			setIconVersion((value) => value + 1);
			setNote("图标已更新");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "上传失败");
		} finally {
			setBusy(false);
		}
	}

	async function resetIcon(): Promise<void> {
		setBusy(true);
		try {
			await api.admin.clearIcon(item.id);
			setIconVersion((value) => value + 1);
			setNote("已恢复成自动读取的图标");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "重置失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 14 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
				<img
					className="card__logo"
					src={`${item.logo}${item.logo?.includes("?") ? "&" : "?"}v=${iconVersion}`}
					alt=""
					width={48}
					height={48}
					style={{ width: 48, height: 48 }}
				/>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div className="row__title">{item.id}</div>
					<div className="row__sub">
						{KIND_LABEL[item.kind]} · {item.clients?.join(", ") || "无兼容信息"}
					</div>
				</div>
				<div className="row__actions">
					<button type="button" className="btn btn--sm" disabled={busy} onClick={() => file.current?.click()}>
						换图标
					</button>
					<button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void resetIcon()}>
						恢复默认
					</button>
				</div>
				<input
					ref={file}
					type="file"
					accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
					hidden
					onChange={(event) => {
						const chosen = event.target.files?.[0];
						if (chosen) void upload(chosen);
						event.target.value = "";
					}}
				/>
			</div>

			<div className="field">
				<label className="field__label" htmlFor={`name-${item.id}`}>
					名称
				</label>
				<input
					id={`name-${item.id}`}
					className="field__input"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>

			<div className="field">
				<label className="field__label" htmlFor={`desc-${item.id}`}>
					描述
				</label>
				<input
					id={`desc-${item.id}`}
					className="field__input"
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</div>

			<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
				<div className="field" style={{ flex: "1 1 180px" }}>
					<label className="field__label" htmlFor={`cat-${item.id}`}>
						分类
					</label>
					<input
						id={`cat-${item.id}`}
						className="field__input"
						value={category}
						onChange={(event) => setCategory(event.target.value)}
					/>
				</div>
				<div className="field" style={{ width: 160 }}>
					<label className="field__label" htmlFor={`color-${item.id}`}>
						品牌色
					</label>
					<div style={{ display: "flex", gap: 6 }}>
						<input
							id={`color-${item.id}`}
							className="field__input"
							style={{ flex: 1, minWidth: 0 }}
							value={brandColor}
							placeholder="#8b5cf6"
							onChange={(event) => setBrandColor(event.target.value)}
						/>
						{/* A swatch, not a colour picker: the value may legitimately be empty or invalid
						    while being typed, and a picker cannot represent either. */}
						<span
							aria-hidden="true"
							style={{
								width: 34,
								flex: "none",
								borderRadius: 8,
								border: "1px solid var(--line)",
								background: /^#[0-9a-f]{3,8}$/i.test(brandColor) ? brandColor : "var(--surface-sunken)",
							}}
						/>
					</div>
				</div>
				<div className="field" style={{ width: 130 }}>
					<label className="field__label" htmlFor={`weight-${item.id}`}>
						排序权重
					</label>
					<input
						id={`weight-${item.id}`}
						className="field__input"
						type="number"
						value={weight}
						onChange={(event) => setWeight(event.target.value)}
					/>
				</div>
			</div>

			<span className="field__hint">
				权重大的排在前面，0 是默认。改过的字段以后不会被每日重建覆盖掉。
			</span>

			{error && <div className="notice notice--error">{error}</div>}
			{note && !error && <div className="notice notice--ok">{note}</div>}

			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void save()}>
					{busy ? "保存中…" : "保存"}
				</button>
				<button type="button" className="btn btn--sm" disabled={busy} onClick={onCancel}>
					取消
				</button>
			</div>
		</div>
	);
}
