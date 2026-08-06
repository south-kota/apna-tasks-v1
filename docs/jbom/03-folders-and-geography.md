# 03 — Folders & geography

## Claimed folders

**Every meaningful folder is claimed by a same-named summary markdown file
that _is_ the folder's record.** `apna-tasks/apna-tasks.md` claims
`apna-tasks/`. The summary file's frontmatter `type:` declares what the
folder is — `project`, `task`, `month`, anything — and its body is the
folder's overview (for a project, typically a generated rollup;
chapter 07).

- The summary file is the folder's **property sheet**: description, tags,
  status, dates — everything the folder "has", it has via its record.
- A folder without a summary record is **transparent**: plain organization
  with no semantics. Membership passes straight through it.
- Native filesystem metadata is **never storage**. The only trustworthy
  native facts are a folder's location/nesting (membership, below) and its
  name (the slug). Everything Finder-rich — tags, comments, colors, icons,
  xattrs — is silently stripped by git/zip/sync and invisible to editors
  and agents; timestamps are weak fallback signals at most.

## Membership is positional

**A record belongs to whatever claims its nearest claimed ancestor
folder.** From this one mechanism:

- **A project is a folder.** Tasks _and every other record type_ — notes,
  decisions, meetings, sessions, memories — belong to a project by living
  inside its folder. There are no `project:` or `parent:` fields; both are
  **derived relations**, assigned by the engine from location and nesting
  at index time, never stored.
- **Nearest claimed ancestor wins.** A task in
  `project-x/subproject-y/` belongs to subproject Y; the full chain up to X
  is derivable when a view wants "everything under X."
- **No claimed ancestor = no project** — which is what "the inbox" means
  (see Root layout below).
- **Moving a file _is_ the membership edit**, and it works identically from
  Finder, vim, or the app, on stamped and unstamped files alike. Identity
  is the frontmatter `id`, so moves are free.
- **Single-homing is structural.** One record, one location, one project —
  forced by the filesystem. Multi-homing does not exist; cross-cutting
  groupings are collections (links, chapter 07). Symlinks and aliases are
  never used to place a record in two homes (the only sanctioned symlinks
  are tool-compat shims on context files; chapter 01).

**Projects nest arbitrarily.** A company folder holding several project
folders is the intended use, not an edge case. **Subtask trees use the same
grammar**: a task with children becomes a folder claimed by a same-named
summary file of `type: task`, with child task files (and their own claimed
folders, unbounded depth) nested inside. The recorded trade: breaking a
task into subtasks means minting a folder and moving a file — accepted
because the dominant case is agents decomposing large work into deep trees
with per-node detail. "Promotion" (turning a body line into a task file, or
a task file into a task folder) is an app/agent action, never schema.

**There are no phases and no lists in the format.** Grouping between
project and task is projects, tasks, and collections — nothing else. A
"list" is a collection (manual = curated list, smart = saved filter).

## Root layout

The root of a deployed vault holds **flat project folders** (nesting freely
inside) plus these conventional homes:

| Folder         | What lands there                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Inbox/`       | random tasks and captures — a _transparent_ folder, so its contents have no project; routine Inbox cleanup is the vault's maintenance loop |
| `archive/`     | old projects, moved whole — archiving is a **move, not a status**; a storage filter, invisible to normal views                             |
| `Journal/`     | flat list of timestamped entries (below)                                                                                                   |
| `Calendar/`    | the organized time structure (below)                                                                                                       |
| `Memory/`      | general/fundamental memories — preferences, cross-project facts                                                                            |
| `Sessions/`    | general sessions, and the home for sessions that belong to no project                                                                      |
| `Collections/` | global views — collections defined here see the whole vault (chapter 07 scoping)                                                           |

Rules that govern all of these:

- **Homes are creation defaults, never enforced.** They are where types are
  created or moved by default; there are no location diagnostics. `type:`
  is truth; location means membership only.
- **Every home is usable at any level** (the fractal principle,
  chapter 01): a project may carry its own `archive/`, `Inbox/`,
  `Sessions/`, `Memory/`, or `Collections/`.
- **Memory and sessions are two-level by design:** the root tier holds
  general material; project-scoped sessions and memories live in the
  project's own folders and archive with it. The per-type default-home
  mapping (where a new record of each type is created) is registry
  configuration (chapter 04) pointing into these folders.
- **Hybrid resource-homes are ordinary projects.** `People/` — home of all
  person records _and_ of people-related scripts and development — is just
  a project folder; the same pattern serves books, movies, music. Nothing
  distinguishes a "resource home" structurally.

There is **no vault seeding step**. A new vault starts empty and is
populated by hand when use begins.

## Project internals

Inside a project folder, by convention (all transparent, present only when
needed):

```
project-x/
  project-x.md        # the summary record (claims the folder)
  AGENTS.md           # agent context for this subtree
  notes/  tasks/  resources/  media/  skills/
  code/               # repos, worktrees — foreign subtrees (chapter 02)
  ...
```

- **`AGENTS.md` is distinct from the summary record**: the summary file is
  the folder's _record_; AGENTS.md is agent-facing context. The root
  carries one for global preferences; any project may carry its own.
  `AGENTS.md` is the canonical name; `CLAUDE.md` and other tool-specific
  names are symlink shims (chapter 01). Today AGENTS.md is a plain tier-2
  file — cascade/assembly semantics are deferred with an owner
  (chapter 08).
- **`code/` is the conventional home for repos.** Anything with `.git` is a
  foreign subtree wherever it sits (chapter 02); `code/` just keeps it
  tidy. Plain path links are the correct link form into foreign subtrees
  (chapter 06).

## Calendar/

`Calendar/` applies the claimed-folder grammar to time:

```
Calendar/
  2026/
    2026.md               # year record claims the year folder
    2026-08/
      2026-08.md          # month record claims the month folder
      2026-08-05.md       # day files live in their month
      2026-w32.md         # week files live in their month, filed by their Monday
```

- Year and month folders are **claimed** by their `year`/`month` records.
- Day and week files sit inside their month as plain files; a day may
  upgrade to its own claimed folder when it accumulates content (the
  standard file→folder promotion).
- Filenames are ISO: `2026.md`, `2026-08.md`, `2026-08-05.md`,
  `2026-w32.md`.
- Day/week/month/year **bodies are generated rollups** — meetings,
  scheduled tasks, deadlines, agendas rendered as linked views
  (chapter 07). The records themselves stay in their projects; the
  calendar shows them.

## Journal/

`Journal/` is a **flat list of timestamped entries** — things written at a
moment (thoughts, transcriptions), as opposed to Calendar's containers for
spans of time.

- Filenames: `YYYY-MM-DD-HHMM-<slug>.md`
  (`2026-08-05-1430-standup-notes.md`) — chronological by name. The
  filename is display (chapter 02); `timestamp:` in the frontmatter is the
  identity.
- Multiple entries per day are expected and legal.
- Journal bodies are **the content itself**, not rollups.

## Filesystem constraints

Adopted as format-level notes because sync and portability depend on them:

- **Lowercase-ASCII kebab slugs for files _and_ folders.** APFS
  case-insensitivity and Unicode normalization differences are real sync
  hazards; staying in lowercase ASCII sidesteps both.
- **Path-length budget.** ~255 bytes per component, ~1024 bytes per path.
  Deep subtask trees are folder chains — keep slugs short.
- **The empty-directory sync problem is dodged by construction**: a claimed
  folder always contains at least its summary file.

## Runtime directories

Two runtime directories, by design, both deployment facts at the vault
root and both invisible to the format:

- **`.jbom/`** — format-level **rebuildable** state: the index, trash,
  logs. Deleting it and rebuilding from markdown is the canonical recovery
  path. (One narrow carve-out: the name-history log, chapter 06.)
- **`.apnatasks/`** — app/sync-level state: sync status, conflict copies.
  Different owner, different lifecycle; some of its contents (e.g. bridge
  state) are _not_ rebuildable, which is exactly why it is not `.jbom/`.

Their two ignore mechanisms are deliberately un-unified for now.
