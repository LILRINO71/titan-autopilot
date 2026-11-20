// The rules a run relies on: what is next, what may start, what a cut-off run leaves behind, when a
// lock is dead, and that the real queue in this repo is well formed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../tools/lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const item = (id, o = {}) => Object.assign({ id, title: 'Item ' + id, state: 'todo', kind: 'fix', brief: 'do ' + id, done_when: ['it is done'], needs: [] }, o);
const Q = (...items) => ({ items });
const T0 = '2026-11-20T10:00:00.000Z';

test('queue: a well-formed queue has nothing wrong; each kind of mistake is named', () => {
  assert.deepEqual(L.validate(Q(item('a'), item('b', { needs: ['a'] }))), []);
  const bad = (q, re) => assert.ok(L.validate(q).some((e) => re.test(e)), JSON.stringify(L.validate(q)));
  bad({}, /no "items"/);
  bad(Q(item('A b')), /lower-case/);
  bad(Q(item('a'), item('a')), /used twice/);
  bad(Q(item('a', { state: 'maybe' })), /state must be/);
  bad(Q(item('a', { kind: 'magic' })), /kind must be/);
  bad(Q(item('a', { done_when: [] })), /done_when/);
  bad(Q(item('a', { needs: ['zz'] })), /not in the queue/);
  bad(Q(item('a', { state: 'blocked' })), /says why/);
  bad(Q(item('a', { state: 'done' })), /what proves it/);
  bad(Q(item('a', { kind: 'owner' })), /only the owner/);
  bad(Q(item('a', { needs: ['b'] }), item('b', { needs: ['a'] })), /wait on each other/);
});

test('queue: next is the first item whose needs are done, in queue order', () => {
  const q = Q(item('a', { state: 'done', result: 'x' }), item('b', { needs: ['c'] }), item('c'), item('d', { needs: ['a'] }));
  assert.deepEqual(L.ready(q).map((x) => x.id), ['c', 'd']);
  assert.equal(L.next(q).item.id, 'c');
  assert.equal(L.next(q).resumed, false);
});

test('queue: an item a cut-off run left in progress comes before anything new, flagged as a resume', () => {
  const q = Q(item('a'), item('b', { state: 'doing', run: 'r1' }));
  const n = L.next(q);
  assert.equal(n.item.id, 'b');
  assert.equal(n.resumed, true);
});

test('queue: items for the owner and blocked items are never handed to a run', () => {
  const q = Q(item('o', { kind: 'owner', state: 'owner' }), item('x', { state: 'blocked', why: 'needs a browser' }), item('y', { needs: ['x'] }));
  assert.equal(L.next(q), null);
  assert.match(L.idleReason(q), /y waits on x \(blocked\)/);
  assert.throws(() => L.move(q, 'o', 'doing', { run: 'r' }, T0), /for the owner/);
  assert.equal(L.idleReason(Q(item('a', { state: 'done', result: 'ok' }))), 'every item an agent can do is done');
});

test('queue: only one item in progress, only when what it needs is done, and done needs proof', () => {
  let q = Q(item('a'), item('b', { needs: ['a'] }), item('c'));
  assert.throws(() => L.move(q, 'b', 'doing', { run: 'r' }, T0), /still needs: a/);
  q = L.move(q, 'a', 'doing', { run: 'r' }, T0);
  assert.equal(q.items[0].started, T0);
  assert.throws(() => L.move(q, 'c', 'doing', { run: 'r' }, T0), /already being worked on/);
  assert.throws(() => L.move(q, 'a', 'done', {}, T0), /what proves it/);
  assert.throws(() => L.move(q, 'a', 'blocked', {}, T0), /why/);
  q = L.move(q, 'a', 'done', { result: 'pushed abc1234, 1100 tests pass' }, T0);
  assert.equal(L.next(q).item.id, 'b');
  assert.deepEqual(L.validate(q), []);
  assert.throws(() => L.move(q, 'nope', 'done', { result: 'x' }, T0), /no item/);
});

test('queue: blocking keeps the reason, unblocking drops it, and the original is never changed', () => {
  const q0 = Q(item('a'));
  const q1 = L.move(L.move(q0, 'a', 'doing', { run: 'r' }, T0), 'a', 'blocked', { why: 'the suite fails in a file it does not own' }, T0);
  assert.equal(q0.items[0].state, 'todo', 'move returns a copy');
  assert.equal(q1.items[0].why, 'the suite fails in a file it does not own');
  const q2 = L.move(q1, 'a', 'todo', {}, T0);
  assert.equal(q2.items[0].why, undefined);
  assert.equal(q2.items[0].started, undefined);
});

test('queue: a run can add work it found, at the end or at the front of what is left', () => {
  const q = Q(item('a', { state: 'done', result: 'x' }), item('b'));
  assert.deepEqual(L.add(q, item('c'), T0).items.map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(L.add(q, item('c'), T0, true).items.map((x) => x.id), ['a', 'c', 'b']);
  assert.throws(() => L.add(q, item('b'), T0), /used twice/);
  assert.throws(() => L.add(q, { id: 'z' }, T0), /no title/);
});

test('lock: free, held, and stale after two silent hours', () => {
  assert.equal(L.lockState(null, T0), 'free');
  assert.equal(L.lockState({ run: 'r', at: 'not a date' }, T0), 'free');
  assert.equal(L.lockState({ run: 'r', at: '2026-11-20T09:30:00.000Z' }, T0), 'held');
  assert.equal(L.lockState({ run: 'r', at: '2026-11-20T06:00:00.000Z', beat: '2026-11-20T09:59:00.000Z' }, T0), 'held', 'a heartbeat keeps it alive');
  assert.equal(L.lockState({ run: 'r', at: '2026-11-20T07:59:00.000Z' }, T0), 'stale');
});

test('status page: one self-contained document, with every state and nothing unescaped', () => {
  const q = Q(item('a', { state: 'done', result: 'pushed <b>abc</b>' }), item('b', { state: 'doing' }), item('c', { state: 'blocked', why: 'x & y' }),
    item('d', { kind: 'owner', state: 'owner', title: 'Time the rollers' }), item('e', { needs: ['b'] }));
  const html = L.renderHtml({ queue: q, journal: [{ at: T0, item: 'b', text: 'started <script>' }], links: [{ label: 'Live', url: 'https://example.org/?a=1&b=2' }], generated: T0 });
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script/i.test(html), 'no script reaches the page');
  assert.match(html, /pushed &lt;b&gt;abc&lt;\/b&gt;/);
  assert.match(html, /x &amp; y/);
  assert.match(html, /1 of 4/, 'the owner item is not counted as agent work');
  assert.match(html, /Being worked on: Item b/);
  assert.match(html, /Time the rollers/);
  assert.match(html, /href="https:\/\/example.org\/\?a=1&amp;b=2"/);
  assert.ok(!/https?:\/\/[^"]*\.(js|css)/.test(html), 'no outside scripts or styles');
});

test('this repo: the real queue is well formed and its links are https', () => {
  const q = JSON.parse(fs.readFileSync(path.join(REPO, 'mission', 'queue.json'), 'utf8'));
  assert.deepEqual(L.validate(q), []);
  assert.ok(q.items.length >= 10);
  const links = JSON.parse(fs.readFileSync(path.join(REPO, 'mission', 'links.json'), 'utf8'));
  for (const l of links) assert.match(l.url, /^https:\/\//, l.label);
});

test('command line: a run from preflight to unlock, on a copy of the repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-cli-'));
  try {
    fs.cpSync(path.join(REPO, 'tools'), path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mission'));
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ root: dir }));
    fs.writeFileSync(path.join(dir, 'mission', 'queue.json'), JSON.stringify(Q(item('one'), item('two', { needs: ['one'] }))));
    fs.writeFileSync(path.join(dir, 'mission', 'links.json'), '[]');
    const run = (...a) => spawnSync(process.execPath, [path.join(dir, 'tools', 'titan.mjs'), ...a], { encoding: 'utf8' });
    let p = run('preflight', '--run', 'r1');
    assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /GO: run r1/); assert.match(p.stdout, /NEXT: one/);
    p = run('preflight', '--run', 'r2');
    assert.equal(p.status, 11, 'a second run is turned away: ' + p.stdout); assert.match(p.stdout, /LOCKED/);
    assert.equal(run('start', 'one', '--run', 'r1').status, 0);
    assert.equal(run('start', 'two', '--run', 'r1').status, 1, 'one item at a time');
    assert.equal(run('done', 'one').status, 1, 'done needs proof');
    assert.equal(run('done', 'one', '--run', 'r1', '--result', 'pushed abc1234').status, 0);
    p = run('next'); assert.match(p.stdout, /NEXT: two/);
    assert.equal(run('unlock', '--run', 'r2').status, 1, 'only the holder unlocks');
    assert.equal(run('unlock', '--run', 'r1').status, 0);
    // the pause switch stops a run before it takes the lock
    fs.writeFileSync(path.join(dir, 'mission', 'PAUSE'), 'exam week');
    p = run('preflight', '--run', 'r3');
    assert.equal(p.status, 10); assert.match(p.stdout, /PAUSED.*exam week/);
    assert.ok(!fs.existsSync(path.join(dir, 'mission', '.lock')));
    fs.rmSync(path.join(dir, 'mission', 'PAUSE'));
    // a run cut off in the middle of an item: the next one resumes it
    assert.equal(run('preflight', '--run', 'r4').status, 0);
    assert.equal(run('start', 'two', '--run', 'r4').status, 0);
    fs.rmSync(path.join(dir, 'mission', '.lock'));                   // the session died; its lock went stale and was cleared
    p = run('preflight', '--run', 'r5');
    assert.equal(p.status, 0); assert.match(p.stdout, /RESUME .*: two/);
    assert.equal(run('block', 'two', '--run', 'r5', '--why', 'needs a measurement').status, 0);
    p = run('preflight', '--run', 'r5');
    assert.equal(p.status, 13, 'nothing left to start: ' + p.stdout);
    assert.equal(run('render', '--out', path.join(dir, 'site')).status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'site', 'index.html'), 'utf8'), /needs a measurement/);
    const j = fs.readFileSync(path.join(dir, 'mission', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(j.some((e) => e.item === 'one' && /done: pushed abc1234/.test(e.text)));
    assert.ok(j.some((e) => e.item === 'two' && /blocked: needs a measurement/.test(e.text)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
