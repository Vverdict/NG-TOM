// Staff activity tracking — per-guild daily message counts (broken down by
// channel) and voice-channel time, tracked by USER ID: everyone on the staff
// list (the Staff Entry Form, or added by an admin from the !staff panel) is
// tracked, whatever roles they hold. The `!staff role @role` role is no longer
// what decides who is tracked — it only controls who may press the self-service
// buttons (Entry Form etc.) before they are on the list.
//
// Writes are batched in memory (see `buffer` / `voiceSessions` below) and
// flushed into storage.js's per-guild store on a timer (startAutoFlush),
// rather than hitting disk/the database on every single message or voice
// tick — messageCreate and voiceStateUpdate fire far more often than the
// bot's other saveGuildStore() call sites (button clicks etc).
const { getGuildStore, saveGuildStore } = require('./storage');

// guildId -> { "<YYYY-MM-DD>": { "<userId>": { messages: {channelId: n}, messageTotal, voiceSeconds } } }
// — not yet written to storage.
const buffer = new Map();
// `${guildId}:${userId}` -> { channelId, since } — an in-progress voice call.
const voiceSessions = new Map();

// Channels whose chat does NOT count toward any staff message total (leaderboard,
// profiles, reports) — whatever staff write there never helps or hurts them.
// Applied to old data too (per-channel counts are stored), not just new messages.
// Add more channel IDs with STAFF_EXCLUDED_CHANNEL_IDS (comma-separated).
const EXCLUDED_CHANNEL_IDS = new Set([
  ...((process.env.STAFF_EXCLUDED_CHANNEL_IDS || '').match(/\d{15,25}/g) || []),
]);

function stripExcluded(stats) {
  let removed = 0;
  for (const ch of EXCLUDED_CHANNEL_IDS) {
    if (stats.messages[ch]) { removed += stats.messages[ch]; delete stats.messages[ch]; }
  }
  if (removed) stats.messageTotal = Math.max(0, stats.messageTotal - removed);
  return stats;
}

// Channels whose chat IS recorded and shown in staff reports / profiles (per-
// channel counts, "Chats today", ...) but does NOT count toward the staff
// LEADERBOARD ranking (the !staff leaderboard and the 7-day Overall %).
// Add more channel IDs with STAFF_LEADERBOARD_EXCLUDED_CHANNEL_IDS (comma-separated).
const LEADERBOARD_EXCLUDED_CHANNEL_IDS = new Set([
  '1538500693449642011',
  ...((process.env.STAFF_LEADERBOARD_EXCLUDED_CHANNEL_IDS || '').match(/\d{15,25}/g) || []),
]);

// Returns a copy of `stats` with the leaderboard-excluded channels taken out.
function stripForLeaderboard(stats) {
  const messages = { ...stats.messages };
  let removed = 0;
  for (const ch of LEADERBOARD_EXCLUDED_CHANNEL_IDS) {
    if (messages[ch]) { removed += messages[ch]; delete messages[ch]; }
  }
  return { ...stats, messages, messageTotal: Math.max(0, stats.messageTotal - removed) };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function currentMonthKey() {
  return todayKey().slice(0, 7); // UTC "YYYY-MM"
}

function bufferDay(guildId, dayKey) {
  let g = buffer.get(guildId);
  if (!g) { g = {}; buffer.set(guildId, g); }
  if (!g[dayKey]) g[dayKey] = {};
  return g[dayKey];
}

function bufferUser(guildId, dayKey, userId) {
  const day = bufferDay(guildId, dayKey);
  if (!day[userId]) day[userId] = { messages: {}, messageTotal: 0, voiceSeconds: 0 };
  return day[userId];
}

function getStaffRoleId(guildId) {
  const store = getGuildStore(guildId);
  return (store.staffActivity && store.staffActivity.roleId) || null;
}

function setStaffRoleId(guildId, roleId) {
  const store = getGuildStore(guildId);
  if (!store.staffActivity) store.staffActivity = { roleId: null, daily: {} };
  store.staffActivity.roleId = roleId;
  saveGuildStore(guildId, store);
}

// The staff list lives in staff-system.js (store.staffSystem.members, keyed
// by user ID). Read straight from the store so the two files don't need to
// require each other.
function getTrackedUserIds(guildId) {
  const store = getGuildStore(guildId);
  return Object.keys((store.staffSystem && store.staffSystem.members) || {});
}

function isTrackedUser(guildId, userId) {
  const store = getGuildStore(guildId);
  return Boolean(userId && store.staffSystem && store.staffSystem.members && store.staffSystem.members[userId]);
}

// Tracked = on the staff list, matched by user ID.
function isTrackedMember(guildId, member) {
  return Boolean(member) && isTrackedUser(guildId, member.id);
}

// Holds the optional `!staff role` role (used only to let people self-register).
function holdsStaffRole(guildId, member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  const roleId = getStaffRoleId(guildId);
  return Boolean(roleId) && member.roles.cache.has(roleId);
}

// Call from messageCreate for every non-bot guild message.
function recordMessage(guildId, member, channelId) {
  if (!isTrackedMember(guildId, member)) return;
  if (EXCLUDED_CHANNEL_IDS.has(String(channelId))) return; // not counted
  const u = bufferUser(guildId, todayKey(), member.id);
  u.messages[channelId] = (u.messages[channelId] || 0) + 1;
  u.messageTotal += 1;
}

function creditElapsed(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const session = voiceSessions.get(key);
  if (!session) return;
  const elapsedSec = Math.max(0, Math.round((Date.now() - session.since) / 1000));
  if (elapsedSec > 0) bufferUser(guildId, todayKey(), userId).voiceSeconds += elapsedSec;
}

// Call from voiceStateUpdate when a tracked member joins a voice channel
// (from having no channel at all).
function voiceJoin(guildId, member, channelId) {
  if (!isTrackedMember(guildId, member)) return;
  voiceSessions.set(`${guildId}:${member.id}`, { channelId, since: Date.now() });
}

// Call when a member leaves voice entirely (no new channel).
function voiceLeave(guildId, userId) {
  creditElapsed(guildId, userId);
  voiceSessions.delete(`${guildId}:${userId}`);
}

// Call when a member switches from one voice channel to another directly.
function voiceSwitch(guildId, member, newChannelId) {
  creditElapsed(guildId, member.id);
  if (isTrackedMember(guildId, member)) {
    voiceSessions.set(`${guildId}:${member.id}`, { channelId: newChannelId, since: Date.now() });
  } else {
    voiceSessions.delete(`${guildId}:${member.id}`);
  }
}

// Rolls every open voice session's elapsed-so-far into the buffer and resets
// its clock to now — so a long call gets captured incrementally on every
// auto-flush instead of only once someone finally leaves, and a restart
// between flushes only loses the time since the last one.
function creditOpenSessions() {
  for (const [key, session] of voiceSessions) {
    const sep = key.indexOf(':');
    const guildId = key.slice(0, sep);
    const userId = key.slice(sep + 1);
    const elapsedSec = Math.max(0, Math.round((Date.now() - session.since) / 1000));
    if (elapsedSec > 0) bufferUser(guildId, todayKey(), userId).voiceSeconds += elapsedSec;
    session.since = Date.now();
  }
}

// Merges one guild's buffered counts into its store and clears the buffer.
function flushGuild(guildId) {
  const g = buffer.get(guildId);
  if (!g || Object.keys(g).length === 0) return;
  const store = getGuildStore(guildId);
  if (!store.staffActivity) store.staffActivity = { roleId: null, daily: {} };
  if (!store.staffActivity.daily) store.staffActivity.daily = {};
  for (const [dayKey, users] of Object.entries(g)) {
    if (!store.staffActivity.daily[dayKey]) store.staffActivity.daily[dayKey] = {};
    const dayStore = store.staffActivity.daily[dayKey];
    for (const [userId, delta] of Object.entries(users)) {
      if (!dayStore[userId]) dayStore[userId] = { messages: {}, messageTotal: 0, voiceSeconds: 0 };
      const u = dayStore[userId];
      for (const [channelId, count] of Object.entries(delta.messages)) {
        u.messages[channelId] = (u.messages[channelId] || 0) + count;
      }
      u.messageTotal += delta.messageTotal;
      u.voiceSeconds += delta.voiceSeconds;
    }
  }
  saveGuildStore(guildId, store);
  buffer.delete(guildId);
}

function flushAll() {
  creditOpenSessions();
  for (const guildId of [...buffer.keys()]) flushGuild(guildId);
}

let flushTimer = null;
function startAutoFlush(intervalMs = 30000) {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    try { flushAll(); } catch (err) { console.error('[staff-activity] Auto-flush failed:', err); }
  }, intervalMs);
  flushTimer.unref?.();
}

// Wipes every saved + buffered message / voice count for a guild (the !staff
// panel Reset). The staff role setting is kept.
function resetGuild(guildId) {
  buffer.delete(guildId);
  for (const key of [...voiceSessions.keys()]) {
    if (key.startsWith(`${guildId}:`)) voiceSessions.delete(key);
  }
  const store = getGuildStore(guildId);
  if (!store.staffActivity) store.staffActivity = { roleId: null, daily: {} };
  store.staffActivity.daily = {};
  saveGuildStore(guildId, store);
}

// { messages: {channelId: count}, messageTotal, voiceSeconds } for one user
// on one day (default: today) — merges saved + still-buffered data, plus a
// live preview of elapsed time on any open voice call (computed on the fly,
// without touching the session, so calling this repeatedly is safe).
function getUserDayStats(guildId, userId, dayKey = todayKey()) {
  const store = getGuildStore(guildId);
  const saved = (store.staffActivity && store.staffActivity.daily && store.staffActivity.daily[dayKey] && store.staffActivity.daily[dayKey][userId])
    || { messages: {}, messageTotal: 0, voiceSeconds: 0 };
  const pending = (buffer.get(guildId) || {})[dayKey]?.[userId];

  const messages = { ...saved.messages };
  let messageTotal = saved.messageTotal;
  let voiceSeconds = saved.voiceSeconds;
  if (pending) {
    for (const [ch, n] of Object.entries(pending.messages)) messages[ch] = (messages[ch] || 0) + n;
    messageTotal += pending.messageTotal;
    voiceSeconds += pending.voiceSeconds;
  }
  if (dayKey === todayKey()) {
    const session = voiceSessions.get(`${guildId}:${userId}`);
    if (session) voiceSeconds += Math.max(0, Math.round((Date.now() - session.since) / 1000));
  }
  return stripExcluded({ messages, messageTotal, voiceSeconds });
}

// Same as above for a list of user IDs, sorted by messages then voice time.
function getLeaderboardStats(guildId, userIds, dayKey = todayKey()) {
  return userIds
    .map(userId => ({ userId, ...stripForLeaderboard(getUserDayStats(guildId, userId, dayKey)) }))
    .sort((a, b) => (b.messageTotal - a.messageTotal) || (b.voiceSeconds - a.voiceSeconds));
}

// Same shape as getUserDayStats, but summed across every day in one UTC
// calendar month (default: the current month) — merges saved days plus
// today's still-buffered data (and a live voice-session preview) when the
// current day falls inside the requested month.
function getUserMonthStats(guildId, userId, monthKey = currentMonthKey()) {
  const store = getGuildStore(guildId);
  const dailyStore = (store.staffActivity && store.staffActivity.daily) || {};
  const messages = {};
  let messageTotal = 0;
  let voiceSeconds = 0;
  for (const [dayKey, users] of Object.entries(dailyStore)) {
    if (!dayKey.startsWith(monthKey)) continue;
    const u = users[userId];
    if (!u) continue;
    for (const [ch, n] of Object.entries(u.messages)) messages[ch] = (messages[ch] || 0) + n;
    messageTotal += u.messageTotal;
    voiceSeconds += u.voiceSeconds;
  }
  const today = todayKey();
  if (today.startsWith(monthKey)) {
    const pending = (buffer.get(guildId) || {})[today]?.[userId];
    if (pending) {
      for (const [ch, n] of Object.entries(pending.messages)) messages[ch] = (messages[ch] || 0) + n;
      messageTotal += pending.messageTotal;
      voiceSeconds += pending.voiceSeconds;
    }
    const session = voiceSessions.get(`${guildId}:${userId}`);
    if (session) voiceSeconds += Math.max(0, Math.round((Date.now() - session.since) / 1000));
  }
  return stripExcluded({ messages, messageTotal, voiceSeconds });
}

// Same shape as getUserDayStats, summed over the last `days` UTC days
// including today (default 7) — used by the weekly staff report. Reads the
// store once instead of once per day.
// Pass { leaderboard: true } to leave out the leaderboard-excluded channels.
function getUserRangeStats(guildId, userId, days = 7, opts = {}) {
  const store = getGuildStore(guildId);
  const daily = (store.staffActivity && store.staffActivity.daily) || {};
  const pendingGuild = buffer.get(guildId) || {};
  const messages = {};
  let messageTotal = 0;
  let voiceSeconds = 0;
  for (let i = 0; i < days; i++) {
    const dayKey = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    for (const u of [daily[dayKey] && daily[dayKey][userId], pendingGuild[dayKey] && pendingGuild[dayKey][userId]]) {
      if (!u) continue;
      for (const [ch, n] of Object.entries(u.messages || {})) messages[ch] = (messages[ch] || 0) + n;
      messageTotal += u.messageTotal || 0;
      voiceSeconds += u.voiceSeconds || 0;
    }
  }
  const session = voiceSessions.get(`${guildId}:${userId}`);
  if (session) voiceSeconds += Math.max(0, Math.round((Date.now() - session.since) / 1000));
  const out = stripExcluded({ messages, messageTotal, voiceSeconds });
  return opts.leaderboard ? stripForLeaderboard(out) : out;
}

function getMonthLeaderboardStats(guildId, userIds, monthKey = currentMonthKey()) {
  return userIds
    .map(userId => ({ userId, ...stripForLeaderboard(getUserMonthStats(guildId, userId, monthKey)) }))
    .sort((a, b) => (b.messageTotal - a.messageTotal) || (b.voiceSeconds - a.voiceSeconds));
}

// ---------------------------------------------------------------------------
// !staff panel state — which staff member and which period (daily/monthly)
// each panel message is currently showing. Keyed by the panel message's own
// ID, so several admins can have independent panels open at once. In-memory
// only: lost on restart, which just means the panel falls back to its
// defaults (leaderboard, daily) on the next click — nothing durable is lost.
// ---------------------------------------------------------------------------
const panelState = new Map();

function getPanelState(messageId) {
  return panelState.get(messageId) || { userId: null, mode: 'daily' };
}

function setPanelState(messageId, patch) {
  const next = { ...getPanelState(messageId), ...patch };
  panelState.set(messageId, next);
  return next;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

module.exports = {
  todayKey, currentMonthKey,
  getStaffRoleId, setStaffRoleId, isTrackedMember, isTrackedUser, getTrackedUserIds, holdsStaffRole,
  recordMessage, voiceJoin, voiceLeave, voiceSwitch,
  flushAll, startAutoFlush, resetGuild,
  getUserDayStats, getLeaderboardStats,
  getUserMonthStats, getMonthLeaderboardStats, getUserRangeStats,
  getPanelState, setPanelState,
  formatDuration,
};
