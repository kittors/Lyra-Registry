/**
 * The small pieces: icons, badges, the theme switch, and the labels for a kind.
 *
 * Icons are inline SVG rather than a font or a package — there are nine of them, they inherit
 * `currentColor`, and an icon font is a network request plus a flash of the wrong glyph.
 */

import { useEffect, useState, type JSX } from "react";

import type { BundleKind, EntryStatus } from "@lyra/registry-shared";

/** What each kind is called, in one place, because it is shown on five screens. */
export const KIND_LABEL: Record<BundleKind, string> = {
	plugin: "插件",
	mcp: "MCP 服务",
	skill: "技能集合",
};

export const STATUS_LABEL: Record<EntryStatus, string> = {
	pending: "待审核",
	approved: "已上架",
	rejected: "已驳回",
	delisted: "已下架",
};

export function KindBadge({ kind }: { kind: BundleKind }): JSX.Element {
	return <span className={`badge badge--${kind}`}>{KIND_LABEL[kind]}</span>;
}

export function StatusBadge({ status }: { status: EntryStatus }): JSX.Element {
	return <span className={`badge badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Icon({ name, size = 15 }: { name: IconName; size?: number }): JSX.Element {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{PATHS[name]}
		</svg>
	);
}

export type IconName =
	| "search"
	| "sun"
	| "moon"
	| "monitor"
	| "download"
	| "github"
	| "arrow-left"
	| "external"
	| "check"
	| "puzzle"
	| "server"
	| "sparkles"
	| "refresh";

const PATHS: Record<IconName, JSX.Element> = {
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
		</>
	),
	moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
	monitor: (
		<>
			<rect x="2" y="3" width="20" height="14" rx="2" />
			<path d="M8 21h8m-4-4v4" />
		</>
	),
	download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />,
	github: (
		<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 19.9 5a4.9 4.9 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.7 12.7 0 0 0-6.6 0C6.9 1.1 5.8 1.4 5.8 1.4A4.9 4.9 0 0 0 5.7 5a5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.2 6.4 6.2 6.7a3.4 3.4 0 0 0-.9 2.6V22" />
	),
	"arrow-left": <path d="M19 12H5m0 0 6 6m-6-6 6-6" />,
	external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
	check: <path d="m20 6-11 11-5-5" />,
	puzzle: (
		<path d="M14 3a2 2 0 0 0-4 0v1H7a1 1 0 0 0-1 1v3H5a2 2 0 0 0 0 4h1v3a1 1 0 0 0 1 1h3v1a2 2 0 0 0 4 0v-1h3a1 1 0 0 0 1-1v-3h1a2 2 0 0 0 0-4h-1V5a1 1 0 0 0-1-1h-3Z" />
	),
	server: (
		<>
			<rect x="2" y="3" width="20" height="7" rx="2" />
			<rect x="2" y="14" width="20" height="7" rx="2" />
			<path d="M6 6.5h.01M6 17.5h.01" />
		</>
	),
	sparkles: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm7 10 .8 2.2L22 16l-2.2.8L19 19l-.8-2.2L16 16l2.2-.8L19 13Z" />,
	refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
};

export function KindIcon({ kind }: { kind: BundleKind }): JSX.Element {
	return <Icon name={kind === "plugin" ? "puzzle" : kind === "mcp" ? "server" : "sparkles"} size={13} />;
}

type Theme = "light" | "dark" | "system";

/**
 * Light, dark, or whatever the system says.
 *
 * Three states rather than a toggle. A site with only two makes "follow my OS" unreachable once
 * you have touched it — and following the OS is what most people want, including the ones whose
 * OS switches at sunset.
 *
 * The switch itself is applied with transitions suppressed for a frame: animating every colour on
 * the page reads as lag, not as polish.
 */
export function ThemeToggle(): JSX.Element {
	const [theme, setTheme] = useState<Theme>(() => {
		const saved = localStorage.getItem("lyra-theme");
		return saved === "light" || saved === "dark" ? saved : "system";
	});

	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("theme-switching");

		if (theme === "system") {
			delete root.dataset.theme;
			localStorage.removeItem("lyra-theme");
		} else {
			root.dataset.theme = theme;
			localStorage.setItem("lyra-theme", theme);
		}

		// Two frames: one for the class to take effect, one for the colours to land under it.
		const timer = requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
		return () => cancelAnimationFrame(timer);
	}, [theme]);

	const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
	const label = theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色";

	return (
		<button
			type="button"
			className="btn btn--ghost btn--icon"
			onClick={() => setTheme(next)}
			title={`主题：${label}（点击切换）`}
			aria-label={`主题：${label}，点击切换`}
		>
			<Icon name={theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon"} size={16} />
		</button>
	);
}

/** A count with its unit, or nothing at all when there is nothing to say. */
export function Counts({ skills, servers }: { skills?: number; servers?: number }): JSX.Element | null {
	const parts: string[] = [];
	if (skills) parts.push(`${skills} 个技能`);
	if (servers) parts.push(`${servers} 个服务`);
	return parts.length ? <span>{parts.join(" · ")}</span> : null;
}

/** Bytes as something readable. Downloads are shown next to this, so precision would be noise. */
export function formatSize(bytes: number | undefined): string {
	if (!bytes) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A date as a day. The time something was rebuilt is never the interesting part. */
export function formatDate(iso: string | undefined): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}
