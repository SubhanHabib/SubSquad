# Fork decision log

SubSquad is a fork of [nodeterm](https://nodeterm.dev). This file is the running record of **what
this fork decided, per branch, and why** — the reasoning that does not survive in a diff.

**Audience: humans and coding agents equally.** `CLAUDE.md` holds the invariants of the *codebase*;
this file holds the decisions of *our work on it*. A decision recorded only in a commit message is
one squash away from being invisible, and one refactor away from being silently undone by someone
who never saw it.

## How to use it

- **Before starting a branch**: skim the entries below for anything touching your area, and the
  **Watch list** at the bottom for known live risks.
- **Before undoing something that looks redundant** (a shim, an odd flag, a field left deliberately
  unchanged): search this file for it. If it is here, the "what breaks" line tells you the cost.
- **When you make a decision**: append to your branch's entry in the same change. Not later.

## What earns an entry

Not every commit. A decision belongs here when it is one of:

- a choice between real alternatives where the loser was defensible;
- something that will look like a mistake or dead weight to a future reader;
- a deliberate divergence from upstream nodeterm (these are the expensive ones — they must be
  re-decided at every merge);
- a constraint discovered by measurement, so nobody has to measure it twice.

Format each as **Decision → Why → Rejected → What breaks if undone**. Say plainly which facts were
*measured* and which are *assumed* — an assumption labelled as one is useful; an assumption dressed
as a fact costs someone an afternoon.

---

## `claude/nodeterm-subsquad-fork-026vb6`

Base `b5031b20` (upstream main, 2026-08-20) · opened 2026-08-23 · **in progress**

Theme: make the kanban board's issue layer provider-neutral so a second tracker (Linear) can be
added without duplicating the board, plus the local macOS packaging needed to actually run the fork.

### 1. Provider-neutral issue cards, adapted in the RENDERER — `f7b7a7d2`

**Decision.** One shape the board renders (`IssueCardView`, `src/shared/issue-provider.ts`), with
providers adapted into it in `src/renderer/lib/issueAdapters.ts`. `GitHubIssueCard` /
`GitHubIssueSummaryModal` become `IssueCard` / `IssueSummaryModal`; `KanbanColumn`'s nine `github*`
props collapse to five neutral ones keyed by the card's own `key` rather than a GitHub issue number;
CSS `github-issue-*` → `issue-*`.

**Why.** Every card type, prop and class on the board said "github", so a second tracker could only
arrive by duplicating the column, the card and the modal. Adapting in the renderer rather than core
is the load-bearing half: `src/core/github/*` and `src/shared/github-issues.ts` stay untouched, so
the GitHub service keeps emitting exactly what it always emitted.

**Two sub-decisions worth their own lines.**
- `readOnly` moved onto the **card**. Board-wide, a half-configured second provider would have
  frozen the first one's cards.
- `KanbanSourceFilter` renders one button per **configured** provider, so a project is never offered
  a filter that could only empty its board.

**What breaks if undone.** Re-widening `readOnly` to the board reintroduces the freeze above.
Pushing the adapters down into core makes the GitHub service's output a shared contract, which is
exactly the coupling this commit spent its effort removing.

### 2. Issue cache/store machinery lifted to `src/core/issues` — `d7ba1f39`

**Decision.** The provider-*neutral* machinery moves; the provider-*shaped* parts stay.
`request-coordinator.ts` moves wholesale (it was never GitHub-specific — already keyed by `userId`,
the scope both providers meter budgets in), with the GitHub path left as a re-export shim under the
historical names. `RevisionedJsonStore` takes control-store's revision check, its FIFO queue and its
atomic publish; `IssueSnapshotCache` takes cache.ts's one-handle read, unique-temp publish and
legacy binding migration. `GitHubControlStore` / `GitHubIssueCache` keep their verbs, validators and
**on-disk field names**. `GitHubControlError` / `GitHubCacheError` become aliases *of* the shared
classes rather than siblings.

**Why.** Linear needs the same request discipline, revision-checked control document and private
snapshot cache. Two hand-maintained copies drift, and their bugs would be silent and identical in
both — this is CLAUDE.md's own "a duplicated rule drifts; the fix is ONE definition in `src/core`".

**What breaks if undone.** The on-disk field names and document shape are not cosmetic — those files
already exist on users' disks. The error classes are aliases, not siblings, specifically so existing
`instanceof` call sites keep working. The gate for a lift of this kind: `cache.test.ts` and
`control-store.test.ts` pass **completely untouched**. If a future lift needs those tests edited, it
is not a lift.

### 3. Local macOS build, installed side by side with upstream — 2026-08-23, *uncommitted*

Only `package.json` changed (plus this log and its pointer in `CLAUDE.md`): `build.appId` → `com.subsquad.app`, `build.productName` → `SubSquad`,
plus a `dist:subsquad` script.

**3a. Distinct bundle identity, shared data identity.** `productName`/`appId` were changed but
`name: node-terminal` was deliberately **left alone**.

- *Why.* Electron keys the user-data dir (`~/Library/Application Support/node-terminal`) and the
  `safeStorage` keychain service off `name`, while the Dock/Finder/LaunchServices identity comes from
  `productName`/`appId`. Splitting them gives a separately-launchable app that reads the same
  projects, settings, sessions and secrets — with no code change and no `--user-data-dir` wrapper.
- *Measured, not assumed*: the packaged `app.asar/package.json` carries `name: node-terminal` and no
  `productName`, and the running upstream app's `--user-data-dir` is `.../node-terminal`.
- *What breaks if undone.* Renaming `name` silently moves the fork to an empty data dir **and** a
  different keychain service, so sealed blobs in the shared dir (`node-auth-key.json`) become
  undecryptable by one of the two apps.

**3b. Side by side, not a replacement.** `/Applications/SubSquad.app` alongside
`/Applications/nodeterm.app`, which is untouched.

- *Why.* Keeps upstream available for testing new features against the same canvases. Requested
  explicitly over the in-place swap.
- *Consequence, by design*: the two **cannot run at once**. `src/main/index.ts:644` takes
  `app.requestSingleInstanceLock()`, keyed on the shared data dir, so the second launch quits and
  focuses the first. The lock is protective — the comment above it explains that a second instance
  re-attaches every node's tmux session with `new-session -A -D`, and that `-D` detaches the first
  instance's clients, leaving dead `[detached]` terminals. The symptom to expect is a click that
  appears to do nothing. `NT_MULTI` cannot help: it is gated on `!app.isPackaged`.

**3c. tmux copied from the installed app, not built from source.** `resources/bin/tmux` (gitignored)
was copied out of `/Applications/nodeterm.app`.

- *Why.* Both apps share the `-L node-terminal` socket, and a tmux **client cannot talk to an older
  running server**. Copying upstream's exact universal 3.7b binary guarantees the running server and
  both clients match; `scripts/build-tmux.mjs` would also have produced 3.7b but takes a compile.
- *What breaks if undone.* A fork bundling a newer tmux than the server currently running makes
  start-order decide whether terminals attach at all.

**3d. `dist:subsquad` uses `--dir` and `--arm64`.** No dmg/zip.

- *Why.* `npm run dist` does **not** restrict architecture — the `build.mac.target` arch list wins,
  so an x64 pass runs too, and its `@electron/rebuild` leaves `node_modules` compiled for **x64**,
  breaking `npm run dev` until `npm run rebuild`. (Upstream's own `release` script re-runs `rebuild`
  afterwards for this reason.) Measured both ways: the `--dir --arm64` run rebuilt arm64 only.

**3e. Auto-update stays disabled**, via `-c.extraMetadata.nodeTermUpdates=disabled` (read by
`src/main/updater.ts`). A fork must never be updated out from under itself by upstream's feed.

**3f. `npm run build`, not bare `electron-vite build`.** `dist` runs the latter, which skips
`build:codex-relay` — even though that script's comment says its output must land in `out/main/` for
electron-builder to pick it up, and the installed upstream 0.3.2 asar indeed has no
`codex-relay.js`. Possibly an upstream bug; the fork builds the complete tree.

**Known cost, accepted.** The build is ad-hoc signed (`-c.mac.identity=null`), so macOS shows a
one-time Keychain prompt per app, and ad-hoc signatures differ on every rebuild, so it can recur.
Worst case is re-entering the GitHub token and model-gateway key; managed Claude/Codex accounts are
unaffected because the CLIs own those in their own config dirs.

**3g. Updating the installed app — the routine.** Decisions 3a–3f say *why* the packaging is shaped
this way but never state the loop itself, so it kept being reconstructed from them. It is:

```bash
git pull
npm install                  # not optional — see below
npm run dist:subsquad
```

then quit **both** SubSquad and nodeterm (3b: they share a data dir and a single-instance lock, so
they cannot run at once), replace `/Applications/SubSquad.app` with the freshly built `.app` under
`dist/`, and reopen.

- **There is no in-app update, by design** (3e). Rebuild-and-replace is the only path.
- **`npm install` after any upstream sync is mandatory.** Its `postinstall` is what patches node-pty
  and runs `electron-rebuild` against Electron's ABI; skipping it leaves native modules built for
  the previous ABI, and terminals fail to open. `npm run rebuild` is the repair.
- **`resources/bin/tmux` must exist or electron-builder fails.** It is gitignored
  (`.gitignore:16`) and mapped by `build.mac.extraResources` to `bin/tmux`, so it survives in an
  existing working copy but **not a fresh clone** — 3c has where it came from and why it is copied
  rather than compiled.
- Expect the Keychain prompt above on each rebuild.

### 4. Linear issues on the Kanban board — 2026-08-23, *uncommitted*

The feature the branch exists for. Decisions 1 and 2 were its groundwork; this is the provider
itself. Full write-up, including the device checklist for everything that could not be verified
without a live workspace: **`docs/linear-issues-kanban.md`**.

**4a. A sibling provider, not a generalisation of the GitHub one.**

- *Why.* `src/core/github/*` is upstream's code. Rewriting it into a provider-generic base would put
  this fork's largest diff through exactly the files it most wants to keep taking patches for. So
  `src/core/linear/` mirrors its shape (client, credentials, cache, control store, host, service,
  handlers, integration) and the GitHub tree is untouched.
- *Rejected.* Extracting a shared service base first. Reasonable once both providers have run in
  production for a while; doing it up front is the same work plus a permanent merge conflict.
- *What breaks if undone.* Every upstream patch to the GitHub integration becomes a manual merge.

**4b. Only the genuinely neutral machinery is shared** — decision 2's `src/core/issues/` (request
coordinator, revisioned store, snapshot cache), consumed by both. The dividing line is "would a
second copy's bugs be silent and identical in both?" Everything provider-shaped, including the
on-disk field names, stays with its provider.

**4c. A column maps to a workflow state, stored by NAME.**

- *Why.* `.nodeterm/project.json` is committed and reviewed; a UUID is unreadable in a diff, and
  Linear state ids do not survive a delete-and-recreate of a state that keeps its name.
- *Cost, accepted and surfaced.* A renamed state leaves a mapping pointing at nothing. It is
  reported as `unknownStates` in the control view and named in Settings; a move into that column
  answers `invalid-target` rather than guessing at a nearby state. A **failed** states read is never
  reported as a stale mapping — that would warn on a healthy board at every network hiccup.

**4d. Completing is SILENT; cancelling and reopening confirm.** This reverses the approved plan,
which mirrored GitHub's confirm-on-close.

- *Why.* GitHub confirms because closing an issue emails every watcher and cannot be undone from the
  board. In Linear the completion move is the board's most common gesture, it is undone by dragging
  back, and nobody is notified. A dialog on the happy path is not a safety feature — it is training
  to click through dialogs, which is what would blunt the cancel confirmation that does matter.
- *What breaks if undone.* Adding a confirm to completion re-trains the reflex this avoids.

**4e. Ungrouped is refused, not confirmed.** Every Linear issue is in exactly one state at all
times, so there is no write meaning "no state". Ungrouped still HOLDS unmapped-state cards (triage,
backlog) — it just cannot receive one. Refused on BOTH sides: the renderer for the message, the
service because that is the side a relay guest reaches.

**4f. No per-card conflict for Linear.** Both GitHub conflicts are structurally impossible here, and
the one remaining mismatch — a state no column maps to — is the normal home of triage and backlog
work. Flagging it per card would stamp a warning on every one of them; the real mapping hole is
reported once, at configuration level.

**4g. Relay cursors are per-refresh and never persisted** — also a departure from the plan, which
called for persisting them in the cache. A cursor addresses a position inside ONE server-side result
set; resuming a later refresh from an earlier cursor would silently skip or repeat issues. An
interrupted refresh restarts, as the GitHub path already does.

**4h. Rate-limit reset headers are a ladder, not a name.** Linear's docs and responses have not
agreed across versions and this was built without a live workspace to measure. So
`RATE_LIMIT_RESET_HEADERS` lists candidates in order, every value is sanity-checked against a
bounded future window (with seconds-vs-milliseconds disambiguated by magnitude), and anything that
fails falls through to exponential backoff. A wrong guess is slow, never a day-long pause of the
whole identity. **Still unverified against a live 429** — checklist item 1.

**4i. Three traps that are pinned by tests because they are invisible otherwise.** GraphQL answers a
FAILED request with **HTTP 200 and a non-empty `errors[]`** (an `ok` check reports a revoked key as
a parser bug); the API key is sent **raw, no `Bearer` prefix** (the OAuth form earns an auth error
that reads like a revoked key); and identity is the **UUID `id`**, never `number` (per-team) or
`identifier` (display).

**4j. Surfaces, decided explicitly.** Desktop and Server Edition are full — the service boots from
`src/core` and `buildLinearApi` is a real bridge implementation, not a stub. Relay tabs get the
GitHub split: reads and moves to the trusted host, `linearControl` local, so a guest can never save
a key or approve a project on another machine. Mobile is **N/A for v1** and needs a transport
protocol change; raise with **@eneskirca**.

**Pre-existing red tests, not caused by this work.** `remote-atomic-write.test.ts` (4),
`hello-probe.test.ts` (3) and `session-host-client.test.ts` (1) were already failing on
`b5031b20`, verified by stashing this branch's changes and re-running them. Everything else passes:
8,832 tests green.

---

## Watch list

Live risks carried by decisions above. Re-read before a merge from upstream.

- **Schema drift across the shared data dir.** Both apps read the same `workspace.json` (v3),
  `settings.json` and `<cwd>/.nodeterm/project.json`. Safe only while the formats stay mutually
  readable. If SubSquad ever bumps the workspace schema, the older upstream app becomes a downgrade
  path over live data — and this codebase's stated behavior for an unreadable project file is to set
  it aside as `project.json.corrupt-<ts>`. **Bumping any persisted schema requires revisiting 3a/3b.**
- **tmux version pairing.** See 3c. Keep `resources/bin/tmux` in step with whatever upstream ships.
- **No upstream remote is configured.** `git remote` lists only `origin` (the SubSquad repo), so
  there is currently no way to pull upstream nodeterm changes — or to notice a tmux bump — without
  adding one.
- **The packaging decisions in §3 are uncommitted.** They live in `package.json` and will be lost by
  a hard reset or an unwary rebase. So is all of §4.
- **The Linear integration has never run against a live workspace.** Nine numbered unknowns are
  listed in `docs/linear-issues-kanban.md` § Device checklist; item 1 (the rate-limit header names)
  is the only one whose wrong answer is invisible to the test suite.
- **Eight tests are red on this branch and were red before it.** Fix or quarantine them before they
  become cover for a real regression — a suite with known failures stops being a signal.
