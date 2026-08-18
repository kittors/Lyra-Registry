-- Two things the first schema could not express.
--
-- **Which agents an entry works with.** The registry is not tied to one client — `SKILL.md` is read
-- by Claude Code, Codex, Pi and Lyra alike, and `.mcp.json` is a protocol with many clients. That
-- was true from the start and simply went unrecorded, so every catalogue row implied "for Lyra"
-- by omission.
--
-- **Curation.** Everything about an entry was derived from its repository, which is right for facts
-- (how many skills, what kind) and wrong for presentation. An icon read off the owner's GitHub
-- avatar is a reasonable default and a poor final answer: several bundles in one repository all get
-- the same picture. These columns are what a maintainer sets by hand, and — critically — what a
-- rebuild must not overwrite.

-- Comma-separated `ClientId`s, derived at build time. Text rather than a join table: it is a short
-- fixed set, always read whole, and never queried by member.
ALTER TABLE entries ADD COLUMN clients TEXT NOT NULL DEFAULT '';

-- An icon uploaded through the console, as an R2 key. Takes precedence over `logo`, which is
-- whatever the manifest or the GitHub avatar supplied.
ALTER TABLE entries ADD COLUMN icon_key TEXT;

-- Which fields a person has edited, comma-separated.
--
-- Without this, a refresh cannot tell "the maintainer wrote this description" from "the description
-- happens to equal what the manifest said last time", and must therefore either always overwrite
-- (losing the edit) or never overwrite (freezing the entry at its first build). Recording the
-- decision makes the rule statable: derived fields refresh, edited fields do not.
ALTER TABLE entries ADD COLUMN curated TEXT NOT NULL DEFAULT '';

-- Editorial ordering, highest first. Zero for everything nobody has touched, so the default order
-- is unchanged and "featured" stays an explicit act rather than an accident of the sort column.
ALTER TABLE entries ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;

CREATE INDEX entries_status_weight ON entries (status, weight DESC, downloads DESC);
