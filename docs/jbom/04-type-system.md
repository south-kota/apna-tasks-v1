# 04 — The type system

This chapter is the machinery: what a type is, what fields are, how values
are validated, how vocabulary grows, and what the diagnostics are. It is
written as if no built-in types existed — chapter 05's defaults are one
library built on this machinery, and a vault declaring entirely different
types is equally valid. **The system described here outranks any particular
type roster.**

## Types and records

A **type** is a named schema: it declares which fields a record of that
type carries, each field's kind, which (if any) are required, and any
closed vocabularies. A **record** is a markdown file whose frontmatter
declares `type: <name>` (tier 1, chapter 02). The type name is the sole
opt-in to validation; nothing else makes a file a record.

Field requirements are deliberately minimal by philosophy: most fields on
most types are optional, and a type should only _require_ a field that is
its **identity** — the fact without which the record is meaningless (a
calendar day without a date, an entry without a timestamp). Everything else
earns optionality plus, where useful, a **default rule**.

### Defaults are rules, not hardcoded semantics

A closed-vocabulary field may declare a default that applies when the field
is absent (e.g. a lifecycle field defaulting to its initial value). The
default is a _declared rule_ — revisitable, and potentially overridable
per-type or per-template later — not a constant baked into readers.
Absence therefore always has a defined meaning, and a freshly created
record is valid with nothing but the creation stamp and a name.

## Field kinds

Every field has a **kind** — the value grammar the engine validates and
indexes. Kinds are generic machinery; no field may hold a closed vocabulary
without a kind backing it (a select without a declared vocabulary would
accept any string, which is the invisible-drift failure this system
exists to prevent).

| Kind               | Value grammar                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `text`             | free string                                                                              |
| `select`           | exactly one token from a closed vocabulary                                               |
| `multiselect`      | list of tokens from a closed vocabulary                                                  |
| `number`           | numeric                                                                                  |
| `url`              | URL string                                                                               |
| `date`             | `YYYY-MM-DD`                                                                             |
| `datetime`         | floating local `YYYY-MM-DD HH:MM` (no zone)                                              |
| `instant`          | zoned ISO-8601 datetime — for facts that are real moments in world time                  |
| `date-or-datetime` | either of the two written forms; **date-only _is_ the all-day representation** (no flag) |
| `duration`         | compact human duration: `30m`, `2h`, `1h30m` — normalized to minutes in the index        |
| `period`           | span identity forms: `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`, `YYYY`                         |
| `ref(<type>)`      | a reference to a record of the given type — canonically a ULID; see chapter 06           |
| `list(<kind>)`     | ordered list of the inner kind                                                           |
| structured         | a field-specific map/list shape declared by the type (validated per its declaration)     |

Two rules govern all time-valued kinds:

- **Kinds are never coerced.** The index stores the value _plus its kind_;
  a date stays a date in views, queries, and bridges. Date→midnight
  coercion is the classic corruption and is banned.
- **Zoned instants are reserved for facts that are real world-moments**
  (e.g. a log timestamp). Planning-time fields use floating forms; bridges
  that need a zone apply the device zone at the boundary as a documented
  lossy edge.

## The registry

The **registry** is the vault-level declaration surface — where everything
grows beyond the defaults:

- **custom types** (full validation, equal to built-ins),
- **custom vocabulary tokens** for extensible selects (below),
- **named places** for location triggers,
- **per-type default homes** (which folder a new record of a type is
  created in — pointing into chapter 03's geography),
- **default rules** for fields that declare them.

Its storage form is an engine decision (phase 23). The v1 direction is a
config file at the vault root; the ratified end-state direction the shape
must stay forward-compatible with:

- **schema-as-records** — type definitions may eventually live as records
  in the vault itself, self-describing and syncable;
- **a shared field pool** — a field (name + kind + vocabulary) is declared
  once and _referenced_ by types, so the same field on two types is the
  same field, not a name coincidence;
- **typed refs** — `ref(<type>)` declared per field.

A vault with no registry configuration at all is fully functional on
defaults.

## Extensible vocabularies: token → canonical category

Some select vocabularies are **closed but extensible**. The mechanism is
uniform wherever it appears:

- The built-in vocabulary defines **canonical categories** — always legal,
  zero configuration.
- The registry may declare **custom display tokens**, each mapping to
  **exactly one** canonical category.
- The file holds **one token** (canonical or declared). The index stores
  both the token and its resolved category; queries can target either.
- An undeclared token is a **tier-2 error** (below) with a near-miss
  suggestion.
- **Bridges never mint vocabulary**: a foreign value maps to the nearest
  canonical category on import; the foreign label stays bridge-side
  (chapter 01, the bridge contract).

The same declare-or-error pattern serves plain extensible vocabularies
without categories (e.g. a format/genre list) and named places.

## Two-tier handling of the unrecognized

Unrecognized input falls into two populations that deserve different
scrutiny:

- **Tier 1 — silently auto-resolved:** safe mechanical variance — case
  (`Task` → `task`), plurals (`tasks` → `task`), known aliases. Silent in
  normal operation but **reportable on demand**, so normalization drift
  never becomes fully invisible.
- **Tier 2 — an error that teaches:** a token that resolves to nothing. The
  diagnostic lists the valid options _and_ a near-miss suggestion
  (`type: meting — unknown type; did you mean 'meeting'? valid types:
...`). Applies to unknown types and to unknown tokens in closed
  vocabularies.

What tier 2 exists to abolish is the **invisible category**: a typo'd type
or status silently creating a class of records no view ever shows.

Unknown _fields_, by contrast, are never diagnostics — always preserved,
always indexed as generic fields (chapter 02). The asymmetry is deliberate:
an unknown field is expressiveness; an unknown token in a closed vocabulary
is drift.

## Validation

Validation has three outcomes per file:

1. **Untyped** — no `type:`; tier 2 of the file model. Content-indexed,
   never validated, never a diagnostic.
2. **Valid record** — typed, all declared constraints met.
3. **Invalid record** — typed, with error diagnostics. Still fully indexed
   and queryable, with readable diagnostics attached. **The file is never
   modified, dropped, or demoted by validation** — reporting and repairing
   are separate acts by separate actors (chapter 01).

### Diagnostics catalog

**Errors** (record marked invalid, still indexed):

- unparseable YAML frontmatter
- wrong field shape for its kind (e.g. a list where a scalar is required)
- unknown type (tier 2)
- undeclared token in a closed vocabulary (tier 2)
- missing identity field required by the type
- duplicate `id` — flagged on **every** file sharing the id; no winner

**Warnings** (record stays valid):

- unresolved or ambiguous body wikilink (chapter 06)
- state-drift cases a type declares (e.g. a close-stamp present on an
  open record — chapter 05 examples)
- a run/record violating a declared protocol invariant (chapter 05,
  `session`)

**Deliberately silent — these are not problems:**

- missing `id` or `name` (unstamped files are a legal steady state)
- missing `type:` (tier-2 files are first-class)
- missing any optional field, `description` included
- unknown frontmatter fields
- a record living outside its type's default home (homes are never
  enforced)
- checkbox lines in any state (content, chapter 01)

## Derived relations

Some relations are **derived by the engine at index time and never
stored**: membership (`project`), parentage (`parent`) — both from folder
nesting (chapter 03) — and every **inverse edge** (e.g. the inverse of a
stored dependency, or a parent's list of children). One stored direction
means contradictory pairs cannot exist; the derived side is recomputed,
never written. This is the rollups-are-generated principle applied to
edges.

## Structured fields

A type may declare structured fields — list-of-maps shapes with their own
inner vocabulary (kinds inside the map are validated like any field). The
canonical example is the shared cause field used by chapter 05's work
types:

```yaml
waiting_on:
  - kind: human # select: human | agent | task | time | external
    ref: 01KY… # optional ref — the cause's identity
    note: "which option?" # optional free text; carries the literal question
    since: 2026-08-05 # optional date
    until: 2026-08-20 # optional — for kind: time, the auto-resurface hook
```

Structured fields are queryable by dot-path (`waiting_on.kind` —
chapter 07).

## Custom types are peers

A registry-declared type gets everything a built-in gets: full validation,
kinds, vocabularies, diagnostics, claimed folders, collections, links. The
built-ins' only privilege is being predeclared. Chapter 05 should be read
in exactly that light.
