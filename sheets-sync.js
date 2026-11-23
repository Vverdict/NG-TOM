// Live Google Sheets mirror of the tournament bot's registrations.
//
// One tab per tournament, named after the tournament. Every registered team is
// a row (group order, slot order — the same layout as the Excel slot-list
// export), and the tab is rewritten a few seconds after anything changes: new
// registrations appear, and rows disappear / move when a team is removed,
// swapped, re-slotted or its group is changed.
//
// storage.saveGuildStore() calls onGuildSaved() on every save. No extra npm
// packages: built-in crypto + fetch (Node 18+).
//
// Env vars:
//   GOOGLE_SHEET_ID                – the long id in the sheet's URL
//   GOOGLE_SERVICE_ACCOUNT_JSON    – service-account key (raw JSON or base64)
//   GOOGLE_SHEET_GUILD_ID          – optional, only mirror this server. When
//                                    unset, every server is mirrored and each
//                                    tab name gets a "-<last 4 of guild id>" suffix.
// Share the sheet with the service account's client_email (Editor).
// If the env vars are missing this module does nothing.
//
// Tabs of deleted tournaments are left as they are (nothing is erased from your
// sheet automatically). Renaming a tournament starts a new tab under the new name.

const crypto = require('crypto');
const { groupSlotNumber } = require('./slots');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEBOUNCE_MS = 4000;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const creds = JSON.parse(text);
    if (!creds.client_email || !creds.private_key) throw new Error('missing client_email/private_key');
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    return creds;
  } catch (err) {
    console.error('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON is invalid:', err.message);
    return null;
  }
}

const creds = loadCredentials();
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ONLY_GUILD = process.env.GOOGLE_SHEET_GUILD_ID || null;

function isEnabled() {
  return !!(creds && SHEET_ID);
}

// ---- auth (service-account JWT -> access token, cached) ----
let token = null;
let tokenExp = 0;

const b64url = (b) => Buffer.from(b).toString('base64url');

async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email, scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), creds.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token request failed: ${json.error_description || json.error || res.status}`);
  token = json.access_token;
  tokenExp = Date.now() + json.expires_in * 1000;
  return token;
}

async function api(path, method, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(json.error && json.error.message) || ''}`);
  return json;
}

// ---- rows ----
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST';
}

const cell = (v) => (typeof v === 'number' ? v : String(v ?? ''));

const HEADERS = [
  'ID', 'Group', 'Slot', 'Team Name', 'Leader', 'Leader ID', 'WhatsApp Number',
  'Player 1 IGN', 'Player 1 UID', 'Player 2 IGN', 'Player 2 UID',
  'Player 3 IGN', 'Player 3 UID', 'Player 4 IGN', 'Player 4 UID',
  'Player 5 IGN', 'Player 5 UID', 'Lineup Discord IDs', 'Registered At',
];

// Round 1 groups (tournament.groups), in group order — same as the Excel export.
function buildRows(tournament) {
  const rows = [];
  const groups = Object.entries(tournament.groups || {})
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  for (const [letter, group] of groups) {
    (group.teams || []).forEach((t, idx) => {
      if (!t) return;
      const igns = t.playerIgns || [];
      const uids = t.playerUids || [];
      rows.push([
        rows.length + 1, letter, groupSlotNumber(group, idx), t.team || '',
        t.ownerName || '', String(t.ownerId || ''), String(t.whatsapp || ''),
        igns[0] || '', String(uids[0] || ''), igns[1] || '', String(uids[1] || ''),
        igns[2] || '', String(uids[2] || ''), igns[3] || '', String(uids[3] || ''),
        igns[4] || '', igns[4] ? String(uids[4] || '') : '',
        (t.playerIds || []).join(', '),
        formatTimestamp(t.registeredAt),
      ].map(cell));
    });
  }
  return [HEADERS, ...rows];
}

// Sheet tab names: max 100 chars, none of  [ ] : * ? / \
function cleanTabName(name) {
  const s = String(name || '').replace(/[\[\]:*?\/\\]/g, '-').replace(/^'+|'+$/g, '').trim().slice(0, 80);
  return s || 'Tournament';
}

// Unique tab name for every tournament in a guild (same-named tournaments get
// their id appended) — computed per save so it stays stable between saves.
function tabNames(guildId, tournaments) {
  const suffix = ONLY_GUILD ? '' : `-${String(guildId).slice(-4)}`;
  const entries = Object.entries(tournaments || {});
  const counts = {};
  for (const [, t] of entries) {
    const k = cleanTabName(t && t.name).toLowerCase();
    counts[k] = (counts[k] || 0) + 1;
  }
  const out = {};
  for (const [tid, t] of entries) {
    const base = cleanTabName(t && t.name);
    const dup = counts[base.toLowerCase()] > 1;
    out[tid] = `${base}${dup ? ` (${String(tid).slice(-4)})` : ''}${suffix}`;
  }
  return out;
}

// ---- sheet writing ----
const tabReady = new Set();

async function ensureTab(title) {
  if (tabReady.has(title)) return;
  const meta = await api('?fields=sheets.properties.title', 'GET');
  const exists = (meta.sheets || []).some(s => s.properties.title === title);
  if (!exists) {
    const sheetId = Math.floor(Math.random() * 2e9);
    await api(':batchUpdate', 'POST', {
      requests: [
        { addSheet: { properties: { title, sheetId, gridProperties: { frozenRowCount: 1 } } } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        } },
      ],
    });
  }
  tabReady.add(title);
}

async function writeTab(title, rows) {
  const q = `'${title.replace(/'/g, "''")}'`;
  await ensureTab(title);
  // Write new data first, then blank anything below it so the sheet is never
  // momentarily empty.
  await api(`/values/${encodeURIComponent(`${q}!A1`)}?valueInputOption=RAW`, 'PUT',
    { range: `${q}!A1`, majorDimension: 'ROWS', values: rows });
  try {
    await api(`/values/${encodeURIComponent(`${q}!A${rows.length + 1}:Z`)}:clear`, 'POST', {});
  } catch (err) {
    // Data filling the sheet exactly to its last row leaves nothing to clear.
    if (!/exceeds grid limits/i.test(err.message)) throw err;
  }
}

// ---- job queue: one debounced job per (guild, tournament) ----
const jobs = new Map(); // jobKey -> { timer, running, dirty, guildId, title, rows, lastHash }

function queueJob(guildId, tid, title, rows) {
  const jobKey = `${guildId}|${tid}`;
  let j = jobs.get(jobKey);
  if (!j) {
    j = { timer: null, running: false, dirty: false, guildId, title, rows, lastHash: null };
    jobs.set(jobKey, j);
  }
  j.title = title;
  j.rows = rows;
  j.dirty = true;
  if (j.timer || j.running) return;
  j.timer = setTimeout(() => runJob(jobKey), DEBOUNCE_MS);
}

async function runJob(jobKey) {
  const j = jobs.get(jobKey);
  j.timer = null;
  if (j.running) return;
  j.running = true;
  try {
    while (j.dirty) {
      j.dirty = false;
      const hash = crypto.createHash('sha1').update(j.title + JSON.stringify(j.rows)).digest('hex');
      if (hash === j.lastHash) continue; // nothing visible changed
      try {
        await writeTab(j.title, j.rows);
        j.lastHash = hash;
      } catch (err) {
        console.error(`[sheets] sync failed for "${j.title}" (guild ${j.guildId}):`, err.message);
        token = null; // force fresh token next time
        tabReady.clear();
        j.timer = setTimeout(() => { j.dirty = true; runJob(jobKey); }, 60000);
        break;
      }
    }
  } finally {
    j.running = false;
  }
}

// Called by storage.saveGuildStore() on every save.
function onGuildSaved(guildId, guildData) {
  if (!isEnabled() || guildId === '__global__') return;
  if (ONLY_GUILD && guildId !== ONLY_GUILD) return;
  if (!guildData || !guildData.tournaments) return;
  const names = tabNames(guildId, guildData.tournaments);
  for (const [tid, t] of Object.entries(guildData.tournaments)) {
    if (!t) continue;
    // Rows are built now (not when the job fires) so a half-finished edit made
    // later can't leak into the sheet.
    queueJob(guildId, tid, names[tid], buildRows(t));
  }
}

// Called once at startup: backfills the sheet with everything already saved.
function syncAllGuilds(allData) {
  if (!isEnabled()) return;
  console.log(`[sheets] Live sync enabled -> sheet ${SHEET_ID}`);
  console.log(`[sheets] Share that sheet (as Editor) with: ${creds.client_email}`);
  for (const [guildId, g] of Object.entries(allData || {})) {
    if (g && typeof g === 'object') onGuildSaved(guildId, g);
  }
}

module.exports = { isEnabled, onGuildSaved, syncAllGuilds };
