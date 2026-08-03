# Beads context: oculist

This file overrides the default `bd prime` output. The default inlines every
persistent memory in full into every session; this replaces those bodies with an
index — enough to know a trap exists, plus the key to expand it.

**Expand any entry with `bd memories <key> --json`.** The `--json` matters:
plain `bd memories` truncates every body to about 110 characters, which is not
enough to act on. `bd config get kv.memory.<key>` also returns the full text.

Add a one-line index entry here whenever you `bd remember` something new.

## Where things are

- The DB lives in `repo/.beads`. Run `bd` from `repo/` or below; from the outer
  `oculist/` directory it resolves nothing. `bd where` confirms.
- `oculist/` and `oculist/repo/` are **two separate git repos**. The outer one is
  the PARA project wrapper (backlog, plans, artifacts) and has **no remote**. The
  inner `repo/` is the code and pushes to `github.com/ya8282/oculist`. Always use
  `git -C <absolute-path>` so you do not commit to the wrong one.
- Bead history syncs to `refs/dolt/data` on the `repo/` GitHub remote, but **only
  when you run `bd dolt push`**. The git hooks do not do it — a normal `git push`
  leaves the ref untouched, and the hook exits 0 silently either way, so there is
  no warning that bead history is unsynced. `sync.remote` in `.beads/config.yaml`
  names the target; `bd dolt push` derives the Dolt remote from git origin on the
  fly, which is why `bd dolt show` reports `Remotes: (none)` even when sync works.
- Task tracking is split: beads is the plan of record for code work, while
  `../artifacts/tasks/backlog.md` holds the longer-range product backlog (FI-*,
  RP-*, BUG-* ids). That file is gated to `/backlog`; do not hand-edit it.

## Core rules

- bd is the plan of record. Do NOT use TodoWrite, TaskCreate, or markdown TODO
  lists for task tracking.
- Create the bead before writing code. Claim it when you start.
- Record durable insight with `bd remember "<insight>"`. No MEMORY.md files.
- Conservative git profile by default: do not commit or push without explicit
  authority from the user or the orchestrator.
- Commits use the repo owner's GitHub account as sole author. Never add a
  `Co-Authored-By` trailer.

## Commands

```bash
bd ready                          # unblocked, actionable work
bd show <id>                      # detail + dependencies
bd list --status=open|in_progress
bd search <query>

bd update <id> --claim
bd update <id> --title/--description/--notes/--design
bd close <id1> <id2> ...          # batch; --reason="..." to explain
bd create --title="..." --description="..." --type=task|bug|feature --priority=2
bd create ... --parent=<id>       # child of an epic/task, inherits labels
bd dep add <issue> <depends-on>

bd stats | bd doctor | bd stale | bd preflight
bd memories <keyword> --json      # expand a memory from the index below
                                  # WITHOUT --json the body is truncated
```

Traps in the CLI itself:

- **Never `bd edit`.** It opens `$EDITOR` and blocks the agent.
- **`bd update -t` sets the issue TYPE, not the title.** The title flag is
  `--title`. Passing a sentence to `-t` fails with `invalid issue type`.
- **Priority is numeric**, 0-4 or P0-P4 (0 critical, 2 medium, 4 backlog). Not
  "high"/"medium"/"low".
- **`bd sync` does not exist** in this version. Use `bd export`.

## Session close

```
[ ] file any discovered work as new beads
[ ] run the gate: npm test        # 22 tests; several launch real Chromium
[ ] bd close <ids>
[ ] bd export -o .beads/issues.jsonl      # see note below
[ ] bd dolt push                          # bead history -> refs/dolt/data
[ ] git -C <abs-path-to-repo> status, then report; do not push unbidden
```

`.beads/issues.jsonl` is a **passive export that never refreshes itself**.
Skip the export and it keeps reporting closed beads as open.

## Testing

- Test validity: a green test proves nothing until you have watched it FAIL
  without the fix. Stash the change and re-run before claiming a fix works.
- `test/*.test.js` run concurrently under `node --test`, and several launch a
  real Chromium via `chromium.launchPersistentContext`. Adding another
  browser-launching suite can starve the existing ones into a 180s launch
  timeout that looks like an unrelated failure. Prefer reusing one context and
  `page.emulateMedia()` over launching a second.
- `channel: 'chromium'` is load-bearing in every browser test. Playwright's
  default bundled build is the headless shell, which silently loads no
  extensions at all, so every selector times out.

---

## Memory index (1)

Expand with `bd memories <key> --json`. Read the ones matching what you are
about to touch; do not expand all of them.

### Tooling

- `bd-has-no-sync-subcommand-in-this-version` — `bd sync` is not a command here;
  use `bd export`. Also the `bd update -t` / `--title` trap.
