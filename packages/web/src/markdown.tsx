/**
 * A README, rendered.
 *
 * This produces React elements, never an HTML string, and there is no `dangerouslySetInnerHTML`
 * anywhere in it. That is the entire security argument: a README comes from a repository anybody
 * can submit, so it is untrusted input being shown to a signed-in admin who is one click from
 * approving things. A markdown-to-HTML library plus a sanitiser would be two dependencies and a
 * configuration to get wrong; building elements cannot inject markup because it never produces any.
 *
 * The subset is what READMEs actually use: headings, paragraphs, lists, fenced and inline code,
 * links, emphasis, block quotes, images and rules. Raw HTML in the source is shown as text rather
 * than interpreted — which is a visible, honest degradation, unlike silently dropping it.
 */

import type { JSX, ReactNode } from "react";

/** Only these can be a link or an image target. `javascript:` is the reason this exists. */
function safeUrl(raw: string): string | null {
	const url = raw.trim();
	return /^(https?:\/\/|mailto:|#|\/)/i.test(url) ? url : null;
}

export function Markdown({ source }: { source: string }): JSX.Element {
	return <div className="readme">{renderBlocks(source)}</div>;
}

function renderBlocks(source: string): ReactNode[] {
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
			out.push(<Tag key={key++}>{renderInline(heading[2] ?? "")}</Tag>);
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
			out.push(<blockquote key={key++}>{renderBlocks(body.join("\n"))}</blockquote>);
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
						<li key={i}>{renderInline(item)}</li>
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
			paragraph.push(next);
			index += 1;
		}
		out.push(<p key={key++}>{renderInline(paragraph.join(" "))}</p>);
	}

	return out;
}

/**
 * Inline markup, scanned once left to right.
 *
 * Order matters: code spans win over everything, because backticks are how a README shows the
 * syntax of everything else. `**bold**` before `*italic*`, or the former would match as two of the
 * latter around an empty string.
 */
const INLINE = /(`[^`]+`)|(!?\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(~~[^~]+~~)/;

function renderInline(text: string): ReactNode[] {
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

		const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
		if (link) {
			const url = safeUrl(link[3] ?? "");
			if (!url) {
				// Not a scheme we will follow — show the text, drop the target. Silently rendering
				// nothing would hide that the README said something here.
				out.push(link[2] ?? "");
			} else if (link[1] === "!") {
				out.push(<img key={key++} src={url} alt={link[2] ?? ""} loading="lazy" />);
			} else {
				out.push(
					<a key={key++} href={url} target="_blank" rel="noreferrer noopener nofollow ugc">
						{link[2] ?? url}
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
