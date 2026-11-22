// The !staff admin panel — 16 buttons, their modals / pickers, and the weekly
// report. All custom IDs start with "staffp:". index.js hands every such
// interaction to handleInteraction(); data lives in staff-system.js.
//
// Who may press what:
//   • Admins (canManageBot) — everything.
//   • Staff (on the staff list, or holding the tracked staff role) — only
//     Check-in / Check-out, View Profile (their own),
//     My Activity, Staff Leave and Report Form. Nothing else.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');
// Modal "Upload File" field — needs discord.js >= 14.22. Older versions fall back to the photo-in-channel step.
const discordJs = require('discord.js');
const MODAL_UPLOAD = Boolean(discordJs.LabelBuilder && discordJs.FileUploadBuilder);
const { canManageBot } = require('./access');
const staffActivity = require('./staff-activity');
const staffSystem = require('./staff-system');
const { listGuildIds } = require('./storage');

// Optional: shrinks uploaded staff photos. Without it, only small images are kept.
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional */ }

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = { main: 0x5865F2, ok: 0x57F287, warn: 0xFEE75C, bad: 0xED4245 };
const GREEN_DOT = '<a:885679180799422574:1548939840547061910>'; // animated green dot = active
const RED_DOT = '<a:836435400498741289:1548939837422309397>';   // animated red dot = inactive
const STATUS_EMOJI = { active: GREEN_DOT, inactive: RED_DOT, leave: '🏖️' };
// Leaderboard panel only — animated custom emojis for active / inactive
const LB_STATUS_EMOJI = STATUS_EMOJI;
const MEDALS = ['🥇', '🥈', '🥉'];

// The ONLY buttons / forms regular staff may use: Check-in / Check-out, View Profile
// (their own), the Pick buttons on the work board, My Activity,
// Staff Leave and Report Form.
// Every other button, picker and form is admin-only.
const SELF_ACTIONS = new Set([
  'checkin', 'checkout', 'co_toggle', 'co_done', 'co_notdone', 'co_continue', 'profile', 'pick', 'myactivity', 'leave', 'report', 'cancel_leave', 'pick_menu', 'unpick_menu', 'pick_sel', 'unpick_sel',
  'm_checkin', 'm_checkout', 'm_leave', 'm_report',
]);

// Where "Distribute Work" posts its tasks (with Pick buttons). Put the channel
// ID in .env as STAFF_WORK_CHANNEL_ID=123456789012345678 — until it is set, the
// tasks are posted in the channel where the admin pressed the button.
const WORK_CHANNEL_ID = (process.env.STAFF_WORK_CHANNEL_ID || '1538500693449642009').trim();
// Public log channels: every check-in / check-out is announced here as an embed.
const CHECKIN_CHANNEL_ID = (process.env.STAFF_CHECKIN_CHANNEL_ID || '1554833110498279524').trim();
const LEAVE_CHANNEL_ID = (process.env.STAFF_LEAVE_CHANNEL_ID || '1538500693449642012').trim();
const CHECKOUT_CHANNEL_ID = (process.env.STAFF_CHECKOUT_CHANNEL_ID || '1558572437736530043').trim();
const MAX_BOARD_TASKS = 9;
// Role pinged every time Distribute Work posts a new work board.
const WORK_PING_ROLE_ID = (process.env.STAFF_WORK_PING_ROLE_ID || '1538500688223670352').trim();

// ------------------------------------------------------------------ helpers
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const isAdmin = (interaction) => canManageBot(interaction.member);

// STAFF_WORK_USER_IDS (Railway variable, comma-separated user IDs): these people may use
// Distribute Work (task board, extra tasks, image, post) and view the Leaderboard, and NOTHING
// else of the admin panel — they are not admins and get no report DMs or other notifications.
const WORK_ACTIONS = new Set(['distribute', 'dw_more', 'dw_image', 'dw_post', 'm_distribute', 'm_dw_image', 'leaderboard']);
const isWorkUser = (userId) => ((process.env.STAFF_WORK_USER_IDS || '').match(/\d{15,25}/g) || []).includes(String(userId));
// Staff = admins, anyone already on the staff list (matched by user ID), or —
// so new people can reach the Entry Form — anyone holding the `!staff role` role.
const isStaff = (interaction) => isAdmin(interaction)
  || staffActivity.isTrackedMember(interaction.guildId, interaction.member)
  || staffActivity.holdsStaffRole(interaction.guildId, interaction.member);
const reply = (interaction, content) => interaction.reply({ content, flags: EPHEMERAL });

// Today's chat + voice activity for the check-out embeds (same figures as View Profile / Leaderboard).
function dayActivityFields(guildId, userId) {
  const st = staffActivity.getUserDayStats(guildId, userId);
  const top = Object.entries(st.messages || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([ch, n]) => `<#${ch}> — **${n}**`).join('\n');
  const fields = [
    { name: '💬 Chats today', value: String(st.messageTotal || 0), inline: true },
    { name: '🎙️ VC time today', value: st.voiceSeconds ? fmtDuration(st.voiceSeconds) : '0m', inline: true },
  ];
  if (top) fields.push({ name: 'Chats by channel', value: top.slice(0, 1024) });
  return fields;
}

function joinLines(lines, max = 3900, empty = '—') {
  if (!lines.length) return empty;
  let out = '';
  let shown = 0;
  for (const line of lines) {
    if ((out + line + '\n').length > max - 40) break;
    out += line + '\n';
    shown++;
  }
  if (shown < lines.length) out += `…and ${lines.length - shown} more`;
  return out.trim();
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function textInput({ id, label, style = TextInputStyle.Short, required = true, placeholder, value, max, min }) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(String(value).slice(0, max || 4000));
  if (max) input.setMaxLength(max);
  if (min) input.setMinLength(min);
  return input;
}

function modal(customId, title, inputs) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(...inputs.map(i => row(i)));
}

function userSelect(customId, placeholder, max = 1) {
  return new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max);
}

const fmtDuration = staffActivity.formatDuration;

// ------------------------------------------------------------- main panel
// The panel shows a picture instead of text. Put the image next to the bot
// files as staff-panel.png (or .jpg / .jpeg / .webp / .gif), or set
// STAFF_PANEL_IMAGE_URL in .env to a direct image link.
function findPanelImage() {
  const fs = require('fs');
  const path = require('path');
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    const file = path.join(__dirname, `staff-panel.${ext}`);
    if (fs.existsSync(file)) return { file, name: `staff-panel.${ext}` };
  }
  return null;
}

function buildMainPanel(guild) {
  const embed = new EmbedBuilder().setColor(COLOR.main);
  const files = [];
  const url = (process.env.STAFF_PANEL_IMAGE_URL || '').trim();
  const local = findPanelImage();
  if (url) embed.setImage(url);
  else if (local) {
    files.push(new AttachmentBuilder(local.file, { name: local.name }));
    embed.setImage(`attachment://${local.name}`);
  } else {
    embed.setTitle('🛡️ Staff Control Panel'); // no image added yet
  }

  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`staffp:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);

  return {
    embeds: [embed],
    files,
    components: [
      row(btn('checkin', 'Staff Check-in / Check-out', '✅', ButtonStyle.Success), btn('entry', 'Staff Entry Form', '📝', ButtonStyle.Primary), btn('active', 'Active / Inactive Staff', '👥'), btn('leaderboard', 'Leaderboard', '🏆')),
      row(btn('list', 'Staff List / Remove', '📋'), btn('profile', 'View Profile / History', '👤'), btn('reset', 'Reset Panel', '🔄', ButtonStyle.Danger)),
      row(btn('distribute', 'Distribute Work', '📤', ButtonStyle.Primary), btn('history', 'Staff History', '📚'), btn('myactivity', 'My Activity', '📈')),
      row(btn('leave', 'Staff Leave', '🏖️'), btn('report', 'Report Form', '🧾')),
    ],
  };
}

// ------------------------------------------------------- screens (payloads)
// One screen for everybody: Active on top, then Inactive, then On Leave.
function statusListPayload(guildId) {
  const members = staffSystem.listMembers(guildId);
  const now = Date.now();
  const SECTION_MAX = 1250; // three sections must fit one embed description (4096)

  const active = members.filter(m => m.status === 'active')
    .map(m => `${GREEN_DOT} <@${m.userId}> • last active ${ts(m.lastActiveAt)} • ${m.openTasks} open task(s)`);
  const inactive = members.filter(m => m.status === 'inactive')
    .map(m => `${RED_DOT} <@${m.userId}> • idle **${Math.floor((now - m.lastActiveAt) / 86400000)}d** (last active ${ts(m.lastActiveAt)})`);
  const onLeave = members.filter(m => m.status === 'leave')
    .map(m => `🏖️ <@${m.userId}> • back after ${staffSystem.formatDay(m.leaveUntil - 1)}`);

  const description = [
    `**${GREEN_DOT} Active Staff (${active.length})**\n${joinLines(active, SECTION_MAX, 'Nobody is active right now.')}`,
    `**${RED_DOT} Inactive Staff (${inactive.length})**\n${joinLines(inactive, SECTION_MAX, '🎉 Nobody is inactive.')}`,
    `**🏖️ Staff On Leave (${onLeave.length})**\n${joinLines(onLeave, SECTION_MAX, 'Nobody is on leave.')}`,
  ].join('\n\n');

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`👥 Staff Status (${members.length})`)
      .setColor(inactive.length ? COLOR.warn : COLOR.ok)
      .setDescription(description)
      .setFooter({ text: `Inactive = no check-in, finished work or report for ${staffSystem.INACTIVE_AFTER_DAYS}+ days (leave excluded).` })],
    allowedMentions: { parse: [] },
  };
}

function buildListPayload(guildId, notice) {
  const members = staffSystem.listMembers(guildId);
  const lines = members.map(m => `${STATUS_EMOJI[m.status]} <@${m.userId}> — ${m.rankName} • ${m.position}`);
  const embed = new EmbedBuilder()
    .setTitle(`📋 Staff List (${members.length})`)
    .setColor(COLOR.main)
    .setDescription(joinLines(lines, 3900, 'No staff yet. Add some with the **Staff Entry Form** button on the panel.'));
  return {
    content: notice || null,
    embeds: [embed],
    components: [
      row(userSelect('staffp:add_select', '➕ Add staff member(s)…', 10)),
      row(userSelect('staffp:rm_select', '🗑️ Remove a staff member…')),
    ],
  };
}

async function buildProfilePayload(guild, userId, { picker = false, notice = null } = {}) {
  const components = picker ? [row(userSelect('staffp:profile_select', '👤 Pick another staff member…'))] : [];
  const m = staffSystem.getMember(guild.id, userId);
  if (!m) {
    return {
      content: notice,
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setDescription(`❌ <@${userId}> isn't in the staff list.`)],
      components,
    };
  }

  const discordMember = await guild.members.fetch(userId).catch(() => null);
  const week = staffActivity.getUserRangeStats(guild.id, userId, 7);
  const month = staffActivity.getUserMonthStats(guild.id, userId);
  const topChannels = Object.entries(month.messages).sort(([, a], [, b]) => b - a).slice(0, 5)
    .map(([ch, n]) => `<#${ch}> — **${n}**`);
  const history = staffSystem.getHistory(guild.id, 8, userId)
    .map(h => `${ts(h.at)} **${h.type.replace('_', ' ')}** — ${h.text || '—'}`);

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${m.name || discordMember?.displayName || 'Staff member'}`)
    .setColor(COLOR[m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'warn'])
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Rank', value: m.rankName, inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[m.status]} ${m.status[0].toUpperCase()}${m.status.slice(1)}`, inline: true },
      { name: 'Position', value: m.position || '—', inline: true },
      { name: 'Joined', value: ts(m.joinedAt, 'D'), inline: true },
      { name: 'Last active', value: ts(m.lastActiveAt), inline: true },
      { name: 'Active timings', value: m.availability || '—', inline: true },
      { name: 'Check-ins', value: `${m.checkins || 0} counted • ${m.missed || 0} missed (no check-out)`, inline: true },
      { name: 'Work', value: `${m.tasksDone || 0} done • ${m.openTasks} open`, inline: true },
      { name: 'Last 7 days', value: `💬 ${week.messageTotal} • 🎙️ ${fmtDuration(week.voiceSeconds)}`, inline: true },
    );
  if (m.leaveUntil && m.leaveUntil > Date.now()) {
    const range = `${staffSystem.formatDay(m.leaveFrom || Date.now())} → ${staffSystem.formatDay(m.leaveUntil - 1)}`;
    embed.addFields({ name: staffSystem.onLeaveNow(m) ? 'On leave' : 'Leave scheduled', value: range, inline: true });
  }
  // Staff on leave: nothing below the "On leave" line (no contact, notes, channels or history).
  if (!staffSystem.onLeaveNow(m)) {
    if (m.contact) embed.addFields({ name: 'Contact', value: m.contact, inline: true });
    if (m.email) embed.addFields({ name: 'E-mail', value: m.email.slice(0, 100), inline: true });
    if (m.notes) embed.addFields({ name: 'Supposed to do', value: m.notes.slice(0, 1000) });
    if (topChannels.length) embed.addFields({ name: 'Top channels this month', value: topChannels.join('\n') });
    embed.addFields({ name: 'Recent history', value: joinLines(history, 1000, 'Nothing yet.') });
  }
  const payload = { content: notice, embeds: [embed], components };
  if (m.photo) {
    embed.setThumbnail('attachment://staff.jpg');
    payload.files = [new AttachmentBuilder(Buffer.from(m.photo, 'base64'), { name: 'staff.jpg' })];
  } else if (discordMember) {
    embed.setThumbnail(discordMember.displayAvatarURL());
  }
  return payload;
}

function buildWorkPayload(guildId, userId, admin, notice = null) {
  const tasks = staffSystem.getOpenTasks(guildId, admin ? null : userId);
  const lines = tasks.map(t =>
    `**#${t.id}** ${admin ? (t.assigneeId ? `<@${t.assigneeId}> — ` : '🕒 *not picked yet* — ') : ''}${t.title}${t.details ? `\n└ ${t.details.slice(0, 80)}` : ''} • ${ts(t.createdAt)}`);
  const embed = new EmbedBuilder()
    .setTitle(admin ? `🛠️ All Open Work (${tasks.length})` : `🛠️ Your Open Work (${tasks.length})`)
    .setColor(tasks.length ? COLOR.warn : COLOR.ok)
    .setDescription(joinLines(lines, 3900, '🎉 No open work.'));

  const components = [];
  if (tasks.length) {
    const members = new Map(staffSystem.listMembers(guildId).map(m => [m.userId, m.name]));
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('staffp:task_done')
        .setPlaceholder('✅ Mark a task as done…')
        .addOptions(tasks.slice(0, 25).map(t => {
          const option = { label: `#${t.id} ${t.title}`.slice(0, 100), value: String(t.id) };
          if (admin) option.description = t.assigneeId ? (String(members.get(t.assigneeId) || 'Unknown').slice(0, 100) || 'Unknown') : 'Not picked yet';
          return option;
        })),
    ));
    if (tasks.length > 25) embed.setFooter({ text: 'Dropdown shows the 25 oldest tasks.' });
  }
  return { content: notice, embeds: [embed], components };
}

// ------------------------------------------------------------- work board
function buildBoardPayload(tasks) {
  const closed = tasks.length > 0 && staffSystem.pickingClosed(tasks[0]); // passed 12 AM — nobody can pick any more
  const lines = tasks.map((t, i) => {
    const n = i + 1;
    if (t.done) return `**${n}.** ~~${t.title}~~ — ✅ done${t.assigneeId ? ` by <@${t.assigneeId}>` : ''}`;
    if (t.assigneeId) return `**${n}.** ${t.title} — 🙋 picked by <@${t.assigneeId}>`;
    return closed ? `**${n}.** ${t.title} — 🔒 closed` : `**${n}.** ${t.title} — 🟢 open`;
  });
  const open = closed ? 0 : tasks.filter(t => !t.done && !t.assigneeId).length;
  const embed = new EmbedBuilder()
    .setTitle(closed ? '🔒 Work Board — closed' : '📤 Work Board — pick your work')
    .setColor(open ? COLOR.ok : COLOR.main)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: closed ? 'Picking closed at 12 AM — this work can no longer be picked.' : (open ? `${open} task(s) still open — press Select work — pick as many as you like. First come, first served.` : 'All tasks are taken.') });
  const batchId = tasks[0] ? tasks[0].batchId : 'none';
  const rows = [row(
    new ButtonBuilder().setCustomId(`staffp:pick_menu:${batchId}`).setLabel('Select work').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(!open),
    new ButtonBuilder().setCustomId(`staffp:unpick_menu:${batchId}`).setLabel('Cancel work').setEmoji('↩️').setStyle(ButtonStyle.Danger),
  )];
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

// A board can carry an admin's image. It sits INSIDE the board embed (below the task list), linked to the
// message's attachment. When the board is redrawn we keep that attachment by id — as a plain
// { id, filename } object, NOT the discord.js Attachment instance (which serialises with `name` instead of
// `filename`, so Discord lost the link and showed the image twice) — and point the embed at it again.
async function keepExtras(payload, message) {
  const att = message && message.attachments && message.attachments.size ? [...message.attachments.values()][0] : null;
  if (!att) return payload;
  payload.embeds[0].setImage(`attachment://${att.name}`);
  return { ...payload, attachments: [{ id: att.id, filename: att.name }] };
}

// Keeps the board message in step when a task is finished from Staff Work.
async function refreshBoard(guild, task) {
  if (!task || !task.batchId || !task.channelId || !task.messageId) return;
  try {
    const channel = await fetchTextChannel(guild, task.channelId);
    const message = channel && await channel.messages.fetch(task.messageId);
    if (message) await message.edit(await keepExtras(buildBoardPayload(staffSystem.getBatchTasks(guild.id, task.batchId)), message));
  } catch { /* board message is gone — nothing to update */ }
}

// Admin's tasks waiting to be posted (guildId:adminId -> titles).
const pendingTasks = new Map();
// guildId:adminId -> { buffer, name } — the image the admin attached to the work board.
const pendingWorkImage = new Map();
const WORK_IMAGE_MAX = 8 * 1024 * 1024;

async function downloadWorkImage(attachment) {
  if (attachment.size && attachment.size > WORK_IMAGE_MAX) throw new Error('image is too big (max 8 MB)');
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > WORK_IMAGE_MAX) throw new Error('image is too big (max 8 MB)');
  const ext = (/\.(png|jpe?g|webp|gif)$/i.exec(attachment.name || '') || [null, 'png'])[1].toLowerCase();
  return { buffer, name: `work-image.${ext}` };
}

// Task 1…5 / 6…9 form: one box per task (Discord allows 5 boxes per form).
function taskModal(from, to) {
  const inputs = [];
  for (let n = from; n <= to && inputs.length < 5; n++) {
    inputs.push(textInput({ id: `t${n}`, label: `Task ${n}`, required: n === 1, max: 100, placeholder: n === 1 ? 'e.g. Verify Group C screenshots' : undefined }));
  }
  return modal(`staffp:m_distribute:${from}`, `Distribute Work — Tasks ${from}-${to}`, inputs);
}

// One task per line; leading "1." / "-" / "•" is ignored.
function parseBoardTasks(text) {
  return String(text || '').split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map(line => line.slice(0, 100));
}

async function postTasks(interaction, titles) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  await interaction.deferReply({ flags: EPHEMERAL });
  const configured = WORK_CHANNEL_ID ? await fetchTextChannel(guild, WORK_CHANNEL_ID) : null;
  const target = configured || interaction.channel;
  if (!target || typeof target.send !== 'function') return interaction.editReply('❌ I can\'t post in this channel.');

  const { batchId, tasks } = staffSystem.createPoolTasks(guildId, { titles, by: userId });
  const imageKey = `${guildId}:${userId}`;
  const image = pendingWorkImage.get(imageKey);
  pendingWorkImage.delete(imageKey);
  try {
    const payload = buildBoardPayload(tasks);
    if (WORK_PING_ROLE_ID) {
      payload.content = `<@&${WORK_PING_ROLE_ID}>`;
      payload.allowedMentions = { roles: [WORK_PING_ROLE_ID] };
    }
    if (image) {
      payload.embeds[0].setImage(`attachment://${image.name}`); // shows under the task list, inside the board
      payload.files = [new AttachmentBuilder(image.buffer, { name: image.name })];
    }
    const sent = await target.send(payload);
    staffSystem.setBatchMessage(guildId, batchId, { channelId: target.id, messageId: sent.id });
  } catch (err) {
    staffSystem.cancelBatch(guildId, batchId);
    return interaction.editReply(`❌ Couldn't post the tasks in <#${target.id}>: ${err.message}. Check my permissions there.`);
  }
  return interaction.editReply(
    `✅ Posted **${tasks.length}** task${tasks.length === 1 ? '' : 's'} in <#${target.id}>${image ? ' with your image' : ''} — staff pick theirs with the Pick buttons.` +
    (WORK_CHANNEL_ID && !configured ? `\n⚠️ The work channel ID in my settings (\`STAFF_WORK_CHANNEL_ID\`) wasn't found, so I used this channel.` : '') +
    (!WORK_CHANNEL_ID ? '\nℹ️ No work channel is set yet (`STAFF_WORK_CHANNEL_ID` in `.env`), so I used this channel.' : ''));
}

// Staff History lists only people who LEFT the staff: removed from the staff
// list, or their staff role taken away by hand.
const LEFT_STAFF_TYPES = new Set(['remove', 'role_removed']);
const LEFT_LABEL = { remove: 'removed from staff', role_removed: 'staff role removed' };

function buildHistoryPayload(guildId) {
  const lines = staffSystem.getHistory(guildId, 100000)
    .filter(h => LEFT_STAFF_TYPES.has(h.type))
    .slice(0, 25)
    .map(h => `${ts(h.at)} **${LEFT_LABEL[h.type]}** ${h.userId ? `<@${h.userId}>` : ''}${h.by && h.by !== h.userId ? ` — by <@${h.by}>` : ''}`);
  return {
    embeds: [new EmbedBuilder().setTitle('📚 Staff History — who left the staff').setColor(COLOR.main)
      .setDescription(joinLines(lines, 3900, 'Nobody has left the staff.'))],
  };
}

// Overall % per staff member: each of work done / check-ins / messages / voice is
// scored against the best staff member in the period (the leader = 100%), then
// combined with weights 40 / 30 / 20 / 10. A measure nobody scored in is left out.
const LB_WEIGHTS = { tasksDone: 40, checkins: 30, messages: 20, voiceSeconds: 10 };

function overallPercent(row, maxima) {
  let got = 0, total = 0;
  for (const [key, weight] of Object.entries(LB_WEIGHTS)) {
    if (!maxima[key]) continue;
    total += weight;
    got += weight * (row[key] / maxima[key]);
  }
  return total ? Math.round((got / total) * 100) : 0;
}

async function buildLeaderboardPayload(guildId, guild) {
  const { rows: all, since, now } = staffSystem.weeklyData(guildId, 7, Date.now(), { leaderboard: true });

  // Hide staff who are no longer in the server.
  let rows = all;
  if (guild) {
    const present = await Promise.all(all.map(async r =>
      guild.members.cache.has(r.userId) || !!(await guild.members.fetch(r.userId).catch(() => null))));
    rows = all.filter((_, i) => present[i]);
  }

  const maxima = {};
  for (const key of Object.keys(LB_WEIGHTS)) maxima[key] = Math.max(0, ...rows.map(r => r[key]));
  const ranked = rows.map(r => ({ ...r, pct: overallPercent(r, maxima) }))
    .sort((a, b) => b.pct - a.pct); // stable: ties keep the original work/check-in/message order

  const lines = ranked.slice(0, 20).map((r, i) =>
    `${MEDALS[i] || `**${i + 1}.**`} <@${r.userId}> ${LB_STATUS_EMOJI[r.status]} — **${r.pct}%**`);
  return {
    embeds: [new EmbedBuilder().setTitle('🏆 Staff Leaderboard — last 7 days').setColor(COLOR.warn)
      .setDescription(`${ts(since, 'D')} → ${ts(now, 'D')}\n\n${joinLines(lines, 3600, 'No staff yet.')}`)
      .setFooter({ text: 'Overall % = work done 40% • check-ins 30% • messages 20% • voice 10%, each compared with the top staff member.' })],
  };
}

function buildRulesPayload(guildId, admin) {
  const rules = staffSystem.getRules(guildId);
  const embed = new EmbedBuilder().setTitle('📜 Staff Rules').setColor(COLOR.main)
    .setDescription(rules || 'No rules have been written yet.');
  const components = admin
    ? [row(new ButtonBuilder().setCustomId('staffp:rules_edit').setLabel('Edit Rules').setEmoji('✏️').setStyle(ButtonStyle.Primary))]
    : [];
  return { embeds: [embed], components };
}

function buildWeeklySettingsPayload(guildId, notice = null) {
  const s = staffSystem.getWeeklySettings(guildId);
  const embed = new EmbedBuilder().setTitle('🗓️ Weekly Staff Report').setColor(COLOR.main)
    .setDescription('A final report of the last 7 days is posted automatically every week.')
    .addFields(
      { name: 'Auto-post', value: s.enabled ? '✅ On' : '⏸️ Off', inline: true },
      { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : '❌ Not set', inline: true },
      { name: 'Schedule', value: `Every Sunday ${String(staffSystem.WEEKLY_HOUR_UTC).padStart(2, '0')}:00 UTC`, inline: true },
      { name: 'Last sent', value: s.lastWeeklyAt ? ts(s.lastWeeklyAt) : 'Never', inline: true },
    );
  return {
    content: notice,
    embeds: [embed],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('staffp:wk_channel').setPlaceholder('Pick the report channel…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)),
      row(
        new ButtonBuilder().setCustomId('staffp:wk_toggle').setLabel(s.enabled ? 'Turn Auto-post Off' : 'Turn Auto-post On')
          .setStyle(s.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staffp:wk_send').setLabel('Send Report Now').setEmoji('📤').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// The weekly report itself — a summary embed plus the per-member breakdown.
function buildWeeklyReportEmbeds(guild) {
  const { rows, since, now } = staffSystem.weeklyData(guild.id, 7);
  if (!rows.length) {
    return [new EmbedBuilder().setTitle('📊 Weekly Staff Report').setColor(COLOR.main)
      .setDescription('No staff are registered yet, so there is nothing to report.')];
  }

  const count = (status) => rows.filter(r => r.status === status).length;
  const sum = (key) => rows.reduce((total, r) => total + r[key], 0);
  const top = rows[0].tasksDone + rows[0].checkins > 0 ? rows[0] : null;
  const needsAttention = rows.filter(r => r.status === 'inactive').map(r => `<@${r.userId}>`);

  const summary = new EmbedBuilder()
    .setTitle('📊 Weekly Staff Report — Final')
    .setColor(COLOR.main)
    .setDescription(`${ts(since, 'D')} → ${ts(now, 'D')}`)
    .addFields(
      { name: 'Staff', value: `${rows.length} total • ${GREEN_DOT} ${count('active')} active • ${RED_DOT} ${count('inactive')} inactive • 🏖️ ${count('leave')} on leave` },
      { name: 'Work', value: `✅ ${sum('checkins')} check-ins • 🛠️ ${sum('tasksDone')} tasks completed • 📌 ${sum('tasksOpen')} still open • 🧾 ${sum('reports')} reports` },
      { name: 'Chat & voice', value: `💬 ${sum('messages')} messages • 🎙️ ${fmtDuration(sum('voiceSeconds'))} in voice` },
    )
    .setFooter({ text: 'Generated by the Staff Control Panel' })
    .setTimestamp(now);
  if (top) summary.addFields({ name: '🏆 Top performer', value: `<@${top.userId}> — ${top.tasksDone} task(s) done, ${top.checkins} check-in(s)` });
  if (needsAttention.length) summary.addFields({ name: '⚠️ Needs attention (inactive)', value: joinLines(needsAttention, 1000) });

  const lines = rows.map((r, i) =>
    `**${i + 1}.** <@${r.userId}> ${STATUS_EMOJI[r.status]} — ✅ ${r.checkins} • 🛠️ ${r.tasksDone} (+${r.tasksOpen} open) • 🧾 ${r.reports} • 💬 ${r.messages} • 🎙️ ${fmtDuration(r.voiceSeconds)}`);
  const embeds = [summary];
  let chunk = '';
  const flush = () => {
    if (!chunk) return;
    embeds.push(new EmbedBuilder().setColor(COLOR.main).setTitle(embeds.length === 1 ? '👥 Staff breakdown' : '👥 Staff breakdown (cont.)').setDescription(chunk.trim()));
    chunk = '';
  };
  let dropped = 0;
  for (const line of lines) {
    if ((chunk + line + '\n').length > 3800) flush();
    if (embeds.length >= 4) { dropped++; continue; }
    chunk += line + '\n';
  }
  flush();
  if (dropped) embeds[embeds.length - 1].setFooter({ text: `…and ${dropped} more staff not shown` });
  return embeds.slice(0, 4);
}

function leaveEmbed(userId, fromMs, toMs, reason, cancelled = false) {
  return new EmbedBuilder().setColor(cancelled ? COLOR.ok : COLOR.warn)
    .setTitle(cancelled ? '✅ Leave cancelled — back to work' : '🏖️ Staff Leave')
    .setDescription(cancelled ? `<@${userId}> is back and ready to work.` : `<@${userId}> is taking leave.`)
    .addFields(
      { name: 'From', value: staffSystem.formatDay(fromMs), inline: true },
      { name: 'To', value: staffSystem.formatDay(toMs - 1), inline: true },
      { name: 'Reason', value: (reason || '—').slice(0, 1024) },
    );
}
const cancelLeaveRow = (userId, guildId) => row(new ButtonBuilder().setCustomId(`staffp:cancel_leave:${userId}:${guildId}`)
  .setLabel('Cancel leave').setEmoji('↩️').setStyle(ButtonStyle.Danger));

// Posts a copy of an embed in a log channel, headed with who it's about.
async function announce(guild, channelId, user, embed, memberName) {
  try {
    const channel = await fetchTextChannel(guild, channelId);
    if (!channel) return;
    const copy = new EmbedBuilder(embed.toJSON()).setDescription(`<@${user.id}>${memberName ? ` — **${memberName}**` : ''}`)
      .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL() : null).setTimestamp();
    await channel.send({ embeds: [copy], allowedMentions: { parse: [] } });
  } catch (err) { console.warn(`[staff] Couldn't post to log channel ${channelId}: ${err.message}`); }
}

async function fetchTextChannel(guild, channelId) {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  return ch && ch.isTextBased() ? ch : null;
}

// ---------------------------------------------------------------- dispatcher
async function handleInteraction(interaction) {
  const [, action, arg] = interaction.customId.split(':');

  if (SELF_ACTIONS.has(action)) {
    if (!isStaff(interaction)) return reply(interaction, '❌ This is for staff members only.');
  } else if (WORK_ACTIONS.has(action) && isWorkUser(interaction.user.id)) {
    // Listed in STAFF_WORK_USER_IDS — may use Distribute Work + Leaderboard only.
  } else if (!isAdmin(interaction)) {
    return reply(interaction, '❌ Only admins can use that.');
  }

  if (interaction.isButton()) return handleButton(interaction, action, arg);
  if (interaction.isModalSubmit()) return handleModal(interaction, action, arg);
  if (interaction.isUserSelectMenu()) return handleUserSelect(interaction, action);
  if (interaction.isStringSelectMenu()) return handleStringSelect(interaction, action, arg);
  if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction, action);
}

// ------------------------------------------------------- leave role swap
// While a staff member is on leave their staff role is taken away and a
// "leave" role is given; when the leave ends (time is up, or they check in
// early) the leave role comes off and the staff role comes back.
// STAFF_ROLE_ID / STAFF_LEAVE_ROLE_ID can be overridden in .env. With no leave
// role id set, a role called "Staff On Leave" is created once and reused.
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID || '1538500688223670352').trim();
const LEAVE_ROLE_NAME = 'Staff On Leave';
const roleWarnAt = new Map(); // throttles repeated restore-failure logs
const botRoleChange = new Set(); // role changes the bot made itself (leave swap) — not "manual"
async function botChangeRole(gm, action, role, reason) {
  const key = `${gm.guild.id}:${gm.id}`;
  botRoleChange.add(key);
  try { return await gm.roles[action](role, reason); }
  finally { setTimeout(() => botRoleChange.delete(key), 10000); }
}

// Someone's staff role was taken away by hand: drop them from the bot's staff
// list/status too. (The bot's own leave role-swap is ignored — see botRoleChange.)
function handleMemberUpdate(oldMember, newMember) {
  try {
    if (!oldMember || oldMember.partial || !oldMember.roles) return;
    if (!oldMember.roles.cache.has(STAFF_ROLE_ID) || newMember.roles.cache.has(STAFF_ROLE_ID)) return;
    if (botRoleChange.has(`${newMember.guild.id}:${newMember.id}`)) return;
    staffSystem.removeMember(newMember.guild.id, newMember.id, null, 'Staff role removed — taken off the staff list');
  } catch (err) { console.error('[staff] role-removal cleanup failed:', err.message); }
}

// Left, kicked or banned (a ban also fires this event): drop them from staff.
function handleMemberRemove(member) {
  try {
    if (!member || !member.guild) return;
    staffSystem.removeMember(member.guild.id, member.id, null, 'Left / kicked / banned from the server — taken off the staff list');
  } catch (err) { console.error('[staff] member-remove cleanup failed:', err.message); }
}

// Safety net: anyone still on the staff list who is no longer in the server
// (they left while the bot was offline) is removed. Runs on startup + every 6h.
async function pruneStaffNotInServer(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const staff = staffSystem.listMembers(guild.id);
      if (!staff.length) continue;
      const members = await guild.members.fetch({ time: 60_000 });
      if (!members || members.size < 2) continue; // fetch looks wrong — never risk wiping the list
      for (const s of staff) {
        if (!members.has(s.userId)) staffSystem.removeMember(guild.id, s.userId, null, 'No longer in the server — taken off the staff list');
      }
    } catch (err) { console.error(`[staff] prune failed for guild ${guild.id}:`, err.message); }
  }
}
function startStaffPruner(client) {
  setTimeout(() => pruneStaffNotInServer(client), 30_000);
  setInterval(() => pruneStaffNotInServer(client), 6 * 60 * 60 * 1000);
}

// New staff entries need the staff role first. Returns null if fine, else the
// error text to show the admin.
async function staffRoleProblem(guild, userId) {
  const gm = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  if (!gm) return `❌ <@${userId}> isn't in this server.`;
  if (!gm.roles.cache.has(STAFF_ROLE_ID)) {
    return `❌ <@${userId}> doesn't have the <@&${STAFF_ROLE_ID}> role. Give them the role first, then fill the staff entry form.`;
  }
  return null;
}

async function findRole(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
}

async function getLeaveRole(guild, { create }) {
  const configured = (process.env.STAFF_LEAVE_ROLE_ID || '').trim() || staffSystem.getLeaveRoleId(guild.id);
  let role = await findRole(guild, configured);
  if (!role && create) {
    role = await guild.roles.create({ name: LEAVE_ROLE_NAME, permissions: [], mentionable: false, reason: 'Staff leave role' });
    staffSystem.setLeaveRoleId(guild.id, role.id);
  }
  return role;
}

// Start of leave: staff role off, leave role on. Returns a list of problems (empty = all good).
async function applyLeaveRoles(guild, userId) {
  const problems = [];
  const gm = await guild.members.fetch(userId).catch(() => null);
  if (!gm) return ['I couldn\'t find them in the server to change their roles'];

  let removedStaff = false;
  if (gm.roles.cache.has(STAFF_ROLE_ID)) {
    try { await botChangeRole(gm, 'remove', STAFF_ROLE_ID, 'Staff leave'); removedStaff = true; }
    catch (err) { problems.push(`couldn't remove the staff role (${err.message}) — my role must be above it and I need Manage Roles`); }
  }
  try {
    const leaveRole = await getLeaveRole(guild, { create: true });
    await gm.roles.add(leaveRole, 'Staff leave');
  } catch (err) {
    problems.push(`couldn't give the leave role (${err.message})`);
  }
  // Extending a leave must not forget that the staff role was already taken.
  const previous = staffSystem.getMember(guild.id, userId)?.leaveRoles;
  staffSystem.setLeaveRoles(guild.id, userId, { removedStaff: removedStaff || Boolean(previous && previous.removedStaff) });
  return problems;
}

// End of leave: leave role off, staff role back. Returns true when finished.
async function restoreLeaveRoles(guild, userId) {
  const record = staffSystem.getMember(guild.id, userId);
  if (!record || !record.leaveRoles) return true;
  const gm = await guild.members.fetch(userId).catch(() => null);
  if (!gm) { staffSystem.setLeaveRoles(guild.id, userId, null); return true; } // left the server
  try {
    if (record.leaveRoles.removedStaff) await botChangeRole(gm, 'add', STAFF_ROLE_ID, 'Staff leave ended');
    const leaveRole = await getLeaveRole(guild, { create: false });
    if (leaveRole && gm.roles.cache.has(leaveRole.id)) await gm.roles.remove(leaveRole, 'Staff leave ended');
    staffSystem.setLeaveRoles(guild.id, userId, null);
    return true;
  } catch (err) {
    const key = `${guild.id}:${userId}`;
    if (Date.now() - (roleWarnAt.get(key) || 0) > 3600000) {
      roleWarnAt.set(key, Date.now());
      console.warn(`[staff] Couldn't restore roles for ${userId} after leave (will retry): ${err.message}`);
    }
    return false;
  }
}

// ------------------------------------------------- staff entry: photo step
// guildId:adminId -> { collector } — the admin's pending "upload the photo" step.
const pendingPhoto = new Map();
const PHOTO_WAIT_MS = 120000;
const PHOTO_MAX_DOWNLOAD = 8 * 1024 * 1024;
const PHOTO_MAX_RAW = 150 * 1024; // only used when `sharp` isn't installed

const isImageAttachment = (a) =>
  (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.name || '');

async function preparePhoto(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PHOTO_MAX_DOWNLOAD) throw new Error('image is too big (max 8 MB)');
  if (sharp) {
    buf = await sharp(buf).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } else if (buf.length > PHOTO_MAX_RAW) {
    throw new Error('image is too big (run `npm install` so photos can be shrunk automatically)');
  }
  return buf.toString('base64');
}

function entrySummaryPayload(m, headline, extra = '') {
  const embed = new EmbedBuilder()
    .setTitle(headline)
    .setColor(COLOR.ok)
    .setDescription(`<@${m.userId}>${extra ? `\n${extra}` : ''}`)
    .addFields(
      { name: 'Name', value: m.name || '—', inline: true },
      { name: 'Contact number', value: m.contact || '—', inline: true },
      { name: 'E-mail id', value: m.email || '—', inline: true },
      { name: 'Supposed to do', value: (m.notes || '—').slice(0, 1024) },
    );
  const payload = { content: null, embeds: [embed], components: [] };
  if (m.photo) {
    embed.setThumbnail('attachment://staff.jpg');
    payload.files = [new AttachmentBuilder(Buffer.from(m.photo, 'base64'), { name: 'staff.jpg' })];
  }
  return payload;
}

// ------------------------------------------- staff entry: report to the owners
// Whenever an admin fills the Staff Entry Form, a report (all details + photo,
// and who filled it) is DMed to these users. Override with
// STAFF_ENTRY_REPORT_USER_IDS=id1,id2 in .env.
const ENTRY_REPORT_USER_IDS = (process.env.STAFF_ENTRY_REPORT_USER_IDS || '1498962894262374462,1491373546885349437')
  .split(',').map(x => x.trim()).filter(Boolean);

// Report Form submissions are DM'd to these admins (override in .env: STAFF_REPORT_USER_IDS).
const REPORT_USER_IDS = (process.env.STAFF_REPORT_USER_IDS || '1491373546885349437,1498962894262374462')
  .split(',').map(x => x.trim()).filter(Boolean);

// Returns a one-line status for the admin ("📨 Report sent to 2 people.", or what failed).
async function sendEntryReport(guild, adminUser, memberRecord, isNew) {
  const m = staffSystem.getMember(guild.id, memberRecord.userId) || memberRecord;
  const payload = entrySummaryPayload(m, isNew ? '📝 New staff member added' : '📝 Staff entry updated');
  const embed = payload.embeds[0];
  embed.setDescription(`<@${m.userId}> (\`${m.userId}\`)`);
  embed.addFields(
    { name: 'Filled by', value: `<@${adminUser.id}> (${adminUser.tag || adminUser.username || adminUser.id})`, inline: true },
    { name: 'Server', value: guild.name || guild.id, inline: true },
  );
  embed.setFooter({ text: `Staff Entry Form • ${staffSystem.formatDay(Date.now())}` });
  if (m.photo) embed.setImage('attachment://staff.jpg'); // full-size photo in the report
  const { content, components, ...message } = payload;

  let sent = 0;
  const failed = [];
  for (const id of ENTRY_REPORT_USER_IDS) {
    try {
      const user = await guild.client.users.fetch(id);
      await user.send(message);
      sent++;
    } catch (err) {
      failed.push(id);
      console.warn(`[staff] Couldn't DM the staff-entry report to ${id}: ${err.message}`);
    }
  }
  if (!ENTRY_REPORT_USER_IDS.length) return '';
  return failed.length
    ? `📨 Report sent to ${sent} of ${ENTRY_REPORT_USER_IDS.length} (couldn't DM ${failed.map(id => `<@${id}>`).join(', ')} — their DMs may be closed).`
    : `📨 Report sent to ${sent} ${sent === 1 ? 'person' : 'people'}.`;
}

// Step 3: wait for the admin to post an image in this channel (or press Skip).
async function askForStaffPhoto(interaction, member, isNew) {
  const guildId = interaction.guildId;
  const adminId = interaction.user.id;
  const key = `${guildId}:${adminId}`;
  const headline = isNew ? '✅ Staff member added' : '✅ Staff entry updated';

  const previous = pendingPhoto.get(key);
  if (previous) previous.collector.stop('replaced');

  const channel = interaction.channel;
  if (!channel || typeof channel.createMessageCollector !== 'function') {
    const delivery = await sendEntryReport(interaction.guild, interaction.user, member, isNew);
    return interaction.reply({ ...entrySummaryPayload(member, headline, `No photo step available in this channel.\n${delivery}`), flags: EPHEMERAL });
  }

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('📷 Staff Entry Form — Step 3 of 3').setColor(COLOR.main)
      .setDescription(`**${member.name || 'The player'}** is ${isNew ? 'added' : 'updated'}. Now **send their photo in this channel** (as an image attachment) within 2 minutes — I'll save it and remove your message.\n\nNo photo? Press **Skip**.`)],
    components: [row(new ButtonBuilder().setCustomId('staffp:entry_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary))],
    flags: EPHEMERAL,
  });

  const collector = channel.createMessageCollector({
    filter: (m) => m.author.id === adminId && [...m.attachments.values()].some(isImageAttachment),
    time: PHOTO_WAIT_MS,
    max: 1,
  });
  pendingPhoto.set(key, { collector });

  let reported = false; // the report goes out exactly once per form
  const report = async (record) => {
    if (reported) return '';
    reported = true;
    return sendEntryReport(interaction.guild, interaction.user, record, isNew);
  };

  collector.on('collect', async (msg) => {
    try {
      const attachment = [...msg.attachments.values()].find(isImageAttachment);
      const base64 = await preparePhoto(attachment.url);
      const updated = staffSystem.setMemberPhoto(guildId, member.userId, base64);
      msg.delete().catch(() => {}); // keep the private photo out of the channel
      const delivery = await report(updated);
      await interaction.editReply(entrySummaryPayload(updated, headline, `📷 Photo saved.\n${delivery}`));
    } catch (err) {
      const current = staffSystem.getMember(guildId, member.userId) || member;
      const delivery = await report(current);
      await interaction.editReply(entrySummaryPayload(current, headline, `⚠️ Couldn't save the photo: ${err.message}. Run **Staff Entry Form** for this player again to retry.\n${delivery}`)).catch(() => {});
    }
  });

  collector.on('end', async (_collected, reason) => {
    const current = pendingPhoto.get(key);
    if (current && current.collector === collector) pendingPhoto.delete(key);
    const record = staffSystem.getMember(guildId, member.userId) || member;
    if (reason === 'skip') {
      const delivery = await report(record);
      await interaction.editReply(entrySummaryPayload(record, headline, `Saved without a new photo.\n${delivery}`)).catch(() => {});
    } else if (reason === 'time') {
      const delivery = await report(record);
      await interaction.editReply(entrySummaryPayload(record, headline, `⌛ No photo received — saved without one. Run **Staff Entry Form** again to add it.\n${delivery}`)).catch(() => {});
    } else if (reason === 'replaced') {
      await report(record); // the admin started another form — still send this one
    }
  });
}

// Animated emojis shown next to each task's status (check-out screen + reports).
const TASK_DONE_EMOJI = '<a:885679180799422574:1548939840547061910>';
const TASK_NOT_DONE_EMOJI = '<a:836435400498741289:1548939837422309397>';
const taskStatusLine = (t) => `${t.done ? `${TASK_DONE_EMOJI} DONE` : `${TASK_NOT_DONE_EMOJI} NOT DONE`} — #${t.id} ${t.title}`;

// ------------------------------------------------- check-out: tasks step
// Before the work form, anyone who has tasks sees them with a Done / Not done
// button each (flip as needed), then presses Continue.
function buildCheckoutTasksPayload(tasks, notice = null) {
  // Every task gets TWO buttons (Done / Not done) = 2 tasks per row, 4 rows
  // + the Continue row (Discord allows 5 rows of 5 buttons).
  const shown = tasks.slice(0, 8);
  const doneCount = tasks.filter(t => t.done).length;
  const lines = shown.map(t => taskStatusLine(t));
  if (tasks.length > shown.length) lines.push(`…and ${tasks.length - shown.length} more`);
  const embed = new EmbedBuilder()
    .setTitle('🏁 Check-out — your tasks')
    .setColor(doneCount === tasks.length ? COLOR.ok : COLOR.warn)
    .setDescription(`${lines.join('\n')}\n\n**${doneCount}/${tasks.length}** done. For each task press **Done** if the work is finished or **Not done** if it isn't, then press **Continue**. Tasks left not done stay open for you.`)
    .setFooter({ text: 'Done tasks are marked finished on the work board too.' });
  const rows = [];
  for (let i = 0; i < shown.length; i += 2) {
    const buttons = [];
    for (const t of shown.slice(i, i + 2)) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`staffp:co_done:${t.id}`)
          .setLabel(`#${t.id} Done`)
          .setEmoji('✅')
          .setStyle(t.done ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`staffp:co_notdone:${t.id}`)
          .setLabel(`#${t.id} Not done`)
          .setEmoji('❌')
          .setStyle(t.done ? ButtonStyle.Secondary : ButtonStyle.Danger),
      );
    }
    rows.push(row(...buttons));
  }
  rows.push(row(new ButtonBuilder().setCustomId('staffp:co_continue').setLabel('Continue to Check-out').setEmoji('➡️').setStyle(ButtonStyle.Primary)));
  return { content: notice, embeds: [embed], components: rows };
}

function buildCheckoutModal() {
  return modal('staffp:m_checkout', 'Check-out', [
    textInput({ id: 'work', label: 'What work have you done?', style: TextInputStyle.Paragraph, placeholder: 'e.g. Handled slot list for Group B, answered 12 tickets', max: 1000 }),
  ]);
}

// ------------------------------------------------------- check-in / out UI
const pad2 = (n) => String(n).padStart(2, '0');

function tooEarlyText(st) {
  return `⏰ Check-in opens at **${staffSystem.CHECKIN_OPENS_HOUR}:00 AM** (${staffSystem.STAFF_TZ}). It is **${pad2(st.hour)}:${pad2(st.minute)}** right now — come back after 9.`;
}

// The personal "toggle": after checking in, the staff member's own (private)
// confirmation carries a Check-out button.
function checkoutRow() {
  return row(new ButtonBuilder().setCustomId('staffp:checkout').setLabel('Check-out').setEmoji('🏁').setStyle(ButtonStyle.Danger));
}

function shiftDonePayload(today) {
  const embed = new EmbedBuilder()
    .setTitle('✅ You are done for today')
    .setColor(COLOR.ok)
    .setDescription(`Checked in ${ts(today.in, 't')} • checked out ${ts(today.out, 't')}\n\nYour check-in opens again tomorrow after ${staffSystem.CHECKIN_OPENS_HOUR}:00 AM.`);
  if (today.work) embed.addFields({ name: 'Work done', value: today.work.slice(0, 1024) });
  return { embeds: [embed] };
}

// ------------------------------------------------------------------ buttons
// Drops a leave, gives the roles back, and updates the message posted in the leave channel.
// Returns null when there was no active leave.
async function performCancelLeave(guild, targetId, byId) {
  const res = staffSystem.cancelLeave(guild.id, targetId, byId);
  if (!res) return null;
  if (res.member.leaveRoles) await restoreLeaveRoles(guild, targetId);
  const done = new EmbedBuilder().setColor(COLOR.ok).setTitle('✅ Leave cancelled — back to work')
    .setDescription(`<@${targetId}> is back and ready to work.`).addFields({ name: 'Original leave', value: res.was }).setTimestamp();
  try {
    const ch = res.msg && await fetchTextChannel(guild, res.msg.channelId);
    const msg = ch && await ch.messages.fetch(res.msg.messageId);
    if (msg) await msg.edit({ embeds: [done], components: [], allowedMentions: { parse: [] } });
  } catch { /* leave message is gone */ }
  return { res, done };
}

const NO_LEAVE_TEXT = 'ℹ️ There is no active leave to cancel (it may already be over or cancelled).';
const CANCELLED_TEXT = '✅ Your leave is cancelled — your staff role is back and you can check in.';

// "Cancel leave" pressed in the staff member's DM (no server in a DM, so the
// server id travels in the button id: staffp:cancel_leave:<userId>:<guildId>).
async function handleDmCancelLeave(interaction) {
  const [, , targetId, guildId] = interaction.customId.split(':');
  await interaction.deferUpdate().catch(() => {});
  if (!targetId || !guildId || interaction.user.id !== targetId) {
    return interaction.followUp({ content: '❌ Only the staff member who took this leave can cancel it.', flags: EPHEMERAL }).catch(() => {});
  }
  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return interaction.editReply({ content: '❌ I can\'t reach that server right now.', components: [] }).catch(() => {});
  const out = await performCancelLeave(guild, targetId, targetId);
  if (!out) return interaction.editReply({ content: NO_LEAVE_TEXT, embeds: [], components: [] }).catch(() => {});
  return interaction.editReply({ content: CANCELLED_TEXT, embeds: [out.done], components: [] }).catch(() => {});
}

async function handleButton(interaction, action, arg) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  switch (action) {
    // One button for both directions. Discord shows a message's buttons the
    // same to everybody, so the toggle happens on press: whoever presses it
    // gets the form that matches THEIR state (check-in if they haven't, check-out
    // if they have). A staff member's confirmation also carries a personal
    // "Check-out" button (see checkoutRow).
    case 'checkin':
    case 'checkout': {
      const st = staffSystem.shiftState(guildId, userId);
      if (!st) return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');

      if (st.state === 'open') {
        const tasks = staffSystem.getTasksForCheckout(guildId, userId);
        if (tasks.length) return interaction.reply({ ...buildCheckoutTasksPayload(tasks), flags: EPHEMERAL });
        return interaction.showModal(buildCheckoutModal());
      }
      if (st.state === 'done') return interaction.reply({ ...shiftDonePayload(st.today), flags: EPHEMERAL });
      if (st.hour < st.opensHour) return reply(interaction, tooEarlyText(st));

      const me = staffSystem.getMember(guildId, userId);
      // The date is filled in automatically (today, IST). It is only shown —
      // whatever is typed there is ignored, the real date is always used.
      return interaction.showModal(modal('staffp:m_checkin', 'Check-in Form', [
        textInput({ id: 'date', label: 'Date (auto)', value: staffSystem.formatDay(Date.now()), max: 30 }),
        textInput({ id: 'timings', label: 'Timing', value: me?.availability, placeholder: 'e.g. 1 PM to 5 PM', max: 100 }),
        textInput({ id: 'plan', label: 'What work can you do?', style: TextInputStyle.Paragraph, placeholder: 'e.g. Slot lists, verifying screenshots, answering tickets', max: 500 }),
      ]));

    }

    // Check-out tasks screen: flip a task between Done and Not done.
    case 'co_toggle': // (old single-button version — still works for old messages)
    case 'co_done':
    case 'co_notdone': {
      const st = staffSystem.shiftState(guildId, userId);
      if (!st || st.state !== 'open') return reply(interaction, '❌ You are not checked in right now.');
      const task = staffSystem.getTask(guildId, arg);
      if (!task || task.assigneeId !== userId) return reply(interaction, '❌ That is not one of your tasks.');
      const wantDone = action === 'co_done' ? true : action === 'co_notdone' ? false : !task.done;
      if (wantDone && !task.done) staffSystem.completeTask(guildId, task.id, userId);
      else if (!wantDone && task.done) staffSystem.uncompleteTask(guildId, task.id, userId);
      refreshBoard(guild, staffSystem.getTask(guildId, task.id));
      return interaction.update(buildCheckoutTasksPayload(staffSystem.getTasksForCheckout(guildId, userId)));
    }

    case 'co_continue': {
      const st = staffSystem.shiftState(guildId, userId);
      if (!st || st.state !== 'open') return reply(interaction, '❌ You are not checked in right now.');
      return interaction.showModal(buildCheckoutModal());
    }

    // Staff Entry Form — admins only, 3 steps: pick the player → form → photo.
    case 'entry':
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('📝 Staff Entry Form — Step 1 of 3').setColor(COLOR.main)
          .setDescription('Select the player you want to add to the staff team.\n\nNext: a short form (name, contact number, e-mail, what they are supposed to do), then their photo.')],
        components: [row(userSelect('staffp:entry_select', 'Select the player to add as staff'))],
        flags: EPHEMERAL,
      });

    // Reset Panel — admin only, with a confirm step. Wipes everything stat-like.
    case 'reset': {
      const members = staffSystem.listMembers(guildId);
      const onLeaveSwap = members.filter(m => m.leaveRoles).length;
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('⚠️ Reset the whole staff panel?').setColor(COLOR.bad)
          .setDescription([
            `This will permanently delete, for **everyone**:`,
            `• the staff list (**${members.length}** member${members.length === 1 ? '' : 's'}) with their entry details, photos and ranks`,
            '• check-ins / check-outs, leave, work, reports and history',
            '• all message and voice-time activity stats',
            onLeaveSwap ? `\nStaff on leave (**${onLeaveSwap}**) get their staff role back and lose the leave role.` : '',
            '\nKept: rules, report channel, weekly-report setting. **This cannot be undone.**',
          ].filter(Boolean).join('\n'))],
        components: [row(
          new ButtonBuilder().setCustomId('staffp:reset_yes').setLabel('Yes, reset everything').setEmoji('🔄').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('staffp:reset_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
        flags: EPHEMERAL,
      });
    }

    case 'reset_no':
      return interaction.update({ content: 'Reset cancelled — nothing was changed.', embeds: [], components: [] });

    case 'reset_yes': {
      await interaction.update({ content: '⏳ Resetting the staff panel…', embeds: [], components: [] });
      // 1) Roles first (needs the records): staff role back, leave role off.
      let restored = 0; let stuck = 0;
      for (const m of staffSystem.listMembers(guildId).filter(x => x.leaveRoles)) {
        if (await restoreLeaveRoles(guild, m.userId)) restored++; else stuck++;
      }
      // 2) Data.
      const removed = staffSystem.resetAll(guildId);
      staffActivity.resetGuild(guildId);
      for (const [key, pending] of [...pendingPhoto.entries()]) {
        if (key.startsWith(`${guildId}:`)) { pending.collector.stop('replaced'); pendingPhoto.delete(key); }
      }
      return interaction.editReply({
        content: `✅ Staff panel reset by <@${userId}>: removed **${removed.members}** staff, **${removed.tasks}** task(s), **${removed.reports}** report(s), **${removed.history}** history entries and all activity stats.` +
          (restored ? `\n🎭 Staff role restored for ${restored} member(s) who were on leave.` : '') +
          (stuck ? `\n⚠️ Couldn't restore the staff role for ${stuck} member(s) — check my Manage Roles permission and role position.` : ''),
        allowedMentions: { parse: [] },
      });
    }

    case 'entry_skip': {
      const pending = pendingPhoto.get(`${guildId}:${userId}`);
      await interaction.deferUpdate().catch(() => {});
      if (pending) pending.collector.stop('skip');
      return;
    }

    case 'active':
    case 'inactive': // old panels still carry this button — same merged screen
      return interaction.reply({ ...statusListPayload(guildId), flags: EPHEMERAL });
    case 'leaderboard':
      return interaction.reply({ ...(await buildLeaderboardPayload(guildId, interaction.guild)), flags: EPHEMERAL });
    case 'list':
      return interaction.reply({ ...buildListPayload(guildId), flags: EPHEMERAL });
    case 'history':
      return interaction.reply({ ...buildHistoryPayload(guildId), flags: EPHEMERAL });

    case 'promote':
      return interaction.reply({
        content: '⬆️ Pick the staff member to promote one rank:',
        components: [row(userSelect('staffp:promote_select', 'Pick a staff member…'))],
        flags: EPHEMERAL,
      });

    case 'profile': {
      if (!isAdmin(interaction)) {
        // Staff only ever see their own profile (it holds contact details).
        await interaction.deferReply({ flags: EPHEMERAL });
        const payload = await buildProfilePayload(guild, userId);
        if (!staffSystem.getMember(guildId, userId)) payload.content = 'You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.';
        return interaction.editReply(payload);
      }
      return interaction.reply({
        content: '👤 Pick a staff member to see their profile and history:',
        components: [row(userSelect('staffp:profile_select', 'Pick a staff member…'))],
        flags: EPHEMERAL,
      });
    }

    case 'work':
      return interaction.reply({ ...buildWorkPayload(guildId, userId, isAdmin(interaction)), flags: EPHEMERAL });

    case 'cancel_leave': {
      const targetId = arg || userId;
      if (targetId !== userId && !isAdmin(interaction)) return reply(interaction, '❌ Only that staff member (or an admin) can cancel this leave.');
      await interaction.deferUpdate().catch(() => {});
      const out = await performCancelLeave(guild, targetId, userId);
      const privateMsg = Boolean(interaction.message?.flags?.has?.(EPHEMERAL));
      if (!out) return interaction.editReply({ content: NO_LEAVE_TEXT, embeds: [], components: [] }).catch(() => {});
      return interaction.editReply({ content: privateMsg ? CANCELLED_TEXT : null, embeds: [out.done], components: [] }).catch(() => {});
    }

    case 'distribute':
      pendingTasks.delete(`${guildId}:${userId}`);
      pendingWorkImage.delete(`${guildId}:${userId}`);
      return interaction.showModal(taskModal(1, 5));

    case 'dw_more':
      return interaction.showModal(taskModal(6, MAX_BOARD_TASKS));

    case 'dw_image': {
      if (MODAL_UPLOAD) {
        const { LabelBuilder, FileUploadBuilder } = discordJs;
        const m = new ModalBuilder().setCustomId('staffp:m_dw_image').setTitle('Attach image to work board');
        m.addLabelComponents(
          new LabelBuilder().setLabel('Image (shown below the work board)')
            .setFileUploadComponent(new FileUploadBuilder().setCustomId('image').setRequired(true).setMinValues(1).setMaxValues(1)),
        );
        return interaction.showModal(m);
      }
      // Older discord.js: wait for the admin to send the image in this channel.
      const channel = interaction.channel;
      if (!channel || typeof channel.createMessageCollector !== 'function') return reply(interaction, '❌ Image upload isn\'t available in this channel.');
      await reply(interaction, '🖼️ Send the image in this channel within 2 minutes — I\'ll save it and remove your message.');
      const collector = channel.createMessageCollector({
        filter: (m) => m.author.id === userId && [...m.attachments.values()].some(isImageAttachment),
        time: PHOTO_WAIT_MS, max: 1,
      });
      collector.on('collect', async (msg) => {
        try {
          const att = [...msg.attachments.values()].find(isImageAttachment);
          pendingWorkImage.set(`${guildId}:${userId}`, await downloadWorkImage(att));
          msg.delete().catch(() => {});
          await interaction.followUp({ content: '🖼️ Image attached — press **Post tasks**.', flags: EPHEMERAL });
        } catch (err) {
          await interaction.followUp({ content: `⚠️ Couldn't save the image: ${err.message}`, flags: EPHEMERAL }).catch(() => {});
        }
      });
      return;
    }

    case 'dw_post': {
      const titles = pendingTasks.get(`${guildId}:${userId}`) || [];
      if (!titles.length) return reply(interaction, '❌ Nothing to post — press **Distribute Work** again.');
      pendingTasks.delete(`${guildId}:${userId}`);
      return postTasks(interaction, titles);
    }

    case 'myactivity': {
      await interaction.deferReply({ flags: EPHEMERAL });
      const payload = await buildProfilePayload(guild, userId);
      if (!staffSystem.getMember(guildId, userId)) payload.content = 'You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.';
      return interaction.editReply(payload);
    }

    case 'leave':
      if (!staffSystem.getMember(guildId, userId)) return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');
      return interaction.showModal(modal('staffp:m_leave', 'Staff Leave', [
        textInput({ id: 'from', label: 'FROM (date)', placeholder: 'DD/MM/YYYY — e.g. 12/10/2026', max: 20 }),
        textInput({ id: 'to', label: 'TO (date, last day of leave)', placeholder: 'DD/MM/YYYY — e.g. 15/10/2026', max: 20 }),
        textInput({ id: 'reason', label: 'REASON', style: TextInputStyle.Paragraph, placeholder: 'Why are you taking leave?', max: 200 }),
      ]));

    case 'report':
      return interaction.showModal(modal('staffp:m_report', 'Report Form', [
        textInput({ id: 'subject', label: 'Subject', placeholder: 'e.g. Player dispute in Group A', max: 100 }),
        textInput({ id: 'details', label: 'What happened?', style: TextInputStyle.Paragraph, max: 1500 }),
      ]));

    case 'rules':
      return interaction.reply({ ...buildRulesPayload(guildId, isAdmin(interaction)), flags: EPHEMERAL });

    case 'rules_edit':
      return interaction.showModal(modal('staffp:m_rules', 'Edit Staff Rules', [
        textInput({ id: 'rules', label: 'Rules', style: TextInputStyle.Paragraph, required: false, value: staffSystem.getRules(guildId), max: 4000 }),
      ]));

    case 'weekly':
      return interaction.reply({ ...buildWeeklySettingsPayload(guildId), flags: EPHEMERAL });

    case 'wk_toggle': {
      const s = staffSystem.getWeeklySettings(guildId);
      staffSystem.setWeeklyEnabled(guildId, !s.enabled);
      return interaction.update(buildWeeklySettingsPayload(guildId, `Auto-post is now ${!s.enabled ? 'on' : 'off'}.`));
    }

    case 'wk_send': {
      await interaction.deferUpdate();
      const embeds = buildWeeklyReportEmbeds(guild);
      const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
      if (!channel) {
        await interaction.followUp({ content: 'No report channel is set (or I can\'t see it), so here is the report just for you:', embeds, flags: EPHEMERAL });
        return;
      }
      try {
        await channel.send({ embeds });
        return interaction.editReply(buildWeeklySettingsPayload(guildId, `✅ Report sent to <#${channel.id}>.`));
      } catch (err) {
        console.error('[staff] Failed to send weekly report:', err);
        return interaction.editReply(buildWeeklySettingsPayload(guildId, '❌ I couldn\'t post in that channel — check my permissions there.'));
      }
    }

    case 'rm_yes': {
      const removed = staffSystem.removeMember(guildId, arg, userId);
      return interaction.update({
        content: removed ? `✅ Removed <@${arg}> from the staff list.` : 'That person was already not on the staff list.',
        embeds: [], components: [],
      });
    }

    case 'rm_no':
      return interaction.update({ content: 'Cancelled — nobody was removed.', embeds: [], components: [] });

    // Pick button on the work board — first press wins.
    // "Select work": a multi-select of the open tasks (as many as you like).
    case 'pick_menu': {
      const tasks = staffSystem.getBatchTasks(guildId, arg);
      if (tasks.length && staffSystem.pickingClosed(tasks[0])) return reply(interaction, '🔒 Picking for this work closed at 12 AM — it can no longer be picked.');
      const open = tasks.map((t, i) => ({ t, n: i + 1 })).filter(x => !x.t.done && !x.t.assigneeId).slice(0, 25);
      if (!open.length) return reply(interaction, '🔒 Every task on this board is already taken.');
      const menu = new StringSelectMenuBuilder().setCustomId(`staffp:pick_sel:${arg}`)
        .setPlaceholder('Select the work you want to do…').setMinValues(1).setMaxValues(open.length)
        .addOptions(open.map(({ t, n }) => ({ label: `${n}. ${t.title}`.slice(0, 100), value: String(t.id) })));
      return interaction.reply({ content: '🙋 **Select your work** — choose one or more:', components: [row(menu)], flags: EPHEMERAL });
    }

    // "Cancel work": a multi-select of the tasks you picked and haven't finished.
    case 'unpick_menu': {
      const tasks = staffSystem.getBatchTasks(guildId, arg);
      const mine = tasks.map((t, i) => ({ t, n: i + 1 })).filter(x => !x.t.done && x.t.assigneeId === userId).slice(0, 25);
      if (!mine.length) return reply(interaction, 'ℹ️ You have no unfinished work picked on this board.');
      const menu = new StringSelectMenuBuilder().setCustomId(`staffp:unpick_sel:${arg}`)
        .setPlaceholder('Select the work to cancel…').setMinValues(1).setMaxValues(mine.length)
        .addOptions(mine.map(({ t, n }) => ({ label: `${n}. ${t.title}`.slice(0, 100), value: String(t.id) })));
      return interaction.reply({ content: '↩️ **Cancel work** — choose what to give back:', components: [row(menu)], flags: EPHEMERAL });
    }

    case 'pick': {
      const res = staffSystem.claimTask(guildId, arg, userId);
      if (res.error === 'gone') return reply(interaction, '❌ That task no longer exists.');
      if (res.error === 'not_member') return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');
      if (res.error === 'on_leave') return reply(interaction, '🏖️ You are on leave — you can pick work when you are back.');
      if (res.error === 'done') return reply(interaction, '✅ That task is already finished.');
      if (res.error === 'closed') return reply(interaction, '🔒 Picking for this work closed at 12 AM — it can no longer be picked.');
      if (res.error === 'taken') {
        await reply(interaction, `❌ Too late — <@${res.task.assigneeId}> already picked that one.`);
        return interaction.message.edit(await keepExtras(buildBoardPayload(staffSystem.getBatchTasks(guildId, res.task.batchId)), interaction.message)).catch(() => {});
      }
      await interaction.deferUpdate(); // re-uploading the image can take a moment
      await interaction.editReply(await keepExtras(buildBoardPayload(staffSystem.getBatchTasks(guildId, res.task.batchId)), interaction.message));
      return interaction.followUp({
        content: `🙋 You picked **#${res.task.id} ${res.task.title}**. You'll see it again at Check-out, where you mark it Done or Not done.`,
        flags: EPHEMERAL,
      });
    }
  }
}

// ------------------------------------------------------------------- modals
async function handleModal(interaction, action, arg) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const field = (id) => interaction.fields.getTextInputValue(id).trim();

  switch (action) {
    case 'm_checkin': {
      // The Discord name is fetched automatically — nothing to type for it.
      const res = staffSystem.startShift(guildId, userId, { name: interaction.member.displayName, timings: field('timings'), plan: field('plan') });
      if (res.error === 'not_member') return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');
      if (res.error === 'too_early') return reply(interaction, tooEarlyText({ ...res, opensHour: staffSystem.CHECKIN_OPENS_HOUR }));
      if (res.error === 'already_done') return interaction.reply({ ...shiftDonePayload(res.today), flags: EPHEMERAL });
      if (res.error === 'already_in') return interaction.reply({ content: 'ℹ️ You are already checked in — press the button again to check out.', components: [checkoutRow()], flags: EPHEMERAL });
      const embed = new EmbedBuilder()
        .setTitle('✅ Checked in')
        .setColor(COLOR.ok)
        .addFields(
          { name: 'Name', value: res.open.name || interaction.member.displayName, inline: true },
          { name: 'Active timing', value: res.open.timings || '—', inline: true },
          { name: 'Checked in at', value: ts(res.open.at, 't'), inline: true },
          { name: 'Date', value: staffSystem.formatDay(res.open.at), inline: true },
          { name: 'Work I can do', value: (res.open.plan || '—').slice(0, 1024) },
        )
        .setFooter({ text: 'Check out before 12 AM, or today will not count in your staff stats.' });
      await interaction.reply({ embeds: [embed], components: [checkoutRow()], flags: EPHEMERAL });
      await announce(guild, CHECKIN_CHANNEL_ID, interaction.user, embed.setFooter(null), res.open.name);
      // Checking in ends a leave early — give the staff role back right away.
      if (res.member && res.member.leaveRoles) await restoreLeaveRoles(guild, userId);
      return;
    }

    case 'm_checkout': {
      const res = staffSystem.endShift(guildId, userId, field('work'), undefined, staffSystem.getTasksForCheckout(guildId, userId));
      if (res.error === 'not_member') return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');
      if (res.error === 'expired') return reply(interaction, '❌ It passed 12 AM before you checked out, so that day was **not counted**. Check in again tomorrow after 9 AM.');
      if (res.error === 'not_in') return reply(interaction, '❌ You are not checked in — press **Staff Check-in / Check-out** to check in first.');
      const embed = new EmbedBuilder()
        .setTitle('🏁 Checked out — day counted')
        .setColor(COLOR.ok)
        .addFields(
          { name: 'Checked in', value: ts(res.shift.in, 't'), inline: true },
          { name: 'Checked out', value: ts(res.shift.out, 't'), inline: true },
          { name: 'Time on shift', value: fmtDuration(Math.round((res.shift.out - res.shift.in) / 1000)), inline: true },
          { name: 'Work done', value: res.shift.work.slice(0, 1024) || '—' },
          ...dayActivityFields(guildId, userId),
        )
        .setFooter({ text: `Total counted check-ins: ${res.member.checkins}` });
      if (res.shift.tasks && res.shift.tasks.length) {
        const doneN = res.shift.tasks.filter(t => t.done).length;
        embed.addFields({
          name: `Tasks (${doneN}/${res.shift.tasks.length} done)`,
          value: res.shift.tasks.map(taskStatusLine).join('\n').slice(0, 1024),
        });
      }
      await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      // The log channel gets the whole day: check-in details + check-out details.
      const day = new EmbedBuilder().setTitle('🏁 Staff day — check-in & check-out').setColor(COLOR.ok)
        .addFields(
          { name: 'Date', value: staffSystem.formatDay(res.shift.in), inline: true },
          { name: 'Active timing', value: res.shift.timings || '—', inline: true },
          { name: 'Time on shift', value: fmtDuration(Math.round((res.shift.out - res.shift.in) / 1000)), inline: true },
          { name: 'Checked in', value: ts(res.shift.in, 't'), inline: true },
          { name: 'Checked out', value: ts(res.shift.out, 't'), inline: true },
          { name: 'Work I could do (check-in)', value: (res.shift.plan || '—').slice(0, 1024) },
          { name: 'Work done (check-out)', value: res.shift.work.slice(0, 1024) || '—' },
          ...dayActivityFields(guildId, userId),
        )
        .setFooter({ text: `Total counted check-ins: ${res.member.checkins}` });
      if (res.shift.tasks && res.shift.tasks.length) {
        const doneN = res.shift.tasks.filter(t => t.done).length;
        day.addFields({ name: `Tasks (${doneN}/${res.shift.tasks.length} done)`,
          value: res.shift.tasks.map(taskStatusLine).join('\n').slice(0, 1024) });
      }
      return announce(guild, CHECKOUT_CHANNEL_ID, interaction.user, day, res.shift.name || interaction.member?.displayName);
    }

    case 'm_entry': {
      const targetId = arg;
      if (!staffSystem.getMember(guildId, targetId)) {
        const problem = await staffRoleProblem(guild, targetId);
        if (problem) return reply(interaction, problem);
      }
      const contact = field('contact');
      const email = field('email');
      const digits = contact.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        return reply(interaction, '❌ That contact number doesn\'t look right (7–15 digits). Press **Staff Entry Form** and try again.');
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply(interaction, '❌ That e-mail id doesn\'t look right. Press **Staff Entry Form** and try again.');
      }
      const note = field('notes');
      const { member, isNew } = staffSystem.registerMember(guildId, targetId, {
        name: field('name'), contact, email, notes: note,
        position: note.split('\n')[0].slice(0, 60) || 'Staff',
      }, userId);
      if (MODAL_UPLOAD) {
        await interaction.deferReply({ flags: EPHEMERAL });
        const headline = isNew ? '✅ Staff member added' : '✅ Staff entry updated';
        let record = member;
        let photoNote = '';
        try {
          const files = interaction.fields.getUploadedFiles ? interaction.fields.getUploadedFiles('photo') : null;
          const attachment = files && [...files.values()].find(isImageAttachment);
          if (files && files.size && !attachment) photoNote = '⚠️ That file isn\'t an image, so no photo was saved.\n';
          else if (attachment) {
            record = staffSystem.setMemberPhoto(guildId, member.userId, await preparePhoto(attachment.url));
            photoNote = '📷 Photo saved.\n';
          }
        } catch (err) {
          photoNote = `⚠️ Couldn't save the photo: ${err.message}\n`;
        }
        const delivery = await sendEntryReport(interaction.guild, interaction.user, record, isNew);
        return interaction.editReply(entrySummaryPayload(record, headline, `${photoNote}${delivery}`));
      }
      return askForStaffPhoto(interaction, member, isNew);
    }

    case 'm_dw_image': {
      await interaction.deferReply({ flags: EPHEMERAL });
      try {
        const files = interaction.fields.getUploadedFiles ? interaction.fields.getUploadedFiles('image') : null;
        const attachment = files && [...files.values()].find(isImageAttachment);
        if (!attachment) return interaction.editReply('⚠️ That file isn\'t an image — press **Add image** and try again.');
        pendingWorkImage.set(`${guildId}:${userId}`, await downloadWorkImage(attachment));
        return interaction.editReply('🖼️ Image attached — it will be shown below the work board. Press **Post tasks** when ready.');
      } catch (err) {
        return interaction.editReply(`⚠️ Couldn't save the image: ${err.message}`);
      }
    }

    case 'm_distribute': {
      const key = `${guildId}:${userId}`;
      const startAt = Number(arg) || 1;
      const entered = [];
      for (let n = startAt; n <= (startAt === 1 ? 5 : MAX_BOARD_TASKS); n++) {
        let v = '';
        try { v = field(`t${n}`); } catch { /* field not in this form */ }
        entered.push(v.slice(0, 100));
      }
      const current = startAt === 1 ? [] : (pendingTasks.get(key) || []);
      const titles = [...current, ...entered.filter(Boolean)].slice(0, MAX_BOARD_TASKS);
      if (!titles.length) return reply(interaction, '❌ Fill at least Task 1.');
      pendingTasks.set(key, titles);
      const buttons = [];
      if (titles.length < MAX_BOARD_TASKS && startAt === 1) {
        buttons.push(new ButtonBuilder().setCustomId('staffp:dw_more').setLabel('Add Tasks 6–9').setEmoji('➕').setStyle(ButtonStyle.Secondary));
      }
      buttons.push(new ButtonBuilder().setCustomId('staffp:dw_image').setLabel('Add image').setEmoji('🖼️').setStyle(ButtonStyle.Secondary));
      buttons.push(new ButtonBuilder().setCustomId('staffp:dw_post').setLabel('Post tasks').setEmoji('📤').setStyle(ButtonStyle.Success));
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle(`📤 ${titles.length} task${titles.length === 1 ? '' : 's'} ready`).setColor(COLOR.main)
          .setDescription(titles.map((t, i) => `**Task ${i + 1}** — ${t}`).join('\n'))],
        components: [row(...buttons)],
        flags: EPHEMERAL,
      });
    }

    case 'm_leave': {
      const from = staffSystem.parseDateInput(field('from'));
      const to = staffSystem.parseDateInput(field('to'));
      if (!from || !to) return reply(interaction, '❌ I couldn\'t read those dates. Use **DD/MM/YYYY**, e.g. `12/10/2026`.');
      const fromMs = staffSystem.dayStartMs(from.y, from.m, from.d);
      const toMs = staffSystem.dayStartMs(to.y, to.m, to.d + 1); // TO is the last day of leave
      const todayParts = staffSystem.tzParts();
      const todayStart = staffSystem.dayStartMs(+todayParts.dayKey.slice(0, 4), +todayParts.dayKey.slice(5, 7), +todayParts.dayKey.slice(8, 10));
      if (fromMs < todayStart) return reply(interaction, '❌ FROM can\'t be in the past — use today or a later date.');
      if (toMs <= fromMs) return reply(interaction, '❌ TO must be the same day as FROM or later.');
      const days = Math.round((toMs - fromMs) / 86400000);
      if (days > 90) return reply(interaction, '❌ Leave can be at most 90 days.');
      const reason = field('reason');
      const member = staffSystem.setLeave(guildId, userId, fromMs, toMs, reason);
      if (!member) return reply(interaction, '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.');

      const range = `**${staffSystem.formatDay(fromMs)}** → **${staffSystem.formatDay(toMs - 1)}**`;
      await interaction.deferReply({ flags: EPHEMERAL });
      let problems = [];
      const startsNow = fromMs <= Date.now();
      if (startsNow) problems = await applyLeaveRoles(guild, userId);
      await interaction.editReply({
        content: `🏖️ Leave recorded: ${range} (${days} day${days === 1 ? '' : 's'}).\n` +
          (startsNow
            ? 'Your staff role is removed for now and comes back automatically when your leave ends (checking in ends it early).'
            : 'Your staff role is removed when your leave starts and comes back automatically when it ends.') +
          (problems.length ? `\n⚠️ ${problems.join('; ')}.` : '') +
          '\nBack early? Press **Cancel leave**.',
        components: [cancelLeaveRow(userId, guildId)],
      });
      // Same message, with the Cancel leave button, in the staff member's own DM.
      interaction.user.send({ embeds: [leaveEmbed(userId, fromMs, toMs, reason)], components: [cancelLeaveRow(userId, guildId)] })
        .catch(() => console.warn(`[staff] Couldn't DM the leave message to ${userId} (DMs closed).`));
      const leaveChannel = await fetchTextChannel(guild, LEAVE_CHANNEL_ID);
      if (leaveChannel) {
        try {
          const sent = await leaveChannel.send({ embeds: [leaveEmbed(userId, fromMs, toMs, reason)], components: [cancelLeaveRow(userId, guildId)], allowedMentions: { parse: [] } });
          staffSystem.setLeaveMessage(guildId, userId, { channelId: leaveChannel.id, messageId: sent.id, reason });
        } catch (err) { console.warn(`[staff] Couldn't post the leave message: ${err.message}`); }
      }
      return;
    }

    case 'm_report': {
      const report = staffSystem.addReport(guildId, { userId, subject: field('subject'), details: field('details') });
      const embed = new EmbedBuilder().setColor(COLOR.warn).setTitle(`🧾 Report #${report.id} — ${report.subject}`)
        .setDescription(report.details)
        .addFields(
          { name: 'From', value: `<@${userId}> (${interaction.user.tag || interaction.user.username || userId})`, inline: true },
          { name: 'Server', value: guild.name || guildId, inline: true },
        )
        .setTimestamp(report.at);
      let sent = 0;
      for (const id of REPORT_USER_IDS) {
        try { await (await guild.client.users.fetch(id)).send({ embeds: [embed] }); sent++; }
        catch (err) { console.warn(`[staff] Couldn't DM report #${report.id} to ${id}: ${err.message}`); }
      }
      // Also post in the report channel when an admin has set one.
      const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
      if (channel) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
      return reply(interaction, sent
        ? `✅ Report #${report.id} sent to ${sent} admin${sent === 1 ? '' : 's'}.`
        : `✅ Report #${report.id} saved, but I couldn't DM the admins (their DMs may be closed).`);
    }

    case 'm_rules':
      staffSystem.setRules(guildId, interaction.fields.getTextInputValue('rules'));
      return reply(interaction, '✅ Rules updated.');
  }
}

// -------------------------------------------------------------- user selects
async function handleUserSelect(interaction, action) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const actorId = interaction.user.id;

  switch (action) {
    case 'entry_select': {
      const targetId = interaction.values[0];
      const target = interaction.users.get(targetId);
      if (target && target.bot) {
        return interaction.update({ content: '❌ Bots can\'t be staff — pick a person.', embeds: [], components: [] });
      }
      const existing = staffSystem.getMember(guildId, targetId);
      if (!existing) {
        const problem = await staffRoleProblem(guild, targetId);
        if (problem) return interaction.update({ content: problem, embeds: [], components: [] });
      }
      const gm = interaction.members?.get(targetId);
      if (MODAL_UPLOAD) {
        const { LabelBuilder, FileUploadBuilder } = discordJs;
        const labelled = (label, input) => {
          if (typeof input.setLabel === 'function' && input.data) delete input.data.label; // label lives on the wrapper
          return new LabelBuilder().setLabel(label).setTextInputComponent(input);
        };
        const m = new ModalBuilder().setCustomId(`staffp:m_entry:${targetId}`).setTitle('Staff Entry Form');
        m.addLabelComponents(
          labelled('Name', textInput({ id: 'name', label: 'Name', value: existing?.name || gm?.displayName || target?.username, max: 60 })),
          labelled('Contact number', textInput({ id: 'contact', label: 'x', value: existing?.contact, placeholder: 'e.g. +91 98765 43210', max: 20 })),
          labelled('E-mail id', textInput({ id: 'email', label: 'x', value: existing?.email, placeholder: 'name@example.com', max: 100 })),
          labelled('What is he supposed to do? (Note)', textInput({ id: 'notes', label: 'x', value: existing?.notes, style: TextInputStyle.Paragraph, placeholder: 'e.g. Handle registrations and slot lists', max: 500 })),
          new LabelBuilder().setLabel('Staff photo (image)')
            .setFileUploadComponent(new FileUploadBuilder().setCustomId('photo').setRequired(false).setMinValues(0).setMaxValues(1)),
        );
        return interaction.showModal(m);
      }
      return interaction.showModal(modal(`staffp:m_entry:${targetId}`, 'Staff Entry Form — Step 2 of 3', [
        textInput({ id: 'name', label: 'Name', value: existing?.name || gm?.displayName || target?.username, max: 60 }),
        textInput({ id: 'contact', label: 'Contact number', value: existing?.contact, placeholder: 'e.g. +91 98765 43210', max: 20 }),
        textInput({ id: 'email', label: 'E-mail id', value: existing?.email, placeholder: 'name@example.com', max: 100 }),
        textInput({ id: 'notes', label: 'What is he supposed to do? (Note)', value: existing?.notes, style: TextInputStyle.Paragraph, placeholder: 'e.g. Handle registrations and slot lists for Group A–C', max: 500 }),
      ]));
    }

    case 'add_select': {
      const added = [];
      const skipped = [];
      for (const user of interaction.users.values()) {
        if (user.bot) continue;
        if (!staffSystem.getMember(guildId, user.id)) {
          const problem = await staffRoleProblem(guild, user.id);
          if (problem) { skipped.push(`<@${user.id}>`); continue; }
        }
        const gm = interaction.members?.get(user.id);
        staffSystem.registerMember(guildId, user.id, { name: gm?.displayName || user.username }, actorId);
        added.push(`<@${user.id}>`);
      }
      const notes = [];
      if (added.length) notes.push(`✅ Added ${added.join(', ')}.`);
      if (skipped.length) notes.push(`⚠️ Not added: ${skipped.join(', ')} — they need the <@&${STAFF_ROLE_ID}> role first (or aren't in the server).`);
      return interaction.update(buildListPayload(guildId, notes.join('\n') || 'Bots can\'t be staff.'));
    }

    case 'rm_select': {
      const targetId = interaction.values[0];
      const m = staffSystem.getMember(guildId, targetId);
      if (!m) return interaction.update({ ...buildListPayload(guildId, `❌ <@${targetId}> isn't in the staff list.`) });
      return interaction.update({
        content: null,
        embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle('Remove staff member?')
          .setDescription(`Remove <@${targetId}> (${m.rankName}) from the staff list? Their unfinished work is cancelled; their history stays.`)],
        components: [row(
          new ButtonBuilder().setCustomId(`staffp:rm_yes:${targetId}`).setLabel('Yes, remove').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('staffp:rm_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    case 'promote_select': {
      const targetId = interaction.values[0];
      const result = staffSystem.promote(guildId, targetId, actorId);
      if (!result) return interaction.update({ content: `❌ <@${targetId}> isn't in the staff list.`, components: [] });
      if (result.maxed) return interaction.update({ content: `⭐ <@${targetId}> is already at the top rank (**${result.rankName}**).`, components: [] });
      await interaction.update({ content: `✅ Promoted <@${targetId}>: **${result.from}** → **${result.to}**.`, components: [] });
      interaction.channel?.send({
        content: `🎉 Congratulations <@${targetId}> — promoted from **${result.from}** to **${result.to}**!`,
        allowedMentions: { users: [targetId] },
      }).catch(() => {});
      return;
    }

    case 'profile_select':
      await interaction.deferUpdate();
      return interaction.editReply(await buildProfilePayload(guild, interaction.values[0], { picker: true }));
  }
}

// ------------------------------------------------------ string / channel selects
// Redraws the work board after picks / cancels.
async function refreshBatchBoard(guild, batchId) {
  const tasks = staffSystem.getBatchTasks(guild.id, batchId);
  const ref = tasks.find(t => t.channelId && t.messageId);
  if (ref) await refreshBoard(guild, ref);
}

async function handleStringSelect(interaction, action, arg) {
  if (action === 'pick_sel') {
    const guildId = interaction.guildId;
    const got = []; const missed = []; const closedTasks = [];
    let blocked = null;
    for (const id of interaction.values) {
      const res = staffSystem.claimTask(guildId, id, interaction.user.id);
      if (res.ok) got.push(res.task);
      else if (res.error === 'not_member' || res.error === 'on_leave') { blocked = res.error; break; }
      else if (res.error === 'closed' && res.task) closedTasks.push(res.task);
      else if (res.task) missed.push(res.task);
    }
    if (blocked) {
      return interaction.update({ content: blocked === 'on_leave' ? '🏖️ You are on leave — you can pick work when you are back.' : '❌ You are not in the staff list yet — ask an admin to add you with the **Staff Entry Form**.', components: [] });
    }
    await interaction.update({
      content: (got.length ? `🙋 You picked ${got.map(t => `**#${t.id} ${t.title}**`).join(', ')}. You'll see them again at Check-out.` : '') +
        (missed.length ? `${got.length ? '\n' : ''}❌ Too late for ${missed.map(t => `**${t.title}**`).join(', ')} — already taken.` : '') +
        (closedTasks.length ? `${got.length || missed.length ? '\n' : ''}🔒 Picking closed at 12 AM for ${closedTasks.map(t => `**${t.title}**`).join(', ')}.` : ''),
      components: [],
    });
    return refreshBatchBoard(interaction.guild, arg);
  }
  if (action === 'unpick_sel') {
    const guildId = interaction.guildId;
    const back = [];
    for (const id of interaction.values) {
      const res = staffSystem.unclaimTask(guildId, id, interaction.user.id);
      if (res.ok) back.push(res.task);
    }
    await interaction.update({
      content: back.length ? `↩️ Cancelled ${back.map(t => `**#${t.id} ${t.title}**`).join(', ')} — back on the board for others.` : 'ℹ️ Nothing to cancel.',
      components: [],
    });
    return refreshBatchBoard(interaction.guild, arg);
  }
  if (action !== 'task_done') return;
  const guildId = interaction.guildId;
  const admin = isAdmin(interaction);
  const task = staffSystem.getTask(guildId, interaction.values[0]);
  if (!task) return interaction.update(buildWorkPayload(guildId, interaction.user.id, admin, '❌ That task no longer exists.'));
  if (!admin && task.assigneeId !== interaction.user.id) {
    return reply(interaction, '❌ You can only finish your own work.');
  }
  const done = staffSystem.completeTask(guildId, task.id, interaction.user.id);
  if (done) refreshBoard(interaction.guild, staffSystem.getTask(guildId, task.id));
  return interaction.update(buildWorkPayload(guildId, interaction.user.id, admin, done ? `✅ Marked **#${task.id} ${task.title}** as done.` : 'That task was already done.'));
}

async function handleChannelSelect(interaction, action) {
  if (action !== 'wk_channel') return;
  staffSystem.setReportChannelId(interaction.guildId, interaction.values[0]);
  return interaction.update(buildWeeklySettingsPayload(interaction.guildId, `✅ Reports and leave / report notices will go to <#${interaction.values[0]}>.`));
}

// ----------------------------------------------------------- weekly scheduler
function startWeeklyScheduler(client) {
  const tick = async () => {
    for (const guildId of listGuildIds()) {
      if (guildId === '__global__') continue;
      try {
        if (!staffSystem.isWeeklyDue(guildId)) continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
        if (!channel) continue;
        await channel.send({ embeds: buildWeeklyReportEmbeds(guild) });
        staffSystem.markWeeklySent(guildId);
        console.log(`[staff] Weekly report posted in guild ${guildId}.`);
      } catch (err) {
        console.error(`[staff] Weekly report failed for guild ${guildId}:`, err);
      }
    }
  };
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, 15 * 60 * 1000).unref?.();
}

// ------------------------------------------------ 9 AM check-in reminder (DM)
const CHECKIN_REMINDER_URL = 'https://discord.com/channels/1538500688038994040/1558572381579251773';
const REMINDER_HOUR = staffSystem.CHECKIN_OPENS_HOUR || 9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// At 9:00 AM (STAFF_TZ) every staff member on the staff list gets this DM, once a day.
// Staff who are on leave are skipped. If the bot was down at exactly 9:00 it still
// sends during the first 10 minutes, but never twice in a day.
function startMorningReminder(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = staffSystem.tzParts();
    if (now.hour !== REMINDER_HOUR || now.minute > 9) return;
    running = true;
    try {
      for (const guildId of listGuildIds()) {
        if (guildId === '__global__') continue;
        if (staffSystem.getMorningDay(guildId) === now.dayKey) continue;
        if (!client.guilds.cache.has(guildId)) continue;
        staffSystem.setMorningDay(guildId, now.dayKey); // mark first so a crash can't double-send
        let sent = 0, failed = 0;
        for (const m of staffSystem.listMembers(guildId)) {
          if (staffSystem.onLeaveNow(m)) continue;
          try {
            const user = await client.users.fetch(m.userId);
            await user.send(`🌅 Good morning <@${m.userId}>! It's 9:00 AM. Don't forget to **Check In** on the ${CHECKIN_REMINDER_URL} !`);
            sent++;
          } catch { failed++; }
          await sleep(1200); // stay under Discord's DM rate limits
        }
        console.log(`[staff] 9 AM check-in reminder: ${sent} sent, ${failed} couldn't be DMed (guild ${guildId}).`);
      }
    } catch (err) {
      console.error('[staff] 9 AM reminder failed:', err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 20 * 1000).unref?.();
}

// ------------------------------------------------ 10:30 PM check-out reminder (DM)
const EVENING_HOUR = 22;
const EVENING_MINUTE = 30;

// At 10:30 PM (STAFF_TZ) every staff member on the staff list gets this DM, once a day.
// Staff who are on leave are skipped. If the bot was down at exactly 10:30 it still
// sends during the first 10 minutes, but never twice in a day.
function startEveningReminder(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = staffSystem.tzParts();
    if (now.hour !== EVENING_HOUR || now.minute < EVENING_MINUTE || now.minute > EVENING_MINUTE + 9) return;
    running = true;
    try {
      for (const guildId of listGuildIds()) {
        if (guildId === '__global__') continue;
        if (staffSystem.getEveningDay(guildId) === now.dayKey) continue;
        if (!client.guilds.cache.has(guildId)) continue;
        staffSystem.setEveningDay(guildId, now.dayKey); // mark first so a crash can't double-send
        let sent = 0, failed = 0;
        for (const m of staffSystem.listMembers(guildId)) {
          if (staffSystem.onLeaveNow(m)) continue;
          try {
            const user = await client.users.fetch(m.userId);
            await user.send(`🌅 Good evening <@${m.userId}>! It's 10:30 PM. Don't forget to **Check out** on the ${CHECKIN_REMINDER_URL} !`);
            sent++;
          } catch { failed++; }
          await sleep(1200); // stay under Discord's DM rate limits
        }
        console.log(`[staff] 10:30 PM check-out reminder: ${sent} sent, ${failed} couldn't be DMed (guild ${guildId}).`);
      }
    } catch (err) {
      console.error('[staff] 10:30 PM reminder failed:', err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 20 * 1000).unref?.();
}

// Every minute: a leave that starts today swaps the roles; a leave that has ended gets the staff role back.
function startLeaveScheduler(client) {
  const tick = async () => {
    for (const guildId of listGuildIds()) {
      if (guildId === '__global__') continue;
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        for (const userId of staffSystem.listRoleApplyDue(guildId)) {
          const problems = await applyLeaveRoles(guild, userId);
          console.log(`[staff] Leave started — roles swapped for ${userId} in guild ${guildId}${problems.length ? ` (${problems.join('; ')})` : ''}.`);
        }
        for (const userId of staffSystem.listRoleRestoreDue(guildId)) {
          if (await restoreLeaveRoles(guild, userId)) console.log(`[staff] Leave over — roles restored for ${userId} in guild ${guildId}.`);
        }
      } catch (err) {
        console.error(`[staff] Leave role sweep failed for guild ${guildId}:`, err);
      }
    }
  };
  setTimeout(tick, 15 * 1000).unref?.();
  setInterval(tick, 60 * 1000).unref?.();
}

// ------------------------------------------- work board: lock at 12 AM, delete after 24h
// Work posted with Distribute Work: from 12 AM (STAFF_TZ) nobody can pick it
// (its board message is edited to show it as closed); 24 hours after it was
// posted the board message is deleted and its unfinished tasks are removed.
const WORK_LIFETIME_MS = 24 * 60 * 60 * 1000;

function startWorkExpiryScheduler(client) {
  const tick = async () => {
    for (const guildId of listGuildIds()) {
      if (guildId === '__global__') continue;
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        // 1) passed 12 AM: lock the board message
        for (const t of staffSystem.closeStaleBoards(guildId)) {
          await refreshBoard(guild, t);
        }

        // 2) 24 hours old: delete the board message + unfinished tasks
        const { removed } = staffSystem.expireOldTasks(guildId, WORK_LIFETIME_MS);
        if (!removed.length) continue;
        const seen = new Set();
        for (const t of removed) {
          if (!t.channelId || !t.messageId || seen.has(t.messageId)) continue;
          seen.add(t.messageId);
          try {
            const channel = await fetchTextChannel(guild, t.channelId);
            const message = channel && await channel.messages.fetch(t.messageId).catch(() => null);
            if (message) await message.delete().catch(() => {});
          } catch { /* board message already gone */ }
        }
        console.log(`[staff] Removed ${removed.length} work task(s) older than 24h in guild ${guildId}.`);
      } catch (err) {
        console.error(`[staff] Work expiry failed for guild ${guildId}:`, err);
      }
    }
  };
  setTimeout(tick, 30 * 1000).unref?.();
  setInterval(tick, 2 * 60 * 1000).unref?.();
}

module.exports = {
  buildMainPanel,
  handleInteraction,
  startWeeklyScheduler,
  startWorkExpiryScheduler,
  startLeaveScheduler,
  startMorningReminder,
  startEveningReminder,
  handleMemberUpdate,
  handleMemberRemove,
  startStaffPruner,
  handleDmCancelLeave,
  buildWeeklyReportEmbeds,
};
