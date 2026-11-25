// Live Google Sheets staff report — same three tabs as the Excel example:
//
//   Staff Dashboard     KPI tiles, checkout-status + work-contribution charts, management notes
//   Staff Report        ranked table: check-ins / check-outs / rate / missing / messages / VC / work
//   Attendance Analysis daily summary + every raw check-in / check-out row
//
// The tabs are rebuilt every STAFF_SHEET_INTERVAL_SEC seconds (default 120) for
// a rolling window of STAFF_SHEET_DAYS days (default 7, today included), and
// only written to Google when something visibly changed.
//
// Env vars:
//   STAFF_SHEET_ID                 – id of the spreadsheet to write to. Optional:
//                                    falls back to GOOGLE_SHEET_ID (then the three
//                                    tabs are added next to your tournament tabs).
//                                    Use a separate id for a brand-new Google Sheet.
//   GOOGLE_SERVICE_ACCOUNT_JSON    – same service-account key sheets-sync.js uses.
//   STAFF_SHEET_GUILD_ID           – optional, only report this server. When unset
//                                    every server with staff gets its own tabs, with
//                                    a "-<last 4 of guild id>" suffix on the tab names.
//   STAFF_SHEET_DAYS               – window length in days (default 7, max 31)
//   STAFF_SHEET_INTERVAL_SEC       – refresh interval (default 120, min 30)
// Share the sheet with the service account's client_email (Editor).
// If no sheet id / credentials are configured this module does nothing.
//
// Tabs are only ever overwritten by this module; nothing else in the spreadsheet is touched.

const crypto = require('crypto');
const staffSystem = require('./staff-system');
const staffActivity = require('./staff-activity');
const sheetsSync = require('./sheets-sync');

const SHEET_ID = (process.env.STAFF_SHEET_ID || process.env.GOOGLE_SHEET_ID || '').trim();
const ONLY_GUILD = (process.env.STAFF_SHEET_GUILD_ID || '').trim() || null;
const DAYS = Math.min(31, Math.max(1, parseInt(process.env.STAFF_SHEET_DAYS, 10) || 7));
const INTERVAL_MS = Math.max(30, parseInt(process.env.STAFF_SHEET_INTERVAL_SEC, 10) || 120) * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = staffSystem.STAFF_TZ || 'Asia/Kolkata';
const WORK_ROWS = 10; // rows in the dashboard's "Staff Work Contribution" table
const NOTE_ROWS = 5; // rows in the dashboard's "Management notes" block

function isEnabled() {
  return !!(SHEET_ID && sheetsSync.hasCredentials());
}

// ------------------------------------------------------------------ Google API
async function api(path, method, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await sheetsSync.getToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(json.error && json.error.message) || ''}`);
  return json;
}

// ------------------------------------------------------------------ formatting
const COLORS = {
  title: '17365D', head: '1F4E78', tile: 'D9EAF7', sub: '666666',
  missing: 'FCE4D6', progress: 'FFF2CC', grid: 'BFBFBF', white: 'FFFFFF',
};
const rgb = (hex) => ({
  red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255,
  blue: parseInt(hex.slice(4, 6), 16) / 255,
});
const rng = (sheetId, r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });

function style(sheetId, [r1, r2, c1, c2], { bg, color, bold, size, align, wrap, numberFormat } = {}) {
  const text = {};
  if (color) text.foregroundColor = rgb(color);
  if (bold) text.bold = true;
  if (size) text.fontSize = size;
  const format = { verticalAlignment: 'MIDDLE' };
  if (bg) format.backgroundColor = rgb(bg);
  if (Object.keys(text).length) format.textFormat = text;
  if (align) format.horizontalAlignment = align;
  if (wrap) format.wrapStrategy = 'WRAP';
  if (numberFormat) format.numberFormat = numberFormat;
  return { repeatCell: { range: rng(sheetId, r1, r2, c1, c2), cell: { userEnteredFormat: format }, fields: 'userEnteredFormat' } };
}

const merge = (sheetId, [r1, r2, c1, c2]) => ({ mergeCells: { range: rng(sheetId, r1, r2, c1, c2), mergeType: 'MERGE_ALL' } });

function box(sheetId, [r1, r2, c1, c2]) {
  const line = { style: 'SOLID', color: rgb(COLORS.grid) };
  return { updateBorders: { range: rng(sheetId, r1, r2, c1, c2), top: line, bottom: line, left: line, right: line, innerHorizontal: line, innerVertical: line } };
}

const width = (sheetId, col, px) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
    properties: { pixelSize: px }, fields: 'pixelSize',
  },
});

const rowHeight = (sheetId, r1, r2, px) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: 'ROWS', startIndex: r1, endIndex: r2 },
    properties: { pixelSize: px }, fields: 'pixelSize',
  },
});

// ------------------------------------------------------------------ data
const nameCache = new Map(); // `${guildId}:${userId}` -> { username, left, at }

// Discord @username for a staff member + whether Discord confirms they left.
// Members already in the guild cache cost nothing; others are fetched at most
// once per 30 minutes (5 minutes after a failed lookup).
async function lookupStaff(guild, userId, fallback) {
  const cached = guild.members.cache.get(userId);
  if (cached && cached.user) return { username: cached.user.username, left: false };
  const key = `${guild.id}:${userId}`;
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;

  let result = null;
  let left = false;
  try {
    const m = await guild.members.fetch(userId);
    if (m && m.user) result = { username: m.user.username, left: false };
  } catch (err) {
    left = Boolean(err && err.code === 10007);
  }
  if (!result) {
    try {
      const u = await guild.client.users.fetch(userId);
      if (u) result = { username: u.username, left };
    } catch { /* unknown account */ }
  }
  const out = { username: (result && result.username) || fallback || userId, left, at: Date.now(), ttl: result ? 30 * 60000 : 5 * 60000 };
  nameCache.set(key, out);
  return out;
}

const fmtTime = (ms) => (ms
  ? new Date(ms).toLocaleString('en-IN', { timeZone: TZ, hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '');

function dayLabel(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })
    .format(Date.UTC(y, m - 1, d));
}

function periodLabel(dayKeys) {
  const [y1, m1, d1] = dayKeys[0].split('-').map(Number);
  const [y2, m2, d2] = dayKeys[dayKeys.length - 1].split('-').map(Number);
  const f = (opts, y, m, d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(Date.UTC(y, m - 1, d));
  if (dayKeys.length === 1) return f({ day: 'numeric', month: 'long', year: 'numeric' }, y1, m1, d1);
  if (y1 === y2 && m1 === m2) return `${d1}–${f({ day: 'numeric', month: 'long', year: 'numeric' }, y2, m2, d2)}`;
  return `${f({ day: 'numeric', month: 'short' }, y1, m1, d1)} – ${f({ day: 'numeric', month: 'short', year: 'numeric' }, y2, m2, d2)}`;
}

// Everything the three tabs need, gathered from the bot's staff data.
async function collect(guild, now = Date.now()) {
  const todayKey = staffSystem.tzParts(now).dayKey;
  const dayKeys = [];
  for (let i = DAYS - 1; i >= 0; i--) dayKeys.push(staffSystem.tzParts(now - i * DAY_MS).dayKey);
  const [y, m, d] = dayKeys[0].split('-').map(Number);
  const since = staffSystem.dayStartMs(y, m, d);
  const tasks = staffSystem.getAllTasks(guild.id);

  const rows = [];
  const records = [];
  for (const member of staffSystem.listMembers(guild.id)) {
    const { username, left } = await lookupStaff(guild, member.userId, member.name);
    const act = staffActivity.getUserRangeStats(guild.id, member.userId, DAYS);
    const workDone = tasks.filter(t => t.done && t.assigneeId === member.userId && t.doneAt >= since).length;

    const shifts = [];
    const a = member.attendance || {};
    for (const [dayKey, s] of Object.entries(a.days || {})) {
      if (s.in && s.in >= since) shifts.push({ dayKey, in: s.in, out: s.out || null });
    }
    if (a.open && a.open.at >= since && !shifts.some(s => s.in === a.open.at)) {
      shifts.push({ dayKey: a.open.dayKey, in: a.open.at, out: null });
    }
    shifts.sort((p, q) => p.in - q.in);
    for (const s of shifts) {
      // A shift still open today isn't a miss — they're simply still on shift.
      s.status = s.out ? 'Completed' : (s.dayKey === todayKey ? 'In progress' : 'Missing');
      records.push({ name: username, ...s });
    }

    const inProgress = shifts.filter(s => s.status === 'In progress').length;
    const checkOuts = shifts.filter(s => s.out).length;
    const settled = shifts.length - inProgress;
    rows.push({
      name: username,
      left,
      checkIns: shifts.length,
      checkOuts,
      rate: settled > 0 ? checkOuts / settled : 0,
      missing: shifts.filter(s => s.status === 'Missing').length,
      inProgress,
      messages: act.messageTotal,
      voiceSeconds: act.voiceSeconds,
      workDone,
    });
  }
  // Best stats first, weakest last (same order as the Excel export).
  rows.sort((p, q) => (q.workDone - p.workDone) || (q.checkOuts - p.checkOuts) || (q.messages - p.messages) || (q.voiceSeconds - p.voiceSeconds));
  records.sort((p, q) => p.in - q.in);
  return { guildName: guild.name, dayKeys, todayKey, rows, records, now };
}

// ------------------------------------------------------------------ tab builders
const pad = (arr, n) => { const out = arr.slice(0, n); while (out.length < n) out.push(''); return out; };
const fmtDuration = (s) => staffActivity.formatDuration(s);

function listNames(names, max = 6) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

function buildDashboard(data, updated) {
  const { rows, records, dayKeys } = data;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const checkIns = sum('checkIns');
  const checkOuts = sum('checkOuts');
  const onShift = sum('inProgress');
  const missing = sum('missing');
  const W = 8;

  const noteLines = [
    `• ${missing} of ${records.length} attendance rows are marked 'Not checked out' (shifts still open today are counted as "On shift now", not missing).`,
    (() => {
      const none = rows.filter(r => r.checkIns === 0).map(r => r.name);
      return none.length ? `• No check-ins in this period: ${listNames(none)}.` : '• Every staff member checked in at least once in this period.';
    })(),
    (() => {
      const gone = rows.filter(r => r.left).map(r => r.name);
      return gone.length ? `• No longer in the server: ${listNames(gone)}.` : '• All listed staff are still in the server.';
    })(),
    '• A zero in Work Done or a low message count is a reporting observation, not proof of misconduct.',
    '',
  ];

  const work = rows.filter(r => r.workDone > 0).slice(0, WORK_ROWS);
  const out = [
    pad(['ADVANCED STAFF PERFORMANCE DASHBOARD'], W),
    pad([`Reporting period: ${periodLabel(dayKeys)} (last ${dayKeys.length} day${dayKeys.length === 1 ? '' : 's'}) | Server: ${data.guildName} | Live${updated ? ` — last change ${updated}` : ''}`], W),
    pad([], W),
    ['Total staff', rows.length, 'Attendance check-ins', checkIns, 'Recorded check-outs', checkOuts, 'On shift now', onShift],
    pad([], W),
    ['Total messages', sum('messages'), 'Total work done', sum('workDone'), 'Total VC time', fmtDuration(sum('voiceSeconds')), 'Missing check-outs (past days)', missing],
    pad([], W),
    pad(['Attendance checkout status'], W),
    pad(['Status', 'Records'], W),
    pad(['Completed checkout', checkOuts], W),
    pad(['Not checked out', missing], W),
    pad(['On shift now', onShift], W),
    pad([], W),
    pad(['Staff Work Contribution'], W),
    pad(['Staff', 'Work Done'], W),
  ];
  for (let i = 0; i < WORK_ROWS; i++) out.push(pad(work[i] ? [work[i].name, work[i].workDone] : [], W));
  out.push(pad([], W));
  out.push(pad(['Management notes'], W));
  for (let i = 0; i < NOTE_ROWS; i++) out.push(pad([noteLines[i] || ''], W));
  return out;
}

function dashboardFormat(sheetId) {
  const s = (r, o) => style(sheetId, r, o);
  const req = [
    s([0, 1, 0, 8], { bg: COLORS.title, color: COLORS.white, bold: true, size: 18 }),
    s([1, 2, 0, 8], { color: COLORS.sub, size: 10 }),
    merge(sheetId, [0, 1, 0, 8]), merge(sheetId, [1, 2, 0, 8]),
    rowHeight(sheetId, 0, 1, 38),
  ];
  for (const r of [3, 5]) {
    for (const c of [0, 2, 4, 6]) {
      req.push(s([r, r + 1, c, c + 1], { bg: COLORS.head, color: COLORS.white, bold: true, size: 9, wrap: true, align: 'CENTER' }));
      req.push(s([r, r + 1, c + 1, c + 2], { bg: COLORS.tile, color: COLORS.title, bold: true, size: 16, align: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '#,##0' } }));
    }
    req.push(rowHeight(sheetId, r, r + 1, 46));
  }
  for (const [r] of [[7], [13], [26]]) {
    req.push(s([r, r + 1, 0, 3], { color: COLORS.title, bold: true, size: 12 }));
  }
  req.push(merge(sheetId, [7, 8, 0, 3]), merge(sheetId, [13, 14, 0, 3]), merge(sheetId, [26, 27, 0, 8]));
  for (const r of [8, 14]) req.push(s([r, r + 1, 0, 2], { bg: COLORS.head, color: COLORS.white, bold: true }));
  req.push(box(sheetId, [8, 12, 0, 2]), box(sheetId, [14, 14 + 1 + WORK_ROWS, 0, 2]));
  req.push(s([9, 12, 1, 2], { align: 'RIGHT' }), s([15, 15 + WORK_ROWS, 1, 2], { align: 'RIGHT' }));
  const notes0 = 27;
  for (let i = 0; i < NOTE_ROWS; i++) {
    req.push(merge(sheetId, [notes0 + i, notes0 + i + 1, 0, 8]));
    req.push(s([notes0 + i, notes0 + i + 1, 0, 8], { wrap: true }));
  }
  [30, 18, 22, 16, 22, 16, 28, 18].forEach((px, i) => req.push(width(sheetId, i, px * 7 + 10)));
  return req;
}

function dashboardCharts(sheetId) {
  const col = (c) => ({ sourceRange: { sources: [rng(sheetId, 9, 12, c, c + 1)] } });
  const wcol = (c) => ({ sourceRange: { sources: [rng(sheetId, 14, 15 + WORK_ROWS, c, c + 1)] } });
  return [
    { addChart: { chart: {
      spec: { title: 'Attendance checkout status', pieChart: { legendPosition: 'RIGHT_LEGEND', domain: col(0), series: col(1) } },
      position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 7, columnIndex: 9 }, widthPixels: 420, heightPixels: 260 } },
    } } },
    { addChart: { chart: {
      spec: { title: 'Staff work contribution', basicChart: {
        chartType: 'COLUMN', legendPosition: 'NO_LEGEND', headerCount: 1,
        axis: [{ position: 'BOTTOM_AXIS', title: 'Staff' }, { position: 'LEFT_AXIS', title: 'Work Done' }],
        domains: [{ domain: wcol(0) }],
        series: [{ series: wcol(1), targetAxis: 'LEFT_AXIS' }],
      } },
      position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 21, columnIndex: 9 }, widthPixels: 520, heightPixels: 300 } },
    } } },
  ];
}

const REPORT_HEADERS = ['Rank', 'Staff', 'Server Status', 'Check-ins', 'Check-outs', 'Checkout Rate', 'Missing Checkouts*', 'Messages', 'VC Time', 'Work Done'];

function buildReport(data) {
  const W = 10;
  const out = [pad(['STAFF PERFORMANCE & ACTIVITY REPORT'], W), pad([], W), REPORT_HEADERS];
  data.rows.forEach((r, i) => out.push([
    i + 1, r.name, r.left ? 'Left the server' : 'In server', r.checkIns, r.checkOuts, r.rate, r.missing,
    r.messages, fmtDuration(r.voiceSeconds), r.workDone,
  ]));
  out.push(pad([], W));
  out.push(pad(['*Missing checkouts = shifts from earlier days with a check-in but no check-out. A shift still open today is not counted. See Attendance Analysis for the raw rows.'], W));
  return out;
}

function reportFormat(sheetId, data) {
  const n = data.rows.length;
  const s = (r, o) => style(sheetId, r, o);
  const req = [
    s([0, 1, 0, 10], { bg: COLORS.title, color: COLORS.white, bold: true, size: 16 }),
    merge(sheetId, [0, 1, 0, 10]), rowHeight(sheetId, 0, 1, 34),
    s([2, 3, 0, 10], { bg: COLORS.head, color: COLORS.white, bold: true, wrap: true, align: 'CENTER' }),
    box(sheetId, [2, 3 + n, 0, 10]),
    s([3, 3 + n, 5, 6], { numberFormat: { type: 'PERCENT', pattern: '0.0%' }, align: 'RIGHT' }),
    s([3, 3 + n, 0, 1], { align: 'CENTER' }),
    s([3 + n + 1, 3 + n + 2, 0, 10], { color: COLORS.sub, size: 9 }),
    merge(sheetId, [3 + n + 1, 3 + n + 2, 0, 10]),
  ];
  data.rows.forEach((r, i) => {
    if (r.missing > 0) req.push(s([3 + i, 4 + i, 6, 7], { bg: COLORS.missing, align: 'RIGHT' }));
    if (r.left) req.push(s([3 + i, 4 + i, 2, 3], { bg: COLORS.missing }));
  });
  [9, 24, 18, 12, 12, 15, 20, 14, 14, 12].forEach((w, i) => req.push(width(sheetId, i, w * 7 + 10)));
  return req;
}

function buildAttendance(data) {
  const W = 6;
  const { dayKeys, records } = data;
  const out = [pad(['ATTENDANCE DETAIL & DAILY SUMMARY'], W), pad([], W),
    ['Date', 'Check-ins', 'Completed check-outs', 'Missing check-outs', 'In progress', '']];
  for (const dk of dayKeys) {
    const day = records.filter(r => r.dayKey === dk);
    out.push([dayLabel(dk), day.length, day.filter(r => r.status === 'Completed').length,
      day.filter(r => r.status === 'Missing').length, day.filter(r => r.status === 'In progress').length, '']);
  }
  out.push(pad([], W));
  out.push(pad(['Raw attendance records'], W));
  out.push(['Staff', 'Day', 'Check-in', 'Check-out', 'Checkout Status', '']);
  for (const r of records) {
    out.push([r.name, r.dayKey, fmtTime(r.in), r.out ? fmtTime(r.out) : 'Not checked out', r.status, '']);
  }
  return out;
}

function attendanceFormat(sheetId, data) {
  const N = data.dayKeys.length;
  const s = (r, o) => style(sheetId, r, o);
  const dailyEnd = 3 + N;
  const headingRow = dailyEnd + 1;
  const rawHead = dailyEnd + 2;
  const rawStart = dailyEnd + 3;
  const req = [
    s([0, 1, 0, 6], { bg: COLORS.title, color: COLORS.white, bold: true, size: 16 }),
    merge(sheetId, [0, 1, 0, 6]), rowHeight(sheetId, 0, 1, 34),
    s([2, 3, 0, 5], { bg: COLORS.head, color: COLORS.white, bold: true, wrap: true, align: 'CENTER' }),
    box(sheetId, [2, dailyEnd, 0, 5]),
    s([3, dailyEnd, 1, 5], { align: 'RIGHT' }),
    s([headingRow, headingRow + 1, 0, 5], { color: COLORS.title, bold: true, size: 12 }),
    merge(sheetId, [headingRow, headingRow + 1, 0, 5]),
    s([rawHead, rawHead + 1, 0, 5], { bg: COLORS.head, color: COLORS.white, bold: true, align: 'CENTER' }),
    box(sheetId, [rawHead, rawStart + data.records.length, 0, 5]),
  ];
  data.records.forEach((r, i) => {
    if (r.status === 'Missing') req.push(s([rawStart + i, rawStart + i + 1, 3, 5], { bg: COLORS.missing }));
    else if (r.status === 'In progress') req.push(s([rawStart + i, rawStart + i + 1, 3, 5], { bg: COLORS.progress }));
  });
  [24, 18, 24, 22, 18, 8].forEach((w, i) => req.push(width(sheetId, i, w * 7 + 10)));
  return req;
}

// Pure: turns collected data into the three tabs (rows + how to format them).
function buildTabs(data, suffix, updated) {
  return [
    { key: 'dash', title: `Staff Dashboard${suffix}`, rows: buildDashboard(data, updated), width: 20,
      format: (id) => dashboardFormat(id), charts: (id) => dashboardCharts(id) },
    { key: 'report', title: `Staff Report${suffix}`, rows: buildReport(data), width: 12,
      format: (id) => reportFormat(id, data) },
    { key: 'att', title: `Attendance Analysis${suffix}`, rows: buildAttendance(data), width: 12,
      format: (id) => attendanceFormat(id, data) },
  ];
}

// ------------------------------------------------------------------ writing
const metaCache = { tabs: null }; // title -> { sheetId, charts }
const prevRows = new Map(); // title -> rows last written (for blanking leftovers)
const lastHash = new Map(); // guildId -> hash

async function loadMeta(force) {
  if (metaCache.tabs && !force) return metaCache.tabs;
  const meta = await api('?fields=sheets(properties(sheetId,title),charts(chartId))', 'GET');
  metaCache.tabs = {};
  for (const sh of meta.sheets || []) {
    metaCache.tabs[sh.properties.title] = { sheetId: sh.properties.sheetId, charts: (sh.charts || []).length };
  }
  return metaCache.tabs;
}

async function writeTabs(tabs) {
  let known = await loadMeta(false);
  const missing = tabs.filter(t => !known[t.title]);
  if (missing.length) {
    const used = new Set(Object.values(known).map(k => k.sheetId));
    await api(':batchUpdate', 'POST', {
      requests: missing.map(t => {
        let sheetId;
        do { sheetId = Math.floor(Math.random() * 2e9); } while (used.has(sheetId));
        used.add(sheetId);
        return { addSheet: { properties: { title: t.title, sheetId } } };
      }),
    });
    known = await loadMeta(true);
  }

  // 1) grid size + formatting (+ charts the first time) — one call for all tabs.
  const requests = [];
  for (const t of tabs) {
    const { sheetId, charts } = known[t.title];
    const rows = Math.max(t.rows.length + 40, 100);
    requests.push({ updateSheetProperties: {
      properties: { sheetId, gridProperties: { rowCount: rows, columnCount: Math.max(t.width, 12), frozenRowCount: t.key === 'dash' ? 0 : 3 } },
      fields: 'gridProperties(rowCount,columnCount,frozenRowCount)',
    } });
    requests.push({ unmergeCells: { range: { sheetId } } });
    requests.push({ repeatCell: { range: { sheetId }, cell: {}, fields: 'userEnteredFormat' } });
    requests.push(...t.format(sheetId));
    if (t.charts && charts === 0) requests.push(...t.charts(sheetId));
  }
  await api(':batchUpdate', 'POST', { requests });
  for (const t of tabs) if (t.charts) known[t.title].charts = Math.max(known[t.title].charts, 2);

  // 2) first run in this process: wipe stale values left from before a restart.
  for (const t of tabs) {
    if (!prevRows.has(t.title)) {
      await api(`/values/${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'`)}:clear`, 'POST', {});
    }
  }

  // 3) values — padded with blank rows so rows that disappeared are erased.
  const data = tabs.map(t => {
    const prev = prevRows.get(t.title) || 0;
    const width = Math.max(...t.rows.map(r => r.length));
    const rows = t.rows.map(r => pad(r, width));
    while (rows.length < prev) rows.push(pad([], width));
    return { range: `'${t.title.replace(/'/g, "''")}'!A1`, majorDimension: 'ROWS', values: rows };
  });
  await api('/values:batchUpdate', 'POST', { valueInputOption: 'RAW', data });
  for (const t of tabs) prevRows.set(t.title, t.rows.length);
}

// ------------------------------------------------------------------ scheduler
let running = false;

async function refreshGuild(guild) {
  if (staffSystem.listMembers(guild.id).length === 0) return;
  const data = await collect(guild);
  const suffix = ONLY_GUILD ? '' : `-${String(guild.id).slice(-4)}`;

  // Hash everything except the "last change" stamp, so we only write on real changes.
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify(buildTabs(data, suffix, null).map(t => [t.title, t.rows]))).digest('hex');
  if (lastHash.get(guild.id) === hash) return;

  const stamp = new Date(data.now).toLocaleString('en-IN', { timeZone: TZ, hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
  await writeTabs(buildTabs(data, suffix, stamp));
  lastHash.set(guild.id, hash);
}

async function refreshAll(client) {
  if (running) return;
  running = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (ONLY_GUILD && guild.id !== ONLY_GUILD) continue;
      try {
        await refreshGuild(guild);
      } catch (err) {
        console.error(`[staff-sheet] update failed (guild ${guild.id}):`, err.message);
        metaCache.tabs = null; // re-read tab ids next time
        prevRows.clear();
        lastHash.delete(guild.id);
      }
    }
  } finally {
    running = false;
  }
}

function start(client) {
  if (!isEnabled()) return;
  console.log(`[staff-sheet] Live staff report enabled -> sheet ${SHEET_ID} (last ${DAYS} days, every ${INTERVAL_MS / 1000}s)`);
  setTimeout(() => refreshAll(client), 15000).unref?.();
  setInterval(() => refreshAll(client), INTERVAL_MS).unref?.();
}

module.exports = { start, isEnabled, _internals: { collect, buildTabs, writeTabs, periodLabel } };
