/**
 * The part of the README renderer that is not about React.
 *
 * `reduceHtml` gets its own test because it is the piece that touches untrusted input most
 * directly: a README can contain anything, and this decides what survives into the page. The
 * safety property is structural — nothing in this module produces markup, only markdown source
 * that then goes through `safeUrl` — but the reduction still has to be right, or a `<script>` body
 * shows up as visible text and a banner disappears.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Lifted out of the module rather than imported.
 *
 * The module is TSX and these tests run under `node --test` with type stripping, which does not
 * handle JSX. `reduceHtml` is plain TypeScript, so extracting it exercises the same source the
 * site ships — the assertion below is what keeps this from silently testing nothing if the
 * function is ever renamed or moved.
 */
const source = readFileSync(fileURLToPath(new URL("../src/markdown.tsx", import.meta.url)), "utf8");

function lift(name: string): string {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start > 0, `${name} must still be a top-level function in markdown.tsx`);
	const end = source.indexOf("\n}\n", start) + 2;
	assert.ok(end > start, `${name} must be a complete function`);
	// Strip the type annotations; the bodies are plain JavaScript.
	return source.slice(start, end).replace(/: string/g, "");
}

const reduceHtml = new Function(`${lift("altOf")}\n${lift("reduceHtml")}\nreturn reduceHtml;`)() as (
	html: string,
) => string;

test("a centred banner becomes its image and text, not a wall of tags", () => {
	// How a large share of READMEs open, Waza's included. Printed verbatim it filled the first screen.
	const banner =
		'<div align="center"> <img src="https://x/logo.svg" width="120" /> <h1>Waza</h1> <p><b>Habits as skills.</b></p> </div>';
	const out = reduceHtml(banner);
	assert.ok(out.includes("![](https://x/logo.svg)"), out);
	assert.ok(out.includes("Waza"), out);
	assert.ok(out.includes("Habits as skills."), out);
	assert.ok(!out.includes("<div"), "no tag should survive");
});

test("a linked badge keeps both the image and where it points", () => {
	const badge = '<a href="https://github.com/o/r/releases"><img src="https://img.shields.io/v.svg" alt="Version"></a>';
	assert.equal(reduceHtml(badge), "[![Version](https://img.shields.io/v.svg)](https://github.com/o/r/releases)");
});

test("a plain image keeps its alt text", () => {
	assert.equal(reduceHtml('<img src="a.png" alt="A diagram">'), "![A diagram](a.png)");
	assert.equal(reduceHtml('<img src="a.png">'), "![](a.png)");
});

test("a link keeps its text and drops the tags inside it", () => {
	assert.equal(reduceHtml('<a href="https://x"><b>Docs</b></a>'), "[Docs](https://x)");
});

test("script and style bodies never reach the page as text", () => {
	// Not a markup-injection risk — nothing here emits markup — but printing the body of a script
	// is still leaking something nobody wants to read.
	assert.equal(reduceHtml('<script>alert("x")</script>'), "");
	assert.equal(reduceHtml("<style>body{color:red}</style>"), "");
	assert.equal(reduceHtml("<!-- a comment -->"), "");
});

test("a tag that survives reduction is only ever characters downstream", () => {
	const out = reduceHtml('<p>before</p><script src="evil.js"></script><p>after</p>');
	assert.ok(!out.includes("<script"), out);
	assert.ok(out.includes("before") && out.includes("after"), out);
});

test("entities come back as the characters they stand for", () => {
	assert.equal(reduceHtml("<p>a &amp; b &lt;c&gt;</p>"), "a & b <c>");
});
