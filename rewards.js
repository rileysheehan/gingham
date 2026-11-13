// Screen time: a person's minutes for today, kept on the server (rewards.json in the household's folder) so a reload, a
// restart or a power cut loses nothing. It is a record, not a monitor: it never measures a device. The timer counts only
// while someone has started it, and every stop is written into the day's record.
//
// Each day starts from that person's daily allowance; time a grown-up adds (earned, or simply added) and takes away is an
// entry, and so is each stop of the timer. What is left is always worked out from the day's entries, never stored, so the
// record and the number on the wall cannot disagree. Nothing carries over from one day to the next.
//
// Time is the server's, in the household's own zone (zone.js): the frame has no clock battery and has booted into 2009,
// so a timer's start, how long it ran and where a day ends are never asked of the frame. A timer stops by itself when
// the time left runs out, charged exactly to zero; more time is a grown-up's to add, and then someone starts it again. A
// timer still running at midnight is stopped at midnight and charged to the day it ran in. Both are worked out on the
// next read from any frame, so it holds with every frame asleep, off or reloading.
//
// `unit` is stored so that a later reward that is not minutes can be added without moving anyone's history.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {dayIn, midnightIn} = require('./zone');

const UNIT = 'min';
const KEEP_DAYS = 60;                                    // about two months of records; the wall shows today
const MAX_PEOPLE = 8, MAX_ENTRIES = 300;                 // per household, per person per day
const ALLOWANCE = {min: 0, max: 240, step: 5, fallback: 30};
const CHANGE_MAX = 240;                                  // the most added or taken away in one entry
const REASONS = ['chores', 'reading', 'helping', 'other'];
const UNDO_MS = 15000;                                   // a timer's start or stop can be taken back this long, without the PIN
const fail = (status, message) => Object.assign(Error(message), {status});
const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nextDay = day => new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const validAllowance = n => Number.isInteger(n) && n >= ALLOWANCE.min && n <= ALLOWANCE.max && n % ALLOWANCE.step === 0;
const newId = () => crypto.randomBytes(6).toString('hex');

// What a file says, kept only where it makes sense: anything else is dropped rather than trusted.
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !Number.isFinite(Date.parse(e.at))) return null;
  const out = {id: e.id.slice(0, 20), at: new Date(e.at).toISOString(), kind: e.kind, by: typeof e.by === 'string' ? e.by.slice(0, 40) : ''};
  if (e.kind === 'earn' || e.kind === 'adjust') {
    if (!Number.isInteger(e.minutes) || !e.minutes || Math.abs(e.minutes) > CHANGE_MAX) return null;
    out.minutes = e.minutes;
    if (REASONS.includes(e.reason)) out.reason = e.reason;
  } else if (e.kind === 'timer') {
    if (!Number.isInteger(e.seconds) || e.seconds < 0 || !Number.isFinite(Date.parse(e.from))) return null;
    out.seconds = e.seconds; out.from = new Date(e.from).toISOString();
  } else if (e.kind === 'remove') {
    if (typeof e.target !== 'string') return null;
    out.target = e.target.slice(0, 20);
  } else return null;
  return out;
}
function cleanDay(d, fallback) {
  const out = {allowance: validAllowance(d && d.allowance) ? d.allowance : fallback, entries: [], timer: null};
  if (d && Array.isArray(d.entries)) out.entries = d.entries.map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES);
  if (d && d.timer && Number.isFinite(Date.parse(d.timer.since))) out.timer = {since: new Date(d.timer.since).toISOString(), by: typeof d.timer.by === 'string' ? d.timer.by.slice(0, 40) : ''};
  return out;
}
function cleanFile(input) {
  const out = {version: 1, unit: UNIT, people: []};
  for (const p of input && Array.isArray(input.people) ? input.people.slice(0, MAX_PEOPLE) : []) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9]{1,20}$/.test(p.id)) continue;
    const name = text(p.name, 30);
    if (!name) continue;
    const allowance = validAllowance(p.allowance) ? p.allowance : ALLOWANCE.fallback, days = {};
    for (const [day, d] of Object.entries(p.days && typeof p.days === 'object' ? p.days : {})) if (/^\d{4}-\d\d-\d\d$/.test(day)) days[day] = cleanDay(d, allowance);
    out.people.push({id: p.id, name, on: p.on === true, allowance, days});
  }
  return out;
}

// Which entries still count: a removal cancels its target, unless the removal was itself removed (an undo).
function standing(entries) {
  const byTarget = {};
  for (const e of entries) if (e.kind === 'remove') (byTarget[e.target] = byTarget[e.target] || []).push(e);
  const memo = {};
  const counts = e => { if (e.id in memo) return memo[e.id]; memo[e.id] = true; memo[e.id] = !(byTarget[e.id] || []).some(counts); return memo[e.id]; };
  return e => counts(e);
}
// The day's entries that count, added up: minutes given, and seconds used by timers that have stopped.
function totals(day) {
  const counts = standing(day.entries);
  let earned = 0, adjusted = 0, used = 0;
  for (const e of day.entries) {
    if (!counts(e)) continue;
    if (e.kind === 'earn') earned += e.minutes;
    else if (e.kind === 'adjust') adjusted += e.minutes;
    else if (e.kind === 'timer') used += e.seconds;
  }
  return {earned, adjusted, used, total: (day.allowance + earned + adjusted) * 60};
}
// The instant a running timer reaches zero: its start, plus what was left when it started.
function timeUpAt(day) { const t = totals(day); return Date.parse(day.timer.since) + Math.max(0, t.total - t.used) * 1000; }
// The day as the wall shows it, at instant `at`. Seconds, so a timer is charged exactly; the wall rounds for people. A
// running timer never counts past what was left, even in the moment before settle closes it.
function summary(day, at) {
  const t = totals(day);
  const running = day.timer ? Math.min(Math.max(0, t.total - t.used), Math.max(0, Math.floor((at - Date.parse(day.timer.since)) / 1000))) : 0;
  const used = t.used + running;
  return {allowance: day.allowance, earned: t.earned, adjusted: t.adjusted, used, left: t.total - used};
}

// `zone()` is the household's time zone, asked every time, since its owner may change it. `persist: false` keeps
// everything in memory (design review), starting from `initial`.
function createRewards({file, persist = true, initial = null, now = () => Date.now(), zone = () => 'UTC'} = {}) {
  let memory = cleanFile(initial);
  function raw() {
    if (!persist) return JSON.parse(JSON.stringify(memory));
    try { return cleanFile(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') throw fail(503, 'Can’t read the screen time record right now.'); return cleanFile(null); }
  }
  function write(value) {
    if (!persist) { memory = value; return; }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  // A timer stops where its time ran out ("time-up", charged exactly to zero) or where its day ended ("midnight"),
  // whichever came first, and is charged to the day it ran in. Old days go. Says whether anything changed, so a plain
  // read writes nothing on an ordinary minute. After a change, `notBefore` is that change's instant: time taken away
  // from a running timer can put its end in the past, and it then stops now, charged every second it ran.
  function settle(all, at, notBefore = 0) {
    const tz = zone(), oldest = dayIn(tz, at - KEEP_DAYS * 86400000);
    let changed = false;
    for (const p of all.people) for (const day of Object.keys(p.days)) {
      const d = p.days[day];
      if (day < oldest) { delete p.days[day]; changed = true; continue; }
      if (!d.timer) continue;
      const up = timeUpAt(d), midnight = Date.parse(midnightIn(tz, nextDay(day))), end = Math.max(notBefore, Math.min(up, midnight));
      if (end > at) continue;
      const since = Date.parse(d.timer.since);
      d.entries.push({id: newId(), at: new Date(end).toISOString(), kind: 'timer', seconds: Math.max(0, Math.floor((end - since) / 1000)), from: d.timer.since, by: up <= midnight ? 'time-up' : 'midnight'});
      d.timer = null; changed = true;
    }
    return changed;
  }
  const todayOf = (p, at) => { const day = dayIn(zone(), at); if (!p.days[day]) p.days[day] = {allowance: p.allowance, entries: [], timer: null}; return p.days[day]; };
  function personIn(all, id) { const p = all.people.find(x => x.id === id); if (!p) throw fail(404, 'That person has no screen time here.'); return p; }
  function view(all, at) {
    const day = dayIn(zone(), at);
    return {unit: all.unit, day, now: at, people: all.people.map(p => {
      const d = p.days[day] || {allowance: p.allowance, entries: [], timer: null}, s = summary(d, at), counts = standing(d.entries);
      const removedAt = {};
      for (const e of d.entries) if (e.kind === 'remove' && counts(e)) removedAt[e.target] = Date.parse(e.at);
      const entries = d.entries.filter(e => e.kind !== 'remove').map(e => ({id: e.id, at: Date.parse(e.at), kind: e.kind,
        ...(e.kind === 'timer' ? {seconds: e.seconds, from: Date.parse(e.from)} : {minutes: e.minutes}), ...(e.by === 'time-up' ? {timeUp: true} : {}), ...(e.reason ? {reason: e.reason} : {}),
        ...(e.id in removedAt ? {removed: removedAt[e.id]} : {})})).reverse();
      return {id: p.id, name: p.name, on: p.on, nextAllowance: p.allowance, ...s, timer: d.timer ? {since: Date.parse(d.timer.since)} : null, entries};
    })};
  }
  function read() {
    const at = now(), all = raw();
    if (settle(all, at)) write(all);
    return view(all, at);
  }
  // Every change: read, settle, change, write whole, answer with the day as it now is. `result` is what the change made,
  // for the wall's Undo.
  function change(fn) {
    const at = now(), all = raw();
    settle(all, at);
    const result = fn(all, at);
    settle(all, at, at);
    write(all);
    return {...view(all, at), ...(result ? {changed: result} : {})};
  }
  function push(d, entry) { if (d.entries.length >= MAX_ENTRIES) throw fail(409, 'Today’s record is full.'); d.entries.push(entry); return entry.id; }

  return {
    read,
    // Anyone at the frame may start or stop the timer; the record shows every stop.
    start: (id, by) => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at);
      if (!p.on) throw fail(404, 'That person has no screen time here.');
      if (d.timer) return null;
      if (summary(d, at).left <= 0) throw fail(409, 'No time left today. A grown-up can add time.');
      d.timer = {since: new Date(at).toISOString(), by: String(by || '')};
      return {kind: 'start'};
    }),
    stop: (id, by) => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at);
      if (!d.timer) return null;
      const since = Date.parse(d.timer.since);
      const entry = push(d, {id: newId(), at: new Date(at).toISOString(), kind: 'timer', seconds: Math.max(0, Math.floor((at - since) / 1000)), from: d.timer.since, by: String(by || '')});
      d.timer = null;
      return {kind: 'stop', entry};
    }),
    // Undo of a start, for a few seconds: as if it never ran. Later, it is a stop like any other.
    cancelStart: id => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at);
      if (!d.timer || at - Date.parse(d.timer.since) > UNDO_MS) throw fail(409, 'That can’t be undone now. Stop the timer instead.');
      d.timer = null;
      return {kind: 'cancel'};
    }),
    // Undo of a stop, for a few seconds: the timer carries on from when it started, so every second is still charged. A
    // timer that time's up stopped, or that would have run out since its stop, stays stopped.
    resume: (id, entryId) => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at), last = d.entries[d.entries.length - 1];
      if (d.timer || !last || last.id !== entryId || last.kind !== 'timer' || at - Date.parse(last.at) > UNDO_MS) throw fail(409, 'That can’t be undone now.');
      const upNow = 'Time’s up. A grown-up can add time.';
      if (last.by === 'time-up') throw fail(409, upNow);
      d.entries.pop();
      d.timer = {since: last.from, by: last.by};
      if (timeUpAt(d) <= at) throw fail(409, upNow);
      return {kind: 'resume'};
    }),
    // A grown-up's change, behind the PIN (server.js checks the manage token): time added, earned (added with a reason)
    // or taken away.
    adjust: (id, minutes, reason, by) => change((all, at) => {
      if (!Number.isInteger(minutes) || !minutes || Math.abs(minutes) > CHANGE_MAX) throw fail(400, 'Add or take away 1 to ' + CHANGE_MAX + ' minutes.');
      if (reason != null && !(minutes > 0 && REASONS.includes(reason))) throw fail(400, 'A reason goes with time added: ' + REASONS.join(', ') + '.');
      const p = personIn(all, id), d = todayOf(p, at);
      const entry = push(d, {id: newId(), at: new Date(at).toISOString(), kind: reason ? 'earn' : 'adjust', minutes, ...(reason ? {reason} : {}), by: String(by || '')});
      return {kind: 'adjust', entry};
    }),
    // Any of today's entries, or a removal (which puts its entry back). The removal is an entry of its own.
    remove: (id, target, by) => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at), found = d.entries.find(e => e.id === target);
      if (!found) throw fail(404, 'That is not in today’s record.');
      const counts = standing(d.entries);
      if (!counts(found)) throw fail(409, 'That is already removed.');
      const entry = push(d, {id: newId(), at: new Date(at).toISOString(), kind: 'remove', target, by: String(by || '')});
      return {kind: 'remove', entry};
    }),
    // The undo of a removal: the removal is removed, so its entry counts again. Found by the entry it removed.
    restore: (id, target, by) => change((all, at) => {
      const p = personIn(all, id), d = todayOf(p, at), counts = standing(d.entries);
      const removal = d.entries.filter(e => e.kind === 'remove' && e.target === target && counts(e)).pop();
      if (!removal) throw fail(409, 'That is not removed.');
      push(d, {id: newId(), at: new Date(at).toISOString(), kind: 'remove', target: removal.id, by: String(by || '')});
      return {kind: 'restore'};
    }),
    // Someone new, or a change to someone: on or off, their name, and the allowance their days start with. A new allowance
    // starts tomorrow: today keeps the one it started with (and changes through an entry). Turning someone off stops
    // their timer first, so nothing runs where nobody can see it. Their record stays.
    person: ({id, name, on, allowance}, by) => change((all, at) => {
      if (allowance !== undefined && !validAllowance(allowance)) throw fail(400, 'A daily allowance is 0 to ' + ALLOWANCE.max + ' minutes, in steps of ' + ALLOWANCE.step + '.');
      if (on !== undefined && typeof on !== 'boolean') throw fail(400, 'Send on as true or false.');
      let p;
      if (id === undefined) {
        const named = text(name, 30);
        if (!named) throw fail(400, 'Give them a name.');
        if (all.people.length >= MAX_PEOPLE) throw fail(409, 'Screen time is kept for at most ' + MAX_PEOPLE + ' people.');
        p = {id: newId(), name: named, on: on !== false, allowance: allowance === undefined ? ALLOWANCE.fallback : allowance, days: {}};
        all.people.push(p);
        return {kind: 'person', id: p.id};
      }
      p = personIn(all, String(id));
      const d = todayOf(p, at);
      if (name !== undefined) { const named = text(name, 30); if (!named) throw fail(400, 'Give them a name.'); p.name = named; }
      if (allowance !== undefined) p.allowance = allowance;
      if (on === false && d.timer) {
        push(d, {id: newId(), at: new Date(at).toISOString(), kind: 'timer', seconds: Math.max(0, Math.floor((at - Date.parse(d.timer.since)) / 1000)), from: d.timer.since, by: String(by || '')});
        d.timer = null;
      }
      if (on !== undefined) p.on = on;
      return {kind: 'person', id: p.id};
    })
  };
}

// Who may change time, held in this server's memory only: a long random token handed to a frame for the household's PIN,
// bound to that frame and household, forgotten after two minutes without use, and gone at Lock or a restart. Only its
// hash is kept, so not even a dump of this process's memory poses as a frame that is unlocked.
const IDLE_MS = 120000, MAX_TOKENS = 500;
function createManageTokens({now = () => Date.now()} = {}) {
  const held = new Map();
  const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
  const prune = at => { for (const [k, t] of held) if (at - t.used > IDLE_MS) held.delete(k); };
  return {
    IDLE_MS,
    issue(household, grant) {
      const at = now(); prune(at);
      if (held.size >= MAX_TOKENS) held.delete(held.keys().next().value);
      const token = crypto.randomBytes(32).toString('base64url');
      held.set(hash(token), {household, grant, used: at});
      return token;
    },
    // True for a token this server gave this frame of this household, used within the last two minutes; a use renews it.
    check(token, household, grant) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
      const at = now(), key = hash(token), t = held.get(key);
      if (!t) return false;
      if (at - t.used > IDLE_MS) { held.delete(key); return false; }
      if (t.household !== household || t.grant !== grant) return false;
      t.used = at;
      return true;
    },
    revoke(token) { if (typeof token === 'string') held.delete(hash(token)); },
    size: () => held.size
  };
}

module.exports = {createRewards, createManageTokens, summary, standing, cleanFile, REASONS, ALLOWANCE, UNDO_MS, KEEP_DAYS, UNIT};
