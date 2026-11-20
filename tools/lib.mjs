// The pure part of the autopilot: the work queue's rules, the run lock, and the status page.
// Nothing here touches the disk or the clock (callers pass `now`), so every rule is tested.

export const STATES = ['todo', 'doing', 'done', 'blocked', 'owner'];
export const KINDS = ['land', 'fix', 'build', 'docs', 'audit', 'owner'];
/** A run that has not said anything for this long is taken to be dead and its lock ignored. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/** Everything wrong with a queue, as plain sentences. An empty list means it can be worked from. */
export function validate(queue) {
  const errors = [];
  if (!queue || typeof queue !== 'object' || !Array.isArray(queue.items)) return ['the queue has no "items" list'];
  const ids = new Set();
  for (const [i, it] of queue.items.entries()) {
    const at = 'item ' + (i + 1) + (it && isStr(it.id) ? ' (' + it.id + ')' : '');
    if (!it || typeof it !== 'object') { errors.push(at + ' is not an object'); continue; }
    if (!isStr(it.id) || !/^[a-z0-9][a-z0-9-]*$/.test(it.id)) errors.push(at + ': id must be lower-case letters, digits and dashes');
    else if (ids.has(it.id)) errors.push(at + ': the id is used twice'); else ids.add(it.id);
    if (!isStr(it.title)) errors.push(at + ': no title');
    if (!STATES.includes(it.state)) errors.push(at + ': state must be one of ' + STATES.join(', '));
    if (!KINDS.includes(it.kind)) errors.push(at + ': kind must be one of ' + KINDS.join(', '));
    if (!isStr(it.brief)) errors.push(at + ': no brief (what to do)');
    if (!Array.isArray(it.done_when) || !it.done_when.length || !it.done_when.every(isStr)) errors.push(at + ': done_when must list at least one way to prove it is done');
    if (it.needs != null && (!Array.isArray(it.needs) || !it.needs.every(isStr))) errors.push(at + ': needs must be a list of ids');
    if (it.state === 'blocked' && !isStr(it.why)) errors.push(at + ': a blocked item says why');
    if (it.state === 'done' && !isStr(it.result)) errors.push(at + ': a done item says what proves it (result)');
    if (it.kind === 'owner' && it.state !== 'owner' && it.state !== 'done') errors.push(at + ': something only the owner can do is in state "owner" until it is done');
  }
  for (const it of queue.items) for (const n of (it && it.needs) || []) if (!ids.has(n)) errors.push('item ' + it.id + ' needs "' + n + '", which is not in the queue');
  // a cycle would leave its items waiting on each other for ever
  const byId = new Map(queue.items.filter((x) => x && isStr(x.id)).map((x) => [x.id, x]));
  const seen = new Map();
  const walk = (id, trail) => {
    if (seen.get(id) === 2) return;
    if (seen.get(id) === 1) { errors.push('these items wait on each other: ' + trail.slice(trail.indexOf(id)).concat(id).join(' -> ')); return; }
    seen.set(id, 1);
    for (const n of (byId.get(id) && byId.get(id).needs) || []) if (byId.has(n)) walk(n, trail.concat(id));
    seen.set(id, 2);
  };
  for (const id of byId.keys()) walk(id, []);
  return errors;
}

const doneIds = (queue) => new Set(queue.items.filter((x) => x.state === 'done').map((x) => x.id));

/** The items that can be started now, in queue order: still to do, with everything they need done. */
export function ready(queue) {
  const done = doneIds(queue);
  return queue.items.filter((x) => x.state === 'todo' && (x.needs || []).every((n) => done.has(n)));
}

/**
 * What a run works on. An item left in "doing" comes first: a run that was cut off left it there,
 * and its branch has to be looked at before anything else is started. Then the first ready item.
 * Returns {item, resumed} or null when nothing can be worked on.
 */
export function next(queue) {
  const doing = queue.items.find((x) => x.state === 'doing');
  if (doing) return { item: doing, resumed: true };
  const r = ready(queue);
  return r.length ? { item: r[0], resumed: false } : null;
}

/** Why nothing can be started, for the run's last line and the status page. */
export function idleReason(queue) {
  const left = queue.items.filter((x) => x.state === 'todo');
  if (!queue.items.some((x) => x.state !== 'done' && x.state !== 'owner')) return 'every item an agent can do is done';
  if (!left.length) return 'what is left is blocked or waits on the owner';
  const done = doneIds(queue), byId = new Map(queue.items.map((x) => [x.id, x]));
  const waits = left.map((x) => x.id + ' waits on ' + (x.needs || []).filter((n) => !done.has(n)).map((n) => n + ' (' + (byId.get(n) ? byId.get(n).state : 'missing') + ')').join(', '));
  return 'nothing is ready: ' + waits.join('; ');
}

/** A copy of the queue with one item moved to a new state. Throws on a move that makes no sense. */
export function move(queue, id, state, fields, now) {
  if (!STATES.includes(state)) throw new Error('no such state: ' + state);
  const i = queue.items.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('no item with id "' + id + '"');
  const was = queue.items[i];
  if (state === 'doing') {
    const other = queue.items.find((x) => x.state === 'doing' && x.id !== id);
    if (other) throw new Error('"' + other.id + '" is already being worked on: finish or block it first');
    const done = doneIds(queue), missing = (was.needs || []).filter((n) => !done.has(n));
    if (missing.length) throw new Error('"' + id + '" still needs: ' + missing.join(', '));
    if (was.kind === 'owner') throw new Error('"' + id + '" is for the owner, not for a run');
  }
  if (state === 'done' && !isStr(fields && fields.result)) throw new Error('say what proves it is done (--result): a commit, a test count, a link');
  if (state === 'blocked' && !isStr(fields && fields.why)) throw new Error('say why it is blocked (--why)');
  const it = Object.assign({}, was, fields || {}, { state, updated: now });
  if (state === 'doing' && !was.started) it.started = now;
  if (state !== 'blocked') delete it.why;
  if (state === 'todo') { delete it.started; delete it.run; }
  const items = queue.items.slice(); items[i] = it;
  return Object.assign({}, queue, { items });
}

/** A new item at the end of the queue (or before the first item that is not done, with `first`). */
export function add(queue, item, now, first) {
  const it = Object.assign({ state: 'todo', needs: [] }, item, { added: now, updated: now });
  const q = Object.assign({}, queue, { items: queue.items.slice() });
  if (first) { const i = q.items.findIndex((x) => x.state === 'todo'); q.items.splice(i < 0 ? q.items.length : i, 0, it); } else q.items.push(it);
  const errors = validate(q);
  if (errors.length) throw new Error(errors.join('; '));
  return q;
}

export function counts(queue) {
  const c = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const x of queue.items) c[x.state]++;
  c.total = queue.items.length;
  c.agent = c.total - c.owner;                     // what a run can ever do
  return c;
}

/** Is another run holding the lock? "stale": it stopped saying anything LOCK_STALE_MS ago. */
export function lockState(lock, now, staleMs = LOCK_STALE_MS) {
  if (!lock || !isStr(lock.run) || !Number.isFinite(Date.parse(lock.beat || lock.at))) return 'free';
  return Date.parse(now) - Date.parse(lock.beat || lock.at) > staleMs ? 'stale' : 'held';
}

/* ------------------------------------------------------------------ the status page */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => (isStr(iso) && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
const LABEL = { todo: 'to do', doing: 'in progress', done: 'done', blocked: 'blocked', owner: 'needs the owner' };

/** The whole status page as one self-contained HTML document. */
export function renderHtml({ queue, journal = [], links = [], generated }) {
  const c = counts(queue), n = next(queue), pct = c.agent ? Math.round(100 * c.done / c.agent) : 100;
  const row = (x) => `<tr class="s-${x.state}"><td><span class="chip ${x.state}">${LABEL[x.state]}</span></td><td><b>${esc(x.title)}</b><div class="id">${esc(x.id)}${(x.needs || []).length ? ' &middot; after ' + x.needs.map(esc).join(', ') : ''}</div>${
    x.state === 'done' ? `<div class="note">${esc(x.result)}</div>` : x.state === 'blocked' ? `<div class="note warn">${esc(x.why)}</div>` : `<div class="note">${esc(x.brief)}</div>`}</td><td class="t">${esc(when(x.updated))}</td></tr>`;
  const section = (title, list, lede) => (list.length ? `<h2>${title} <span class="n">${list.length}</span></h2>${lede ? `<p class="lede">${lede}</p>` : ''}<table>${list.map(row).join('')}</table>` : '');
  const by = (s) => queue.items.filter((x) => x.state === s);
  const j = journal.slice(-14).reverse();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operation Titan status</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1c1a;--mute:#6b6862;--line:#e4e1da;--accent:#b7791f;--ok:#2f7d4f;--warn:#b3402a;--blue:#2b5fb3}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--card:#1f1e1b;--ink:#ece9e2;--mute:#9a968d;--line:#33312c;--accent:#e0a94a;--ok:#6cc48d;--warn:#ef8a70;--blue:#8ab0ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 2px;letter-spacing:-.01em}h2{font-size:16px;margin:30px 0 8px}.n{color:var(--mute);font-weight:400}
.sub,.lede{color:var(--mute);margin:0 0 14px}.lede{font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.card span{color:var(--mute);font-size:13px}
.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:6px 0 2px}.bar i{display:block;height:100%;background:var(--ok)}
.now{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:12px 14px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}td:first-child{width:128px}td.t{width:150px;color:var(--mute);font-size:12px;text-align:right;white-space:nowrap}
.chip{display:inline-block;font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.chip.done{color:var(--ok);border-color:var(--ok)}.chip.doing{color:var(--accent);border-color:var(--accent)}.chip.blocked{color:var(--warn);border-color:var(--warn)}.chip.owner{color:var(--blue);border-color:var(--blue)}
.id{color:var(--mute);font:12px ui-monospace,Consolas,monospace;margin-top:1px}.note{color:var(--mute);font-size:13px;margin-top:4px}.note.warn{color:var(--warn)}
ul.links{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}ul.links a{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--ink);text-decoration:none}ul.links a:hover{border-color:var(--accent)}
.log div{padding:7px 0;border-top:1px solid var(--line);font-size:13px}.log div:first-child{border-top:0}.log time{color:var(--mute);font:12px ui-monospace,Consolas,monospace;margin-right:8px}
footer{color:var(--mute);font-size:12px;margin-top:34px}
@media (max-width:560px){td.t{display:none}td:first-child{width:104px}}
</style></head><body><main>
<h1>Operation Titan</h1>
<p class="sub">The work queue for the FTC digital-twin project. Scheduled sessions take the next item, do it, prove it and move on.</p>
<div class="cards">
<div class="card"><b>${c.done} of ${c.agent}</b><span>items done</span><div class="bar"><i style="width:${pct}%"></i></div></div>
<div class="card"><b>${c.doing}</b><span>in progress</span></div>
<div class="card"><b>${ready(queue).length}</b><span>ready to start</span></div>
<div class="card"><b>${c.blocked}</b><span>blocked</span></div>
<div class="card"><b>${c.owner}</b><span>need the owner</span></div>
</div>
<div class="now"><b>${n ? (n.resumed ? 'Being worked on: ' : 'Next up: ') + esc(n.item.title) : 'Nothing to start'}</b><div class="note">${n ? esc(n.item.brief) : esc(idleReason(queue))}</div></div>
${links.length ? `<h2>Links</h2><ul class="links">${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join('')}</ul>` : ''}
${section('In progress', by('doing'))}
${section('Blocked', by('blocked'), 'A run could not finish these. Each says why.')}
${section('Needs the owner', by('owner'), 'Things no agent can do: a measurement on the real robot, an account setting, a decision.')}
${section('To do', by('todo'), 'In order. An item starts once everything it comes after is done.')}
${section('Done', by('done').slice().reverse())}
${j.length ? `<h2>Recent runs</h2><div class="card log">${j.map((e) => `<div><time>${esc(when(e.at))}</time>${e.item ? '<b>' + esc(e.item) + '</b> ' : ''}${esc(e.text)}</div>`).join('')}</div>` : ''}
<footer>Written ${esc(when(generated))} from mission/queue.json by tools/titan.mjs. Nothing on this page is edited by hand.</footer>
</main></body></html>
`;
}
