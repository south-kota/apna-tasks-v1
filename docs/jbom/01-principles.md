# 01 — Principles

These principles govern every other chapter. When a detailed rule seems to
conflict with one of these, the principle wins and the rule needs rereading
or fixing.

## The vault

A JBOM vault is a folder of markdown files. Everything durable — tasks,
projects, people, agents, notes, journal entries, session records — is a
`.md` file inside it. There is exactly one human owner per vault; agents,
apps, bridges, and scripts are additional writers acting on the owner's
behalf.

**The vault boundary is a hard permission boundary.** Nothing outside the
vault root may be touched by agents, sync engines, or scripts. Everything
inside it is theirs to read (writing is governed by the writer rules below).

**The vault is the life vault entirely, not just a second brain.** Resource
libraries (people, books, media), agent infrastructure, and calendars are
all in scope. The built-in types (chapter 05) are the designed defaults for
that scope, not its limits.

## Files are the truth

The markdown files are the only durable state. Any index (SQLite or
otherwise), any view, any app surface is a **derived, rebuildable
projection**: deleting it and rebuilding from the markdown is the canonical
recovery path and must be lossless. Nothing the system needs to re-derive
its state may live only outside the files — with one narrow, named
exception (the name-history log, chapter 06, which is observational and
carries its own carve-out).

Corollary: **the app only renders markdown.** There is no privileged view
layer. A generated view is a script writing markdown into a file that the
app then renders like any other file.

## The fractal vault

**Any claimed folder is a valid vault-in-miniature.** A project folder can
carry its own record, its own AGENTS.md, its own sessions, memories, tasks,
notes, code, and its own subtree-scoped collections — so opening any
subtree as if it were a root just works. There is nothing structurally
special about the vault root.

Root-only concerns are **deployment facts, not format facts**: runtime
directories (`.jbom/`, `.apnatasks/`), sync configuration, and the
id-uniqueness horizon live at the deployed root. Conventional homes
(`Inbox/`, `archive/`, `Memory/`, `Sessions/`, `Calendar/`, `Journal/`,
`Collections/`) are **defaults usable at any level**, never root-schema —
a project may carry its own `archive/` or `Inbox/`.

## The open vault

Files enter the vault from anywhere — the app, an agent, vim, Obsidian,
`cp`, a shell script. All of them are legal. The format never punishes a
file for how it was born: a file with no frontmatter at all is still
indexed and still first-class content (the three-tier model, chapter 02).
Record-hood is opted into by declaring a `type:`; it is never imposed.

## Writer discipline

Four invariants bind every writer in the system:

1. **No background writes, ever.** The watcher/indexer never modifies a
   file. Not to stamp an id, not to fix a field, not to refresh a rollup.
   Every write is performed by a foreground writer: the app, an agent, a
   bridge, or a script acting deliberately. (The concrete failure this
   prevents: a background stamper rewriting a file that sits open in an
   external editor, whose stale save then wipes the stamp.)
2. **Write-only-if-changed.** Every non-human writer writes a file only
   when the content actually changed. No timestamp-only rewrites, no
   regenerate-identical-content churn. This keeps sync quiet and conflict
   copies rare.
3. **Every machine write is attributable.** All writes by non-human writers
   are recorded in an echo ledger so any change can be explained after the
   fact. The ledger's mechanics belong to the sync-engine design
   (chapter 08); the invariant does not wait for it.
4. **Repair is an action, never a side effect.** Diagnostics report
   problems (chapter 04); fixing them — resolving a duplicate id, repairing
   a broken link, re-homing a file — is always an explicit app/agent
   action.

Nothing in the system auto-writes `created:` or `updated:`; if present,
they were written by whoever authored or edited the file on purpose.

## Frontmatter is for facts; prose belongs to the document

Frontmatter carries the facts the index queries: identity, status, dates,
refs. Everything narrative — close reasons, acceptance criteria, meeting
notes, collection member lists — lives in the body as ordinary markdown.
When in doubt, prefer the body: a field must earn its place by being
queried.

Two recurring consequences of this principle:

- **Rollups are generated.** Any derived list — a project's task rollup, a
  collection's member list, an agent's run history, a day's agenda — is
  written by a generator into a marked region of the body (chapter 07),
  never hand-maintained. Derived inverse relations (`blocks`,
  children-of-a-parent) are likewise always computed, never stored.
- **Checkboxes are content.** A `- [ ]` line anywhere is ordinary markdown
  — never a task, never a task reference, never indexed for checked-state,
  never policed or refreshed. Checkboxes are used far more broadly than
  tasks, and they stay free. A task exists in exactly one way: as a file
  (chapter 05).

## Naming sovereignty

JBOM chooses its own field names and semantics on their own merits.
Agreement with any other app's vocabulary is a non-goal; per-app naming
differences are the bridge's mapping table, never a constraint on the
schema. What the format owes bridges instead is **well-defined semantics**
for every field, so mappings are unambiguous.

## Superset, not lowest common denominator

The schema targets near-complete coverage of the personal-productivity
feature space. When a bridge target cannot represent something, the bridge
**documents the lossy edge and warns** — the schema never shrinks to what
round-trips everywhere. The burden of proof on a field is not "does every
app have this" but "is this coherent, and does its degradation have a
defined shape."

## The bridge contract

Bridges mirror vault records into external systems (Reminders, Notion,
contacts, calendar apps) and back. The rules they operate under are part of
the format:

- **Bridges map foreign vocabulary to the nearest canonical value, nothing
  more.** A foreign status/priority/label is preserved on the bridge side
  for round-tripping, but is never auto-declared into the vault's
  vocabulary. The vault's vocabulary grows only by the owner's declaration.
- **Raw foreign values stay bridge-side.** No foreign ids, labels, or
  unmapped payloads are written into vault files. There is no
  `integrations:` frontmatter field.
- **Identity mappings live in a cloud-authoritative ledger, not in files.**
  Bridges may run wherever the app runs (several replicas at once), so the
  `(bridge, vault-id) → foreign-id` table is owned by the cloud sync
  authority, and the anti-duplicate primitive is an **atomic claim**
  (compare-and-set): two replicas that both decide a file needs a foreign
  counterpart race the claim; the loser _adopts_ the winner's foreign id
  instead of creating a second one. Establishing a _new_ link therefore
  requires the network — an offline replica queues the create (deferring a
  page beats duplicating one); existing links keep syncing from local
  cache.
- **Bridges never promote foreign content into vault records on their
  own.** In particular, a foreign checkbox never becomes a vault task by
  bridge action.
- **Lossy edges are documented, not silent.** Where a target cannot hold a
  field (a zone-based reminder in a system without them, a session-count
  estimate, a floating datetime), the bridge's mapping documents the
  degradation and surfaces it.

## Tool-agnostic conventions

The vault speaks tool-agnostic standards. `AGENTS.md` is the canonical
agent-context filename; anything tool-specific (`CLAUDE.md` and its kin) is
a symlink shim onto the canonical file, managed by tooling. The same
principle applies wherever a tool-specific name duplicates a generic one.
(Symlinks remain banned as _record_ aliases — a record lives in exactly one
place; see chapter 03.)

## Spec-first

This document is the source of truth for the format. Engine behavior,
existing code, and legacy files carry no normative weight: "the engine
already does X" is never an argument. Where implementation detail is
deliberately left open, the spec says so and names the owner (chapter 08).
