# 02 — Files & identity

## Markdown files

A JBOM file is a UTF-8 markdown file, optionally opening with a YAML
frontmatter block:

- The frontmatter is delimited by `---` fences, and the opening fence must
  start at **byte 0** of the file. Anything else is body.
- Files round-trip **byte-preserving**: reading and rewriting a file that
  didn't change must be a byte-identical no-op. CRLF line endings are
  tolerated and preserved.
- Dates are written `YYYY-MM-DD`; datetimes are floating local wall-clock
  `YYYY-MM-DD HH:MM` unless a type's field explicitly calls for a zoned
  ISO-8601 instant (chapter 04, value kinds). Stored as text, compared
  lexically.

## The three-tier file model

Every path in the vault falls into exactly one of three tiers:

1. **Typed record.** A markdown file whose frontmatter declares a `type:`.
   Record-hood requires `type:` — full stop. Typed records get schema
   validation against their type (chapter 04) plus everything tier 2 gets.
2. **Untyped-but-indexed file.** Any other markdown file — including files
   with no frontmatter at all. It is fully **content-indexed**: body links,
   backlinks, tags, text, and path identity. It is first-class content; it
   simply isn't a record. Plenty of externally-born files live their whole
   lives in this tier, and that is a legal steady state — never nagged,
   never warned about, never auto-upgraded.
3. **Foreign subtree.** Any directory containing a `.git` entry (directory
   or worktree file) is foreign: it contributes **no records, is never
   synced, and is never touched by scripts** — but it is always browsable,
   viewable, and editable through the app and by agents. Exclusion applies
   to record-hood and automation, never to visibility. A manual marker file
   can declare a non-repo directory foreign the same way (marker name is an
   engine decision, phase 23). Skipped subtrees are **counted and surfaced**
   in the index — exclusion is always loud, never silent.

Whitelisting individual files inside a foreign subtree back into the record
tier is deliberately unsupported until a real need appears.

## Identity: the creation stamp and ULIDs

**When the app or an agent creates a file, it stamps `id` and `name` into
the frontmatter at birth.** This is the creation stamp:

- It fires **only on creation by the app or an agent** — never from the
  watcher, never retroactively on files born elsewhere (writer discipline,
  chapter 01).
- It is **write-once**: stamped at birth, never revisited, so it converges
  after a single write and stays permanently quiet under
  write-only-if-changed.
- Whether the stamp also writes `type:` is deferred to the templates
  conversation (chapter 08). Until then a freshly stamped file with no
  `type:` is simply tier 2 — a well-defined state, not an error.

**`id` is an opaque ULID**: 26 characters, Crockford base32
(`01KY6NYS7221H6A8YR3JG6XMP0`), 48-bit millisecond timestamp + 80 bits of
randomness. Properties the format relies on:

- **Opaque.** The id encodes nothing mutable — no type, no title slug — so
  it can never go stale and is never rewritten. Rewriting an id destroys
  the only property an id has.
- **Sortable.** Lexicographic order is creation order, giving a stable
  tiebreak and a creation-time reading that doesn't depend on trusting a
  `created:` field nothing maintains.
- **Standard.** ULID is a published spec; bridges and external tooling can
  parse it.

Human readability is served by `name:` on the line above, not by the id.
ULIDs never appear in filenames.

Consequences:

- "Every file has an id" holds for **files the system created**. Files born
  in external editors arrive unstamped and stay that way, keyed by
  vault-relative path. That is legal (tier 2, or an unstamped typed
  record). Missing `id`/`name` is **never a diagnostic**.
- **Duplicate ids are an error on every file sharing the id.** No winner is
  picked, no record is dropped or demoted — resolving the ambiguity is a
  human/agent decision (repair is an action).
- Id uniqueness is scoped to the deployed vault root (a deployment fact,
  chapter 01).

## `name` — the single title key

`name` is the sole title key in the format. There is no `title:` field and
no alias for it. Display-name resolution for any file:

1. frontmatter `name:`
2. else the first `# H1` in the body
3. else the filename stem

A file carrying `title:` does not error — like any unknown field it is
preserved and indexed as a generic field (chapter 04); it simply is not
read as the name.

## The common field set

Six fields are common to **every** type, uniformly — no per-type
allocation:

| Field         | Kind | Meaning                                                                                                               |
| ------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `id`          | ULID | identity (see above)                                                                                                  |
| `name`        | text | the thing's name — entities have names, not titles                                                                    |
| `description` | text | **one line, no markdown** — for list views, generated collection bodies, and agents triaging without opening the body |
| `tags`        | list | freeform labels (see Tags below)                                                                                      |
| `created`     | date | when the file was made — never auto-written                                                                           |
| `updated`     | date | last deliberate touch — never auto-written                                                                            |

All six are **optional; absence is never a diagnostic**. `description` is a
real convention, not decoration — writers should populate it — but a file
without one is fine.

Types add their own fields on top (chapter 04 for the machinery,
chapter 05 for the built-ins). A type with a time identity carries both
facts: a `journal` has `created` (when the file was made) _and_ `timestamp`
(the moment it records) — normally equal, diverging on backfill, and
deliberately distinct.

## Filenames

- Filenames are **kebab-case slugs of the name**: lowercase ASCII, words
  joined by `-` (`ratify-jbom-conventions.md`). The same rule extends to
  folder names (chapter 03).
- A filename is a **display fact, not identity**. Identity is the
  frontmatter `id`, so renames are free and slug drift after a retitle is
  legal — nothing resolves identity through the filename.
- ULIDs never appear in filenames; no status, sequence, or type prefixes
  either (anything a filename encoded would go stale — the same defect
  that ruled out slug ids).
- Time-based files use ISO names instead of slugs (`2026-08-05.md`,
  `2026-w32.md`, `2026-08.md`, `2026.md`); journal entries prefix a
  timestamp to a slug (`2026-08-05-1430-standup-notes.md`). See
  chapter 03.

## Tags

Tags come from two places, both indexed:

- the frontmatter `tags:` list;
- inline `#tag` in the body, Obsidian-compatible: nested `#foo/bar`
  counts; tags inside code fences and code spans are ignored.

## Unknown fields

Unknown or extra frontmatter fields are **always preserved and never
diagnostics**. They are additionally indexed as generic fields so they stay
queryable. (Unknown _types_ and unknown _values in closed vocabularies_ are
a different matter — chapter 04's two-tier handling.)

## Deletion

Deletion is soft: a deleted file moves to the engine's trash
(`.jbom/trash/`), never `rm`. Trash is rebuildable-state territory
(chapter 03, runtime directories) — restoring from it is an app/agent
action.
