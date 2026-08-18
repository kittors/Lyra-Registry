/**
 * tar, checked against a real tar.
 *
 * A round-trip through our own reader and writer proves they agree with each other, which is worth
 * very little: two halves of one misunderstanding round-trip perfectly. So the tests that matter
 * here shell out to the system `tar` — what we write has to unpack there, and what it packs has to
 * read here. That is the actual requirement, because the archives on both ends of this pipeline
 * are written by `git archive` and unpacked by whatever the user's machine has.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { readTar, writeTar, type TarEntry } from "../src/build/tar.ts";

/*
 * macOS's bsdtar stores extended attributes as extra `._name` members unless told not to. They are
 * a real part of the archive it produced, so filtering them out of the assertion would be hiding
 * them; setting this produces the archive every other platform would have written instead.
 */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: "1" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workspaces: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "lyra-tar-"));
	workspaces.push(dir);
	return dir;
}

// Leaving archives in the temp dir is the sort of debris that turns up months later, unexplained.
after(() => {
	for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function file(path: string, text: string, mode = 0o644): TarEntry {
	return { path, data: encoder.encode(text), mode };
}

test("what we write, we read back unchanged", () => {
	const entries = [file("a.md", "# A"), file("nested/deep/b.json", '{"x":1}')];
	const back = readTar(writeTar(entries));
	assert.deepEqual(
		back.map((entry) => entry.path),
		["a.md", "nested/deep/b.json"],
	);
	assert.equal(decoder.decode(back[1]!.data), '{"x":1}');
});

test("an executable stays executable through a rebuild", () => {
	// A skill can ship a hook script; losing the bit turns it into a file nothing will run.
	const back = readTar(writeTar([file("run.sh", "#!/bin/sh\n", 0o755)]));
	assert.equal(back[0]?.mode, 0o755);
});

test("the system tar unpacks what we wrote", () => {
	const dir = scratch();
	const archive = join(dir, "out.tar");
	writeFileSync(archive, writeTar([file("skill/SKILL.md", "---\nname: x\n---\n"), file("skill/run.sh", "ok", 0o755)]));

	// -x through the real implementation: this is the assertion that the format is right, not ours.
	execFileSync("tar", ["-xf", archive, "-C", dir]);
	assert.equal(readFileSync(join(dir, "skill/SKILL.md"), "utf8"), "---\nname: x\n---\n");
	assert.equal(readFileSync(join(dir, "skill/run.sh"), "utf8"), "ok");
});

test("we read what the system tar wrote", () => {
	const dir = scratch();
	mkdirSync(join(dir, "src/skills/review"), { recursive: true });
	writeFileSync(join(dir, "src/skills/review/SKILL.md"), "# review");
	writeFileSync(join(dir, "src/top.txt"), "top");

	const archive = join(dir, "in.tar");
	execFileSync("tar", ["-cf", archive, "-C", dir, "src"], { env: TAR_ENV });

	const entries = readTar(new Uint8Array(readFileSync(archive)));
	const paths = entries.map((entry) => entry.path).sort();
	assert.deepEqual(paths, ["src/skills/review/SKILL.md", "src/top.txt"]);
	assert.equal(decoder.decode(entries.find((e) => e.path.endsWith("SKILL.md"))!.data), "# review");
});

test("a path too long for the header survives, in both directions", () => {
	// `git archive` emits a pax header for anything over 100 bytes, and every deeply nested skill
	// directory is one. Truncating instead would unpack to the wrong path without erroring.
	const long = `${"a-rather-long-directory-name/".repeat(5)}SKILL.md`;
	assert.ok(long.length > 100, "the fixture has to actually be long");

	const back = readTar(writeTar([file(long, "deep")]));
	assert.equal(back.length, 1, "the pax header must not surface as an entry of its own");
	assert.equal(back[0]?.path, long);

	const dir = scratch();
	const archive = join(dir, "long.tar");
	writeFileSync(archive, writeTar([file(long, "deep")]));
	execFileSync("tar", ["-xf", archive, "-C", dir]);
	assert.equal(readFileSync(join(dir, long), "utf8"), "deep");
});

test("we read the pax headers the system tar writes for long paths", () => {
	const dir = scratch();
	const long = `${"b-rather-long-directory-name/".repeat(5)}SKILL.md`;
	mkdirSync(dirname(join(dir, "root", long)), { recursive: true });
	writeFileSync(join(dir, "root", long), "deep");

	const archive = join(dir, "long-in.tar");
	// --format=pax forces the encoding git uses, rather than whatever bsdtar picks by default.
	execFileSync("tar", ["--format=pax", "-cf", archive, "-C", dir, "root"], { env: TAR_ENV });

	const entries = readTar(new Uint8Array(readFileSync(archive)));
	assert.deepEqual(
		entries.map((entry) => entry.path),
		[`root/${long}`],
	);
});

test("directories and symlinks are dropped rather than represented", () => {
	const dir = scratch();
	mkdirSync(join(dir, "pkg/empty"), { recursive: true });
	writeFileSync(join(dir, "pkg/real.txt"), "real");
	execFileSync("ln", ["-s", "real.txt", join(dir, "pkg/link.txt")]);

	const archive = join(dir, "mixed.tar");
	execFileSync("tar", ["-cf", archive, "-C", dir, "pkg"], { env: TAR_ENV });

	const paths = readTar(new Uint8Array(readFileSync(archive))).map((entry) => entry.path);
	// A symlink in a bundle is either meaningless once extracted or an attempt to write outside it.
	assert.deepEqual(paths, ["pkg/real.txt"]);
});

test("two builds of the same content produce the same bytes", () => {
	// The whole point of the sha256 in an entry: it has to mean "these files", not "this second".
	const entries = [file("a.md", "A"), file("b.md", "B")];
	assert.deepEqual(writeTar(entries), writeTar(entries));
});

test("an archive that lies about a file's length is refused, not read past", () => {
	const archive = writeTar([file("a.md", "hello")]);
	// Overwrite the size field with something larger than the archive.
	const bogus = archive.slice();
	bogus.set(encoder.encode("00000077777"), 124);
	assert.throws(() => readTar(bogus), /tar 损坏/);
});

test("an empty archive is empty, not an error", () => {
	assert.deepEqual(readTar(writeTar([])), []);
	assert.deepEqual(readTar(new Uint8Array(0)), []);
});
