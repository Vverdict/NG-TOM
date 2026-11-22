'use strict';
const {
  EmbedBuilder, Events, AuditLogEvent, PermissionFlagsBits, PermissionsBitField, ChannelType,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

// ---------------------------------------------------------------------------
// Server logs — 9 log channels.
//
// NOTHING is stored: every event is turned into an embed and sent straight to
// its log channel. The only thing saved is which channel ID belongs to which
// category (guild settings -> serverLogs.channels).
//
// Message edit/delete text can only be shown while the message is still in
// the bot's in-memory cache (messages seen since the bot started).
// ---------------------------------------------------------------------------

const CATEGORIES = {
  server:     { name: 'server-management-logs', label: 'Server Management', topic: 'Server name / icon / banner / settings changes' },
  member:     { name: 'member-logs',            label: 'Member',            topic: 'Joins, leaves, kicks, bans, nickname / profile changes, timeouts' },
  role:       { name: 'role-logs',              label: 'Role',              topic: 'Role create / delete / edits / assignments' },
  channel:    { name: 'channel-logs',           label: 'Channel',           topic: 'Channel create / delete / edits / permissions' },
  message:    { name: 'message-logs',           label: 'Message',           topic: 'Deleted / edited / pinned messages, threads, forum posts' },
  voice:      { name: 'voice-logs',             label: 'Voice',             topic: 'Voice joins, leaves, moves, server mute / deafen' },
  moderation: { name: 'moderation-logs',        label: 'Moderation',        topic: 'Bans, kicks, timeouts, warnings, AutoMod, suspicious activity' },
  security:   { name: 'security-logs',          label: 'Integration & Security', topic: 'Webhooks, bots, invites, integrations, emoji, stickers, events' },
  community:  { name: 'community-logs',         label: 'Community & Other', topic: 'Stage, threads, onboarding, soundboard, AutoMod rules, other audit-log entries' },
};
const KEYS = Object.keys(CATEGORIES);
const CATEGORY_NAME = '📋・SERVER LOGS';
// Your existing logs category — /setup-logs create uses it (if it exists in the server) instead of making a new one.
const DEFAULT_CATEGORY_ID = process.env.LOGS_CATEGORY_ID || '1570321174947430430';

const COLOR = {
  green: 0x2ecc71, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db,
  yellow: 0xf1c40f, grey: 0x95a5a6, purple: 0x9b59b6, dark: 0x2c2f33,
};

// ------------------------------------------------------------------ helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 1000) => {
  s = s === null || s === undefined ? '' : String(s);
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const fmtVal = v => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') { try { return clip(JSON.stringify(v), 80); } catch { return '[object]'; } }
  return clip(v, 80);
};
const unix = ms => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
const pretty = arr => arr.map(p => String(p).replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ');
const bitsIn = (a, b) => new PermissionsBitField(BigInt(a) & ~BigInt(b)).toArray(); // in a but not b
const userStr = u => (u ? `<@${u.id}> (${clip(u.username || u.tag || 'unknown', 40)})\n\`${u.id}\`` : 'Unknown');
const idMention = id => (id ? `<@${id}>` : 'Unknown');

function mk(color, title, description) {
  const e = new EmbedBuilder().setColor(color).setTitle(clip(title, 250)).setTimestamp();
  if (description) e.setDescription(clip(description, 3500));
  return e;
}
function field(e, name, value, inline = false) {
  e.addFields({ name: clip(name, 250), value: clip(value, 1000), inline });
  return e;
}
function addActor(e, entry) {
  if (!entry) return e;
  if (entry.executorId) field(e, 'Done by', idMention(entry.executorId), true);
  if (entry.reason) field(e, 'Reason', entry.reason, true);
  return e;
}
const changeLines = list => list
  .filter(([, a, b]) => String(a ?? '') !== String(b ?? ''))
  .map(([label, a, b]) => `**${label}:** ${fmtVal(a)} → ${fmtVal(b)}`);

// ------------------------------------------------------------- config cache
const cfgCache = new Map(); // guildId -> { key: channelId } | null
function getCfg(guildId) {
  if (cfgCache.has(guildId)) return cfgCache.get(guildId);
  let cfg = null;
  try {
    const s = getGuildStore(guildId);
    cfg = (s.settings && s.settings.serverLogs && s.settings.serverLogs.channels) || null;
  } catch (err) { console.error('[server-logs] config load failed:', err.message); }
  cfgCache.set(guildId, cfg);
  return cfg;
}
function saveCfg(guild, patch) {
  const store = getGuildStore(guild.id);
  if (!store.settings) store.settings = {};
  const cur = store.settings.serverLogs || { categoryId: null, channels: {} };
  const next = { categoryId: patch.categoryId !== undefined ? patch.categoryId : cur.categoryId, channels: { ...cur.channels, ...(patch.channels || {}) } };
  for (const k of patch.remove || []) delete next.channels[k];
  store.settings.serverLogs = next;
  saveGuildStore(guild.id, store);
  cfgCache.set(guild.id, next.channels);
  return next;
}
const isLogChannel = (guildId, channelId) => {
  const cfg = getCfg(guildId);
  return !!cfg && Object.values(cfg).includes(channelId);
};

// --------------------------------------------------------- batched sender
// One send per channel every ~1.5s, up to 10 embeds per message, so a burst
// of events (raid, bulk role change) never hits Discord's rate limit.
const queues = new Map(); // channelId -> { guild, items: [] }
let timer = null;
const MAX_QUEUE = 200;

function log(guild, key, embed) {
  try {
    const cfg = getCfg(guild.id);
    const id = cfg && cfg[key];
    if (!id) return;
    let q = queues.get(id);
    if (!q) { q = { guild, items: [] }; queues.set(id, q); }
    if (q.items.length >= MAX_QUEUE) q.items.shift();
    q.items.push(embed);
    if (!timer) timer = setTimeout(flush, 1500);
  } catch (err) { console.error('[server-logs] enqueue failed:', err.message); }
}

async function flush() {
  timer = null;
  for (const [id, q] of queues) {
    const ch = q.guild.channels.cache.get(id);
    if (!ch || !ch.isTextBased()) { queues.delete(id); continue; }
    const batch = [];
    let size = 0;
    while (q.items.length && batch.length < 10) {
      const len = JSON.stringify(q.items[0].toJSON()).length;
      if (batch.length && size + len > 5500) break;
      size += len;
      batch.push(q.items.shift());
    }
    if (batch.length) {
      try {
        await ch.send({ embeds: batch, allowedMentions: { parse: [] } });
      } catch (err) {
        console.warn(`[server-logs] send to #${ch.name} (${q.guild.id}) failed: ${err.message}`);
        if ([50013, 50001, 10003].includes(err.code)) queues.delete(id);
      }
    }
    if (!q.items.length) queues.delete(id);
  }
  if (queues.size) timer = setTimeout(flush, 1500);
}

// -------------------------------------------------------- audit-log lookup
let auditPending = 0;
async function audit(guild, types, { targetId = null, windowMs = 15000, wait = 1200, filter = null } = {}) {
  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  if (auditPending >= 15) return null; // raid protection — skip enrichment, still log the event
  auditPending++;
  try {
    if (wait) await sleep(wait);
    const list = Array.isArray(types) ? types : [types];
    const opts = list.length === 1 ? { type: list[0], limit: 8 } : { limit: 15 };
    const logs = await guild.fetchAuditLogs(opts);
    const now = Date.now();
    return logs.entries.find(e =>
      list.includes(e.action)
      && now - e.createdTimestamp < windowMs
      && (!targetId || e.targetId === targetId)
      && (!filter || filter(e))) || null;
  } catch { return null; } finally { auditPending--; }
}

// ------------------------------------------- high-permission role ping
// When a role carrying dangerous permissions (Administrator, Manage Server/
// Roles/Channels, Ban/Kick, ...) is given to a member, post in the role-logs
// channel and ping ONLY: this fixed user + whoever gave the role.
// Override the pinged user with the ROLE_ALERT_USER_ID env var.
const ROLE_ALERT_USER_ID = process.env.ROLE_ALERT_USER_ID || '1498962894262374462';

async function pingHighRoleGrant(guild, targetUser, roles, entry) {
  try {
    const risky = [...roles.values()].filter(r => r.id !== guild.id && DANGEROUS.some(p => r.permissions.has(PermissionFlagsBits[p])));
    if (!risky.length) return;
    const cfg = getCfg(guild.id);
    const ch = cfg && guild.channels.cache.get(cfg.role);
    if (!ch || !ch.isTextBased()) return;
    const actorId = entry && entry.executorId;
    const users = [...new Set([ROLE_ALERT_USER_ID, ...(actorId ? [actorId] : [])])];
    const content = `🚨 <@${ROLE_ALERT_USER_ID}> **High-permission role given**\n`
      + `**Given by:** ${actorId ? `<@${actorId}>` : 'Unknown (no audit-log access)'}\n`
      + `**Given to:** <@${targetUser.id}>\n`
      + `**Role(s):** ${risky.map(r => `<@&${r.id}>`).join(' ')}`;
    await ch.send({ content: clip(content, 1900), allowedMentions: { users, roles: [] } });
  } catch (err) { console.warn('[server-logs] high-role ping failed:', err.message); }
}

// ------------------------------------------------------- suspicious bursts
const bursts = new Map();
function burst(key, windowMs, threshold) {
  const now = Date.now();
  const arr = (bursts.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  bursts.set(key, arr);
  return arr.length === threshold; // true exactly once per burst
}
function alert(guild, title, description) {
  log(guild, 'moderation', mk(COLOR.red, `🚨 Suspicious activity: ${title}`, description));
}

// ------------------------------------------------------------------- diffs
const DANGEROUS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'MentionEveryone', 'ManageWebhooks'];

function overwriteDiff(oldCh, newCh) {
  const out = [];
  const o = oldCh.permissionOverwrites.cache;
  const n = newCh.permissionOverwrites.cache;
  const label = (id, ow) => (ow.type === 0 || ow.type === 'role' ? `<@&${id}>` : `<@${id}>`);
  for (const [id, ow] of n) {
    const prev = o.get(id);
    if (!prev) {
      const a = ow.allow.toArray(); const d = ow.deny.toArray();
      out.push(`➕ ${label(id, ow)} added${a.length ? ` — allow: ${pretty(a)}` : ''}${d.length ? ` — deny: ${pretty(d)}` : ''}`);
    } else if (prev.allow.bitfield !== ow.allow.bitfield || prev.deny.bitfield !== ow.deny.bitfield) {
      const parts = [];
      const aAdd = bitsIn(ow.allow.bitfield, prev.allow.bitfield); if (aAdd.length) parts.push(`✅ allowed: ${pretty(aAdd)}`);
      const aDel = bitsIn(prev.allow.bitfield, ow.allow.bitfield); if (aDel.length) parts.push(`↩️ no longer allowed: ${pretty(aDel)}`);
      const dAdd = bitsIn(ow.deny.bitfield, prev.deny.bitfield); if (dAdd.length) parts.push(`⛔ denied: ${pretty(dAdd)}`);
      const dDel = bitsIn(prev.deny.bitfield, ow.deny.bitfield); if (dDel.length) parts.push(`↩️ no longer denied: ${pretty(dDel)}`);
      out.push(`✏️ ${label(id, ow)} — ${parts.join(' | ')}`);
    }
  }
  for (const [id, ow] of o) if (!n.has(id)) out.push(`➖ ${label(id, ow)} overwrite removed`);
  return out;
}

const chanKind = ch => {
  switch (ch.type) {
    case ChannelType.GuildText: return 'Text channel';
    case ChannelType.GuildVoice: return 'Voice channel';
    case ChannelType.GuildCategory: return 'Category';
    case ChannelType.GuildAnnouncement: return 'Announcement channel';
    case ChannelType.GuildStageVoice: return 'Stage channel';
    case ChannelType.GuildForum: return 'Forum channel';
    default: return 'Channel';
  }
};
const isForum = t => !!t.parent && (t.parent.type === ChannelType.GuildForum || t.parent.type === ChannelType.GuildMedia);

// =========================================================================
function attach(client) {
  setInterval(() => { // keep the burst map small
    const now = Date.now();
    for (const [k, arr] of bursts) if (!arr.some(t => now - t < 120000)) bursts.delete(k);
  }, 10 * 60 * 1000).unref();

  const on = (event, fn) => client.on(event, async (...args) => {
    try { await fn(...args); } catch (err) { console.error(`[server-logs] ${String(event)} handler failed:`, err); }
  });

  // ============================================================ 1. SERVER
  on(Events.GuildUpdate, async (o, n) => {
    const lines = changeLines([
      ['Name', o.name, n.name],
      ['Description', o.description, n.description],
      ['Vanity URL', o.vanityURLCode, n.vanityURLCode],
      ['Verification level', o.verificationLevel, n.verificationLevel],
      ['Explicit content filter', o.explicitContentFilter, n.explicitContentFilter],
      ['Default notifications', o.defaultMessageNotifications, n.defaultMessageNotifications],
      ['2FA requirement', o.mfaLevel, n.mfaLevel],
      ['AFK channel', o.afkChannelId && `<#${o.afkChannelId}>`, n.afkChannelId && `<#${n.afkChannelId}>`],
      ['AFK timeout (s)', o.afkTimeout, n.afkTimeout],
      ['System channel', o.systemChannelId && `<#${o.systemChannelId}>`, n.systemChannelId && `<#${n.systemChannelId}>`],
      ['Rules channel', o.rulesChannelId && `<#${o.rulesChannelId}>`, n.rulesChannelId && `<#${n.rulesChannelId}>`],
      ['Updates channel', o.publicUpdatesChannelId && `<#${o.publicUpdatesChannelId}>`, n.publicUpdatesChannelId && `<#${n.publicUpdatesChannelId}>`],
      ['Language', o.preferredLocale, n.preferredLocale],
      ['Boost progress bar', o.premiumProgressBarEnabled, n.premiumProgressBarEnabled],
      ['Owner', o.ownerId && `<@${o.ownerId}>`, n.ownerId && `<@${n.ownerId}>`],
    ]);
    const e = mk(COLOR.blue, '⚙️ Server updated');
    if (o.icon !== n.icon) { lines.push('**Icon:** changed'); const u = n.iconURL({ size: 256 }); if (u) e.setThumbnail(u); }
    if (o.banner !== n.banner) { lines.push('**Banner:** changed'); const u = n.bannerURL({ size: 512 }); if (u) e.setImage(u); }
    if (o.splash !== n.splash) lines.push('**Invite splash:** changed');
    if (o.discoverySplash !== n.discoverySplash) lines.push('**Discovery splash:** changed');
    if (!lines.length) return;
    e.setDescription(clip(lines.join('\n'), 3500));
    addActor(e, await audit(n, AuditLogEvent.GuildUpdate, { targetId: n.id }));
    log(n, 'server', e);
  });

  // ============================================================ 2. MEMBER
  on(Events.GuildMemberAdd, async (m) => {
    const guild = m.guild;
    const ageMs = Date.now() - m.user.createdTimestamp;
    if (m.user.bot) {
      const e = mk(COLOR.purple, '🤖 Bot added to server');
      field(e, 'Bot', userStr(m.user), true);
      e.setThumbnail(m.user.displayAvatarURL({ size: 128 }));
      addActor(e, await audit(guild, AuditLogEvent.BotAdd, { targetId: m.id }));
      log(guild, 'security', e);
      return;
    }
    const e = mk(COLOR.green, '📥 Member joined');
    e.setThumbnail(m.user.displayAvatarURL({ size: 128 }));
    field(e, 'Member', userStr(m.user), true);
    field(e, 'Account created', unix(m.user.createdTimestamp), true);
    field(e, 'Member count', String(guild.memberCount), true);
    log(guild, 'member', e);

    if (ageMs < 3 * 24 * 3600 * 1000) {
      alert(guild, 'Very new account joined', `${userStr(m.user)}\nAccount created ${unix(m.user.createdTimestamp)}`);
    }
    if (burst(`join:${guild.id}`, 30000, 6)) {
      alert(guild, 'Possible raid — join burst', '6+ members joined within 30 seconds.');
    }
  });

  on(Events.GuildMemberRemove, async (m) => {
    const guild = m.guild;
    const user = m.user;
    if (!user) return;
    const found = await audit(guild, [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd], { targetId: user.id });
    if (user.bot) {
      const e = mk(COLOR.purple, '🤖 Bot removed from server');
      field(e, 'Bot', userStr(user), true);
      addActor(e, found);
      log(guild, 'security', e);
      return;
    }
    if (found && found.action === AuditLogEvent.MemberBanAdd) return; // covered by the ban log
    const roles = m.roles && m.roles.cache ? m.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`) : [];
    const kicked = !!found;
    const e = mk(kicked ? COLOR.orange : COLOR.red, kicked ? '👢 Member kicked' : '📤 Member left');
    e.setThumbnail(user.displayAvatarURL({ size: 128 }));
    field(e, 'Member', userStr(user), true);
    if (m.joinedTimestamp) field(e, 'Joined', unix(m.joinedTimestamp), true);
    if (roles.length) field(e, 'Roles', roles.join(' '));
    if (kicked) addActor(e, found);
    log(guild, 'member', e);
    if (kicked) log(guild, 'moderation', e);
  });

  on(Events.GuildBanAdd, async (ban) => {
    const guild = ban.guild;
    const entry = await audit(guild, AuditLogEvent.MemberBanAdd, { targetId: ban.user.id });
    const e = mk(COLOR.red, '🔨 Member banned');
    e.setThumbnail(ban.user.displayAvatarURL({ size: 128 }));
    field(e, 'User', userStr(ban.user), true);
    addActor(e, entry);
    if (!entry && ban.reason) field(e, 'Reason', ban.reason, true);
    log(guild, 'member', e);
    log(guild, 'moderation', e);
    if (entry && entry.executorId && burst(`ban:${guild.id}:${entry.executorId}`, 60000, 5)) {
      alert(guild, 'Mass banning', `${idMention(entry.executorId)} banned 5+ members within a minute.`);
    }
  });

  on(Events.GuildBanRemove, async (ban) => {
    const guild = ban.guild;
    const entry = await audit(guild, AuditLogEvent.MemberBanRemove, { targetId: ban.user.id });
    const e = mk(COLOR.green, '🔓 Member unbanned');
    field(e, 'User', userStr(ban.user), true);
    addActor(e, entry);
    log(guild, 'member', e);
    log(guild, 'moderation', e);
  });

  on(Events.GuildMemberUpdate, async (o, n) => {
    if (o.partial) return; // nothing to compare against
    const guild = n.guild;
    const user = n.user;

    // nickname
    if (o.nickname !== n.nickname) {
      const e = mk(COLOR.blue, '✏️ Nickname changed');
      field(e, 'Member', userStr(user), true);
      field(e, 'Before', o.nickname || '*none*', true);
      field(e, 'After', n.nickname || '*none*', true);
      addActor(e, await audit(guild, AuditLogEvent.MemberUpdate, { targetId: n.id, filter: x => x.changes.some(c => c.key === 'nick') }));
      log(guild, 'member', e);
    }

    // server profile avatar
    if (o.avatar !== n.avatar) {
      const e = mk(COLOR.blue, '🖼️ Server profile avatar changed');
      field(e, 'Member', userStr(user), true);
      const u = n.avatarURL({ size: 256 }); if (u) e.setThumbnail(u);
      log(guild, 'member', e);
    }

    // timeouts
    const now = Date.now();
    const oT = o.communicationDisabledUntilTimestamp; const nT = n.communicationDisabledUntilTimestamp;
    const wasOn = !!oT && oT > now; const isOn = !!nT && nT > now;
    if (isOn && (!wasOn || oT !== nT)) {
      const e = mk(COLOR.orange, '⏳ Member timed out');
      field(e, 'Member', userStr(user), true);
      field(e, 'Until', unix(nT), true);
      addActor(e, await audit(guild, AuditLogEvent.MemberUpdate, { targetId: n.id, filter: x => x.changes.some(c => c.key === 'communication_disabled_until') }));
      log(guild, 'member', e); log(guild, 'moderation', e);
    } else if (wasOn && !isOn) {
      const e = mk(COLOR.green, '✅ Timeout removed');
      field(e, 'Member', userStr(user), true);
      addActor(e, await audit(guild, AuditLogEvent.MemberUpdate, { targetId: n.id, filter: x => x.changes.some(c => c.key === 'communication_disabled_until') }));
      log(guild, 'member', e); log(guild, 'moderation', e);
    }

    // roles assigned / removed
    const added = n.roles.cache.filter(r => !o.roles.cache.has(r.id));
    const removed = o.roles.cache.filter(r => !n.roles.cache.has(r.id));
    if (added.size || removed.size) {
      const entry = await audit(guild, AuditLogEvent.MemberRoleUpdate, { targetId: n.id });
      if (added.size) {
        const e = mk(COLOR.green, '➕ Role assigned to member');
        field(e, 'Member', userStr(user), true);
        field(e, 'Role(s)', added.map(r => `<@&${r.id}>`).join(' '), true);
        addActor(e, entry); log(guild, 'role', e);
        pingHighRoleGrant(guild, user, added, entry);
      }
      if (removed.size) {
        const e = mk(COLOR.orange, '➖ Role removed from member');
        field(e, 'Member', userStr(user), true);
        field(e, 'Role(s)', removed.map(r => `<@&${r.id}>`).join(' '), true);
        addActor(e, entry); log(guild, 'role', e);
      }
    }
  });

  // Global profile changes (username / display name / avatar) — only seen for cached users.
  on(Events.UserUpdate, async (o, n) => {
    const lines = changeLines([
      ['Username', o.username, n.username],
      ['Display name', o.globalName, n.globalName],
    ]);
    if (o.avatar !== n.avatar) lines.push('**Avatar:** changed');
    if (!lines.length) return;
    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.cache.has(n.id)) continue;
      const e = mk(COLOR.blue, '👤 User profile changed', lines.join('\n'));
      field(e, 'User', userStr(n), true);
      e.setThumbnail(n.displayAvatarURL({ size: 128 }));
      log(guild, 'member', e);
    }
  });

  // =============================================================== 3. ROLE
  on(Events.GuildRoleCreate, async (r) => {
    const e = mk(COLOR.green, '🆕 Role created');
    field(e, 'Role', `<@&${r.id}> (${clip(r.name, 60)})\n\`${r.id}\``, true);
    addActor(e, await audit(r.guild, AuditLogEvent.RoleCreate, { targetId: r.id }));
    log(r.guild, 'role', e);
  });

  on(Events.GuildRoleDelete, async (r) => {
    const e = mk(COLOR.red, '🗑️ Role deleted');
    field(e, 'Role', `${clip(r.name, 60)}\n\`${r.id}\``, true);
    field(e, 'Colour', r.hexColor, true);
    addActor(e, await audit(r.guild, AuditLogEvent.RoleDelete, { targetId: r.id }));
    log(r.guild, 'role', e);
    if (burst(`roledel:${r.guild.id}`, 30000, 3)) alert(r.guild, 'Mass role deletion', '3+ roles were deleted within 30 seconds.');
  });

  on(Events.GuildRoleUpdate, async (o, n) => {
    const lines = changeLines([
      ['Name', o.name, n.name],
      ['Colour', o.hexColor, n.hexColor],
      ['Shown separately', o.hoist, n.hoist],
      ['Mentionable', o.mentionable, n.mentionable],
      ['Position (hierarchy)', o.position, n.position],
    ]);
    if (o.icon !== n.icon) lines.push('**Icon:** changed');
    const pAdd = bitsIn(n.permissions.bitfield, o.permissions.bitfield);
    const pDel = bitsIn(o.permissions.bitfield, n.permissions.bitfield);
    if (pAdd.length) lines.push(`**Permissions added:** ${pretty(pAdd)}`);
    if (pDel.length) lines.push(`**Permissions removed:** ${pretty(pDel)}`);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '🛠️ Role updated');
    field(e, 'Role', `<@&${n.id}> (${clip(n.name, 60)})`, true);
    e.setDescription(clip(lines.join('\n'), 3500));
    addActor(e, await audit(n.guild, AuditLogEvent.RoleUpdate, { targetId: n.id }));
    log(n.guild, 'role', e);

    const dangerous = pAdd.filter(p => DANGEROUS.includes(p));
    if (dangerous.length) {
      alert(n.guild, n.id === n.guild.id ? '@everyone gained dangerous permissions' : 'Role gained dangerous permissions',
        `<@&${n.id}> was given: **${pretty(dangerous)}**`);
    }
  });

  // ============================================================ 4. CHANNEL
  on(Events.ChannelCreate, async (ch) => {
    if (!ch.guild) return;
    const e = mk(COLOR.green, `🆕 ${chanKind(ch)} created`);
    field(e, 'Channel', `<#${ch.id}> (${clip(ch.name, 60)})\n\`${ch.id}\``, true);
    if (ch.parentId) field(e, 'Category', `<#${ch.parentId}>`, true);
    addActor(e, await audit(ch.guild, AuditLogEvent.ChannelCreate, { targetId: ch.id }));
    log(ch.guild, 'channel', e);
  });

  on(Events.ChannelDelete, async (ch) => {
    if (!ch.guild) return;
    const e = mk(COLOR.red, `🗑️ ${chanKind(ch)} deleted`);
    field(e, 'Channel', `${clip(ch.name, 60)}\n\`${ch.id}\``, true);
    if (ch.parentId) field(e, 'Category', `<#${ch.parentId}>`, true);
    addActor(e, await audit(ch.guild, AuditLogEvent.ChannelDelete, { targetId: ch.id }));
    log(ch.guild, 'channel', e);
    if (burst(`chdel:${ch.guild.id}`, 30000, 3)) alert(ch.guild, 'Mass channel deletion', '3+ channels were deleted within 30 seconds.');
  });

  on(Events.ChannelUpdate, async (o, n) => {
    if (!n.guild) return;
    const lines = changeLines([
      ['Name', o.name, n.name],
      ['Topic', o.topic, n.topic],
      ['Category', o.parentId && `<#${o.parentId}>`, n.parentId && `<#${n.parentId}>`],
      ['Position', o.rawPosition, n.rawPosition],
      ['Slowmode (s)', o.rateLimitPerUser, n.rateLimitPerUser],
      ['NSFW', o.nsfw, n.nsfw],
      ['Bitrate', o.bitrate, n.bitrate],
      ['User limit', o.userLimit, n.userLimit],
    ]);
    if (o.permissionOverwrites && n.permissionOverwrites) lines.push(...overwriteDiff(o, n));
    if (!lines.length) return;
    const e = mk(COLOR.blue, `🛠️ ${chanKind(n)} updated`);
    field(e, 'Channel', `<#${n.id}> (${clip(n.name, 60)})`, true);
    e.setDescription(clip(lines.join('\n'), 3500));
    addActor(e, await audit(n.guild, [AuditLogEvent.ChannelUpdate, AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete], { targetId: n.id }));
    log(n.guild, 'channel', e);
  });

  // ============================================================ 5. MESSAGE
  on(Events.MessageDelete, async (m) => {
    if (!m.guild || isLogChannel(m.guild.id, m.channelId)) return;
    if (m.author && m.author.bot) return;
    const e = mk(COLOR.red, '🗑️ Message deleted');
    if (m.author) field(e, 'Author', userStr(m.author), true);
    field(e, 'Channel', `<#${m.channelId}>`, true);
    if (m.partial || m.content === null) e.setDescription('*Message text unavailable (sent before the bot cached it).*');
    else if (m.content) e.setDescription(clip(m.content, 3500));
    if (m.attachments && m.attachments.size) field(e, 'Attachments', m.attachments.map(a => a.name || a.url).join('\n'));
    field(e, 'Message ID', `\`${m.id}\``, true);
    if (m.author) {
      const entry = await audit(m.guild, AuditLogEvent.MessageDelete, { targetId: m.author.id, windowMs: 8000, filter: x => !x.extra || !x.extra.channel || x.extra.channel.id === m.channelId });
      if (entry && entry.executorId) field(e, 'Deleted by', idMention(entry.executorId), true);
    }
    log(m.guild, 'message', e);
  });

  on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!channel.guild) return;
    const lines = [];
    for (const m of [...messages.values()].slice(0, 15)) {
      const who = m.author ? m.author.username : 'unknown';
      lines.push(`**${clip(who, 30)}:** ${m.content ? clip(m.content.replace(/\n/g, ' '), 90) : '*not cached*'}`);
    }
    const e = mk(COLOR.red, '🧹 Bulk messages deleted', lines.join('\n'));
    field(e, 'Channel', `<#${channel.id}>`, true);
    field(e, 'Count', String(messages.size), true);
    addActor(e, await audit(channel.guild, AuditLogEvent.MessageBulkDelete, { windowMs: 8000 }));
    log(channel.guild, 'message', e);
  });

  on(Events.MessageUpdate, async (o, n) => {
    if (!n.guild || isLogChannel(n.guild.id, n.channelId)) return;
    if (n.partial) { try { await n.fetch(); } catch { return; } }
    if (n.author && n.author.bot) return;
    const newText = n.content;
    if (!o.partial && o.content === newText) return; // embed / pin / etc. update, not an edit
    if (o.partial && newText === null) return;
    const e = mk(COLOR.yellow, '✏️ Message edited');
    if (n.author) field(e, 'Author', userStr(n.author), true);
    field(e, 'Channel', `<#${n.channelId}>`, true);
    field(e, 'Jump', `[Go to message](${n.url})`, true);
    field(e, 'Before', o.partial ? '*not cached*' : clip(o.content, 1000));
    field(e, 'After', clip(newText, 1000));
    log(n.guild, 'message', e);
  });

  on(Events.ThreadCreate, async (t, newlyCreated) => {
    if (!t.guild || !newlyCreated) return;
    const forum = isForum(t);
    const e = mk(COLOR.green, forum ? '🆕 Forum post created' : '🆕 Thread created');
    field(e, forum ? 'Post' : 'Thread', `<#${t.id}> (${clip(t.name, 60)})`, true);
    if (t.parentId) field(e, forum ? 'Forum' : 'Parent channel', `<#${t.parentId}>`, true);
    if (t.ownerId) field(e, 'Created by', idMention(t.ownerId), true);
    log(t.guild, 'message', e);
  });

  on(Events.ThreadDelete, async (t) => {
    if (!t.guild) return;
    const forum = isForum(t);
    const e = mk(COLOR.red, forum ? '🗑️ Forum post deleted' : '🗑️ Thread deleted');
    field(e, forum ? 'Post' : 'Thread', `${clip(t.name, 60)}\n\`${t.id}\``, true);
    if (t.parentId) field(e, forum ? 'Forum' : 'Parent channel', `<#${t.parentId}>`, true);
    addActor(e, await audit(t.guild, AuditLogEvent.ThreadDelete, { targetId: t.id }));
    log(t.guild, 'message', e);
  });

  // =============================================================== 6. VOICE
  on(Events.VoiceStateUpdate, async (o, n) => {
    const guild = n.guild;
    const member = n.member || o.member;
    if (!member || member.user.bot) return;

    if (o.channelId !== n.channelId) {
      if (!o.channelId) {
        const e = mk(COLOR.green, '🔊 Joined voice');
        field(e, 'Member', userStr(member.user), true);
        field(e, 'Channel', `<#${n.channelId}>`, true);
        log(guild, 'voice', e);
        return;
      }
      // leave / switch — give the audit log a moment to show a moderator action
      await sleep(1500);
      if (!n.channelId) {
        const entry = await audit(guild, AuditLogEvent.MemberDisconnect, { wait: 0, windowMs: 6000 });
        const byMod = entry && entry.executorId !== member.id;
        const e = mk(byMod ? COLOR.orange : COLOR.grey, byMod ? '⛔ Member disconnected by moderator' : '🔇 Left voice');
        field(e, 'Member', userStr(member.user), true);
        field(e, 'Channel', `<#${o.channelId}>`, true);
        if (byMod) field(e, 'Done by (likely)', idMention(entry.executorId), true);
        log(guild, 'voice', e);
      } else {
        const entry = await audit(guild, AuditLogEvent.MemberMove, { wait: 0, windowMs: 6000, filter: x => !x.extra || !x.extra.channel || x.extra.channel.id === n.channelId });
        const byMod = entry && entry.executorId !== member.id;
        const e = mk(byMod ? COLOR.orange : COLOR.blue, byMod ? '↪️ Member moved by moderator' : '🔀 Switched voice channel');
        field(e, 'Member', userStr(member.user), true);
        field(e, 'From', `<#${o.channelId}>`, true);
        field(e, 'To', `<#${n.channelId}>`, true);
        if (byMod) field(e, 'Done by (likely)', idMention(entry.executorId), true);
        log(guild, 'voice', e);
      }
      return;
    }

    if (n.channelId && (o.serverMute !== n.serverMute || o.serverDeaf !== n.serverDeaf)) {
      const entry = await audit(guild, AuditLogEvent.MemberUpdate, { targetId: member.id, windowMs: 8000, filter: x => x.changes.some(c => c.key === 'mute' || c.key === 'deaf') });
      if (o.serverMute !== n.serverMute) {
        const e = mk(n.serverMute ? COLOR.orange : COLOR.green, n.serverMute ? '🔇 Member server-muted' : '🔈 Server mute removed');
        field(e, 'Member', userStr(member.user), true); field(e, 'Channel', `<#${n.channelId}>`, true);
        addActor(e, entry); log(guild, 'voice', e);
      }
      if (o.serverDeaf !== n.serverDeaf) {
        const e = mk(n.serverDeaf ? COLOR.orange : COLOR.green, n.serverDeaf ? '🔕 Member server-deafened' : '🔔 Server deafen removed');
        field(e, 'Member', userStr(member.user), true); field(e, 'Channel', `<#${n.channelId}>`, true);
        addActor(e, entry); log(guild, 'voice', e);
      }
    }
  });

  // ======================================================== 7. MODERATION
  on(Events.AutoModerationActionExecution, async (a) => {
    const e = mk(COLOR.orange, '🛡️ AutoMod action');
    field(e, 'Rule', a.ruleTriggerType !== undefined ? `Trigger type ${a.ruleTriggerType}` : `\`${a.ruleId}\``, true);
    field(e, 'User', idMention(a.userId), true);
    if (a.channelId) field(e, 'Channel', `<#${a.channelId}>`, true);
    field(e, 'Action', String(a.action && a.action.type), true);
    if (a.matchedKeyword) field(e, 'Matched', a.matchedKeyword, true);
    if (a.content) field(e, 'Content', a.content);
    log(a.guild, 'moderation', e);
  });

  // ============================================ 8. INTEGRATIONS & SECURITY
  on(Events.InviteCreate, async (inv) => {
    const guild = inv.guild && inv.guild.channels ? inv.guild : (inv.channel && inv.channel.guild);
    if (!guild) return;
    const e = mk(COLOR.green, '🔗 Invite created');
    field(e, 'Code', `\`${inv.code}\``, true);
    if (inv.channel) field(e, 'Channel', `<#${inv.channel.id}>`, true);
    if (inv.inviter) field(e, 'Created by', userStr(inv.inviter), true);
    field(e, 'Max uses', inv.maxUses ? String(inv.maxUses) : 'Unlimited', true);
    field(e, 'Expires', inv.expiresTimestamp ? unix(inv.expiresTimestamp) : 'Never', true);
    if (inv.temporary) field(e, 'Temporary membership', 'Yes', true);
    log(guild, 'security', e);
  });

  on(Events.InviteDelete, async (inv) => {
    const guild = inv.guild && inv.guild.channels ? inv.guild : (inv.channel && inv.channel.guild);
    if (!guild) return;
    const e = mk(COLOR.red, '🔗 Invite deleted');
    field(e, 'Code', `\`${inv.code}\``, true);
    if (inv.channel) field(e, 'Channel', `<#${inv.channel.id}>`, true);
    log(guild, 'security', e);
  });

  on(Events.GuildEmojiCreate, async (em) => {
    const e = mk(COLOR.green, '😀 Emoji created', `${em.toString()} \`:${em.name}:\``);
    if (em.imageURL) e.setThumbnail(em.imageURL({ size: 64 }));
    addActor(e, await audit(em.guild, AuditLogEvent.EmojiCreate, { targetId: em.id }));
    log(em.guild, 'security', e);
  });
  on(Events.GuildEmojiDelete, async (em) => {
    const e = mk(COLOR.red, '😶 Emoji deleted', `\`:${em.name}:\` (\`${em.id}\`)`);
    addActor(e, await audit(em.guild, AuditLogEvent.EmojiDelete, { targetId: em.id }));
    log(em.guild, 'security', e);
  });
  on(Events.GuildEmojiUpdate, async (o, n) => {
    const lines = changeLines([['Name', o.name, n.name]]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '😀 Emoji updated', `${n.toString()}\n${lines.join('\n')}`);
    addActor(e, await audit(n.guild, AuditLogEvent.EmojiUpdate, { targetId: n.id }));
    log(n.guild, 'security', e);
  });

  on(Events.GuildStickerCreate, async (s) => {
    const e = mk(COLOR.green, '🏷️ Sticker created', `**${clip(s.name, 60)}**${s.description ? `\n${clip(s.description, 200)}` : ''}`);
    if (s.url) e.setThumbnail(s.url);
    addActor(e, await audit(s.guild, AuditLogEvent.StickerCreate, { targetId: s.id }));
    log(s.guild, 'security', e);
  });
  on(Events.GuildStickerDelete, async (s) => {
    const e = mk(COLOR.red, '🏷️ Sticker deleted', `**${clip(s.name, 60)}** (\`${s.id}\`)`);
    addActor(e, await audit(s.guild, AuditLogEvent.StickerDelete, { targetId: s.id }));
    log(s.guild, 'security', e);
  });
  on(Events.GuildStickerUpdate, async (o, n) => {
    const lines = changeLines([['Name', o.name, n.name], ['Description', o.description, n.description], ['Tags', o.tags, n.tags]]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '🏷️ Sticker updated', lines.join('\n'));
    addActor(e, await audit(n.guild, AuditLogEvent.StickerUpdate, { targetId: n.id }));
    log(n.guild, 'security', e);
  });

  on(Events.GuildScheduledEventCreate, async (ev) => {
    const e = mk(COLOR.green, '📅 Scheduled event created');
    field(e, 'Name', ev.name, true);
    if (ev.scheduledStartTimestamp) field(e, 'Starts', unix(ev.scheduledStartTimestamp), true);
    if (ev.channelId) field(e, 'Channel', `<#${ev.channelId}>`, true);
    if (ev.entityMetadata && ev.entityMetadata.location) field(e, 'Location', ev.entityMetadata.location, true);
    if (ev.creatorId) field(e, 'Created by', idMention(ev.creatorId), true);
    log(ev.guild, 'security', e);
  });
  on(Events.GuildScheduledEventUpdate, async (o, n) => {
    if (!o) return;
    const lines = changeLines([
      ['Name', o.name, n.name], ['Description', o.description, n.description], ['Status', o.status, n.status],
      ['Start', o.scheduledStartTimestamp && `<t:${Math.floor(o.scheduledStartTimestamp / 1000)}:f>`, n.scheduledStartTimestamp && `<t:${Math.floor(n.scheduledStartTimestamp / 1000)}:f>`],
      ['Channel', o.channelId && `<#${o.channelId}>`, n.channelId && `<#${n.channelId}>`],
    ]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '📅 Scheduled event updated', lines.join('\n'));
    field(e, 'Event', clip(n.name, 100), true);
    addActor(e, await audit(n.guild, AuditLogEvent.GuildScheduledEventUpdate, { targetId: n.id }));
    log(n.guild, 'security', e);
  });
  on(Events.GuildScheduledEventDelete, async (ev) => {
    const e = mk(COLOR.red, '📅 Scheduled event deleted');
    field(e, 'Name', clip(ev.name, 100), true);
    addActor(e, await audit(ev.guild, AuditLogEvent.GuildScheduledEventDelete, { targetId: ev.id }));
    log(ev.guild, 'security', e);
  });

  // ======================================================== 9. COMMUNITY
  on(Events.ThreadUpdate, async (o, n) => {
    if (!n.guild) return;
    const lines = changeLines([
      ['Name', o.name, n.name], ['Archived', o.archived, n.archived], ['Locked', o.locked, n.locked],
      ['Auto-archive (min)', o.autoArchiveDuration, n.autoArchiveDuration], ['Slowmode (s)', o.rateLimitPerUser, n.rateLimitPerUser],
    ]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, isForum(n) ? '🧵 Forum post updated' : '🧵 Thread updated', lines.join('\n'));
    field(e, 'Thread', `<#${n.id}>`, true);
    log(n.guild, 'community', e);
  });

  on(Events.ThreadMembersUpdate, async (added, removed, thread) => {
    if (!thread.guild || (!added.size && !removed.size)) return;
    const e = mk(COLOR.grey, '🧵 Thread members changed');
    field(e, 'Thread', `<#${thread.id}>`, true);
    if (added.size) field(e, 'Joined', [...added.keys()].slice(0, 20).map(id => `<@${id}>`).join(' '));
    if (removed.size) field(e, 'Left', [...removed.keys()].slice(0, 20).map(id => `<@${id}>`).join(' '));
    log(thread.guild, 'community', e);
  });

  on(Events.StageInstanceCreate, async (s) => {
    const e = mk(COLOR.green, '🎙️ Stage started');
    field(e, 'Topic', s.topic, true); field(e, 'Channel', `<#${s.channelId}>`, true);
    log(s.guild, 'community', e);
  });
  on(Events.StageInstanceUpdate, async (o, n) => {
    if (!o) return;
    const lines = changeLines([['Topic', o.topic, n.topic], ['Privacy level', o.privacyLevel, n.privacyLevel]]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '🎙️ Stage updated', lines.join('\n'));
    field(e, 'Channel', `<#${n.channelId}>`, true);
    log(n.guild, 'community', e);
  });
  on(Events.StageInstanceDelete, async (s) => {
    const e = mk(COLOR.red, '🎙️ Stage ended');
    field(e, 'Topic', s.topic, true); field(e, 'Channel', `<#${s.channelId}>`, true);
    log(s.guild, 'community', e);
  });

  on(Events.AutoModerationRuleCreate, async (r) => {
    const e = mk(COLOR.green, '🛡️ AutoMod rule created');
    field(e, 'Rule', clip(r.name, 100), true); field(e, 'Enabled', String(r.enabled), true);
    if (r.creatorId) field(e, 'Created by', idMention(r.creatorId), true);
    log(r.guild, 'community', e);
  });
  on(Events.AutoModerationRuleUpdate, async (o, n) => {
    if (!o) return;
    const lines = changeLines([['Name', o.name, n.name], ['Enabled', o.enabled, n.enabled]]);
    if (!lines.length) return;
    const e = mk(COLOR.blue, '🛡️ AutoMod rule updated', lines.join('\n'));
    field(e, 'Rule', clip(n.name, 100), true);
    log(n.guild, 'community', e);
  });
  on(Events.AutoModerationRuleDelete, async (r) => {
    const e = mk(COLOR.red, '🛡️ AutoMod rule deleted');
    field(e, 'Rule', clip(r.name, 100), true);
    log(r.guild, 'community', e);
  });

  // Audit-log feed: webhooks / integrations / pins get their own embeds;
  // anything without a dedicated handler (onboarding, soundboard, etc.) is
  // posted to the Community log as a generic entry.
  const DEDICATED = new Set([
    'GuildUpdate', 'ChannelCreate', 'ChannelUpdate', 'ChannelDelete', 'ChannelOverwriteCreate', 'ChannelOverwriteUpdate',
    'ChannelOverwriteDelete', 'MemberKick', 'MemberBanAdd', 'MemberBanRemove', 'MemberUpdate', 'MemberRoleUpdate',
    'MemberMove', 'MemberDisconnect', 'RoleCreate', 'RoleUpdate', 'RoleDelete', 'InviteCreate', 'InviteUpdate',
    'InviteDelete', 'EmojiCreate', 'EmojiUpdate', 'EmojiDelete', 'StickerCreate', 'StickerUpdate', 'StickerDelete',
    'GuildScheduledEventCreate', 'GuildScheduledEventUpdate', 'GuildScheduledEventDelete', 'ThreadCreate',
    'ThreadUpdate', 'ThreadDelete', 'MessageDelete', 'MessageBulkDelete', 'BotAdd', 'StageInstanceCreate',
    'StageInstanceUpdate', 'StageInstanceDelete', 'AutoModerationRuleCreate', 'AutoModerationRuleUpdate',
    'AutoModerationRuleDelete', 'AutoModerationBlockMessage', 'AutoModerationFlagToChannel',
    'AutoModerationUserCommunicationDisabled', 'MemberPrune',
  ]);
  const entryEmbed = (entry, color, title) => {
    const e = mk(color, title);
    if (entry.executorId) field(e, 'Done by', idMention(entry.executorId), true);
    const tgt = entry.target && (entry.target.name || entry.target.username);
    field(e, 'Target', tgt ? `${clip(tgt, 80)}\n\`${entry.targetId}\`` : (entry.targetId ? `\`${entry.targetId}\`` : '—'), true);
    if (entry.reason) field(e, 'Reason', entry.reason, true);
    const ch = (entry.changes || []).slice(0, 10).map(c => `**${c.key}:** ${fmtVal(c.old)} → ${fmtVal(c.new)}`);
    if (ch.length) e.setDescription(clip(ch.join('\n'), 3500));
    return e;
  };

  on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    const name = AuditLogEvent[entry.action];
    if (!name) return;
    const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (/^Webhook/.test(name)) {
      const color = /Create/.test(name) ? COLOR.green : /Delete/.test(name) ? COLOR.red : COLOR.blue;
      return log(guild, 'security', entryEmbed(entry, color, `🪝 ${spaced}`));
    }
    if (/^Integration/.test(name)) {
      const color = /Create/.test(name) ? COLOR.green : /Delete/.test(name) ? COLOR.red : COLOR.blue;
      return log(guild, 'security', entryEmbed(entry, color, `🔌 ${spaced}`));
    }
    if (name === 'MessagePin' || name === 'MessageUnpin') {
      const e = mk(COLOR.yellow, name === 'MessagePin' ? '📌 Message pinned' : '📍 Message unpinned');
      const chId = entry.extra && entry.extra.channel && entry.extra.channel.id;
      const msgId = entry.extra && entry.extra.messageId;
      if (entry.executorId) field(e, 'Done by', idMention(entry.executorId), true);
      if (chId) field(e, 'Channel', `<#${chId}>`, true);
      const cached = chId && guild.channels.cache.get(chId) && guild.channels.cache.get(chId).messages.cache.get(msgId);
      if (cached && cached.content) field(e, 'Message', clip(cached.content, 500));
      if (chId && msgId) field(e, 'Jump', `[Go to message](https://discord.com/channels/${guild.id}/${chId}/${msgId})`, true);
      return log(guild, 'message', e);
    }
    if (DEDICATED.has(name)) return;
    log(guild, 'community', entryEmbed(entry, COLOR.dark, `📜 Audit log: ${spaced}`));
  });

  console.log('[server-logs] listeners attached.');
}

// ------------------------------------------------------------ setup helpers
async function setupGuild(guild) {
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('I need the **Manage Channels** permission to create the log channels.');
  }
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
  ];
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed) continue;
    if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) {
      overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    }
  }

  const store = getGuildStore(guild.id);
  const saved = (store.settings && store.settings.serverLogs) || { categoryId: null, channels: {} };
  let category = guild.channels.cache.get(saved.categoryId || DEFAULT_CATEGORY_ID) || null;
  if (!category) {
    category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: 'Server logs setup' });
  }
  const channels = { ...saved.channels };
  const created = []; const kept = [];
  for (const key of KEYS) {
    const existing = channels[key] && guild.channels.cache.get(channels[key]);
    if (existing) { kept.push(key); continue; }
    const ch = await guild.channels.create({
      name: CATEGORIES[key].name, type: ChannelType.GuildText, parent: category.id,
      topic: CATEGORIES[key].topic, permissionOverwrites: overwrites, reason: 'Server logs setup',
    });
    channels[key] = ch.id;
    created.push(key);
  }
  saveCfg(guild, { categoryId: category.id, channels });
  return { created, kept, categoryId: category.id };
}

function setChannel(guild, key, channelId) { return saveCfg(guild, { channels: { [key]: channelId } }); }
function clearChannel(guild, key) { return saveCfg(guild, { remove: [key] }); }
function getStatus(guild) {
  const cfg = getCfg(guild.id) || {};
  return KEYS.map(k => ({ key: k, label: CATEGORIES[k].label, channelId: cfg[k] && guild.channels.cache.has(cfg[k]) ? cfg[k] : null }));
}

// For a future /warn command: require('./server-logs').logWarning(guild, { target, moderator, reason })
function logWarning(guild, { target, moderator, reason }) {
  const e = mk(COLOR.yellow, '⚠️ Member warned');
  field(e, 'Member', userStr(target), true);
  if (moderator) field(e, 'Warned by', userStr(moderator), true);
  field(e, 'Reason', reason || 'No reason given');
  log(guild, 'moderation', e);
}

module.exports = { attach, setupGuild, setChannel, clearChannel, getStatus, logWarning, CATEGORIES, KEYS };
