# 07 — Collections & views

A collection is a view over records: **smart** (a saved query the system
materializes) or **manual** (a curated list). Collections are the _only_
grouping mechanism besides folders — lists, boards, pinned sets,
someday/backlog piles, agent inboxes are all collections. They never own
member state; deleting one loses no data.

## The record

```yaml
---
type: collection
id: 01KY…
name: Pending tasks
mode: smart # smart | manual
query: # smart only — queries live ONLY here, never in bodies
  type: task
  where:
    status: [todo, doing]
  sort: [-priority, scheduled]
generated: 2026-08-05 16:40 # written by the generator; its own field, never `updated`
---
<!-- jbom:generated -->
- [[write-spec-chapter-4]]
- [[review-bridge-contract]]
<!-- /jbom:generated -->

Anything outside the marker is ordinary content and is always preserved.
```

- **Membership always lives in the body** as ordinary links — manual
  membership is the links the owner wrote, smart membership is the links
  the generator wrote. One reading path for app, bridges, and agents; the
  app only renders markdown.
- A **script** — never the app, never the watcher — resolves a smart
  collection's query and rewrites the marked region, stamping `generated`.
  It writes **only when content changed**. When each generator runs is the
  script-runtime conversation's question (chapter 08).
- **`smart → manual` freezes the current list** and makes it editable —
  the ratified curation path. Links in a frozen list keep their
  freeze-time form (chapter 06).
- **Ordering:** a manual collection's body _is_ its order — per-container,
  no rank fields anywhere. A smart collection orders by its `sort` keys.

## The query vocabulary

Structured YAML in the collection's frontmatter:

```yaml
query:
  type: task # one type or a list
  where:
    status: [todo, doing] # value list = OR within the field
    priority: urgent # scalar = equals
    deadline: { before: this-week } # date predicates
    waiting_on.kind: human # dot-paths reach into structured fields
    tags: { any: [health, family] } # tags: any / all / none
    closed: { exists: false } # existence
    assignee: { not: 01KY… } # negation
  under: notes/ # optional — NARROWS within scope only
  sort: [-priority, scheduled] # multi-key; `-` = descending
  limit: 20
```

- **Fields AND together; a value list ORs within its field.**
- Predicates: scalar equality, value lists, `{exists:}`, `{not:}`, and
  date operators `{before:}`, `{after:}`, `{on:}`, `{on_or_before:}`,
  `{within:}`.
- **Relative date tokens** (`today`, `this-week`, …) are legal in date
  predicates and re-resolve at each generation.
- `status:` filters accept **category tokens** — they match custom display
  statuses through their canonical category (chapter 04).
- Deliberately excluded from v1 (add only on real need): cross-field OR,
  full-text search, aggregation.

## Scope: location is the filter

**A collection's query sees only its enclosing folder's subtree.** Scope is
implicit and positional — the folder model's "location = membership"
extended to views:

- A collection inside a project needs zero project filter; recursion into
  nested folders is the default by construction.
- A collection in root `Collections/` sees the whole vault — that is what
  makes a view global.
- `under:` exists only to **narrow** within scope.
- **Cross-scope querying is forbidden.** There is no escape hatch; a wide
  view is built by _placing the collection high_ and embedding it where
  needed (below).

## Linked views: define once, embed anywhere

A block in **any** record's body can embed an existing collection:

```markdown
<!-- jbom:view [[todays-meetings]] -->

- [[standup-2026-08-05]]
- [[design-review]]
<!-- /jbom:view -->
```

- The generator writes the referenced collection's current member list
  into the block. **Queries never appear in bodies** — the view marker
  carries a ref, not a query.
- **Definition placement chooses scope; embed placement chooses display.**
  Embeds may reference collections anywhere in the vault — required,
  since a day file in `Calendar/` must embed root-scoped collections to
  show records living in project folders.
- **Context-relative resolution:** when a collection using relative date
  tokens is embedded in a time record (`day`/`week`/`month`/`year`), the
  tokens resolve against the **host record's own date**, not wall-clock —
  one reusable `todays-meetings` renders correctly in every historical day
  file. In the collection's own body, tokens resolve at generation time.

## Rollups are generated — everywhere

The marker mechanism generalizes: project overview bodies, calendar
day/week/month/year bodies, an agent record's run history — every derived
list in any body is generator-written inside a marker, write-only-if-
changed, never hand-maintained. Content outside markers is always
preserved.

## Standard views

The agent-visibility views ship as ordinary smart collections, no special
machinery:

- **Inbox** — sessions with `status: needs-input` first (with the literal
  question and wait time), then tasks in `status: review`, then
  `waiting_on kind: human`.
- **Agent board** — running (descriptions + `last_active`), queued,
  recently done with outcomes.
- **Orchestration view** — sessions grouped by their `spawned_by` tree
  (derived, chapter 05).

`Collections/` is the conventional home at any level; root `Collections/`
holds the global views (chapter 03).
