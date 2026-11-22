// Staff activity Excel export — used by the !staff activity panel buttons.
//
//   Daily / Weekly / Monthly button -> builds an .xlsx and DMs it to
//   STAFF_EXPORT_USER_ID (default 468459883847614484), never to the clicker.
//
// Columns: Rank, Staff, Check-ins (how many times), Check-outs (how many
// times), Total Messages, Total VC Time, Work Done (tasks completed in the
// period). Best stats first, weakest last. An "Attendance" sheet lists the
// exact check-in / check-out time of every shift.
const ExcelJS = require('exceljs');
const { AttachmentBuilder } = require('discord.js');
const staffSystem = require('./staff-system');
const staffActivity = require('./staff-activity');

const EXPORT_USER_ID = (process.env.STAFF_EXPORT_USER_ID || '468459883847614484').trim();
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = staffSystem.STAFF_TZ;

const fmtTime = (ms) => (ms
  ? new Date(ms).toLocaleString('en-IN', { timeZone: TZ, hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

// Period window + the activity stats for one member, per kind.
function periodOf(kind, now = Date.now()) {
  const t = staffSystem.tzParts(now);
  const [y, m, d] = t.dayKey.split('-').map(Number);
  if (kind === 'daily') {
    return { label: `Daily ${t.dayKey}`, since: staffSystem.dayStartMs(y, m, d), days: 1,
      stats: (gid, uid) => staffActivity.getUserDayStats(gid, uid) };
  }
  if (kind === 'weekly') {
    return { label: `Weekly (last 7 days, to ${t.dayKey})`, since: now - 7 * DAY_MS, days: 7,
      stats: (gid, uid) => staffActivity.getUserRangeStats(gid, uid, 7) };
  }
  return { label: `Monthly ${t.dayKey.slice(0, 7)}`, since: staffSystem.dayStartMs(y, m, 1), days: d,
    stats: (gid, uid) => staffActivity.getUserMonthStats(gid, uid) };
}

// Discord username (the @handle) for a staff member, plus whether they are
// still in the server. Falls back to the name they entered on the staff form
// if the account can't be found. `left` is only true when Discord confirms the
// member is gone (Unknown Member, code 10007) — a network hiccup never marks
// anyone as having left.
async function lookupStaff(guild, userId, fallback) {
  let left = false;
  try {
    const m = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    if (m && m.user) return { username: m.user.username, left: false };
  } catch (err) {
    left = Boolean(err && err.code === 10007);
  }
  try {
    const u = await guild.client.users.fetch(userId);
    if (u) return { username: u.username, left };
  } catch { /* unknown account */ }
  return { username: fallback || userId, left };
}

async function collectRows(guild, kind) {
  const period = periodOf(kind);
  const tasks = staffSystem.getAllTasks(guild.id);
  const rows = [];
  const attendance = [];

  for (const m of staffSystem.listMembers(guild.id)) {
    const { username, left } = await lookupStaff(guild, m.userId, m.name);
    const act = period.stats(guild.id, m.userId);
    const workDone = tasks.filter(t => t.done && t.assigneeId === m.userId && t.doneAt >= period.since).length;

    // Check-in / check-out inside the window (finished shifts + a shift still open).
    const shifts = [];
    const a = m.attendance || {};
    for (const [dayKey, s] of Object.entries(a.days || {})) {
      if (s.in && s.in >= period.since) shifts.push({ dayKey, in: s.in, out: s.out || null });
    }
    if (a.open && a.open.at >= period.since) shifts.push({ dayKey: a.open.dayKey, in: a.open.at, out: null });
    shifts.sort((x, y) => x.in - y.in);

    rows.push({
      userId: m.userId,
      name: username,
      left,
      checkIns: shifts.length,
      checkOuts: shifts.filter(s => s.out).length,
      messages: act.messageTotal,
      voiceSeconds: act.voiceSeconds,
      workDone,
    });
    for (const s of shifts) attendance.push({ name: username, ...s });
  }

  // Best stats first, worst last.
  rows.sort((a, b) => (b.workDone - a.workDone) || (b.checkOuts - a.checkOuts) || (b.messages - a.messages) || (b.voiceSeconds - a.voiceSeconds));
  attendance.sort((a, b) => a.in - b.in);
  return { period, rows, attendance };
}

async function buildWorkbook(guild, kind) {
  const { period, rows, attendance } = await collectRows(guild, kind);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Staff Activity');
  ws.columns = [
    { header: 'Rank', key: 'rank', width: 7 },
    { header: 'Staff (username)', key: 'name', width: 26 },
    { header: 'Server Status', key: 'status', width: 18 },
    { header: 'Check-ins', key: 'in', width: 12 },
    { header: 'Check-outs', key: 'out', width: 12 },
    { header: 'Total Messages', key: 'msgs', width: 16 },
    { header: 'Total VC Time', key: 'vc', width: 16 },
    { header: 'Work Done', key: 'work', width: 12 },
  ];
  rows.forEach((r, i) => ws.addRow({
    rank: i + 1, name: r.name, status: r.left ? 'Left the server' : '', in: r.checkIns, out: r.checkOuts,
    msgs: r.messages, vc: staffActivity.formatDuration(r.voiceSeconds), work: r.workDone,
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  {
    const at = wb.addWorksheet('Attendance');
    at.columns = [
      { header: 'Staff', key: 'name', width: 26 },
      { header: 'Day', key: 'day', width: 14 },
      { header: 'Check-in', key: 'in', width: 20 },
      { header: 'Check-out', key: 'out', width: 20 },
    ];
    for (const s of attendance) at.addRow({ name: s.name, day: s.dayKey, in: fmtTime(s.in), out: s.out ? fmtTime(s.out) : 'Not checked out' });
    at.getRow(1).font = { bold: true };
    at.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, period, count: rows.length };
}

// Builds the sheet and DMs it to the fixed export user.
async function sendExport(client, guild, kind) {
  const { buffer, period, count } = await buildWorkbook(guild, kind);
  const file = new AttachmentBuilder(buffer, { name: `staff-${kind}-${new Date().toISOString().slice(0, 10)}.xlsx` });
  const user = await client.users.fetch(EXPORT_USER_ID);
  await user.send({ content: `📊 **${period.label}** staff activity — ${guild.name} (${count} staff, best first)`, files: [file] });
  return { period, count };
}

module.exports = { sendExport, EXPORT_USER_ID };
