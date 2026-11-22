// !form — the admin picks a person, the bot DMs them the "Get to know you"
// form. Their answers are saved per server and the AI chat (ai-chat.js) uses
// them so the bot knows its staff like friends. The admin who sent the form
// gets a DM with the answers.
//
// A Discord form holds 5 boxes at most and this one has 9 questions, so it
// opens in two steps (5 + 4). Buttons in a DM carry the server id in their id:
//   staffform:<guildId>:<adminId>:<step>   step = start | m1 | next | m2
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, MessageFlags, AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getGuildStore, saveGuildStore } = require('./storage');

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = 0x5865F2;
// Every submitted form is DM'd to this user as a .txt file (override: STAFF_FORM_RECEIVER_ID).
const RECEIVER_ID = (process.env.STAFF_FORM_RECEIVER_ID || '1491373546885349437').trim();
// Only this user can run !form and use its picker (override: STAFF_FORM_OWNER_ID).
const OWNER_ID = (process.env.STAFF_FORM_OWNER_ID || '1491373546885349437').trim();
const isOwner = (userId) => String(userId) === OWNER_ID;
const PENDING_MS = 30 * 60 * 1000;
const pending = new Map(); // `${guildId}:${userId}` -> { at, a: {...first 5 answers} }

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const input = ({ id, label, style = TextInputStyle.Short, required = true, placeholder, max = 100 }) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
};

// ------------------------------------------------------------ admin side
function buildPickerPayload() {
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📋 Send the staff info form')
      .setDescription('Pick the person below. I\'ll DM them a short form (name, role, timings, personality …) so I can get to know them.')],
    components: [row(new UserSelectMenuBuilder().setCustomId('staffform_pick').setPlaceholder('Select the player to send the form to').setMinValues(1).setMaxValues(1))],
  };
}

async function handlePick(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: '❌ Only the owner can send this form.', flags: EPHEMERAL });
  }
  const targetId = interaction.values[0];
  const target = interaction.users.get(targetId);
  if (target && target.bot) {
    return interaction.reply({ content: '❌ Bots can\'t fill a form — pick a person.', flags: EPHEMERAL });
  }
  const guildId = interaction.guildId;
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('👋 Let me get to know you!')
    .setDescription(`**${interaction.guild.name}** staff would like me to know you better. Press the button and answer a few quick questions — it takes about a minute.\n\n` +
      '• Name (what should I call you)\n• Discord name / nickname\n• Role in the server\n• What you handle / are good at\n• Active timings\n• Language(s) you speak\n• Personality / how you like to be talked to\n• Fun fact or interests (optional)\n• Nickname I may use for you\n\n' +
      '⚠️ Please don\'t share passwords, phone numbers or addresses.')
    .setFooter({ text: `Sent by ${interaction.user.username}` });
  const button = new ButtonBuilder().setCustomId(`staffform:${guildId}:${interaction.user.id}:start`)
    .setLabel('Fill the form').setEmoji('📝').setStyle(ButtonStyle.Success);
  try {
    const user = await interaction.client.users.fetch(targetId);
    await user.send({ embeds: [embed], components: [row(button)] });
  } catch {
    return interaction.reply({ content: `❌ I couldn't DM <@${targetId}> — their DMs are closed.`, flags: EPHEMERAL });
  }
  await interaction.reply({ content: `✅ Form sent to <@${targetId}>'s DM.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
  // The picker has done its job — remove it from the channel.
  return interaction.message.delete().catch(() => {});
}

// ------------------------------------------------------------ DM side
function modalOne(prefix) {
  return new ModalBuilder().setCustomId(`${prefix}:m1`).setTitle('About you — 1 of 2').addComponents(
    row(input({ id: 'name', label: 'Name (what should the bot call you)', max: 40 })),
    row(input({ id: 'discord', label: 'Discord name / nickname', max: 40 })),
    row(input({ id: 'role', label: 'Role in the server', placeholder: 'e.g. Discord manager, registrations, support', max: 80 })),
    row(input({ id: 'handles', label: 'What you handle / are good at', style: TextInputStyle.Paragraph, max: 300 })),
    row(input({ id: 'timings', label: 'Active timings', placeholder: 'e.g. 1 PM to 5 PM', max: 60 })),
  );
}
function modalTwo(prefix) {
  return new ModalBuilder().setCustomId(`${prefix}:m2`).setTitle('About you — 2 of 2').addComponents(
    row(input({ id: 'languages', label: 'Language(s) you speak', max: 80 })),
    row(input({ id: 'personality', label: 'Personality / how you like to be talked to', style: TextInputStyle.Paragraph, placeholder: 'e.g. funny, serious, short replies', max: 300 })),
    row(input({ id: 'fun', label: 'Fun fact or interests (optional)', style: TextInputStyle.Paragraph, required: false, max: 300 })),
    row(input({ id: 'nickname', label: 'Nickname the bot may use for you', required: false, max: 40 })),
  );
}

// One sentence the AI chat can read, like a line in staff.txt.
function profileLine(p) {
  const bits = [];
  bits.push(`${p.name}${p.discord ? ` (Discord: ${p.discord}${p.nickname ? `, nickname "${p.nickname}"` : ''})` : (p.nickname ? ` (nickname "${p.nickname}")` : '')} is ${/^[aeiou]/i.test(p.role) ? 'an' : 'a'} ${p.role}.`);
  if (p.handles) bits.push(`Handles / good at: ${p.handles}.`);
  if (p.timings) bits.push(`Active ${p.timings}.`);
  if (p.languages) bits.push(`Speaks ${p.languages}.`);
  if (p.personality) bits.push(`Likes to be talked to like this: ${p.personality}.`);
  if (p.fun) bits.push(`Fun fact / interests: ${p.fun}.`);
  return bits.join(' ').replace(/\s+/g, ' ').replace(/\.\./g, '.');
}

// The .txt that is DM'd: the answers, plus a ready-to-paste line for staff.txt.
function profileText(p, userId, guildName) {
  return [
    `STAFF FORM — ${guildName || 'server'}`,
    `Submitted: ${new Date(p.updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    `Discord user ID: ${userId}`,
    '',
    `Name (what should the bot call you): ${p.name}`,
    `Discord name / nickname: ${p.discord}`,
    `Role in the server: ${p.role}`,
    `What you handle / are good at: ${p.handles}`,
    `Active timings: ${p.timings}`,
    `Language(s) you speak: ${p.languages}`,
    `Personality / how you like to be talked to: ${p.personality}`,
    `Fun fact or interests: ${p.fun || '-'}`,
    `Nickname the bot may use for you: ${p.nickname || '-'}`,
    '',
    '--- line for staff.txt ---',
    profileLine(p),
    '',
  ].join('\n');
}

function profileEmbed(p, userId, title) {
  return new EmbedBuilder().setColor(COLOR).setTitle(title)
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Name', value: p.name || '—', inline: true },
      { name: 'Discord name / nickname', value: p.discord || '—', inline: true },
      { name: 'Bot nickname', value: p.nickname || '—', inline: true },
      { name: 'Role', value: p.role || '—', inline: true },
      { name: 'Active timings', value: p.timings || '—', inline: true },
      { name: 'Languages', value: p.languages || '—', inline: true },
      { name: 'Handles / good at', value: (p.handles || '—').slice(0, 1024) },
      { name: 'Personality', value: (p.personality || '—').slice(0, 1024) },
      { name: 'Fun fact / interests', value: (p.fun || '—').slice(0, 1024) },
    ).setTimestamp();
}

async function handleDm(interaction) {
  const [, guildId, adminId, step] = interaction.customId.split(':');
  const userId = interaction.user.id;
  const prefix = `staffform:${guildId}:${adminId}`;
  const key = `${guildId}:${userId}`;

  if (interaction.isButton() && step === 'start') return interaction.showModal(modalOne(prefix));

  if (interaction.isButton() && step === 'next') {
    const p = pending.get(key);
    if (!p || Date.now() - p.at > PENDING_MS) {
      return interaction.reply({ content: '⌛ That took too long — press **Fill the form** on the first message to start again.' });
    }
    return interaction.showModal(modalTwo(prefix));
  }

  if (interaction.isModalSubmit() && step === 'm1') {
    const f = (id) => interaction.fields.getTextInputValue(id).trim();
    pending.set(key, { at: Date.now(), a: { name: f('name'), discord: f('discord'), role: f('role'), handles: f('handles'), timings: f('timings') } });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR).setDescription('✅ Part 1 saved. One more short part to go!')],
      components: [row(new ButtonBuilder().setCustomId(`${prefix}:next`).setLabel('Continue (2 of 2)').setEmoji('➡️').setStyle(ButtonStyle.Primary))],
    });
  }

  if (interaction.isModalSubmit() && step === 'm2') {
    const first = pending.get(key);
    if (!first || Date.now() - first.at > PENDING_MS) {
      return interaction.reply({ content: '⌛ Part 1 was lost (it took too long). Press **Fill the form** on the first message and start again.' });
    }
    const f = (id) => interaction.fields.getTextInputValue(id).trim();
    const profile = {
      ...first.a,
      languages: f('languages'), personality: f('personality'), fun: f('fun'), nickname: f('nickname'),
      userId, updatedAt: Date.now(),
    };
    pending.delete(key);
    const store = getGuildStore(guildId);
    if (!store.staffProfiles) store.staffProfiles = {};
    store.staffProfiles[userId] = profile;
    saveGuildStore(guildId, store);

    await interaction.reply({
      content: '🎉 Thanks! I saved everything — I\'ll remember you now.',
      embeds: [profileEmbed(profile, userId, '📋 Your answers')],
    });
    try { // the answers go to the owner's DM as a .txt file
      const owner = await interaction.client.users.fetch(RECEIVER_ID);
      const safeName = String(profile.name || 'staff').replace(/[^a-z0-9]+/gi, '_').slice(0, 30) || 'staff';
      await owner.send({
        content: `📬 <@${userId}> filled the staff form.`,
        files: [new AttachmentBuilder(Buffer.from(profileText(profile, userId, interaction.client.guilds.cache.get(guildId)?.name), 'utf8'), { name: `staff-form-${safeName}.txt` })],
        allowedMentions: { parse: [] },
      });
    } catch (err) { console.warn(`[staff-form] Couldn't DM the form to ${RECEIVER_ID}: ${err.message}`); }
  }
}

// Lines for the AI chat (ai-chat.js): everyone in this server who filled the form.
// Staff profiles for a server: the ones saved through !form (database) win;
// staff-seed.json (forms handed over as files) fills in anyone not saved yet.
function allProfiles(guildId) {
  let seed = {};
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'staff-seed.json'), 'utf8')); } catch { /* optional */ }
  let db = {};
  try { db = getGuildStore(guildId).staffProfiles || {}; } catch { /* ignore */ }
  return { ...seed, ...db };
}

function aiLines(guildId) {
  try {
    return Object.values(allProfiles(guildId)).filter(p => p && p.name && p.role).map(profileLine);
  } catch { return []; }
}

// The staff profile line for ONE person (matched by Discord ID, here in code —
// IDs never go to the AI), or null if they aren't a known staff member.
function speakerLine(guildId, userId) {
  try {
    const p = allProfiles(guildId)[String(userId)];
    return p && p.name && p.role ? profileLine(p) : null;
  } catch { return null; }
}

module.exports = { isOwner, buildPickerPayload, handlePick, handleDm, aiLines, speakerLine };
