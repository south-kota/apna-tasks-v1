# 06 — Links

The canonical link form is **split by surface**: machine surfaces carry
identity, human surfaces carry names.

## Frontmatter refs are ULIDs

Every `ref(<type>)` field — `depends_on`, `duplicate_of`, `superseded_by`,
`assignee`, `waiting_on.ref`, `spawned_by`, `participants`, `skills`, … —
canonically holds the target's **ULID**:

```yaml
assignee: 01KY6NYS7221H6A8YR3JG6XMP0
depends_on:
  - 01KYA1B2C3D4E5F6G7H8J9K0M1
```

- System writers (app, agents, bridges, scripts) **always write ids**.
- A hand-typed name in a ref field is **legal degraded input**: resolved at
  index time when it uniquely names a record (same spirit as unstamped
  files — the open vault never punishes hand-authoring). Ambiguity leaves
  it unresolved, with a diagnostic.
- Refs are typed via the registry's `ref(<type>)` kind (chapter 04).
- **Frontmatter refs are indexed as fields/relations, never as links** —
  link/backlink indexing is a body concept.

## Body links are name wikilinks

In markdown bodies, the convention is `[[name]]` / `[[name|display]]`.
Resolution order for `[[x]]`:

1. a record whose `name:` is `x`
2. a `person` whose `aliases` include `x` (so `[[Mom]]` resolves)
3. a summary-file / basename match

- **Path-qualified wikilinks** (`[[projects/apna/research]]`) are the
  disambiguation form — the folder model multiplies basename collisions
  (every project's `research/` mints another `research.md`), so
  qualification must always be available.
- `#heading` suffixes are stripped for resolution.
- **Plain markdown path links are legal but discouraged** for records —
  they are just markdown, but the folder model makes paths simultaneously
  meaningful and volatile (every membership edit is a move), so path links
  rot at exactly the rate the system encourages moves. The one place path
  links are the _correct_ form: linking into **foreign subtrees**
  (chapter 02), which have no records to name-link to.
- Links inside checkbox lines are ordinary links (checkboxes are content).
- Body links and backlinks are indexed from bodies only; tags likewise
  (chapter 02).

## Diagnostics: unresolved and ambiguous links warn

An unresolved or ambiguous body wikilink emits a **warning** — never a
silent no-op. When the name-history log (below) knows more, the warning
says so: _"`[[research-notes]]` unresolved — renamed to `field-notes` on
2026-08-01"_ — the fix arrives in the reader's hand.

## Renames

Rename rot is handled by **diagnostics plus app-side refactor**, never by
the watcher:

- **App renames refactor referring links vault-wide.** The app is a legal
  foreground writer — the refactor is echo-ledgered and
  write-only-if-changed. External renames (Finder, vim) are accepted rot:
  surfaced by diagnostics, repaired only by explicit app/agent action.
- **The engine detects renames by id continuity**: same ULID, changed
  `name`/filename at re-index. Each detection appends
  `(id, old name, new name, timestamp, how observed)` to the
  **name-history log**, which the unresolved-link warning consults.
- Two honest limits, recorded: the name-history log is **observational,
  not rebuildable from markdown** — it is the named carve-out from
  `.jbom/`'s rebuildable characterization (its home and retention are
  engine decisions, phase 23). And **unstamped files get best-effort
  detection only** — with no id, a rename is indistinguishable from
  delete + create.
- The echo ledger additionally attributes app renames vs external ones.

## Generated bodies self-heal

Links inside generated regions (smart-collection member lists, rollups)
are rewritten on every regeneration, so they never rot. A **frozen manual
collection keeps its freeze-time links** — accepted staleness, surfaced by
the same warnings as any other body.
