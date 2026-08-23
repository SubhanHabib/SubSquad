# Linear issues on the Kanban board

nodeterm can show a Linear team's issues beside live session cards, and moving a card changes the
issue's **workflow state** in Linear. Linear remains the source of truth; issues are never copied
into the shared Kanban assignments.

It sits **beside** the GitHub integration rather than replacing it. A board can host both, and
`src/core/github/*` is untouched by this feature — see [Why it is a sibling, not a
generalisation](#why-it-is-a-sibling-not-a-generalisation).

## Set up

1. Open the project and create its Kanban board if it does not have one.
2. Open Settings → **Linear Issues**.
3. Turn on **Show Linear issues on this board**.
4. Paste a **personal API key** (Linear → Settings → Security & access → Personal API keys).
5. Choose the **team** from the picker.
6. Map each column to one **workflow state**.
7. **Approve** access for this project on this computer.

Team and state mappings are shared in `.nodeterm/project.json`. The API key and the machine
approval are local and are never written to the project file.

## How this differs from the GitHub integration

Most of it is the same machinery — the same 60 s poll, the same refresh floors, the same
per-identity request coordinator, the same private on-disk cache, the same per-project-per-machine
approval. The differences below are the ones that change what a user sees.

| | GitHub | Linear |
| --- | --- | --- |
| A column maps to | one exact issue **label** | one **workflow state** |
| Finishing an issue | close/reopen, a separate axis from labels | the state's own `type` |
| Mapping conflicts | possible (two mapped labels) | impossible (one state per issue) |
| Ungrouped | a legal drop target | **refused** — every issue always has a state |
| Identity | `number`, unique per repo | `id` (UUID); `identifier` (ENG-12) is display only |
| Assignees | many | exactly one |
| Auth | `gh` CLI **or** a token | personal API key only — Linear ships no CLI |
| Subject detection | repository read from the git origin | **none** — a team is chosen by hand |
| Conditional reads | ETags | none; an `updatedAt` watermark instead |
| Avatars | fetched and inlined | **initials only** in v1 |

Two things are genuinely worse and are worth saying plainly: **setup is manual** (there is nothing
in a git checkout that names a Linear team, and no CLI session to borrow), and **there is no
conditional request**, so an unchanged poll still costs a real query. Everything else is neutral or
better.

## Movement, and which moves ask first

The rules live in one pure module, `src/renderer/lib/linearIssueMove.ts`, so the drag handler, the
card's Move selector and the summary modal cannot disagree.

| Move | Asks first? |
| --- | --- |
| Between two ordinary states | No |
| Into a **completed** state | **No** |
| Into a **canceled** state | **Yes** |
| Out of a completed or canceled state | **Yes** |
| Onto Ungrouped | Refused, with the reason |

**Completing is deliberately silent**, and this is the one place the design departs from the GitHub
board on purpose. On GitHub the equivalent move closes the issue and notifies every watcher, so it
confirms. In Linear it is the most common gesture on the board, it is undone by dragging the card
back, and nobody is emailed. A dialog on the happy path is not a safety feature — it is training to
click through dialogs, which is exactly what would blunt the cancel confirmation that does matter.

**Ungrouped is refused rather than confirmed.** A Linear issue is in exactly one workflow state at
all times, so there is no write that means "no state". Ungrouped still *holds* cards — issues whose
state no column maps to, typically triage and backlog — it simply cannot receive one. Both the
renderer and the service refuse it; the service's refusal is the one that matters, since it is the
side a relay guest reaches.

## Mappings are stored by state NAME

`.nodeterm/project.json` is committed and reviewed by humans, and a UUID is unreadable in a diff.
Linear state ids are also not stable across a delete-and-recreate of a state that keeps its name,
while the name survives. Names resolve to ids at runtime against the team's own states, exactly as
GitHub matches label names case-insensitively.

The cost is that a renamed or deleted state leaves a mapping pointing at nothing. That is surfaced,
not swallowed: `LinearControlView.project.unknownStates` lists them and the Settings page names
them. A move into such a column answers `invalid-target` rather than guessing at a nearby state.

**A failed states read is never reported as a stale mapping.** `null` from the states reader means
"we could not look", and reporting it as a broken mapping would put a warning on a healthy board on
every network hiccup.

## Auth, trust and where the key lives

A resolved credential is reused for up to 30 s, for the same measured reason as GitHub's: the
service re-checks its epoch around every read and write, and an uncached resolve spends a `viewer`
query that does **not** pass through the request coordinator — so it is neither rate-limited nor
backed off. Saving a key, clearing it, or revoking the machine drops the memo immediately.

The key field is write only; the renderer cannot read the saved value. Electron uses encrypted
system storage when a secure backend is available and otherwise warns and writes a mode `0600`
file. Server Edition always uses the restricted file.

Approval is per **(machine, project, team)**. Changing the project's team requires approving the
new one — the old approval does not carry over, by design.

## The GraphQL trap this client exists for

**Linear answers a failed request with HTTP 200 and a non-empty `errors[]`.** A `response.ok` check
alone reports every authentication failure, rate limit and validation error as a success whose
`data` is null, and the decoders then call that "malformed response" — hiding a revoked key behind
what looks like a parser bug. `LinearIssuesClient.post` inspects `errors[]` before anything else,
and `client.test.ts` pins it.

Two more, both pinned by tests:

- **The API key is sent raw, with no `Bearer` prefix.** The Bearer form is for OAuth access tokens;
  a prefixed personal key earns an authentication error that reads exactly like a revoked key.
- **Rate-limit reset headers are a ladder, not a name.** Linear's documentation and its responses
  have not agreed on these across versions, so `RATE_LIMIT_RESET_HEADERS` lists candidates in order,
  `resolveRetryAt` sanity-checks every value against a bounded future window (and disambiguates
  seconds from milliseconds by magnitude), and anything that fails those checks falls through to
  plain exponential backoff. A wrong guess is therefore slow, never a pause of the whole identity
  for a day. **This ladder has not been verified against a live 429** — see Device checklist.

## Refresh, cache and paging

One poll per 60 s while a board is visible. Caller-driven refreshes are floored at 1 per 30 s and
full reconciliations at 1 per 2 minutes; a **failed** refresh does not hold the floor, or the first
network blip would disable the board's own Retry button. A full reconciliation is forced every 24 h.

Incremental passes filter on `updatedAt: { gt: <last refresh − 2 s> }`. The 2 s overlap is the same
one the GitHub path uses: `updatedAt` is written by the server, and a filter anchored exactly at our
own start instant would drop an issue whose write landed in that moment.

The cache is private per `(authenticated user, team)` under `<userData>/linear-issues-cache`, capped
at 10,000 issues and 64 MiB. An incomplete refresh never replaces the last complete snapshot, and a
partial first refresh is read only.

**Relay cursors are per-refresh and never persisted**, which is a deliberate departure from the
original plan. A cursor addresses a position inside one server-side result set; resuming a later
refresh from a cursor minted against an earlier one would silently skip or repeat issues. An
interrupted refresh restarts — which is what the GitHub path does too.

## Surfaces

- **Desktop**: full.
- **Server Edition**: full. The service boots from `src/core`, and `buildLinearApi` in the ws-bridge
  is a real implementation, not a stub.
- **Relay tabs**: reads and moves go to the trusted **host** (its credential, its approval, its
  cache); `linearControl` stays **local**, so a guest can never save a key or approve a project on
  someone else's machine. Same split as GitHub.
- **Mobile companion**: **N/A for v1**. The iOS board is a read/move mirror over the transport
  protocol and has no issue-provider concept; surfacing one means extending that protocol. Raise
  with **@eneskirca**.

## Why it is a sibling, not a generalisation

`src/core/linear/` duplicates the *shape* of `src/core/github/` — service, host, cache, control
store, client. That is the deliberate price of keeping `jasonkneen/nodeterm` mergeable: the GitHub
files are upstream's, and rewriting them into a provider-generic base would put this fork's largest
diff through exactly the files it most wants to keep taking patches for.

What is genuinely provider-neutral was **lifted rather than copied**, into `src/core/issues/`: the
request coordinator, the revisioned control store and the snapshot cache. Those are the pieces where
a second copy's bugs would be silent and identical in both. The renderer's meeting point is
`IssueCardView` in `src/shared/issue-provider.ts`, with adapters in `lib/issueAdapters.ts`.

Once both providers have been in production for a while, extracting a shared service base is a
reasonable follow-up. Doing it first would have been the same work plus a large upstream conflict.

## Current scope

Not built, deliberately: creating or editing issues, comments, assignee/label/priority edits from
the board, creating workflow states, sub-issue nesting, webhooks (they need a public endpoint), and
avatar images. "Open in Linear" is the escape hatch for all of it.

## Device checklist

Everything below is unverified against a live Linear workspace — this was built without one. Each
is a numbered item so a single capture run can close several.

1. **Rate-limit headers.** Trip a 429 and record the exact reset header names and units against
   `RATE_LIMIT_RESET_HEADERS`. This is the one place a wrong guess is invisible in tests.
2. **`DateTimeOrDuration`.** Confirm the `updatedAt: { gt: $since }` variable type is accepted as
   declared; if the schema names it differently the incremental pass silently degrades to full.
3. **`issues` ordering.** Confirm `orderBy: updatedAt` paginates stably under `first`/`after`.
4. **Archived issues.** Confirm they are excluded by default, and decide whether a full
   reconciliation should notice an archive as a deletion.
5. **`estimate` type.** Confirm it decodes as a number on a team with estimation enabled.
6. **Cycle naming.** Confirm `cycle.name` is present, and that the `Cycle <number>` fallback fires
   only where it should.
7. **Complexity budget.** Measure what one 60 s poll of a ~1,000-issue team actually costs.
8. **`issueUpdate` confirmation.** Confirm the returned issue carries the new `state.id` (the
   service throws `mutation-not-confirmed` if it does not).
9. **Server Edition + relay.** Run the setup flow in the browser, and a move from a relay guest, to
   prove the bridge implementations are real.
