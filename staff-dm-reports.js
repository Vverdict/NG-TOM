// Staff report DMs — sent to every user ID listed in ALLOWED_USER_IDS.
//   • Daily   : Active / Inactive / On-leave staff list.
//   • Weekly  : one report card per staff member (last 7 days), every Sunday.
//   • Monthly : one report card per staff member for the month that just ended,
//               on the 1st of each month.
// All times are STAFF_TZ (default Asia/Kolkata). Each report goes out at most
// once per period; if the bot was down at the exact time it still sends later
// the same day. Override the hour with STAFF_DM_REPORT_HOUR (0-23, default 0 = 12 AM).
const { EmbedBuilder } = require('discord.js');
const { envAllowedIds } = require('./access');
const staffSystem = require('./staff-system');
const staffActivity = require('./staff-activity');

const REPORT_HOUR = Number.isInteger(+process.env.STAFF_DM_REPORT_HOUR) && process.env.STAFF_DM_REPORT_HOUR !== ''
  ? Math.min(23, Math.max(0, +process.env.STAFF_DM_REPORT_HOUR)) : 0;
const STATUS_EMOJI = { active: '🟢', inactive: '🔴', leave: '🏖️' };
const COLOR = { main: 0x5865F2, ok: 0x57F287, bad: 0xED4245, warn: 0xFEE75C };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtDuration = staffActivity.formatDuration;
const ts = (ms, style = 'D') => `<t:${Math.floor(ms / 1000)}:${style}>`;

// ------------------------------------------------------------------ DM helper
async function dmAll(client, payloads) {
  const ids = envAllowedIds();
  let sent = 0, failed = 0;
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      for (const payload of payloads) { await user.send(payload); await sleep(600); }
      sent++;
    } catch (err) {
      failed++;
      console.warn(`[staff-dm] Couldn't DM ${id}: ${err.message}`);
    }
  }
  return { sent, failed, total: ids.length };
}

function chunkEmbeds(embeds, size = 10) {
  const out = [];
  for (let i = 0; i < embeds.length; i += size) out.push({ embeds: embeds.slice(i, i + size) });
  return out;
}

// ------------------------------------------------------------------ daily list
function buildDailyListEmbeds(guild) {
  const members = staffSystem.listMembers(guild.id);
  const by = (status) => members.filter(m => m.status === status);
  const line = (m) => `${STATUS_EMOJI[m.status]} <@${m.userId}> — ${m.rankName || ''}`.trim();
  const section = (title, list, empty) => {
    let text = '';
    let shown = 0;
    for (const m of list) {
      const l = line(m) + '\n';
      if ((text + l).length > 1000) break;
      text += l; shown++;
    }
    if (shown < list.length) text += `…and ${list.length - shown} more`;
    return { name: `${title} (${list.length})`, value: text || empty };
  };
  return [new EmbedBuilder()
    .setTitle(`📋 Daily Staff List — ${guild.name}`)
    .setColor(by('inactive').length ? COLOR.warn : COLOR.ok)
    .setDescription(`${members.length} staff • ${staffActivity.todayKey()}`)
    .addFields(
      section('🟢 Active Staff', by('active'), 'Nobody is active.'),
      section('🔴 Inactive Staff', by('inactive'), '🎉 Nobody is inactive.'),
      section('🏖️ Staff On Leave', by('leave'), 'Nobody is on leave.'),
    )
    .setFooter({ text: `Inactive = no check-in, finished work or report for ${staffSystem.INACTIVE_AFTER_DAYS}+ days (leave excluded).` })
    .setTimestamp()];
}

// ------------------------------------------------------------ per-staff cards
function memberCard(row, title, periodText, extra = {}) {
  const messages = extra.messages ?? row.messages;
  const voiceSeconds = extra.voiceSeconds ?? row.voiceSeconds;
  return new EmbedBuilder()
    .setTitle(`${STATUS_EMOJI[row.status] || ''} ${title} — ${row.name || row.userId}`)
    .setColor(row.status === 'inactive' ? COLOR.bad : row.status === 'leave' ? COLOR.warn : COLOR.ok)
    .setDescription(`<@${row.userId}> • ${row.rankName || ''}\n${periodText}`)
    .addFields(
      { name: '✅ Check-ins', value: String(row.checkins), inline: true },
      { name: '🛠️ Tasks done', value: `${row.tasksDone} (+${row.tasksOpen} open)`, inline: true },
      { name: '🧾 Reports', value: String(row.reports), inline: true },
      { name: '💬 Messages', value: String(messages), inline: true },
      { name: '🎙️ Voice', value: fmtDuration(voiceSeconds), inline: true },
      { name: 'Status', value: row.status, inline: true },
    );
}

function weeklyCards(guild, userId = null) {
  const { since, now, rows } = staffSystem.weeklyData(guild.id, 7);
  const period = `${ts(since)} → ${ts(now)} (last 7 days)`;
  return rows.filter(r => !userId || r.userId === userId).map(r => memberCard(r, 'Weekly Report', period));
}

// Previous calendar month in STAFF_TZ, e.g. "2026-09". Activity stores are keyed by UTC month.
function previousMonth(dayKey) {
  let [y, m] = dayKey.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return { key: `${y}-${String(m).padStart(2, '0')}`, days: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

function monthlyCards(guild, monthKey, daysInMonth, userId = null) {
  const { rows } = staffSystem.weeklyData(guild.id, daysInMonth);
  return rows.filter(r => !userId || r.userId === userId).map(r => {
    const act = staffActivity.getUserMonthStats(guild.id, r.userId, monthKey);
    return memberCard(r, 'Monthly Report', `Month: **${monthKey}**`, { messages: act.messageTotal, voiceSeconds: act.voiceSeconds });
  });
}

// ----------------------------------------------------------------- scheduler
function weekdayOf(dayKey) { return new Date(`${dayKey}T00:00:00Z`).getUTCDay(); } // 0 = Sunday

function startStaffDmReports(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = staffSystem.tzParts();
    if (now.hour < REPORT_HOUR) return;
    if (!envAllowedIds().length) return;
    running = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        if (!staffSystem.listMembers(guild.id).length) continue;

        // Daily list
        if (staffSystem.getDmReportMark(guild.id, 'daily') !== now.dayKey) {
          staffSystem.setDmReportMark(guild.id, 'daily', now.dayKey); // mark first: a crash can't double-send
          const r = await dmAll(client, [{ embeds: buildDailyListEmbeds(guild) }]);
          console.log(`[staff-dm] Daily list: ${r.sent}/${r.total} DM'd (guild ${guild.id}).`);
        }

        // Weekly — every Sunday
        if (weekdayOf(now.dayKey) === 0 && staffSystem.getDmReportMark(guild.id, 'weekly') !== now.dayKey) {
          staffSystem.setDmReportMark(guild.id, 'weekly', now.dayKey);
          const cards = weeklyCards(guild);
          const head = { content: `📊 **Weekly staff reports — ${guild.name}** (${cards.length} staff)` };
          const r = await dmAll(client, [head, ...chunkEmbeds(cards)]);
          console.log(`[staff-dm] Weekly reports: ${r.sent}/${r.total} DM'd (guild ${guild.id}).`);
        }

        // Monthly — the 1st, covering the month that just ended
        const prev = previousMonth(now.dayKey);
        if (now.dayKey.endsWith('-01') && staffSystem.getDmReportMark(guild.id, 'monthly') !== prev.key) {
          staffSystem.setDmReportMark(guild.id, 'monthly', prev.key);
          const cards = monthlyCards(guild, prev.key, prev.days);
          const head = { content: `🗓️ **Monthly staff reports for ${prev.key} — ${guild.name}** (${cards.length} staff)` };
          const r = await dmAll(client, [head, ...chunkEmbeds(cards)]);
          console.log(`[staff-dm] Monthly reports: ${r.sent}/${r.total} DM'd (guild ${guild.id}).`);
        }
      }
    } catch (err) {
      console.error('[staff-dm] report tick failed:', err);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 45 * 1000).unref?.();
  setInterval(tick, 60 * 1000).unref?.();
}

module.exports = { startStaffDmReports, dmAll, buildDailyListEmbeds, weeklyCards, monthlyCards, previousMonth };
