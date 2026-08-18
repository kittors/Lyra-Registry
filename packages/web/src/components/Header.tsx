/**
 * The header, and the sign-in state that lives in it.
 *
 * `viewer` is passed in rather than fetched here: three screens need to know who is signed in, and
 * having each of them ask would be three requests and three chances to disagree about the answer.
 */

import type { JSX } from "react";

import type { Viewer } from "@lyra/registry-shared";

import { SIGN_IN_URL } from "../api.ts";
import { useRoute } from "../router.ts";
import { Icon, ThemeToggle } from "./bits.tsx";

export function Header({
	viewer,
	pendingCount,
	onSignOut,
}: {
	viewer: Viewer | null;
	pendingCount: number;
	onSignOut: () => void;
}): JSX.Element {
	const route = useRoute().split("?")[0] ?? "/";

	return (
		<header className="header">
			<div className="page header__inner">
				<a className="brand" href="/">
					<Logo />
					Lyra 市场
				</a>

				<nav className="nav">
					<a className="nav__link" href="/" aria-current={route === "/" ? "page" : undefined}>
						目录
					</a>
					{viewer && (
						<a className="nav__link" href="/mine" aria-current={route === "/mine" ? "page" : undefined}>
							我的
						</a>
					)}
					{viewer?.isAdmin && (
						<a className="nav__link" href="/admin" aria-current={route === "/admin" ? "page" : undefined}>
							审核
							{pendingCount > 0 && <span className="nav__badge">{pendingCount}</span>}
						</a>
					)}
				</nav>

				<ThemeToggle />

				{viewer ? (
					<>
						<a className="btn btn--primary btn--sm" href="/submit">
							发布
						</a>
						<button
							type="button"
							className="btn btn--ghost btn--icon"
							onClick={onSignOut}
							title={`${viewer.login}（点击退出）`}
							aria-label={`已登录为 ${viewer.login}，点击退出`}
						>
							{viewer.avatarUrl ? (
								<img
									src={viewer.avatarUrl}
									alt=""
									width={20}
									height={20}
									style={{ borderRadius: "50%", display: "block" }}
								/>
							) : (
								<Icon name="github" size={16} />
							)}
						</button>
					</>
				) : (
					<a className="btn btn--sm" href={SIGN_IN_URL}>
						<Icon name="github" size={14} />
						用 GitHub 登录
					</a>
				)}
			</div>
		</header>
	);
}

/**
 * The mark: a lyre's strings, as four lines of decreasing length.
 *
 * Drawn rather than shipped as a file so it takes its colour from the text beside it and is
 * therefore correct in both themes without a second asset.
 */
function Logo(): JSX.Element {
	return (
		<svg className="brand__mark" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
			<path
				d="M5 20V7.5C5 5 7 3 9.5 3S14 5 14 7.5V20M19 20V9.5C19 7.6 17.9 6 16 6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<circle cx="9.5" cy="20.5" r="2" fill="currentColor" />
			<circle cx="18.5" cy="20.5" r="1.6" fill="currentColor" opacity="0.55" />
		</svg>
	);
}
