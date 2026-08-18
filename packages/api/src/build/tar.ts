/**
 * Reading and writing tar, because the worker has no git and no shell.
 *
 * The app installs by cloning. The platform cannot: a V8 isolate at the edge has no subprocess to
 * run `git` in, so a bundle arrives as GitHub's tarball over HTTP and leaves as one we built. That
 * makes tar a format this codebase has to actually know, rather than one it can shell out to.
 *
 * It is a simple format and this implementation stays inside the simple part of it: 512-byte
 * blocks, an octal-ish header, content padded to the next block, two zero blocks at the end. What
 * it does have to handle is how git writes long paths — pax extended headers — because `git
 * archive` emits them for any path over 100 bytes and every deep skill directory is one.
 *
 * Pure: no bindings, no globals beyond TextEncoder. That is what lets it be tested under
 * `node --test` alongside the rest of the repo rather than needing a Workers runtime to run at all.
 */

const BLOCK = 512;

export interface TarEntry {
	path: string;
	/** Regular files only; directories carry no bytes and are recreated from the paths anyway. */
	data: Uint8Array;
	/** Unix mode, kept so an executable hook stays executable through a rebuild. */
	mode: number;
}

/**
 * Read a tar archive into its regular files.
 *
 * Directories, symlinks and everything else are dropped rather than represented. A registry bundle
 * is markdown, JSON and the occasional script; a symlink in one is either meaningless once
 * extracted or an attempt to write outside the extraction root, and neither deserves support.
 */
export function readTar(buffer: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	const decoder = new TextDecoder();
	let offset = 0;
	/** Set by a pax or GNU header, consumed by the very next file header, then cleared. */
	let pendingPath: string | null = null;

	while (offset + BLOCK <= buffer.length) {
		const header = buffer.subarray(offset, offset + BLOCK);
		// Two consecutive zero blocks end the archive; one is enough to know we are past the files.
		if (isZero(header)) break;

		const size = readOctal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0);
		const start = offset + BLOCK;
		const end = start + size;
		if (end > buffer.length) throw new Error("tar 损坏：内容超出了文件长度");

		const body = buffer.subarray(start, end);
		// Content is padded up to the next block boundary; the padding is not part of the file.
		offset = start + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "x" || type === "X") {
			// pax extended header: `%d %s=%s\n` records. Only `path` matters to us.
			pendingPath = paxPath(decoder.decode(body)) ?? pendingPath;
			continue;
		}
		if (type === "L") {
			// GNU long name: the next header's name, as a NUL-terminated string in the body.
			pendingPath = decoder.decode(body).replace(/\0.*$/s, "");
			continue;
		}
		if (type === "K") continue; // GNU long *link* name; we drop links anyway.

		const path = pendingPath ?? readString(header, 0, 100, readString(header, 345, 155, ""));
		pendingPath = null;

		// '0' and NUL both mean a regular file; NUL is what older writers emit.
		if (type !== "0" && type !== "\0") continue;
		entries.push({ path, data: body.slice(), mode: readOctal(header, 100, 8) || 0o644 });
	}

	return entries;
}

/**
 * Write entries into a tar archive.
 *
 * Everything that could vary between two builds of the same commit is pinned: mtime is zero, uid
 * and gid are zero, the owner names are empty, and the caller is expected to have sorted the
 * entries. That is what makes the SHA-256 of the result mean "these bytes" rather than "these
 * bytes, built at this second" — a hash that changes on every rebuild cannot be used to tell a
 * cached copy from a tampered one.
 */
export function writeTar(entries: TarEntry[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	const encoder = new TextEncoder();

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.path);
		/*
		 * Long paths get a pax header of their own rather than being truncated into the 100-byte
		 * field. Truncating would produce an archive that unpacks to the wrong path, silently.
		 */
		if (nameBytes.length > 100) {
			const record = paxRecord("path", entry.path);
			chunks.push(header(paxName(entry.path), record.length, 0o644, "x"), pad(record));
		}
		chunks.push(header(entry.path, entry.data.length, entry.mode, "0"), pad(entry.data));
	}

	// The end-of-archive marker: two zero blocks. Readers that stop at one still work.
	chunks.push(new Uint8Array(BLOCK * 2));
	return concat(chunks);
}

/** A 512-byte tar header, checksummed. */
function header(path: string, size: number, mode: number, type: string): Uint8Array {
	const block = new Uint8Array(BLOCK);
	const encoder = new TextEncoder();

	const name = encoder.encode(path);
	// Truncation here is safe only because `writeTar` emitted a pax header for anything longer.
	block.set(name.subarray(0, 100), 0);
	writeOctal(block, 100, 8, mode & 0o7777);
	writeOctal(block, 108, 8, 0); // uid
	writeOctal(block, 116, 8, 0); // gid
	writeOctal(block, 124, 12, size);
	writeOctal(block, 136, 12, 0); // mtime: pinned, see `writeTar`
	block[156] = type.charCodeAt(0);
	block.set(encoder.encode("ustar\0"), 257);
	block.set(encoder.encode("00"), 263);

	/*
	 * The checksum is computed with its own field read as eight spaces, then written into it.
	 * Getting this wrong produces an archive GNU tar refuses and Node's tar accepts, which is the
	 * worst of the three possible outcomes.
	 */
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) sum += byte;
	writeOctal(block, 148, 7, sum);
	block[155] = 0x20;

	return block;
}

/** Content plus the zeros that round it up to a block boundary. */
function pad(data: Uint8Array): Uint8Array {
	const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
	padded.set(data);
	return padded;
}

/** One pax record: `<len> <key>=<value>\n`, where `<len>` counts itself. */
function paxRecord(key: string, value: string): Uint8Array {
	const encoder = new TextEncoder();
	const tail = encoder.encode(` ${key}=${value}\n`).length;
	// The length prefix is part of the length, so it can push the total into another digit.
	let length = tail + 1;
	while (String(length).length + tail !== length) length = String(length).length + tail;
	return encoder.encode(`${length} ${key}=${value}\n`);
}

/** What the pax header block itself is called. Never extracted; readers use it for diagnostics. */
function paxName(path: string): string {
	return `PaxHeaders/${path.split("/").pop() ?? "entry"}`.slice(0, 100);
}

/** The `path=` record out of a pax extended header, if it has one. */
function paxPath(text: string): string | null {
	for (const line of text.split("\n")) {
		const match = /^\d+ path=(.*)$/.exec(line);
		if (match) return match[1] ?? null;
	}
	return null;
}

function readString(block: Uint8Array, offset: number, length: number, prefix: string): string {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	const text = new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
	// The `prefix` field is a ustar-ism for paths just over 100 bytes: prefix + '/' + name.
	return prefix && text ? `${prefix}/${text}` : text || prefix;
}

/**
 * A numeric header field.
 *
 * Normally octal digits in ASCII. GNU switches to base-256 with the high bit set for values that
 * do not fit — which for `size` means files over 8GB, and this refuses those long before here, but
 * a mis-parsed high bit would produce a plausible wrong number rather than an error, so it is read
 * properly.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
	const field = block.subarray(offset, offset + length);
	if ((field[0] ?? 0) & 0x80) {
		let value = 0;
		for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] ?? 0);
		return value;
	}
	const text = new TextDecoder().decode(field).replace(/\0/g, "").trim();
	if (!text) return 0;
	const value = Number.parseInt(text, 8);
	return Number.isFinite(value) ? value : 0;
}

/** Right-aligned octal, NUL-terminated — the layout every tar reader expects. */
function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
	const text = value.toString(8).padStart(length - 1, "0");
	const bytes = new TextEncoder().encode(text.slice(-(length - 1)));
	block.set(bytes, offset);
	block[offset + length - 1] = 0;
}

function isZero(block: Uint8Array): boolean {
	return block.every((byte) => byte === 0);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
