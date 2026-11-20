# Titan autopilot

Keeps **Operation Titan** moving when nobody is at the keyboard. Operation Titan is the work of
making [FTC SimBench Pro](https://ftc-simbench-pro.pages.dev) (a browser simulator that runs a
team's real robot code on their CAD) behave like the real robot, for FTC Team 7831.

**Live status: https://lilrino71.github.io/titan-autopilot/**

## How it works

- [`mission/queue.json`](mission/queue.json) is the work: ordered items, each with a brief a
  stranger can act on and a list of what proves it is done.
- A scheduled session on the owner's computer starts every few hours, reads
  [`RUNBOOK.md`](RUNBOOK.md), takes the next item, does it, proves it, records it here and
  stops. It has no memory of earlier sessions: the queue, the runbook and the mission log are
  the memory.
- [`tools/titan.mjs`](tools/titan.mjs) is the only way a run reads or changes the queue. It
  refuses a second run while one is working, hands back an item a cut-off run left half done,
  and will not mark anything done without a line of proof.
- GitHub Actions tests the runner, checks the queue and publishes the status page on every push
  and once a day.

Nothing reaches the simulator's `main` without a full test run, an independent review and, where
it can be seen, a look in the running page. The runbook's section 4 is that gate.

## Try the unreleased work

Every branch of the simulator gets its own preview site:

| Branch | What | Preview |
|---|---|---|
| `main` | what is live | https://ftc-simbench-pro.pages.dev |
| `titan/physics` | motor and servo figures from vendor pages, realistic strafe, FLOAT coasting | https://titan-physics.ftc-simbench-pro.pages.dev |
| `titan/jvm` | loop rate, Java integer rules, errors the robot would throw, runaway code | https://titan-jvm.ftc-simbench-pro.pages.dev |
| `titan/app` | minifier and build checks, response headers, stored settings | https://titan-app.ftc-simbench-pro.pages.dev |

These three are built and pass their tests but have not been reviewed yet. They are the next
items in the queue.

## The owner's switches

| To | Do |
|---|---|
| Pause everything | Create a file `mission/PAUSE` (any text) here, on the computer or on github.com from a phone. Delete it to resume. |
| Stop the schedule | Disable "Operation Titan autopilot" in the Claude app's scheduled tasks. |
| Change what happens next | Reorder or edit `mission/queue.json`. |
| See what happened | The status page, or `mission/journal.jsonl`. |

## Using it by hand

```
node tools/titan.mjs status
node tools/titan.mjs next
node tools/titan.mjs render        # writes _site/index.html
npm test
```

Needs only Node 22 or newer. `machine.example.json` shows the one local setting (where the
repositories are); without it the parent folder of this checkout is used.

## Layout

| Path | What |
|---|---|
| `RUNBOOK.md` | what a session does, step by step, and the rules that do not bend |
| `mission/queue.json` | the work |
| `mission/journal.jsonl` | one line per event, appended by the runner |
| `mission/links.json` | the links on the status page |
| `scheduled/RESUME_PROMPT.md` | the prompt the scheduled task runs |
| `tools/titan.mjs`, `tools/lib.mjs` | the runner and its rules |
| `tests/` | the rules, tested |
