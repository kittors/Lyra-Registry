-- The registry's tables.
--
-- Written as plain SQL rather than through an ORM. There are five tables and the queries are the
-- kind SQL is good at; a mapping layer would be a dependency, a build step and a second place to
-- look, in exchange for hiding a language everyone reading this already knows.
--
-- Every timestamp is ISO 8601 text. SQLite has no date type, and text that sorts correctly is
-- worth more here than integers that need decoding to be read in a console.

-- Whoever claimed an entry on this platform. Not necessarily the code's author: `entries.author`
-- is what the bundle says about itself, this is who is answerable for the listing.
CREATE TABLE publishers (
	-- GitHub's numeric id, not the login. A login can be changed and reused by somebody else;
	-- keying on it would silently hand an account's entries to a stranger.
	id            INTEGER PRIMARY KEY,
	login         TEXT    NOT NULL,
	name          TEXT,
	avatar_url    TEXT,
	created_at    TEXT    NOT NULL,
	last_seen_at  TEXT    NOT NULL
);

CREATE INDEX publishers_login ON publishers (login);

CREATE TABLE entries (
	-- The directory it installs as. Also the URL segment, which is why it is checked, not trusted.
	id             TEXT    PRIMARY KEY,
	kind           TEXT    NOT NULL CHECK (kind IN ('plugin', 'mcp', 'skill')),
	name           TEXT    NOT NULL,
	description    TEXT,
	category       TEXT,
	repository     TEXT    NOT NULL,
	-- '' means the repository root. Never NULL, so that comparisons never have to think about it.
	subpath        TEXT    NOT NULL DEFAULT '',
	homepage       TEXT,
	author         TEXT,
	logo           TEXT,
	brand_color    TEXT,
	license        TEXT,
	package        TEXT,
	publisher_id   INTEGER REFERENCES publishers (id) ON DELETE SET NULL,
	status         TEXT    NOT NULL DEFAULT 'pending'
	                       CHECK (status IN ('pending', 'approved', 'rejected', 'delisted')),
	latest_version TEXT,
	-- Denormalised on purpose: every catalogue row shows it, and summing the daily table for a
	-- page of 24 entries is 24 aggregate queries to render a number that changes by one.
	downloads      INTEGER NOT NULL DEFAULT 0,
	readme         TEXT,
	-- Why it was rejected or delisted. Shown to its publisher and to admins, never in the catalogue.
	review_note    TEXT,
	created_at     TEXT    NOT NULL,
	updated_at     TEXT    NOT NULL,
	-- When it first became visible. Null while pending, and not the same as created_at.
	published_at   TEXT
);

-- The catalogue's only query: approved entries, filtered by kind or category, ordered by one of
-- four columns. Status leads every index because it is in every WHERE clause.
CREATE INDEX entries_status_downloads ON entries (status, downloads DESC);
CREATE INDEX entries_status_updated   ON entries (status, updated_at DESC);
CREATE INDEX entries_status_kind      ON entries (status, kind, downloads DESC);
CREATE INDEX entries_status_category  ON entries (status, category, downloads DESC);
CREATE INDEX entries_publisher        ON entries (publisher_id);
-- One listing per bundle. Two people submitting the same sub-path of the same repo is a duplicate,
-- not two entries, and finding that out at insert time is cheaper than reconciling it later.
CREATE UNIQUE INDEX entries_source ON entries (repository, subpath);

CREATE TABLE versions (
	entry_id     TEXT    NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
	version      TEXT    NOT NULL,
	-- Key in R2, not a URL: the bucket may move or gain a custom domain, and rewriting every row
	-- to change a hostname is a migration nobody should have to run.
	tarball_key  TEXT    NOT NULL,
	sha256       TEXT    NOT NULL,
	size         INTEGER NOT NULL,
	commit_sha   TEXT,
	-- Counted from the archive at build time, never taken from a manifest's claim about itself.
	skill_count  INTEGER,
	server_count INTEGER,
	-- Withdrawn, but still downloadable: people already installed it, and breaking their machines
	-- is not a way to express disapproval. Hidden from resolution, kept on disk.
	yanked       INTEGER NOT NULL DEFAULT 0,
	yanked_reason TEXT,
	created_at   TEXT    NOT NULL,
	PRIMARY KEY (entry_id, version)
);

CREATE INDEX versions_entry_created ON versions (entry_id, created_at DESC);

-- An append-only record of every moderation decision, including the ones that were reversed.
-- Who un-rejected something and when is exactly the question an audit asks.
CREATE TABLE reviews (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	entry_id    TEXT    NOT NULL,
	reviewer_id INTEGER REFERENCES publishers (id) ON DELETE SET NULL,
	action      TEXT    NOT NULL CHECK (action IN ('approve', 'reject', 'delist', 'restore', 'submit')),
	note        TEXT,
	created_at  TEXT    NOT NULL
);

CREATE INDEX reviews_entry ON reviews (entry_id, created_at DESC);

-- Daily buckets, so "popular this week" is a range scan rather than a guess.
-- The cumulative total lives on `entries`; this is the shape of it over time.
CREATE TABLE download_stats (
	entry_id TEXT    NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
	day      TEXT    NOT NULL,
	count    INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (entry_id, day)
);

CREATE INDEX download_stats_day ON download_stats (day);
