# Runbook: how a session continues Operation Titan

You are a fresh session with no memory of the ones before you. Everything you need is on disk.
Follow this file in order. It is short on purpose: the details live where each step points.

**The mission:** make FTC SimBench Pro (a browser simulator that runs a team's real robot code on
their CAD) behave like the real robot, for FTC Team 7831, and keep the repositories around it
healthy. The work is a queue (`mission/queue.json`). Each run takes the next item, does it,
proves it, and records it.

## 1. Before anything

Work from the folder that holds the repositories side by side (called ROOT below;
`node tools/titan.mjs where` prints it and the other local paths, which live in the untracked
`machine.json`). Make up a run id from the date and time, for example `2026-11-21-0923`.

```
cd titan-autopilot
git pull --ff-only
node tools/titan.mjs preflight --run <run id>
```

| It says | Do |
|---|---|
| `PAUSED` (exit 10) | Stop. Say the autopilot is paused and why. Change nothing. |
| `LOCKED` (exit 11) | Stop. Another run is working. Change nothing. |
| `BROKEN QUEUE` (exit 12) | Fix `mission/queue.json` so `node tools/titan.mjs validate` passes, commit, push, then start again. |
| `nothing to start` (exit 13) | Stop. Say what it printed. If a blocked item's reason no longer holds, `todo <id>` it and start again. |
| `GO` (exit 0) | You hold the lock. Continue. |

Then read, in this order: the hub's `ftc-platform/OPERATION_TITAN.md` (the section headed START
HERE), the simulator's `ftc-simbench-pro-claude/AGENTS.md`, and the item preflight printed.
Preflight also lists each checkout's branch and uncommitted files: **look at the real state
before you trust any note**, this one included.

If preflight said `RESUME`, a run was cut off in the middle of that item. Read the item's `notes`,
look at its branch and worktree (`git log`, `git status`), and carry on from what is actually
there. Never redo finished work and never assume unfinished work was finished.

## 2. The loop

```
node tools/titan.mjs start <id> --run <run id>
   ... do the item (sections 4 to 7) ...
node tools/titan.mjs done <id> --run <run id> --result "what proves it: commits, test counts, links"
        or
node tools/titan.mjs block <id> --run <run id> --why "what stopped it, and what would unblock it"
node tools/titan.mjs render && git add -A mission && git commit -m "<id>: done|blocked ..." && git push
```

Then update the hub's `OPERATION_TITAN.md` (what landed, with commits; anything found on the
way) and push the hub. Then `node tools/titan.mjs next` and go again.

- Do at most **3 items in one run**. Stop sooner if you are running low: a half-done item with
  honest notes is worth more than a third item started.
- Say `node tools/titan.mjs log --run <run id> --item <id> --text "..."` when something worth
  knowing happens in a long item. It also tells the lock you are alive (a run silent for two
  hours loses its lock).
- Found new work? Write it as an item (`add --file item.json`): id, title, kind, a brief that a
  stranger can act on, and `done_when`. Do not do unqueued work beyond what your item needs.
- Something only the owner can do (a measurement on the real robot, an account setting, a
  purchase, a decision)? Add it with `"kind": "owner", "state": "owner"` and move on.

**When you stop, for any reason:** leave the item's state true (`doing` with `--notes` saying
exactly where you got to, or `blocked`, or `done`), push this repo and the hub, and run
`node tools/titan.mjs unlock --run <run id>`. End your last message with what you did, what you
verified, and what is next.

## 3. Rules that do not bend

1. **Never spend money.** No paid service, no plan upgrade, no purchase. Free tiers only.
2. **No Onshape API calls** unless the item says so (the allowance is small and yearly). Use
   files already on disk.
3. **Never push to the simulator's `main` without the gate in section 4.** Never force-push,
   never rewrite `main`, never commit `dist/`, CAD files, `node_modules` or secrets.
4. **Never claim a test you did not run.** Report the numbers you saw. If something was not
   verified, say so.
5. **Fix the cause, not the instance.** No special case for one robot or one team in the
   simulator. A fix comes with a test that fails without it. Never weaken a test to get to
   green: when an expected number changes, the commit says why the new one is right.
6. **The team's Android Studio project** (`Quickstart`, branch `Testing-code`): never stage its
   own `build.gradle` or gradle-wrapper edits. Team code goes to `Testing-code`, then merge into
   `master`. Comments in team code are short and plain.
7. **Privacy.** No e-mail addresses, tokens, keys or account names in anything you commit or
   send to a service. This repository is public: write about security findings by their id, and
   keep how to exploit them in the private hub.
8. **Waggle is off.** Do not start it, call it, or rely on anything it ran.
9. **Do not install global packages** and do not change system settings.
10. Other agents (BATMAN, Ramarao) push to the simulator too. `git fetch` before every push,
    and keep the claims table in `AGENTS.md` true: claim before editing a shared file, release
    when done.

## 4. Landing a branch (`kind: land`) and the gate for every push to the simulator's `main`

1. In the branch's worktree: `git fetch origin && git rebase origin/main`. Resolve conflicts by
   reading both sides. Then `NODE_OPTIONS=--max-old-space-size=6144 node tools/test.mjs` must
   end `fail 0` (about a minute).
2. **An independent review.** Start one subagent that did not write the code (Opus, high
   effort), read-only on the repository, with scratch scripts in its own temp folder. Tell it:
   the branch and how to see its diff; what the change is meant to do; to hunt for wrong
   behaviour, crashes, stale state between runs or robots, lost or duplicated game pieces,
   anything that changes behaviour where the feature is off, unsafe handling of untrusted input,
   and per-tick cost; to give for each defect the file and line, the scenario, how sure it is,
   and a script that shows it; at most 60 lines, real defects only. The first review of this
   project found eight real defects in code that passed all of its tests. Do not skip it.
3. Fix every real finding, each with a test. Run the suite again.
4. **If the change can be seen or driven in the page, look at it in the page** (section 6).
5. `git fetch origin && git rebase origin/main && git push origin HEAD:main`.
6. Watch CI (`gh run watch`), then check the live site carries your build:
   `node tools/build.mjs --min` prints the build hash, and
   `curl -s https://ftc-simbench-pro.pages.dev/ | grep -o '"build":"[0-9a-f]*"'` must match it
   within a few minutes.
7. If CI goes red or the live page breaks: `git revert` your commits, push the revert, and
   `block` the item with what you saw. A broken `main` is worse than a late feature.
8. Remove the item's row from the claims table in `AGENTS.md`.

## 5. Building or fixing (`kind: fix`, `build`)

```
cd ftc-simbench-pro-claude && git fetch origin
git worktree add -b titan/<id> ../ftc-simbench-titan-<id> origin/main
cd ../ftc-simbench-titan-<id>
cmd //c "mklink /J node_modules <ROOT, backslashes doubled>\\ftc-simbench-pro-claude\\node_modules"
```

Claim the shared files you will edit in `AGENTS.md` and push that claim first. Reproduce the
defect before you change anything (audit findings have a script in the hub's
`docs/titan/audit/<area>/repro/`). Write the failing test, then the fix. One topic per commit;
the subject starts with the area (`sim:`, `physics:`, `parser:`, `docs:`, `chore:`); the body
says what was wrong, what changed, how it was tested. Push the branch (`git push origin
titan/<id>`) as you go so nothing lives on one disk: Cloudflare builds every branch at
`https://titan-<id>.ftc-simbench-pro.pages.dev`. Then land it by section 4.

For a large item, plan first and build in steps that each leave the suite green.

## 6. Looking at it in the page

```
node tools/build.mjs --min          # in the worktree; writes dist/
python -m http.server 8771 --directory dist
```

Drive it with the Playwright browser tools (a real browser with a running frame loop). The team's
real code is in the Android Studio project: choose a file through the page's own file input
(`#codeFile`). What cost time before:

- The page runs INIT by itself when code loads: the INIT button is then disabled. Press START.
- `?robot=sample` gives a robot the team's drive code drives straight. On the default robot the
  team's device names bind to that robot's joints.
- Keys in the default layout: I J K L drive, U O turn, A B X Y buttons, C right trigger, Z left
  trigger, E right bumper, Q left bumper. A key goes to the gamepad the code reads it from.
  Hold a key for 150 ms or more: an instant press falls between two 20 ms passes.
- Moving the robot by setting `Sim.chassis` sweeps its body through everything on the way and
  knocks balls off: move first, wait, then place a ball.
- A match with AI robots ends at its clock (2:00). Switch them off to work without one.
- The browser profile remembers the last code and switches between visits.
- A static server has no `/onshape/status` or `/leaderboard`: those two 404s are expected.

## 7. Subagents

Use them for bulk work and for review; keep judgment (what to build, whether a result is
accepted) for yourself. Opus at high effort to build or review; Sonnet for mechanical work
(reading, listing, reformatting). At most 5 at once. One writer per set of files, each in its
own worktree; a builder commits on its branch and never pushes `main`. Give every worker: the
goal and what done looks like, the files it owns and the ones it must not touch, the rules in
section 3, and a report of at most 40 lines with what it could not verify. A tool may refuse to
let a subagent write a report file: have it return the text instead. Check a worker's result
yourself (run the tests, read the diff) before you call it done.

## 8. Where things are

| What | Where |
|---|---|
| The queue, the journal, the pause switch | `mission/queue.json`, `mission/journal.jsonl`, `mission/PAUSE` |
| The long mission log and every audit finding | hub (private): `ftc-platform/OPERATION_TITAN.md`, `docs/titan/audit/` |
| What each builder reported about its branch | hub: `docs/titan/wave2a/*.json` |
| The simulator (work here, never in the stale `ftc-simbench-pro` folder) | `ftc-simbench-pro-claude`, worktrees `ftc-simbench-titan-*` |
| The simulator's rules and conventions | its `AGENTS.md`, `src/README.md`, `docs/` |
| The team's real robot code | the Android Studio project `Quickstart` (`teamRepo` in `machine.json`), branch `Testing-code` |
| The real robot's record and check | hub: `robots/meet0/` |
| The state of all nine repositories | hub: `node tools/status.mjs [--checks] [--full]` |
| Project skills | hub: `skills/`, installed with `node tools/install-skills.mjs` |
| `gh` | signed in; its path is `gh` in `machine.json` when it is not on the PATH |

Bash heredocs on this computer eat backslashes: write files with the editor tools.

## 9. The owner's switches

- **Pause:** create `mission/PAUSE` (any text, the reason) in this repository, on the computer
  or on github.com from a phone. Runs stop at preflight until it is deleted.
- **Stop the schedule:** disable the task "Operation Titan autopilot" in the Claude app's
  scheduled tasks.
- **Change the order:** reorder `mission/queue.json`. **Add work:** add an item.
