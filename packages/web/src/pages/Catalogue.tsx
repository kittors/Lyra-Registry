/**
 * The catalogue: what the site is for.
 *
 * Filters live in the URL rather than in component state, so a filtered view can be linked to and
 * survives a reload — and so the back button undoes a filter instead of leaving the site.
 *
 * The search is debounced, which is the difference between one request and one request per
 * keystroke. 220ms is below the threshold where typing feels laggy and above the interval between
 * keystrokes for anyone typing normally.
 */

import { useEffect, useState, type JSX } from "react";

import { BUNDLE_KINDS, type BundleKind, type EntrySort, type EntrySummary, type RegistryStats } from "@lyra/registry-shared";

import { api } from "../api.ts";
import { useQueryParam } from "../router.ts";
import { Counts, Icon, KIND_LABEL, KindIcon } from "../components/bits.tsx";

const SORTS: { value: EntrySort; label: string }[] = [
	{ value: "downloads", label: "最多安装" },
	{ value: "updated", label: "最近更新" },
	{ value: "name", label: "名称" },
];

export function Catalogue(): JSX.Element {
	const [q, setQ] = useQueryParam("q");
	const [kind, setKind] = useQueryParam("kind");
	const [category, setCategory] = useQueryParam("category");
	const [sort, setSort] = useQueryParam("sort");

	const [typed, setTyped] = useState(q);
	const [items, setItems] = useState<EntrySummary[] | null>(null);
	const [total, setTotal] = useState(0);
	const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
	const [stats, setStats] = useState<RegistryStats | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The box follows the URL when the URL changes from elsewhere — a link, the back button.
	useEffect(() => setTyped(q), [q]);

	useEffect(() => {
		const timer = setTimeout(() => setQ(typed), 220);
		return () => clearTimeout(timer);
	}, [typed, setQ]);

	useEffect(() => {
		void api.categories().then(setCategories).catch(() => undefined);
		void api.stats().then(setStats).catch(() => undefined);
	}, []);

	useEffect(() => {
		let cancelled = false;
		setError(null);
		api
			.entries({
				q: q || undefined,
				kind: (BUNDLE_KINDS as readonly string[]).includes(kind) ? (kind as BundleKind) : undefined,
				category: category || undefined,
				sort: (sort as EntrySort) || undefined,
				pageSize: 48,
			})
			.then((page) => {
				// A response for a query the user has already changed must not overwrite a newer one.
				if (cancelled) return;
				setItems(page.items);
				setTotal(page.total);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : "加载失败");
			});
		return () => {
			cancelled = true;
		};
	}, [q, kind, category, sort]);

	const filtered = Boolean(q || kind || category);

	return (
		<>
			<section className="page hero">
				<h1 className="hero__title">给 Lyra 装点东西</h1>
				<p className="hero__subtitle">
					插件、MCP 服务和技能集合。每一个都从源码构建、记录了哈希——装之前就能看到它到底带了多少技能。
				</p>
				{stats && stats.entries > 0 && (
					<div className="hero__stats">
						<span className="hero__stat">
							<b>{stats.entries}</b> 个条目
						</span>
						{stats.skills > 0 && (
							<span className="hero__stat">
								<b>{stats.skills}</b> 个技能
							</span>
						)}
						{stats.servers > 0 && (
							<span className="hero__stat">
								<b>{stats.servers}</b> 个 MCP 服务
							</span>
						)}
						{stats.downloads > 0 && (
							<span className="hero__stat">
								<b>{stats.downloads}</b> 次安装
							</span>
						)}
					</div>
				)}
			</section>

			<div className="page">
				<div className="filters">
					<div className="search">
						<span className="search__icon">
							<Icon name="search" size={15} />
						</span>
						<input
							className="search__input"
							type="search"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							placeholder="搜索名称或描述…"
							aria-label="搜索"
						/>
					</div>

					<div className="segmented" role="group" aria-label="按类型筛选">
						<button
							type="button"
							className="segmented__item"
							aria-pressed={!kind}
							onClick={() => setKind("")}
						>
							全部
						</button>
						{BUNDLE_KINDS.map((value) => (
							<button
								key={value}
								type="button"
								className="segmented__item"
								aria-pressed={kind === value}
								onClick={() => setKind(kind === value ? "" : value)}
							>
								{KIND_LABEL[value]}
							</button>
						))}
					</div>

					<select
						className="field__select"
						value={sort || "downloads"}
						onChange={(event) => setSort(event.target.value)}
						aria-label="排序方式"
					>
						{SORTS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>

				{categories.length > 0 && (
					<div className="chips">
						{categories.map((row) => (
							<button
								key={row.category}
								type="button"
								className="chip"
								aria-pressed={category === row.category}
								onClick={() => setCategory(category === row.category ? "" : row.category)}
							>
								{row.category} · {row.count}
							</button>
						))}
					</div>
				)}

				{error && <div className="notice notice--error">{error}</div>}

				{items === null && !error && (
					<div className="grid">
						{Array.from({ length: 6 }, (_, i) => (
							<div key={i} className="skeleton skeleton--card" />
						))}
					</div>
				)}

				{items?.length === 0 && (
					<div className="empty">
						<p className="empty__title">{filtered ? "没有匹配的条目" : "目录还是空的"}</p>
						<p>{filtered ? "换个关键词，或者清掉筛选。" : "第一个发布的人就是你。"}</p>
					</div>
				)}

				{items && items.length > 0 && (
					<>
						<div className="grid">
							{items.map((item) => (
								<EntryCard key={item.id} item={item} />
							))}
						</div>
						{total > items.length && (
							<p className="empty" style={{ paddingTop: 0 }}>
								显示前 {items.length} 个，共 {total} 个
							</p>
						)}
					</>
				)}
			</div>
		</>
	);
}

function EntryCard({ item }: { item: EntrySummary }): JSX.Element {
	return (
		<a className="card" href={`/e/${encodeURIComponent(item.id)}`}>
			<div className="card__head">
				{item.logo ? (
					<img className="card__logo" src={item.logo} alt="" loading="lazy" width={38} height={38} />
				) : (
					<div className="card__logo" />
				)}
				<div style={{ minWidth: 0, flex: 1 }}>
					<h2 className="card__title">{item.name}</h2>
					<span className="card__id">{item.id}</span>
				</div>
				<span className={`badge badge--${item.kind}`}>
					<KindIcon kind={item.kind} />
					{KIND_LABEL[item.kind]}
				</span>
			</div>

			{item.description && <p className="card__desc">{item.description}</p>}

			<div className="card__foot">
				<Counts skills={item.skillCount} servers={item.serverCount} />
				{(item.downloads ?? 0) > 0 && (
					<span>
						<Icon name="download" size={12} />
						{item.downloads}
					</span>
				)}
				{item.version && <span style={{ marginLeft: "auto" }}>v{item.version}</span>}
			</div>
		</a>
	);
}
