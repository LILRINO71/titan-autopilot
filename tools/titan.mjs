#!/usr/bin/env node
// The autopilot's command line: the one way a run reads and changes the work queue.
//
//   node tools/titan.mjs preflight --run <id>    may this run start? (pause switch, lock, queue, repos) and what is next
//   node tools/titan.mjs status [--json]         the queue in brief
//   node tools/titan.mjs next [--json]           the item to work on now
//   node tools/titan.mjs start <id> --run <id>   take it (one item at a time)
//   node tools/titan.mjs done <id> --result "what proves it: commits, test counts, links"
//   node tools/titan.mjs block <id> --why "what stopped it and what would unblock it"
//   node tools/titan.mjs todo <id>               put an item back
//   node tools/titan.mjs add --file item.json [--first | --before <id>]
//   node tools/titan.mjs move <id> --before <id>
//   node tools/titan.mjs log --run <id> [--item <id>] --text "one line for the journal"
//   node tools/titan.mjs beat --run <id>         "still working" (start, done, block and log say it too)
//   node tools/titan.mjs unlock --run <id>       the run is over
//   node tools/titan.mjs where                   the local paths a run needs (from machine.json)
//   node tools/titan.mjs validate                is the queue well formed?
//   node tools/titan.mjs render [--out _site]    the status page
//
// Exit codes of preflight: 0 go ahead, 10 paused, 11 another run holds the lock, 12 the queue is
// broken, 13 nothing can be started. Everything else exits 1 on an error and says why.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = (f) => path.join(REPO, 'mission', f);
const argv = process.argv.slice(2), cmd = argv[0];
const flag = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
const arg1 = () => (argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined);
const now = () => new Date().toISOString();
const die = (msg, code = 1) => { console.error('titan: ' + msg); process.exit(code); };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (d !== undefined && e.code === 'ENOENT') return d; throw new Error(path.basename(f) + ': ' + e.message); } };
const readQueue = () => readJson(M('queue.json'));
const writeQueue = (q) => { const errs = L.validate(q); if (errs.length) die('that would break the queue: ' + errs.join('; ')); fs.writeFileSync(M('queue.json'), JSON.stringify(q, null, 2) + '\n'); };
const readJournal = () => (fs.existsSync(M('journal.jsonl')) ? fs.readFileSync(M('journal.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const journal = (e) => fs.appendFileSync(M('journal.jsonl'), JSON.stringify(Object.assign({ at: now() }, e)) + '\n');
const readLock = () => readJson(M('.lock'), null);
const beat = (run) => { const l = readLock(); if (l && run && l.run === run) fs.writeFileSync(M('.lock'), JSON.stringify(Object.assign(l, { beat: now() })) + '\n'); };
const needRun = () => { const r = flag('run'); if (typeof r !== 'string') die('say which run this is: --run <id> (for example the date and time it started)'); return r; };

const machine = readJson(path.join(REPO, 'machine.json'), {});
const ROOT = path.resolve(machine.root || path.join(REPO, '..'));
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '').trimEnd() : null; };

function brief(q) {
  const c = L.counts(q);
  return `${c.done} of ${c.agent} done, ${c.doing} in progress, ${L.ready(q).length} ready, ${c.blocked} blocked, ${c.owner} need the owner`;
}
function show(n) {
  const it = n.item;
  console.log((n.resumed ? 'RESUME (a run was cut off on this one: look at its branch and worktree before doing anything): ' : 'NEXT: ') + it.id);
  console.log('  ' + it.title + '  [' + it.kind + (it.repo ? ', ' + it.repo : '') + (it.branch ? ', branch ' + it.branch : '') + ']');
  console.log('  what: ' + it.brief);
  for (const d of it.done_when) console.log('  done when: ' + d);
  if (it.notes) console.log('  notes: ' + it.notes);
}

try {
  if (cmd === 'validate') {
    const errs = L.validate(readQueue());
    if (errs.length) { for (const e of errs) console.error('  ' + e); die(errs.length + ' problem(s) in mission/queue.json', 12); }
    console.log('queue ok: ' + brief(readQueue()));
  } else if (cmd === 'status') {
    const q = readQueue();
    if (flag('json')) console.log(JSON.stringify({ counts: L.counts(q), ready: L.ready(q).map((x) => x.id), next: (L.next(q) || {}).item || null, lock: readLock(), paused: fs.existsSync(M('PAUSE')) }, null, 1));
    else { console.log(brief(q)); for (const x of q.items) console.log('  ' + x.state.padEnd(8) + x.id.padEnd(24) + x.title); }
  } else if (cmd === 'next') {
    const q = readQueue(), n = L.next(q);
    if (!n) { console.log('nothing to start: ' + L.idleReason(q)); process.exit(13); }
    if (flag('json')) console.log(JSON.stringify(n, null, 1)); else show(n);
  } else if (cmd === 'preflight') {
    const run = needRun();
    if (fs.existsSync(M('PAUSE'))) { console.log('PAUSED: mission/PAUSE exists (' + (fs.readFileSync(M('PAUSE'), 'utf8').trim().slice(0, 200) || 'no reason given') + '). Do nothing. Remove the file to resume.'); process.exit(10); }
    const lock = readLock(), ls = L.lockState(lock, now());
    if (ls === 'held' && lock.run !== run) { console.log('LOCKED: run ' + lock.run + ' is working (last heard ' + (lock.beat || lock.at) + '). Do nothing: two runs must not edit the same branches.'); process.exit(11); }
    const q = readQueue(), errs = L.validate(q);
    if (errs.length) { for (const e of errs) console.log('  ' + e); console.log('BROKEN QUEUE: fix mission/queue.json before anything else.'); process.exit(12); }
    if (ls === 'stale') journal({ run, text: 'took over from run ' + lock.run + ', silent since ' + (lock.beat || lock.at) });
    fs.writeFileSync(M('.lock'), JSON.stringify({ run, at: now(), beat: now() }) + '\n');
    console.log('GO: run ' + run + ' holds the lock. ' + brief(q));
    // where each checkout stands: a run must look before it trusts the queue
    const dirs = ['ftc-simbench-pro-claude', 'ftc-platform', 'titan-autopilot'].concat(fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => /^ftc-simbench-titan-/.test(d)) : []);
    for (const d of dirs) {
      const p = path.join(ROOT, d); if (!fs.existsSync(path.join(p, '.git'))) continue;
      const br = git(p, 'rev-parse', '--abbrev-ref', 'HEAD'), head = git(p, 'rev-parse', '--short', 'HEAD'), dirty = (git(p, 'status', '--porcelain') || '').split('\n').filter(Boolean).length;
      console.log('  ' + d.padEnd(30) + (br || '?').padEnd(18) + (head || '?') + (dirty ? '  ' + dirty + ' UNCOMMITTED file(s)' : ''));
    }
    const n = L.next(q);
    if (!n) { console.log('nothing to start: ' + L.idleReason(q)); fs.rmSync(M('.lock'), { force: true }); process.exit(13); }
    show(n);
  } else if (cmd === 'start' || cmd === 'done' || cmd === 'block' || cmd === 'todo') {
    const id = arg1(); if (!id) die('which item? ' + cmd + ' <id>');
    const state = { start: 'doing', done: 'done', block: 'blocked', todo: 'todo' }[cmd];
    const fields = {}, run = flag('run');
    if (cmd === 'start') fields.run = needRun();
    if (typeof flag('result') === 'string') fields.result = flag('result');
    if (typeof flag('why') === 'string') fields.why = flag('why');
    if (typeof flag('notes') === 'string') fields.notes = flag('notes');
    const q = L.move(readQueue(), id, state, fields, now());
    writeQueue(q);
    journal({ run: typeof run === 'string' ? run : undefined, item: id, text: cmd === 'start' ? 'started' : cmd === 'done' ? 'done: ' + fields.result : cmd === 'block' ? 'blocked: ' + fields.why : 'put back' });
    if (typeof run === 'string') beat(run);
    console.log(id + ' is now ' + state + '. ' + brief(q));
  } else if (cmd === 'add') {
    const f = flag('file'); if (typeof f !== 'string') die('add --file item.json [--first | --before <id>]');
    const before = flag('before');
    const q = L.add(readQueue(), readJson(path.resolve(f)), now(), typeof before === 'string' ? { before } : !!flag('first'));
    writeQueue(q); journal({ item: readJson(path.resolve(f)).id, text: 'added to the queue' });
    console.log('added. ' + brief(q));
  } else if (cmd === 'move') {
    const id = argv[1], before = flag('before');
    if (!id || typeof before !== 'string') die('move <id> --before <id>');
    const q = L.reorder(readQueue(), id, before, now());
    writeQueue(q); journal({ item: id, text: 'moved ahead of ' + before });
    console.log(id + ' is now ahead of ' + before + '. ' + brief(q));
  } else if (cmd === 'log') {
    const text = flag('text'); if (typeof text !== 'string') die('log --text "..."');
    const run = flag('run'), item = flag('item');
    journal({ run: typeof run === 'string' ? run : undefined, item: typeof item === 'string' ? item : undefined, text });
    if (typeof run === 'string') beat(run);
  } else if (cmd === 'beat') { beat(needRun()); }
  else if (cmd === 'unlock') {
    const run = needRun(), lock = readLock();
    if (lock && lock.run !== run) die('the lock belongs to run ' + lock.run + ', not ' + run);
    fs.rmSync(M('.lock'), { force: true }); console.log('unlocked.');
  } else if (cmd === 'where') {
    console.log('ROOT      ' + ROOT + (machine.root ? '' : '   (the parent of this checkout: there is no machine.json)'));
    console.log('simulator ' + path.join(ROOT, 'ftc-simbench-pro-claude') + '   (worktrees: ftc-simbench-titan-*)');
    console.log('hub       ' + path.join(ROOT, 'ftc-platform'));
    console.log('team code ' + (machine.teamRepo || '(set teamRepo in machine.json)'));
    console.log('gh        ' + (machine.gh || 'gh'));
  } else if (cmd === 'render') {
    const out = path.resolve(typeof flag('out') === 'string' ? flag('out') : path.join(REPO, '_site')), q = readQueue();
    const errs = L.validate(q); if (errs.length) die('the queue is broken: ' + errs.join('; '), 12);
    fs.mkdirSync(out, { recursive: true });
    const generated = now(), jr = readJournal();
    fs.writeFileSync(path.join(out, 'index.html'), L.renderHtml({ queue: q, journal: jr, links: readJson(M('links.json'), []), generated }));
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify({ generated, counts: L.counts(q), next: (L.next(q) || {}).item ? L.next(q).item.id : null, items: q.items.map((x) => ({ id: x.id, title: x.title, state: x.state, kind: x.kind, updated: x.updated || null })) }, null, 1) + '\n');
    console.log('wrote ' + path.join(out, 'index.html') + ' (' + brief(q) + ')');
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { die(e.message); }
