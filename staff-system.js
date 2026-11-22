// Staff management data layer for the !staff panel — members, ranks, check-ins,
// work (tasks), leave, reports, history and the weekly report numbers.
// Everything lives under store.staffSystem in the per-guild store (storage.js),
// so it works the same on the JSON file and on PostgreSQL. All functions here
// are synchronous: read the store, change it, save it.
const { getGuildStore, saveGuildStore } = require('./storage');
const staffActivity = require('./staff-activity');

// Promotion ladder — edit this list to rename / add ranks.
const RANKS = ['Trial Staff', 'Staff', 'Senior Staff', 'Head Staff', 'Manager'];

// A staff member with no check-in / finished work / report for this many days
// (and not on leave) counts as inactive.
const INACTIVE_AFTER_DAYS = 7;

// The weekly report goes out every Sunday at this hour, UTC (18 = 23:30 IST).
const WEEKLY_HOUR_UTC = 18;

const DAY_MS = 86400000;
const MAX_HISTORY = 1000;
const MAX_REPORTS = 200;
const MAX_DONE_TASKS = 400;

function defaults() {
  return {
    members: {},          // userId -> member (see registerMember)
    tasks: [],            // { id, title, details, assigneeId, by, createdAt, done, doneAt }
    reports: [],          // { id, userId, subject, details, at }
    history: [],          // { at, type, userId, by, text }
    rules: '',
    reportChannelId: null,
    leaveRoleId: null,    // auto-created "Staff On Leave" role (see staff-panel-handlers)
    weeklyEnabled: true,
    lastWeeklyAt: null,
    lastMorningDm: null,  // day key (STAFF_TZ) the 9 AM check-in reminder DMs were last sent
    lastEveningDm: null,  // day key (STAFF_TZ) the 10:30 PM check-out reminder DMs were last sent
    panelMessages: [],    // [{ channelId, messageId }] — !staff panel messages the bot keeps up to date
    nextTaskId: 1,
    nextReportId: 1,
  };
}

function open(guildId) {
  const store = getGuildStore(guildId);
  const d = defaults();
  if (!store.staffSystem) store.staffSystem = d;
  for (const key of Object.keys(d)) {
    if (store.staffSystem[key] === undefined) store.staffSystem[key] = d[key];
  }
  return { store, sys: store.staffSystem };
}

function commit(guildId, store) {
  saveGuildStore(guildId, store);
}

function pushHistory(sys, type, userId, text, by) {
  sys.history.push({ at: Date.now(), type, userId: userId || null, by: by || null, text: String(text || '').slice(0, 300) });
  if (sys.history.length > MAX_HISTORY) sys.history.splice(0, sys.history.length - MAX_HISTORY);
}

// True while a leave is actually running (FROM has started, TO has not ended).
function onLeaveNow(m, now = Date.now()) {
  return Boolean(m.leaveUntil && m.leaveUntil > now && (!m.leaveFrom || m.leaveFrom <= now));
}

function statusOf(member, now = Date.now()) {
  if (onLeaveNow(member, now)) return 'leave';
  const last = member.lastActiveAt || member.joinedAt || 0;
  if (now - last > INACTIVE_AFTER_DAYS * DAY_MS) return 'inactive';
  return 'active';
}

function decorate(member, openCounts, now) {
  return {
    ...member,
    status: statusOf(member, now),
    openTasks: openCounts[member.userId] || 0,
    rankName: RANKS[member.rank] || RANKS[0],
  };
}

function openCountsOf(sys) {
  const counts = {};
  for (const t of sys.tasks) if (!t.done) counts[t.assigneeId] = (counts[t.assigneeId] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- members
function listMembers(guildId) {
  const { sys } = open(guildId);
  const now = Date.now();
  const counts = openCountsOf(sys);
  return Object.values(sys.members)
    .map(m => decorate(m, counts, now))
    .sort((a, b) => (b.rank - a.rank) || String(a.name).localeCompare(String(b.name)));
}

function getMember(guildId, userId) {
  const { sys } = open(guildId);
  const m = sys.members[userId];
  return m ? decorate(m, openCountsOf(sys), Date.now()) : null;
}

// Adds a staff member, or updates their entry form if they're already listed.
// info: { name, position, availability, notes } — all optional.
function registerMember(guildId, userId, info = {}, by = null) {
  const { store, sys } = open(guildId);
  const now = Date.now();
  let m = sys.members[userId];
  const isNew = !m;
  if (!m) {
    m = sys.members[userId] = {
      userId, name: '', position: 'Staff', availability: '', notes: '',
      rank: 0, joinedAt: now, lastActiveAt: now, checkins: 0, tasksDone: 0,
      leaveUntil: null, recentCheckins: [],
    };
  }
  if (info.name) m.name = String(info.name).slice(0, 60);
  if (info.position) m.position = String(info.position).slice(0, 60);
  if (info.availability !== undefined) m.availability = String(info.availability).slice(0, 100);
  if (info.notes !== undefined) m.notes = String(info.notes).slice(0, 500);
  if (info.contact !== undefined) m.contact = String(info.contact).slice(0, 30);
  if (info.email !== undefined) m.email = String(info.email).slice(0, 100);
  pushHistory(sys, isNew ? 'join' : 'update', userId, isNew ? `Added to staff as ${m.position}` : 'Staff entry updated', by || userId);
  commit(guildId, store);
  return { member: decorate(m, openCountsOf(sys), now), isNew };
}

// Staff photo: a small JPEG kept as base64 on the member (set from the admin's
// Staff Entry Form upload). null / '' removes it.
function setMemberPhoto(guildId, userId, base64) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  if (base64) m.photo = String(base64); else delete m.photo;
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), Date.now());
}

// Staff role taken away by hand in Discord: shown in the history only. It does
// NOT change status or leave, and doesn't remove them from the staff list.
function logRoleRemoved(guildId, userId, by = null) {
  const { store, sys } = open(guildId);
  if (!sys.members[userId]) return false;
  pushHistory(sys, 'role_removed', userId, 'Staff role removed manually', by);
  commit(guildId, store);
  return true;
}

function removeMember(guildId, userId, by = null, reason = 'Removed from the staff list') {
  const { store, sys } = open(guildId);
  if (!sys.members[userId]) return false;
  delete sys.members[userId];
  // Their unfinished work goes away with them; finished work stays for the record.
  sys.tasks = sys.tasks.filter(t => t.done || t.assigneeId !== userId);
  pushHistory(sys, 'remove', userId, reason, by);
  commit(guildId, store);
  return true;
}

// ---------------------------------------------------------------- check-in
function checkIn(guildId, userId, note) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  const now = Date.now();
  m.checkins = (m.checkins || 0) + 1;
  m.lastActiveAt = now;
  m.recentCheckins = [...(m.recentCheckins || []), now].slice(-60);
  if (onLeaveNow(m, now)) { m.leaveUntil = null; m.leaveFrom = null; } // checking in ends a running leave early
  pushHistory(sys, 'checkin', userId, note, userId);
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), now);
}


// ------------------------------------------------- daily shift (check-in / out)
// One shift per staff member per calendar day, in STAFF_TZ (default IST):
//   • check-in opens at 9:00 AM — form: Active timing (Discord name is fetched
//     automatically by the panel)
//   • check-out must happen before midnight — form: what work was done
//   • a day only COUNTS (check-in total, weekly report, leaderboard, last
//     active) once it has been checked out. Forgetting to check out before
//     midnight = that day is recorded as missed and is not counted.
// Stored on the member: member.attendance = { open, days }.
let STAFF_TZ = process.env.STAFF_TZ || 'Asia/Kolkata';
try { new Intl.DateTimeFormat('en-GB', { timeZone: STAFF_TZ }); } catch { STAFF_TZ = 'Asia/Kolkata'; }
const CHECKIN_OPENS_HOUR = 9;
const MAX_ATTENDANCE_DAYS = 90;

function tzParts(ms = Date.now()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: STAFF_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return { dayKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// ---- leave dates (FROM / TO), read in STAFF_TZ
function tzOffsetMs(ms) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: STAFF_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Midnight (00:00) at the start of y-m-d in STAFF_TZ, as a timestamp. Days can overflow (d+1).
function dayStartMs(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - tzOffsetMs(guess);
  ms = guess - tzOffsetMs(ms);
  return ms;
}

function formatDay(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: STAFF_TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "12/10/2026", "12-10-26", "12.10", "2026-10-12", "12 Oct", "12 October 2026"  ->  { y, m, d } or null
function parseDateInput(text, now = Date.now()) {
  const thisYear = Number(tzParts(now).dayKey.slice(0, 4));
  const t = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ');
  let y; let m; let d; let match;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(t))) {
    d = +match[1]; m = +match[2]; y = match[3] ? (match[3].length === 2 ? 2000 + +match[3] : +match[3]) : thisYear;
  } else if ((match = /^(\d{1,2}) ?([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(t)) || (match = /^([a-z]{3,9})\.? (\d{1,2})(?: (\d{4}))?$/.exec(t))) {
    const dayFirst = /^\d/.test(t);
    const monthWord = dayFirst ? match[2] : match[1];
    d = +(dayFirst ? match[1] : match[2]);
    m = MONTHS.indexOf(monthWord.slice(0, 3)) + 1;
    y = match[3] ? +match[3] : thisYear;
    if (!m) return null;
  } else {
    return null;
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

// A shift left open past midnight is closed as "missed" (not counted).
// Returns true when it changed something (caller commits).
function settleShift(m, now) {
  if (!m.attendance) m.attendance = { open: null, days: {} };
  const a = m.attendance;
  if (!a.days) a.days = {};
  if (a.open && a.open.dayKey !== tzParts(now).dayKey) {
    a.days[a.open.dayKey] = { in: a.open.at, out: null, name: a.open.name, timings: a.open.timings, plan: a.open.plan || '', work: '', counted: false };
    a.open = null;
    m.missed = (m.missed || 0) + 1;
    const keys = Object.keys(a.days).sort();
    while (keys.length > MAX_ATTENDANCE_DAYS) delete a.days[keys.shift()];
    return true;
  }
  return false;
}

// null (not on the staff list) or { state: 'none' | 'open' | 'done', open, today, hour, minute }
function shiftState(guildId, userId, now = Date.now()) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  if (settleShift(m, now)) commit(guildId, store);
  const t = tzParts(now);
  const a = m.attendance;
  const today = a.days[t.dayKey] || null;
  return {
    state: a.open ? 'open' : (today && today.counted ? 'done' : 'none'),
    open: a.open, today, hour: t.hour, minute: t.minute, opensHour: CHECKIN_OPENS_HOUR, tz: STAFF_TZ,
  };
}

// -> { error: 'not_member' | 'already_in' | 'already_done' | 'too_early' } or { ok, open }
function startShift(guildId, userId, { name, timings, plan }, now = Date.now()) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return { error: 'not_member' };
  const changed = settleShift(m, now);
  const t = tzParts(now);
  const a = m.attendance;
  if (a.open) { if (changed) commit(guildId, store); return { error: 'already_in', open: a.open }; }
  if (a.days[t.dayKey] && a.days[t.dayKey].counted) { if (changed) commit(guildId, store); return { error: 'already_done', today: a.days[t.dayKey] }; }
  if (t.hour < CHECKIN_OPENS_HOUR) { if (changed) commit(guildId, store); return { error: 'too_early', hour: t.hour, minute: t.minute }; }

  const cleanTimings = String(timings || '').trim().slice(0, 100);
  const cleanPlan = String(plan || '').trim().slice(0, 500);
  a.open = { dayKey: t.dayKey, at: now, name: String(name || m.name || '').slice(0, 60), timings: cleanTimings, plan: cleanPlan };
  if (cleanTimings) m.availability = cleanTimings;
  if (!m.name && name) m.name = String(name).slice(0, 60);
  if (onLeaveNow(m, now)) { m.leaveUntil = null; m.leaveFrom = null; } // checking in ends a running leave early
  pushHistory(sys, 'checkin', userId, `Checked in${cleanTimings ? ` — active ${cleanTimings}` : ''}${cleanPlan ? ` — can do: ${cleanPlan}` : ''}`, userId);
  commit(guildId, store);
  return { ok: true, open: a.open, member: decorate(m, openCountsOf(sys), now) };
}

// -> { error: 'not_member' | 'not_in' | 'expired' } or { ok, shift, member }
function endShift(guildId, userId, work, now = Date.now(), tasks = []) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return { error: 'not_member' };
  const expired = settleShift(m, now);
  const a = m.attendance;
  if (!a.open) {
    if (expired) { commit(guildId, store); return { error: 'expired' }; }
    return { error: 'not_in' };
  }
  const cleanWork = String(work || '').trim().slice(0, 1000);
  const taskList = (tasks || []).slice(0, 30).map(t => ({ id: t.id, title: String(t.title).slice(0, 100), done: Boolean(t.done) }));
  const shift = { in: a.open.at, out: now, name: a.open.name, timings: a.open.timings, plan: a.open.plan || '', work: cleanWork, tasks: taskList, counted: true };
  a.days[a.open.dayKey] = shift;
  a.open = null;
  m.checkins = (m.checkins || 0) + 1;
  m.lastActiveAt = now;
  m.recentCheckins = [...(m.recentCheckins || []), now].slice(-60);
  pushHistory(sys, 'checkout', userId, `${taskList.length ? `[tasks ${taskList.filter(t => t.done).length}/${taskList.length} done] ` : ''}${cleanWork}`, userId);
  commit(guildId, store);
  return { ok: true, shift, member: decorate(m, openCountsOf(sys), now) };
}

// Reset of the whole staff panel: staff list, ranks, check-ins / shifts, leave,
// work, reports and history all go back to empty. Settings are kept (rules,
// report channel, weekly on/off, leave role). Returns what was removed.
function resetAll(guildId) {
  const { store, sys } = open(guildId);
  const removed = {
    members: Object.keys(sys.members).length,
    tasks: sys.tasks.length,
    reports: sys.reports.length,
    history: sys.history.length,
  };
  const d = defaults();
  sys.members = d.members;
  sys.tasks = d.tasks;
  sys.reports = d.reports;
  sys.history = d.history;
  sys.nextTaskId = d.nextTaskId;
  sys.nextReportId = d.nextReportId;
  commit(guildId, store);
  return removed;
}

// ---------------------------------------------------------------- promote
// Returns null (not staff), { maxed: true, rankName } or { from, to }.
function promote(guildId, userId, by = null) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  if (m.rank >= RANKS.length - 1) return { maxed: true, rankName: RANKS[m.rank] };
  const from = RANKS[m.rank];
  m.rank += 1;
  const to = RANKS[m.rank];
  pushHistory(sys, 'promote', userId, `${from} → ${to}`, by);
  commit(guildId, store);
  return { from, to };
}

// ---------------------------------------------------------------- work
function createTasks(guildId, { title, details, assigneeIds, by }) {
  const { store, sys } = open(guildId);
  const created = [];
  for (const assigneeId of assigneeIds) {
    if (!sys.members[assigneeId]) continue;
    const task = {
      id: sys.nextTaskId++,
      title: String(title).slice(0, 100),
      details: String(details || '').slice(0, 500),
      assigneeId, by, createdAt: Date.now(), done: false, doneAt: null,
    };
    sys.tasks.push(task);
    pushHistory(sys, 'task_assigned', assigneeId, `#${task.id} ${task.title}`, by);
    created.push(task);
  }
  // Keep the file small: drop the oldest finished tasks past the cap.
  const done = sys.tasks.filter(t => t.done);
  if (done.length > MAX_DONE_TASKS) {
    const drop = new Set(done.sort((a, b) => a.doneAt - b.doneAt).slice(0, done.length - MAX_DONE_TASKS).map(t => t.id));
    sys.tasks = sys.tasks.filter(t => !drop.has(t.id));
  }
  commit(guildId, store);
  return created;
}

// ---------------------------------------------------------- work board (pick)
// Admins post a batch of tasks (Distribute Work); each task starts UNCLAIMED
// (assigneeId null) and a staff member takes it with the Pick button.
function createPoolTasks(guildId, { titles, by }) {
  const { store, sys } = open(guildId);
  const batchId = `b${Date.now().toString(36)}`;
  const tasks = titles.map(title => {
    const task = {
      id: sys.nextTaskId++, title: String(title).slice(0, 100), details: '',
      assigneeId: null, by, createdAt: Date.now(), done: false, doneAt: null,
      batchId, pickedAt: null, channelId: null, messageId: null,
    };
    sys.tasks.push(task);
    return task;
  });
  pushHistory(sys, 'work_posted', null, `${tasks.length} task(s) posted for picking`, by);
  commit(guildId, store);
  return { batchId, tasks };
}

// Work posted with Distribute Work can only be PICKED on the day it was posted:
// from 12 AM (STAFF_TZ) nobody can pick it any more. Its board message then
// stays in the channel (locked) until it is 24 hours old — see expireOldTasks.
function startOfToday(now = Date.now()) {
  const dk = tzParts(now).dayKey;
  return dayStartMs(+dk.slice(0, 4), +dk.slice(5, 7), +dk.slice(8, 10));
}
function pickingClosed(task, now = Date.now()) {
  return Boolean(task && task.batchId && typeof task.createdAt === 'number' && task.createdAt < startOfToday(now));
}

// Boards that just passed 12 AM and still need their message locked (once per
// batch). Returns one task per batch so the caller can edit its message.
function closeStaleBoards(guildId, now = Date.now()) {
  const { store, sys } = open(guildId);
  const reps = new Map();
  for (const t of sys.tasks) {
    if (!t.boardClosed && t.batchId && t.messageId && pickingClosed(t, now)) {
      reps.set(t.batchId, t);
    }
  }
  if (!reps.size) return [];
  for (const t of sys.tasks) if (reps.has(t.batchId)) t.boardClosed = true;
  commit(guildId, store);
  return [...reps.values()];
}

// Work posted with Distribute Work disappears 24 hours after it was posted:
// every UNFINISHED task that old is removed (finished ones stay — they feed the
// weekly report numbers). Returns { removed } so the caller can delete the
// board messages.
function expireOldTasks(guildId, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  const { store, sys } = open(guildId);
  const cutoff = now - maxAgeMs;
  const removed = sys.tasks.filter(t => !t.done && t.batchId && typeof t.createdAt === 'number' && t.createdAt <= cutoff);
  if (!removed.length) return { removed: [] };
  const gone = new Set(removed.map(t => t.id));
  sys.tasks = sys.tasks.filter(t => !gone.has(t.id));
  commit(guildId, store);
  return { removed };
}

function getAllTasks(guildId) { return open(guildId).sys.tasks.slice(); }

function getBatchTasks(guildId, batchId) {
  const { sys } = open(guildId);
  return sys.tasks.filter(t => t.batchId === batchId).sort((a, b) => a.id - b.id);
}

function setBatchMessage(guildId, batchId, { channelId, messageId }) {
  const { store, sys } = open(guildId);
  for (const t of sys.tasks) if (t.batchId === batchId) { t.channelId = channelId; t.messageId = messageId; }
  commit(guildId, store);
}

// Throws the batch away again (used when the board message couldn't be posted).
function cancelBatch(guildId, batchId) {
  const { store, sys } = open(guildId);
  sys.tasks = sys.tasks.filter(t => t.batchId !== batchId);
  commit(guildId, store);
}

// First press wins. -> { ok, task } or { error: 'gone' | 'taken' | 'not_member' | 'on_leave' | 'done', task }
function claimTask(guildId, taskId, userId) {
  const { store, sys } = open(guildId);
  const task = sys.tasks.find(t => t.id === Number(taskId));
  if (!task) return { error: 'gone' };
  if (task.done) return { error: 'done', task };
  if (task.assigneeId) return { error: 'taken', task };
  if (pickingClosed(task)) return { error: 'closed', task };
  const m = sys.members[userId];
  if (!m) return { error: 'not_member', task };
  if (onLeaveNow(m)) return { error: 'on_leave', task };
  task.assigneeId = userId;
  task.pickedAt = Date.now();
  pushHistory(sys, 'task_picked', userId, `#${task.id} ${task.title}`, userId);
  commit(guildId, store);
  return { ok: true, task };
}

// Staff gives a picked (unfinished) task back to the board.
function unclaimTask(guildId, taskId, userId) {
  const { store, sys } = open(guildId);
  const task = sys.tasks.find(t => t.id === Number(taskId));
  if (!task) return { error: 'gone' };
  if (task.done) return { error: 'done', task };
  if (task.assigneeId !== userId) return { error: 'not_yours', task };
  task.assigneeId = null;
  task.pickedAt = null;
  pushHistory(sys, 'task_released', userId, `#${task.id} ${task.title}`, userId);
  commit(guildId, store);
  return { ok: true, task };
}

// The n least-busy staff members who aren't on leave (active ones first).
function pickLeastBusy(guildId, n = 1) {
  const members = listMembers(guildId).filter(m => m.status !== 'leave');
  const pool = members.some(m => m.status === 'active') ? members.filter(m => m.status === 'active') : members;
  return pool
    .sort((a, b) => (a.openTasks - b.openTasks) || (a.tasksDone - b.tasksDone))
    .slice(0, n)
    .map(m => m.userId);
}

function getOpenTasks(guildId, userId = null) {
  const { sys } = open(guildId);
  return sys.tasks
    .filter(t => !t.done && (!userId || t.assigneeId === userId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function getTask(guildId, taskId) {
  const { sys } = open(guildId);
  return sys.tasks.find(t => t.id === Number(taskId)) || null;
}

function completeTask(guildId, taskId, by = null) {
  const { store, sys } = open(guildId);
  const task = sys.tasks.find(t => t.id === Number(taskId));
  if (!task || task.done) return null;
  const now = Date.now();
  task.done = true;
  task.doneAt = now;
  const m = sys.members[task.assigneeId];
  if (m) { m.tasksDone = (m.tasksDone || 0) + 1; m.lastActiveAt = now; }
  pushHistory(sys, 'task_done', task.assigneeId, `#${task.id} ${task.title}`, by);
  commit(guildId, store);
  return task;
}

// A staff member's tasks for the check-out screen: everything still open that
// is assigned to them, plus what they finished today (STAFF_TZ day).
function getTasksForCheckout(guildId, userId, now = Date.now()) {
  const { sys } = open(guildId);
  const t = tzParts(now);
  const todayStart = dayStartMs(+t.dayKey.slice(0, 4), +t.dayKey.slice(5, 7), +t.dayKey.slice(8, 10));
  return sys.tasks
    .filter(x => x.assigneeId === userId && (!x.done || (x.doneAt && x.doneAt >= todayStart)))
    .sort((a, b) => a.id - b.id);
}

// Undo of completeTask (the check-out screen lets people flip Done / Not done).
function uncompleteTask(guildId, taskId, by = null) {
  const { store, sys } = open(guildId);
  const task = sys.tasks.find(t => t.id === Number(taskId));
  if (!task || !task.done) return null;
  task.done = false;
  task.doneAt = null;
  const m = sys.members[task.assigneeId];
  if (m) m.tasksDone = Math.max(0, (m.tasksDone || 0) - 1);
  pushHistory(sys, 'task_reopened', task.assigneeId, `#${task.id} ${task.title}`, by);
  commit(guildId, store);
  return task;
}

// ---------------------------------------------------------------- leave
function setLeave(guildId, userId, fromMs, toMs, reason) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  m.leaveFrom = fromMs;
  m.leaveUntil = toMs; // exclusive: the start of the day AFTER the "TO" date
  pushHistory(sys, 'leave', userId, `${formatDay(fromMs)} → ${formatDay(toMs - 1)}${reason ? ` — ${reason}` : ''}`, userId);
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), Date.now());
}

// ---- panel messages kept up to date automatically
function listPanelMessages(guildId) { return open(guildId).sys.panelMessages.slice(); }
function addPanelMessage(guildId, ref) {
  const { store, sys } = open(guildId);
  if (sys.panelMessages.some(p => p.messageId === ref.messageId)) return false;
  sys.panelMessages.push({ channelId: ref.channelId, messageId: ref.messageId });
  if (sys.panelMessages.length > 20) sys.panelMessages.shift();
  commit(guildId, store);
  return true;
}
function removePanelMessage(guildId, messageId) {
  const { store, sys } = open(guildId);
  sys.panelMessages = sys.panelMessages.filter(p => p.messageId !== messageId);
  commit(guildId, store);
}

// ---- 9 AM check-in reminder (once per day)
function getMorningDay(guildId) { return open(guildId).sys.lastMorningDm || null; }
function setMorningDay(guildId, dayKey) {
  const { store, sys } = open(guildId);
  sys.lastMorningDm = dayKey;
  commit(guildId, store);
}

// ---- DM report schedules (daily list / weekly staff reports / monthly report) — once each
function getDmReportMark(guildId, kind) { return (open(guildId).sys.dmReportMarks || {})[kind] || null; }
function setDmReportMark(guildId, kind, mark) {
  const { store, sys } = open(guildId);
  if (!sys.dmReportMarks) sys.dmReportMarks = {};
  sys.dmReportMarks[kind] = mark;
  commit(guildId, store);
}

// ---- 10:30 PM check-out reminder (once per day)
function getEveningDay(guildId) { return open(guildId).sys.lastEveningDm || null; }
function setEveningDay(guildId, dayKey) {
  const { store, sys } = open(guildId);
  sys.lastEveningDm = dayKey;
  commit(guildId, store);
}

// Staff came back early: the leave is dropped (roles are restored by the handler).
function cancelLeave(guildId, userId, by = null) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m || !m.leaveUntil || m.leaveUntil <= Date.now()) return null;
  const was = `${formatDay(m.leaveFrom || Date.now())} → ${formatDay(m.leaveUntil - 1)}`;
  const msg = m.leaveMsg || null;
  m.leaveFrom = null;
  m.leaveUntil = null;
  delete m.leaveMsg;
  pushHistory(sys, 'leave_cancelled', userId, `Leave cancelled (was ${was})`, by || userId);
  commit(guildId, store);
  return { member: decorate(m, openCountsOf(sys), Date.now()), was, msg };
}
function setLeaveMessage(guildId, userId, ref) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return;
  m.leaveMsg = ref;
  commit(guildId, store);
}

// ---- leave roles (the Discord roles themselves are swapped by staff-panel-handlers)
function getLeaveRoleId(guildId) { return open(guildId).sys.leaveRoleId || null; }
function setLeaveRoleId(guildId, roleId) {
  const { store, sys } = open(guildId);
  sys.leaveRoleId = roleId || null;
  commit(guildId, store);
}
// member.leaveRoles = { removedStaff } while the staff role is swapped out for the leave role; null otherwise.
function setLeaveRoles(guildId, userId, value) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  if (value) m.leaveRoles = value; else delete m.leaveRoles;
  commit(guildId, store);
  return m.leaveRoles || null;
}
// Staff whose leave is over (expired, or ended early by a check-in) but whose roles are still swapped.
function listRoleRestoreDue(guildId, now = Date.now()) {
  const { sys } = open(guildId);
  return Object.values(sys.members)
    .filter(m => m.leaveRoles && !onLeaveNow(m, now))
    .map(m => m.userId);
}
// Staff whose leave has started (FROM reached) but whose roles haven't been swapped yet.
function listRoleApplyDue(guildId, now = Date.now()) {
  const { sys } = open(guildId);
  return Object.values(sys.members)
    .filter(m => !m.leaveRoles && onLeaveNow(m, now))
    .map(m => m.userId);
}

// ---------------------------------------------------------------- reports
function addReport(guildId, { userId, subject, details }) {
  const { store, sys } = open(guildId);
  const report = {
    id: sys.nextReportId++, userId,
    subject: String(subject).slice(0, 100), details: String(details).slice(0, 1500), at: Date.now(),
  };
  sys.reports.push(report);
  if (sys.reports.length > MAX_REPORTS) sys.reports.splice(0, sys.reports.length - MAX_REPORTS);
  const m = sys.members[userId];
  if (m) m.lastActiveAt = report.at;
  pushHistory(sys, 'report', userId, `#${report.id} ${report.subject}`, userId);
  commit(guildId, store);
  return report;
}

// ---------------------------------------------------------------- history
function getHistory(guildId, limit = 20, userId = null) {
  const { sys } = open(guildId);
  return sys.history
    .filter(h => !userId || h.userId === userId)
    .slice(-limit)
    .reverse();
}

// ---------------------------------------------------------------- settings
function getRules(guildId) { return open(guildId).sys.rules || ''; }
function setRules(guildId, text) {
  const { store, sys } = open(guildId);
  sys.rules = String(text || '').slice(0, 4000);
  commit(guildId, store);
}

function getReportChannelId(guildId) { return open(guildId).sys.reportChannelId || null; }
function setReportChannelId(guildId, channelId) {
  const { store, sys } = open(guildId);
  sys.reportChannelId = channelId;
  if (!sys.lastWeeklyAt) sys.lastWeeklyAt = Date.now(); // don't fire for a Sunday that already passed
  commit(guildId, store);
}

function getWeeklySettings(guildId) {
  const { sys } = open(guildId);
  return { enabled: Boolean(sys.weeklyEnabled), channelId: sys.reportChannelId || null, lastWeeklyAt: sys.lastWeeklyAt || null };
}
function setWeeklyEnabled(guildId, enabled) {
  const { store, sys } = open(guildId);
  sys.weeklyEnabled = Boolean(enabled);
  if (!sys.lastWeeklyAt) sys.lastWeeklyAt = Date.now();
  commit(guildId, store);
}

// ---------------------------------------------------------------- weekly
// Most recent Sunday WEEKLY_HOUR_UTC:00 that is not in the future.
function lastScheduledMoment(now = Date.now()) {
  const d = new Date(now);
  let moment = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WEEKLY_HOUR_UTC, 0, 0)
    - d.getUTCDay() * DAY_MS;
  if (moment > now) moment -= 7 * DAY_MS;
  return moment;
}

// True once per week, after the scheduled moment, if auto-report is on and a
// channel is set. The first time a guild is seen it just starts the clock.
function isWeeklyDue(guildId, now = Date.now()) {
  const { store, sys } = open(guildId);
  if (!sys.weeklyEnabled || !sys.reportChannelId) return false;
  if (!sys.lastWeeklyAt) {
    sys.lastWeeklyAt = now;
    commit(guildId, store);
    return false;
  }
  return sys.lastWeeklyAt < lastScheduledMoment(now);
}

function markWeeklySent(guildId, now = Date.now()) {
  const { store, sys } = open(guildId);
  sys.lastWeeklyAt = now;
  commit(guildId, store);
}

// Per-member numbers for the last `days` days, best performer first.
// opts.leaderboard = true → messages in leaderboard-excluded channels aren't counted.
function weeklyData(guildId, days = 7, now = Date.now(), opts = {}) {
  const { sys } = open(guildId);
  const since = now - days * DAY_MS;
  const counts = openCountsOf(sys);
  const rows = Object.values(sys.members).map(m => {
    const act = staffActivity.getUserRangeStats(guildId, m.userId, days, opts);
    return {
      userId: m.userId,
      name: m.name,
      rankName: RANKS[m.rank] || RANKS[0],
      status: statusOf(m, now),
      checkins: (m.recentCheckins || []).filter(t => t >= since).length,
      tasksDone: sys.tasks.filter(t => t.done && t.assigneeId === m.userId && t.doneAt >= since).length,
      tasksOpen: counts[m.userId] || 0,
      reports: sys.reports.filter(r => r.userId === m.userId && r.at >= since).length,
      messages: act.messageTotal,
      voiceSeconds: act.voiceSeconds,
    };
  });
  rows.sort((a, b) =>
    (b.tasksDone - a.tasksDone) || (b.checkins - a.checkins) ||
    (b.messages - a.messages) || (b.voiceSeconds - a.voiceSeconds));
  return { since, now, rows };
}

module.exports = {
  RANKS, INACTIVE_AFTER_DAYS, WEEKLY_HOUR_UTC, CHECKIN_OPENS_HOUR, STAFF_TZ,
  getMorningDay, setMorningDay, getEveningDay, setEveningDay, getDmReportMark, setDmReportMark, cancelLeave, setLeaveMessage, listPanelMessages, addPanelMessage, removePanelMessage, listMembers, getMember, registerMember, setMemberPhoto, removeMember, logRoleRemoved,
  checkIn, shiftState, startShift, endShift, resetAll, promote,
  createTasks, getTasksForCheckout, uncompleteTask, createPoolTasks, getAllTasks, expireOldTasks, closeStaleBoards, pickingClosed, getBatchTasks, setBatchMessage, cancelBatch, claimTask, unclaimTask, pickLeastBusy, getOpenTasks, getTask, completeTask,
  setLeave, getLeaveRoleId, setLeaveRoleId, setLeaveRoles, listRoleRestoreDue, listRoleApplyDue, parseDateInput, dayStartMs, formatDay, tzParts, onLeaveNow, addReport, getHistory,
  getRules, setRules,
  getReportChannelId, setReportChannelId,
  getWeeklySettings, setWeeklyEnabled,
  lastScheduledMoment, isWeeklyDue, markWeeklySent, weeklyData,
};
