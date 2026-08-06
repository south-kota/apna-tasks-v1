# 05 — Built-in types

The 17 types that ship with the system. They are a **standard library built
on chapter 04's machinery** — predeclared, but in no other way privileged.
Everything here (vocabularies, defaults, structured fields) uses mechanisms
chapter 04 defines generically; registry-declared custom types are full
peers.

All 17 carry the common six fields (chapter 02). Fields listed per type are
_additions_. Every field is optional unless marked as the type's identity.

The roster:

| Group         | Types                                     |
| ------------- | ----------------------------------------- |
| Work          | `task`, `project`                         |
| Entities      | `person`, `agent`                         |
| Agent records | `session`, `skill`, `memory`              |
| Content       | `note`, `resource`, `decision`, `meeting` |
| Time          | `journal`, `day`, `week`, `month`, `year` |
| Views         | `collection`                              |

---

## `task`

A unit of work. **A task is a file — that is the only way a task exists.**
Checkbox lines are never tasks (chapter 01). The simplest valid task is
just the creation stamp and a name; the simplest _useful_ one might add
only a `remind:` — a standalone reminder **is** a minimal task, not a
separate type.

### Status & lifecycle

- `status` — select, extensible (chapter 04 token→category machinery).
  Seven canonical categories:
  - open: `todo` (not started) → `doing`; `waiting`, `blocked` (side
    states); `review` (work routed back to the owner — the state that
    matters in a delegate-to-agents workflow)
  - closed: `done`, `canceled`
  - **Optional; absent ⇒ `todo`** (a default rule). A task is complete iff
    it explicitly says `done`/`canceled`.
  - Semantics to hold: `waiting` = paused on an external actor or event;
    `blocked` = cannot proceed on a precondition (typically a dependency).
  - Deliberately not statuses: someday/backlog (a collection/filter fact),
    archived (a storage fact — chapter 03).
- `waiting_on` — structured list (chapter 04's worked example): typed
  cause `kind: human | agent | task | time | external` + optional
  `ref`/`note`/`since`/`until`. Serves both `waiting` and `blocked`; the
  typing is what makes stuck work routable (`kind: task` can auto-unblock
  when the blocker closes; `kind: human` is a review-my-inbox query;
  `kind: time` is a snooze). Optional — but writers setting
  `waiting`/`blocked` always write it, by convention.
- `closed` — date, stamped by **the writer performing the close** when the
  task enters `done` _or_ `canceled` (never the watcher). Optional;
  removed on reopen; present on an open task = warning. There is **no
  close-reason field** — reasons live in the body when worth recording.
  Who closed it is `session` territory, not a task field.

### Time

- `scheduled` — date-or-datetime. The day the owner intends to work on it;
  drives day views; slipping it is free and means nothing externally.
- `deadline` — date-or-datetime. The externally real due date; missing it
  has consequences. Most tasks won't carry one. The schedule/deadline
  split is load-bearing: a slipped plan must never read as "overdue."
- `estimate` — duration (`30m`, `2h`, `1h30m`) **or** an agent-session
  count (`1 session`, `3 sessions`). Two distinct kinds, never mixed in
  one value, never converted; what a session is worth in time is
  deliberately undefined (chapter 08).
- There is **no `start` field** — ranged work is `scheduled` + `estimate`;
  a field without distinct semantics from its neighbor is manufactured
  confusion. Add only if a real ranged-work need appears.
- `repeat` — recurrence, in JBOM's own human vocabulary (`every monday`,
  `every 2 weeks`) with the **full RRULE feature space as the
  expressiveness target**: where natural vocabulary runs out, a raw
  RRULE-grade form is legal in the same field (`RRULE:FREQ=MONTHLY;BYDAY=-1FR`).
  Tricky-to-write is acceptable; inexpressible is not.
  - Fixed-cadence vs completion-relative are **distinct rule kinds** with
    distinct syntax: `every monday` vs `every 2 weeks after done`.
  - The engine normalizes into the **index only** — the file is never
    rewritten. RRULE is the bridge-boundary interchange form. Unparseable
    = tier-2 error.
  - **Materialization: one file, rolling forward.** Completing an
    occurrence means the closing writer advances `scheduled` to the next
    occurrence and the task stays open. `done` = the series is finished;
    `canceled` = the series is abandoned; `closed:` appears only then.
    Per-occurrence history is `session` records — never
    a-file-per-occurrence.
- `remind` — list of triggers, three kinds:
  - absolute: `2026-08-09 09:00` (floating datetime)
  - relative-to-anchor: `10m before deadline`, `2h before scheduled` — the
    anchor is always named, since there are two time fields
  - zone-based: `arriving <place>`, `leaving <place>` — places are
    registry-declared tokens (chapter 04); place→coordinates/radius is
    device-side config. A declared place is a join point: one zone event
    can fire many reminders.
  - Firing machinery is deferred with an owner (chapter 08) — the schema
    carries the triggers.
- `snoozed_until` — floating datetime. **Snooze is schema state**: the
  surface where the human snoozes writes it, and it syncs — snoozing on
  the phone silences the Mac. Snooze menus and re-nag cadence are UI and
  firing behavior.

### Routing & structure

- `assignee` — `ref(person | agent)`, **zero or one, never a list**. The
  single accountable owner; absent = not yet routed. Multi-person work is
  decomposition into subtasks. Deliberately not fields: creator
  (provenance = echo ledger + sessions), completer (sessions), watchers,
  reviewer (the reviewer is definitionally the owner; `status: review` +
  session outcomes cover it).
- `priority` — select `low | normal | high | urgent`; absent ⇒ `normal`.
  Foreign priorities map to nearest; raw values stay bridge-side.
- `depends_on` — `list(ref(task))`. **The only stored graph edge.**
  `blocks` is the derived inverse, never written. `waiting_on` is the
  cause of the _current status_; `depends_on` is the _standing graph_ —
  neither derives from the other, and a task with unmet dependencies can
  still be `todo`.
- `duplicate_of`, `superseded_by` — `ref(task)`: the typed close-edges.
- **Subtasks are nested task files** (chapter 03): a task with children
  becomes a `type: task`-claimed folder, unbounded depth. No `parent:`
  field — parentage is derived from nesting. Project membership likewise —
  no `project:` field.
- **Acceptance criteria are a body convention**: an `## Acceptance`
  section with evidence as ordinary links. Never frontmatter.

### Decided absences

No `kind`/subtype field (custom statuses, tags, and templates are the
upgrade paths). No rank/`sequence` field — ordering is derived sorts in
smart views plus body order in manual collections; a task does not know it
is third in "This week." No pinned/flagged field — pinning is a view fact
(a manual "Pinned" collection). No `resolution`, no `references` (body
links are already indexed), no `start`.

---

## `project`

A container of work — and **a project is a folder** (chapter 03), claimed
by its same-named `type: project` summary file. Everything inside belongs
to it.

- `status` — select, extensible: `idea | active | paused | done |
canceled`. `archived` is deliberately not a status — archiving is moving
  the folder to an `archive/` (a storage filter).
- Body: the project overview — typically a generated rollup of its tasks
  (chapter 07).
- Projects nest arbitrarily; hybrid resource-homes (`People/`, media
  libraries) are ordinary projects. There are **no phases and no lists**
  between project and task (chapter 03).

---

## `person`

A human. **The frontmatter is the contact card** — deliberately mirroring
the vCard/CSV column space so a person file is importable/exportable as a
contact:

- `aliases` — list of alternate names/nicknames, with **system
  significance**: body wikilink resolution accepts aliases, so `[[Mom]]`
  resolves (chapter 06).
- `emails`, `phones`, `addresses`, `links` — lists; entries are plain
  strings or single-pair labeled maps (`- work: kota@example.com`) so
  vCard/Apple labels round-trip losslessly.
- `birthday` — date. `timezone`, `location`, `org`, `role` — text.

Everything else about a person is **backlinks territory**: meetings,
sessions, and tasks referencing them accrue as backlinks and smart
collections. Relationships are tags. Deliberately absent: avatars (an
asset question, not yet taken), `last_contacted`/cadence fields
(interaction history lives in journals and backlinks).

The vault owner is an ordinary person record — no special "me" token; one
identity mechanism for every human. `assignee` and `waiting_on kind:
human` refs point at person records.

Contact bridges (Apple Contacts, Google Contacts, CSV) are the designed
mapping targets for this field set.

---

## `agent`

An executor identity — persistent or one-time. A definition record, not a
unit of work.

- `status` — select: `active | retired` (lifecycle of the definition).
- Execution config: `provider` (select — matching available drivers),
  `model` (text), `effort` (select: `low | medium | high | xhigh | max`),
  `tools` / `disallowed_tools` (lists; omitted = provider default),
  `permission_mode` (select, provider-native modes), `max_turns` (number),
  `token_budget` (number), `isolation` (select: `none | worktree |
container`), `skills` (`list(ref(skill))`).
- **Body = the system prompt / operating instructions.**
- `description` (common field) = **the dispatch interface**: when to use
  this agent.

**One-time agents are full agent records** — minted at dispatch (ULID,
creation stamp), used, `retired`. One reading path: every run points at an
agent record, so "which config produced this" is always answerable the
same way. Ephemeral agents are expected to be the majority; hygiene is a
folder/archive concern, not schema.

Predefined agents double as **capability classes**: routing a task to an
agent = `assignee` → its record. Memories attach by locality and links,
not by a field. Triggers/schedules are deferred with an owner
(chapter 08).

---

## `session`

**Any recorded interaction with agents** — human↔agent or agent↔agent: a
dispatch, a conversation, a run. The execution record and the system's
append-only attempt history. Every dispatch creates one; **a retry is a
new session, never a reopened one**.

- `started_at` — instant. **The sole required field** (identity).
- `agent` — `ref(agent)`: the executor. `participants` —
  `list(ref(person | agent))` and `initiated_by` — `ref(person | agent)`
  cover the broadened shape a bare `agent:` can't.
- `task` — `ref(task)`, optional (exploratory sessions have none).
- `ended_at` — instant, set at terminal status.
- `status` — select: `queued | running | needs-input | done | failed |
canceled`. **A deliberately different vocabulary from task status** —
  execution vs planning. `needs-input` is first-class and always sorts
  first in views.
- `outcome` — select: `success | partial | failure`. **Separate from
  `status`** because infra exit ≠ task success: `status: done, outcome:
failure` is a valid, important state (the run finished cleanly and
  reports the approach didn't work).
- `waiting_on` — the same structured field tasks use, unchanged. When
  `needs-input`, the `note` carries **the literal question**; when waiting
  on a specific execution, `ref` points at that _session_.
- `spawned_by` — `ref(session)`: the orchestrating run. Children point up;
  the orchestration tree downward is always derived (backlinks), never
  hand-maintained.
- `provider_session` (text — resume handle), `branch` (text), `commits`
  (list) — **heavy content is referenced, never inlined**: the raw
  transcript lives with the provider, diffs live in git; the body holds
  the human-readable record. Keeps files readable and sync quiet.
- `last_active` — instant; heartbeat stamped by the harness, not the
  agent.
- `tokens_used` — number.
- `description` (common field) = the one-line live summary of what it's
  doing / needs / produced.

Body sections, by convention:
`## Brief`, `## Report`, `## Needs`, `## Evidence`, `## Log`.

### Protocol invariants (spec-level)

The industry's hardest-won lesson is agents not updating state; these are
ratified as format invariants (enforcement mechanics are engine work):

1. A session reaching `done`/`failed` **must** carry `outcome`,
   `ended_at`, and a non-empty `## Report`.
2. `status: needs-input` **must** carry a `waiting_on` entry whose note
   states the question.
3. A `running` session whose `last_active` exceeds a TTL is flagged stale.
4. **A terminal session never reopens** — retry = new session.

Task-side integration: a delegated task reads `status: waiting` +
`waiting_on {kind: agent, ref: <session>}`; the session carries execution
truth. Atomic claiming of tasks (setting `assignee` + `status: doing` via
a claim primitive) is engine work.

---

## `skill`

A packaged capability an agent can load. Deliberately minimal:

- `allowed_tools` (list), `compatibility` (text) — both optional.
- **Body = the instructions.**
- `description` = what it does **and when to use it** — the dispatch/recall
  interface.

---

## `memory`

An agent-facing remembered fact. The type exists and its **locality is
settled** (root `Memory/` general tier + project-local, chapter 03;
agent-specific — nothing to do with person records). A memory is valid
with just the common fields.

**The field set beyond the common six is deliberately unspecified** —
owned by the orchestration-layer conversation (chapter 08), where real
agent usage patterns exist to design against.

---

## `note`

Authored prose that isn't any of the more specific things. Common fields
only — **a note has no `status`** (a note has no lifecycle; status-like
needs are tags or a custom type) and no other additions.

---

## `resource`

**External material not authored by the owner or an agent** — the
distinction is **provenance, not shape**. A link, book, webpage, paper.

- `format` — select, extensible (plain-vocabulary variant): built-in
  starter vocabulary `book | article | webpage | video | paper | podcast`,
  registry-extensible; undeclared values are tier-2 errors.
- **Deliberately no rules about body structure.**

---

## `decision`

A recorded decision.

- `status` — select: `open | decided | replaced | dropped`.

---

## `meeting`

A meeting record. Ships in the roster; **its field set beyond the common
six is not yet ratified** — it awaits real usage (registry extension or a
spec amendment when the calendar workflows firm up). Meetings appear in
day/week views via collections over whatever fields usage settles.

---

## `journal`

**An entry written at a moment** — a thought, a transcription. Not a
calendar container.

- `timestamp` — instant. **Required (identity).**
- Multiple entries per day are expected and legal.
- Home: flat `Journal/` folders; filename
  `YYYY-MM-DD-HHMM-<slug>.md` (chapter 03). Body = the content itself.

---

## `day`, `week`, `month`, `year`

**Calendar containers** — notes attached to a span of time, the way a
calendar lets you annotate a week without that being a journal. Identity
fields:

| Type    | Identity field | Form         |
| ------- | -------------- | ------------ |
| `day`   | `date`         | `YYYY-MM-DD` |
| `week`  | `week`         | `YYYY-Www`   |
| `month` | `month`        | `YYYY-MM`    |
| `year`  | `year`         | `YYYY`       |

Month and year records **claim their Calendar folders** (chapter 03); day
and week files live inside their month. Bodies are **generated rollups**
(linked views — chapter 07): meetings, scheduled tasks, deadlines,
agendas. The records they show stay in their projects.

A container is not a journal: `journal` records a moment; these hold a
span. A day file carries both `created` and `date` — different facts.

---

## `collection`

A view: a saved query or a curated list. Fully specified in chapter 07;
the schema surface:

- `mode` — select: `smart | manual`.
- `query` — structured (chapter 07 vocabulary); meaningful when `smart`.
  **Queries live only here** — never in any body.
- `generated` — generation stamp, written by the generator (its own field;
  never `updated`).
- **Membership always lives in the body** as ordinary links — one reading
  path for app, bridges, and agents. There is no `items:` field.
- `smart → manual` **freezes** the current list and makes it editable —
  the curation path.
- A collection never owns member state; deleting one loses no data.
