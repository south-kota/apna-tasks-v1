# JBOM — the Apna Tasks record format

JBOM is a markdown-native record format: a way of keeping tasks, projects,
people, agents, notes, and everything else durable in a life vault as plain
`.md` files on disk. Files are the truth; every index, view, and app surface
is derived from them and rebuildable.

This specification is the authoritative description of the format. It was
authored from scratch in August 2026 from the ratified decision set of the
phase-17 format review (binding record: `Apna Tasks/plan/17-jbom-format-review.md`
in the planning vault). It supersedes every earlier JBOM document; the old
draft spec is sealed and is not an input to, or interpretation aid for, this
one. Where this spec disagrees with existing code, the spec wins — the engine
is rebuilt against it (phase 23).

## Chapters

| #   | Chapter                                            | Covers                                                                                                              |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 01  | [Principles](01-principles.md)                     | What JBOM is, the vault, the invariants every writer obeys, the bridge contract                                     |
| 02  | [Files & identity](02-files-and-identity.md)       | The three-tier file model, frontmatter, the creation stamp, ULIDs, names, filenames, tags                           |
| 03  | [Folders & geography](03-folders-and-geography.md) | Claimed folders, projects as folders, derived membership, the root layout, Calendar/Journal, filesystem constraints |
| 04  | [The type system](04-type-system.md)               | Types, fields, field kinds, the registry, vocabularies, validation, diagnostics — the machinery itself              |
| 05  | [Built-in types](05-built-in-types.md)             | The 17 default types that ship with the system, as a standard library built on chapter 04                           |
| 06  | [Links](06-links.md)                               | Frontmatter refs vs body wikilinks, resolution, renames, the name-history log                                       |
| 07  | [Collections & views](07-collections-and-views.md) | The query vocabulary, subtree scoping, linked views, generated rollups                                              |
| 08  | [Out of scope](08-out-of-scope.md)                 | Deliberately unspecified areas and who owns each                                                                    |

## How to read it

Chapter 01 governs everything else — when in doubt, its principles win.
Chapters 02–04 define the machinery: what a file is, what a folder is, what
a type is. Chapter 05 is deliberately separate from chapter 04: **the type
system is the format; the built-in types are only its first library.** A
vault that declared 17 different types would be exactly as much a JBOM vault
as one using the defaults.

A reader implementing the engine needs all eight chapters. A reader writing
files in the vault needs 01–03 and 05–06. A reader building a bridge needs
01 (the bridge contract), 04 (vocabularies), and 05 (per-type semantics and
lossy edges).
