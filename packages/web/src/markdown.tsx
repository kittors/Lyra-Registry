/**
 * A README, rendered.
 *
 * This produces React elements, never an HTML string, and there is no `dangerouslySetInnerHTML`
 * anywhere in it. That is the entire security argument: a README comes from a repository anybody
 * can submit, so it is untrusted input being shown to a signed-in admin who is one click from
 * approving things. A markdown-to-HTML library plus a sanitiser would be two dependencies and a
 * configuration to get wrong; building elements cannot inject markup because it never produces any.
 *
 * The subset is what READMEs actually use: headings, paragraphs, lists, tables, fenced and inline
 * code, links, emphasis, block quotes, images and rules.
 *
 * Raw HTML is *reduced*, not printed and not executed. Printing it was the first attempt and it is
 * what a `<div align="center">` banner — which is how a large share of READMEs open — turns into:
 * a screenful of angle brackets above the fold. Reduction pulls out the parts that carry meaning
 * (images, links, text) and rewrites them as markdown, which then goes through the same safe path
 * as everything else. Tags themselves are dropped. Nothing here ever produces markup from a string.
 */

import type { JSX, ReactNode } from "react";

/**
 * Where a README's relative links point.
 *
 * A README written for GitHub is full of them — `[/think](skills/think/SKILL.md)`, `![](assets/x.svg)`
 * — and they mean "relative to this file in this repository". Rendered on another origin they are
 * meaningless, and the first version dropped them, which turned every such link into bare text and
 * every screenshot into nothing. Resolving them against the repository is what GitHub itself does.
 */
export interface Base {
	/** For links a person clicks: the file's page. */
	blob: string;
	/** For images the browser loads: the file's bytes. */
	raw: string;
}

/**
 * A URL we are willing to emit, or null.
 *
 * Absolute http(s), anchors and mail links pass through. A repository-relative path is resolved
 * against `base` when there is one. Everything else — `javascript:`, `data:`, anything with a
 * scheme we did not name — is refused, which is the entire reason this function exists.
 */
function safeUrl(raw: string, base: Base | undefined, isImage: boolean): string | null {
	const url = raw.trim();
	if (!url) return null;
	if (/^(https?:\/\/|mailto:|#)/i.test(url)) return url;
	// A scheme we have not allowed. Checked before the relative case so `javascript:x` cannot be
	// mistaken for a filename.
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
	if (!base) return null;

	const cleaned = url.replace(/^\.\//, "").replace(/^\//, "");
	if (cleaned.includes("..")) return null;
	return `${isImage ? base.raw : base.blob}/${cleaned}`;
}

export function Markdown({ source, base }: { source: string; base?: Base }): JSX.Element {
	return <div className="readme">{renderBlocks(source, base)}</div>;
}

function renderBlocks(source: string, base: Base | undefined): ReactNode[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const out: ReactNode[] = [];
	let index = 0;
	let key = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";

		if (!line.trim()) {
			index += 1;
			continue;
		}

		/*
		 * A block of raw HTML.
		 *
		 * Collected up to the next blank line and reduced to markdown. Checked after fenced code so
		 * that a README *showing* HTML in a code block keeps showing it.
		 */
		if (/^\s*<(?:div|p|h[1-6]|a|img|picture|table|center|br|span|sub|blockquote)\b/i.test(line)) {
			const html: string[] = [];
			while (index < lines.length && (lines[index] ?? "").trim()) {
				html.push(lines[index] ?? "");
				index += 1;
			}
			const reduced = reduceHtml(html.join(" "));
			if (reduced.trim()) out.push(<p key={key++}>{renderInline(reduced, base)}</p>);
			continue;
		}

		// Fenced code: everything up to the closing fence is literal, including things that look
		// like other block syntax. Checked first for exactly that reason.
		const fence = /^\s*```(\w*)\s*$/.exec(line);
		if (fence) {
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
				body.push(lines[index] ?? "");
				index += 1;
			}
			index += 1;
			out.push(
				<pre key={key++}>
					<code>{body.join("\n")}</code>
				</pre>,
			);
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = Math.min(heading[1]!.length, 6);
			const Tag = `h${level}` as "h1";
			out.push(<Tag key={key++}>{renderInline(heading[2] ?? "", base)}</Tag>);
			index += 1;
			continue;
		}

		if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
			out.push(<hr key={key++} />);
			index += 1;
			continue;
		}

		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
				body.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
				index += 1;
			}
			out.push(<blockquote key={key++}>{renderBlocks(body.join("\n"), base)}</blockquote>);
			continue;
		}

		/*
		 * A pipe table.
		 *
		 * Common enough in a README that leaving it out is visible: Waza's renders its whole skill
		 * list this way, and unparsed it arrives as one paragraph reading `| Skill | When | ...`.
		 * Recognised by a delimiter row of dashes under a header row, which is what separates a
		 * table from a paragraph that merely contains pipes.
		 */
		if (line.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1] ?? "")) {
			const header = splitRow(line);
			index += 2;
			const rows: string[][] = [];
			while (index < lines.length && (lines[index] ?? "").includes("|")) {
				rows.push(splitRow(lines[index] ?? ""));
				index += 1;
			}
			out.push(
				<table key={key++}>
					<thead>
						<tr>
							{header.map((cell, i) => (
								<th key={i}>{renderInline(cell, base)}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, r) => (
							<tr key={r}>
								{row.map((cell, c) => (
									<td key={c}>{renderInline(cell, base)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>,
			);
			continue;
		}

		const bullet = /^\s*[-*+]\s+/;
		const numbered = /^\s*\d+[.)]\s+/;
		if (bullet.test(line) || numbered.test(line)) {
			const ordered = !bullet.test(line);
			const marker = ordered ? numbered : bullet;
			const items: string[] = [];
			while (index < lines.length && marker.test(lines[index] ?? "")) {
				items.push((lines[index] ?? "").replace(marker, ""));
				index += 1;
			}
			const List = ordered ? "ol" : "ul";
			out.push(
				<List key={key++}>
					{items.map((item, i) => (
						<li key={i}>{renderInline(item, base)}</li>
					))}
				</List>,
			);
			continue;
		}

		// A paragraph runs until a blank line or the start of another block.
		const paragraph: string[] = [];
		while (index < lines.length) {
			const next = lines[index] ?? "";
			if (!next.trim() || /^\s*(?:#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s)/.test(next)) break;
			// A table starts on the *next* line, so a paragraph must stop before its header row.
			if (next.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1] ?? "")) break;
			paragraph.push(next);
			index += 1;
		}
		out.push(<p key={key++}>{renderInline(paragraph.join(" "), base)}</p>);
	}

	return out;
}

/**
 * Inline markup, scanned once left to right.
 *
 * Order matters. Code spans win over everything, because backticks are how a README shows the
 * syntax of everything else. A linked image comes before a plain link, since `[![a](b)](c)` also
 * starts like one and the plain pattern's `[^\]]*` cannot cross the inner `]` — which left every
 * badge in a README rendering as its own source. `**bold**` precedes `*italic*`, or the former
 * matches as two of the latter around an empty string.
 */
const INLINE =
	/(`[^`]+`)|(\[!\[[^\]]*\]\([^)\s]+\)\]\([^)\s]+\))|(!?\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(~~[^~]+~~)/;

/**
 * HTML reduced to the markdown it was standing in for.
 *
 * Images and links become their markdown equivalents so they render through `safeUrl` like any
 * other; every remaining tag is deleted and its text kept. The output is markdown *source*, not
 * markup — it goes back through `renderInline`, so a `<script>` in a README ends up as the text
 * inside it and can never become an element.
 */
function reduceHtml(html: string): string {
	return (
		html
			// Content that is not prose and would otherwise leak out as text.
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
			.replace(/<!--[\s\S]*?-->/g, "")
			/*
			 * `<a href="x"><img …></a>` — a linked badge, which is what a README's header row is made of.
			 *
			 * The whole `<img>` is captured and its attributes read separately. Matching `src` and an
			 * optional `alt` in one pattern looks tidier and silently loses the alt: the optional group
			 * can match empty, and the `[^>]*` after it then consumes the attribute.
			 */
			.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi, (_m, href: string, img: string) => {
				const src = /src=["']([^"']+)["']/i.exec(img)?.[1];
				return src ? `[![${altOf(img)}](${src})](${href})` : `[](${href})`;
			})
			.replace(
				/<img\b[^>]*?src=["']([^"']+)["'][^>]*?>/gi,
				(match: string, src: string) => `![${altOf(match)}](${src})`,
			)
			.replace(
				/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
				(_m, href: string, text: string) => `[${text.replace(/<[^>]*>/g, "").trim()}](${href})`,
			)
			.replace(/<br\s*\/?>/gi, " ")
			// Everything else: keep the words, drop the tag.
			.replace(/<[^>]*>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** The `alt` of an `<img>` tag, or an empty string. */
function altOf(tag: string): string {
	return /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
}

/** One row of a pipe table, with the optional leading and trailing pipes discarded. */
function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.trim());
}

function renderInline(text: string, base: Base | undefined): ReactNode[] {
	const out: ReactNode[] = [];
	let rest = text;
	let key = 0;

	while (rest) {
		const match = INLINE.exec(rest);
		if (!match || match.index === undefined) {
			out.push(rest);
			break;
		}

		if (match.index > 0) out.push(rest.slice(0, match.index));
		const token = match[0];
		rest = rest.slice(match.index + token.length);

		if (token.startsWith("`")) {
			out.push(<code key={key++}>{token.slice(1, -1)}</code>);
			continue;
		}

		// A badge: an image wrapped in a link. Emitted by `reduceHtml`, and written directly too.
		const linkedImage = /^\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)$/.exec(token);
		if (linkedImage) {
			const src = safeUrl(linkedImage[2] ?? "", base, true);
			const href = safeUrl(linkedImage[3] ?? "", base, false);
			if (src && href) {
				out.push(
					<a key={key++} href={href} target="_blank" rel="noreferrer noopener nofollow ugc">
						<img src={src} alt={linkedImage[1] ?? ""} loading="lazy" />
					</a>,
				);
			} else if (src) {
				out.push(<img key={key++} src={src} alt={linkedImage[1] ?? ""} loading="lazy" />);
			} else {
				out.push(linkedImage[1] ?? "");
			}
			continue;
		}

		const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
		if (link) {
			const isImage = link[1] === "!";
			const label = link[2] ?? "";
			const url = safeUrl(link[3] ?? "", base, isImage);
			if (!url) {
				// Not a target we will follow — show the text, drop the link. Rendering nothing would
				// hide that the README said something here.
				out.push(...renderInline(label, base));
			} else if (isImage) {
				out.push(<img key={key++} src={url} alt={label} loading="lazy" />);
			} else {
				out.push(
					<a key={key++} href={url} target="_blank" rel="noreferrer noopener nofollow ugc">
						{/* Recursive: `[`/think`](…)` is a link whose text is inline code, and the label
						    is markdown like any other. */}
						{label ? renderInline(label, base) : url}
					</a>,
				);
			}
			continue;
		}

		if (token.startsWith("**") || token.startsWith("__")) {
			out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
			continue;
		}
		if (token.startsWith("~~")) {
			out.push(<del key={key++}>{token.slice(2, -2)}</del>);
			continue;
		}
		out.push(<em key={key++}>{token.slice(1, -1)}</em>);
	}

	return out;
}
