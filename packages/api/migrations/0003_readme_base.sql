-- Where the README's relative links point.
--
-- A README may come from the bundle itself or, for a bundle with none of its own, from the
-- repository root. The two resolve relative paths differently — `skills/think/SKILL.md` inside
-- `plugins/x/README.md` means `plugins/x/skills/…`, and the same line in the root README means
-- `skills/…` — and only the build knows which one it took.
--
-- Without this the site guessed, using the entry's sub-path for both. Waza's links came out as
-- `/skills/skills/think/SKILL.md`: a 404 for every link in the table that is most of its README.
ALTER TABLE entries ADD COLUMN readme_base TEXT NOT NULL DEFAULT '';
