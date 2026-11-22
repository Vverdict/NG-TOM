const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const staffActivity = require('./staff-activity');

// !staff-transfer <old user ID> <new user ID or @new account>
//
// Moves ALL staff progress from an old Discord account to a new one and wipes
// it from the old one: staff profile + rank, check-ins, leave, tasks, reports,
// history, daily message / VC stats and the "get to know you" form profile.
// If the new account is already on the staff list the two records are merged
// (earlier join date, higher rank, counters added together).
//
// Only the two user IDs in ALLOWED_TRANSFER_IDS may run it.
// A JSON backup of everything touched is written next to the data file first.

// ONLY these two user IDs may run the command (nobody else, not even the server owner).
const ALLOWED_TRANSFER_IDS = ['468459883847614484', '852161698298724362'];

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const clone = (o) => JSON.parse(JSON.stringify(o));
const pickId = (s) => ((String(s || '').match(/\d{15,25}/) || [null])[0]);

function transfer(guildId, oldId, newId) {
  const store = getGuildStore(guildId);
  const sys = store.staffSystem;
  const act = store.staffActivity;
  const profiles = store.staffProfiles;

  const summary = { member: false, merged: false, tasks: 0, reports: 0, history: 0, days: 0, profile: false };
  const backup = { guildId, oldId, newId, at: new Date().toISOString(), member: null, newMemberBefore: null, profile: null, newProfileBefore: null };

  if (sys) {
    // --- staff member record
    const oldM = sys.members && sys.members[oldId];
    if (oldM) {
      backup.member = clone(oldM);
      const newM = sys.members[newId];
      if (newM) {
        backup.newMemberBefore = clone(newM);
        summary.merged = true;
        newM.rank = Math.max(newM.rank || 0, oldM.rank || 0);
        newM.joinedAt = Math.min(newM.joinedAt || Infinity, oldM.joinedAt || Infinity);
        if (!Number.isFinite(newM.joinedAt)) newM.joinedAt = Date.now();
        newM.lastActiveAt = Math.max(newM.lastActiveAt || 0, oldM.lastActiveAt || 0);
        newM.checkins = (newM.checkins || 0) + (oldM.checkins || 0);
        newM.tasksDone = (newM.tasksDone || 0) + (oldM.tasksDone || 0);
        newM.recentCheckins = [...(oldM.recentCheckins || []), ...(newM.recentCheckins || [])].slice(-30);
        for (const k of Object.keys(oldM)) {
          if (k === 'userId' || k === 'recentCheckins') continue;
          if (newM[k] === undefined || newM[k] === null || newM[k] === '') newM[k] = oldM[k];
        }
      } else {
        sys.members[newId] = { ...clone(oldM), userId: newId };
      }
      delete sys.members[oldId];
      summary.member = true;
    }
    // --- tasks / reports / history
    for (const t of sys.tasks || []) {
      if (t.assigneeId === oldId) { t.assigneeId = newId; summary.tasks++; }
      if (t.by === oldId) t.by = newId;
    }
    for (const r of sys.reports || []) {
      if (r.userId === oldId) { r.userId = newId; summary.reports++; }
      if (r.by === oldId) r.by = newId;
    }
    for (const h of sys.history || []) {
      if (h.userId === oldId) { h.userId = newId; summary.history++; }
      if (h.by === oldId) h.by = newId;
    }
  }

  // --- daily message / VC stats
  if (act && act.daily) {
    for (const users of Object.values(act.daily)) {
      const o = users[oldId];
      if (!o) continue;
      const n = users[newId] || (users[newId] = { messages: {}, messageTotal: 0, voiceSeconds: 0 });
      for (const [ch, c] of Object.entries(o.messages || {})) n.messages[ch] = (n.messages[ch] || 0) + c;
      n.messageTotal += o.messageTotal || 0;
      n.voiceSeconds += o.voiceSeconds || 0;
      delete users[oldId];
      summary.days++;
    }
  }

  // --- "get to know you" form profile (staff-seed.json can't be edited live)
  if (profiles && profiles[oldId]) {
    backup.profile = clone(profiles[oldId]);
    if (profiles[newId]) backup.newProfileBefore = clone(profiles[newId]);
    profiles[newId] = { ...profiles[oldId], ...(profiles[newId] || {}), userId: newId };
    delete profiles[oldId];
    summary.profile = true;
  }

  if (sys) {
    sys.history.push({ at: Date.now(), type: 'transfer', userId: newId, by: null, text: `Staff progress transferred from account ${oldId}`.slice(0, 300) });
  }
  saveGuildStore(guildId, store);
  return { summary, backup };
}

module.exports = {
  transfer, // exported for testing
  name: 'staff-transfer',
  aliases: ['staff_transfer', 'transferstaff'],
  description: 'Move all staff progress from an old account to a new one — usage: !staff-transfer <old user ID> <new user ID or @mention>',
  adminOnly: false, // the ID list below is the only gate

  async execute(message, args) {
    const { guild, author } = message;
    if (!ALLOWED_TRANSFER_IDS.includes(author.id)) {
      return message.reply('❌ You are not allowed to transfer staff progress.').catch(() => {});
    }

    const oldId = pickId(args[0]);
    const newId = pickId(args[1]) || (message.mentions.users.first() || {}).id;
    if (!oldId || !newId) {
      return message.reply('Usage: `!staff-transfer <old user ID> <new user ID or @new account>`').catch(() => {});
    }
    if (oldId === newId) return message.reply('❌ The old and new account are the same.').catch(() => {});

    // Make sure counted-but-unsaved messages / VC time are written first.
    try { staffActivity.voiceLeave(guild.id, oldId); staffActivity.flushAll(); } catch { /* best effort */ }

    const store = getGuildStore(guild.id);
    const oldM = store.staffSystem && store.staffSystem.members && store.staffSystem.members[oldId];
    const hasProfile = store.staffProfiles && store.staffProfiles[oldId];
    const hasStats = store.staffActivity && store.staffActivity.daily
      && Object.values(store.staffActivity.daily).some(u => u[oldId]);
    if (!oldM && !hasProfile && !hasStats) {
      return message.reply(`❌ No staff data found for \`${oldId}\` in this server. Check the old ID.`).catch(() => {});
    }
    const newM = store.staffSystem && store.staffSystem.members && store.staffSystem.members[newId];

    const oldName = oldM && oldM.name ? ` (${oldM.name})` : '';
    const ask = await message.reply({
      content: `⚠️ **Transfer staff progress?**\n`
        + `**From (will be wiped):** <@${oldId}>${oldName} \`${oldId}\`\n`
        + `**To:** <@${newId}> \`${newId}\`\n`
        + (newM ? '⚠️ The new account is already on the staff list — the two records will be **merged**.\n' : '')
        + 'This cannot be undone from Discord (a backup file is saved on the server). Press **Confirm** within 60 seconds.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('stafftransfer_yes').setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('stafftransfer_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { parse: [] },
    });

    let click;
    try {
      click = await ask.awaitMessageComponent({
        componentType: ComponentType.Button, time: 60000,
        filter: i => i.user.id === author.id && i.customId.startsWith('stafftransfer_'),
      });
    } catch {
      return ask.edit({ content: '⌛ Transfer cancelled (no confirmation).', components: [] }).catch(() => {});
    }
    if (click.customId === 'stafftransfer_no') {
      return click.update({ content: '❎ Transfer cancelled.', components: [] }).catch(() => {});
    }

    try {
      // Re-flush in case anything was counted while waiting, then move.
      try { staffActivity.voiceLeave(guild.id, oldId); staffActivity.flushAll(); } catch { /* best effort */ }
      const { summary, backup } = transfer(guild.id, oldId, newId);
      let backupNote = '';
      try {
        const dir = path.join(DATA_DIR, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `staff-transfer-${guild.id}-${oldId}-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(backup, null, 2));
        backupNote = `\n💾 Backup saved: \`${path.basename(file)}\``;
      } catch (err) { backupNote = `\n⚠️ Backup file could not be written (${err.message}).`; }

      await click.update({
        content: `✅ **Staff progress moved** from <@${oldId}> to <@${newId}>${summary.merged ? ' (merged with their existing record)' : ''}.\n`
          + `Profile & rank: ${summary.member ? 'moved' : 'none found'} · Tasks: ${summary.tasks} · Reports: ${summary.reports} · History entries: ${summary.history} · Activity days: ${summary.days} · Form profile: ${summary.profile ? 'moved' : 'none'}\n`
          + `The old account now has no staff data.${backupNote}`,
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('[staff-transfer] failed:', err);
      await click.update({ content: `❌ Transfer failed: ${err.message}`, components: [] }).catch(() => {});
    }
  },
};
