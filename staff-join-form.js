// Staff application form.
//
// Every NEW channel created inside the category set in FORM_CATEGORY_ID gets an
// embed "FILL THIS FORM" with a FORM button. Pressing it opens the application
// form (8 questions = 2 steps, because Discord forms hold 5 fields at most).
// The finished answers are posted as an embed in that same channel, and a .txt
// file (each question followed by its answer) is DM'd to every user ID in
// FORM_RECIPIENT_IDS — no embed in the DMs.
//
// Railway variables:
//   FORM_CATEGORY_ID    category ID (several IDs may be separated by commas)
//   FORM_RECIPIENT_IDS  user IDs that receive the answers (comma-separated)
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  LabelBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const PREFIX = 'jform:';
// q     = the exact question (used in the DM / file sent to the team)
// label = the single heading shown in the form (Discord limits it to 45 characters)
// hint  = grey text inside the empty answer box (the rest of the wording, if the label had to be shortened)
const QUESTIONS = [
  { id: 'name',       q: 'Name',                                  label: 'Name',                                  hint: '',                                   long: false },
  { id: 'age',        q: "What's your age?",                      label: "What's your age?",                      hint: '',                                   long: false },
  { id: 'active',     q: 'Active Time',                           label: 'Active Time',                           hint: 'e.g. 6 hours daily, 7 PM - 1 AM IST', long: false },
  { id: 'applying',   q: 'What are you applying for?',            label: 'What are you applying for?',            hint: '',                                   long: false },
  { id: 'experience', q: 'Past Experience',                       label: 'Past Experience',                       hint: 'Where and for how long? Write "None" if no experience.', long: true },
  { id: 'servers',    q: 'Past Servers',                          label: 'Past Servers',                          hint: 'Names of servers you worked in before', long: true },
  { id: 'working',    q: 'Working in any server? (YES/NO)',       label: 'Working in any server? (YES/NO)',       hint: 'YES or NO',                          long: false },
  { id: 'other',      q: 'Any other work (like Spec/PT)',         label: 'Any other work (like Spec/PT)',         hint: 'Write "None" if nothing',            long: true },
];
const STEPS = [QUESTIONS.slice(0, 5), QUESTIONS.slice(5)];
const pending = new Map();                 // `${userId}:${channelId}` -> { answers, at }
const PENDING_TTL_MS = 30 * 60 * 1000;

const ids = (v) => [...new Set(String(v || '').match(/\d{15,25}/g) || [])];
const categoryIds = () => ids(process.env.FORM_CATEGORY_ID);
const recipientIds = () => ids(process.env.FORM_RECIPIENT_IDS);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------ channel embed
async function onChannelCreate(channel) {
  try {
    if (!channel.guild || channel.type !== ChannelType.GuildText) return;
    if (!channel.parentId || !categoryIds().includes(channel.parentId)) return;
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) return;
    await sleep(1500); // let Discord finish setting up the channel
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('FILL THIS FORM').setDescription('Press the **FORM** button below to start.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}open`).setLabel('FORM').setStyle(ButtonStyle.Primary),
      )],
    });
  } catch (err) {
    console.warn(`[staff-form] Couldn't post the form embed in a new channel: ${err.message}`);
  }
}

// -------------------------------------------------------------- the modals
function buildModal(step) {
  const modal = new ModalBuilder().setCustomId(`${PREFIX}step${step}`).setTitle(`Staff application (${step + 1}/${STEPS.length})`);
  const modern = typeof LabelBuilder === 'function';
  for (const q of STEPS[step]) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setStyle(q.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(q.long ? 1000 : 100)
      .setRequired(true);
    if (q.hint) input.setPlaceholder(trunc(q.hint, 100));
    if (modern) {
      modal.addLabelComponents(new LabelBuilder().setLabel(trunc(q.label, 45)).setTextInputComponent(input));
    } else {
      input.setLabel(trunc(q.label, 45));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
  }
  return modal;
}

// --------------------------------------------------------------- delivery
// The answers are posted as an embed in the channel where the form was filled,
// and only a .txt file (each question followed by its answer) goes to the DMs.
function buildEmbeds(user, channelId, answers) {
  const when = new Date();
  const make = (title) => new EmbedBuilder().setColor(0x57F287).setTitle(title);
  let embed = make('📝 Staff application')
    .setDescription(`From <@${user.id}> (${user.tag || user.username})`)
    .setThumbnail(user.displayAvatarURL())
    .setTimestamp(when);
  const embeds = [];
  let size = 200;
  QUESTIONS.forEach((q, i) => {
    const name = trunc(`${i + 1}. ${q.q}`, 256);
    const value = trunc(answers[q.id] || '—', 1024);
    // one message may carry at most 6000 characters of embed text — start a new embed before that
    if (size + name.length + value.length > 5500) {
      embeds.push(embed);
      embed = make('📝 Staff application (continued)').setTimestamp(when);
      size = 50;
    }
    embed.addFields({ name, value });
    size += name.length + value.length;
  });
  embeds.push(embed);
  return embeds;
}

function buildFile(user, guild, channelId, answers) {
  const lines = [
    'STAFF APPLICATION',
    `Applicant : ${user.tag || user.username} (${user.id})`,
    `Server    : ${guild.name}`,
    `Channel   : #${guild.channels.cache.get(channelId)?.name || channelId}`,
    `Submitted : ${new Date().toISOString()}`,
    '',
  ];
  QUESTIONS.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.q}`, `   ${(answers[q.id] || '—').replace(/\n/g, '\n   ')}`, '');
  });
  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `application-${user.username}.txt` });
}

async function deliver(interaction, answers) {
  const { client, user, guild, channelId, channel } = interaction;

  // 1) embed(s) in the channel where the form was filled
  let posted = false;
  try {
    for (const embed of buildEmbeds(user, channelId, answers)) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    posted = true;
  } catch (err) {
    console.warn(`[staff-form] Couldn't post the answers in the channel: ${err.message}`);
  }

  // 2) only the .txt file to each recipient's DM
  const targets = recipientIds();
  let sent = 0;
  for (const id of targets) {
    try {
      const u = await client.users.fetch(id);
      await u.send({ files: [buildFile(user, guild, channelId, answers)] });
      sent++;
    } catch (err) {
      console.warn(`[staff-form] Couldn't DM ${id}: ${err.message}`);
    }
    await sleep(500);
  }
  return { posted, sent, total: targets.length };
}

// ------------------------------------------------------------ interactions
async function handleInteraction(interaction) {
  const id = interaction.customId;
  const key = `${interaction.user.id}:${interaction.channelId}`;

  // FORM button -> step 1
  if (interaction.isButton() && id === `${PREFIX}open`) {
    if (!recipientIds().length) {
      return interaction.reply({ content: '❌ The form isn\'t set up yet (no recipients). Please tell an admin.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildModal(0));
  }

  // "Continue" button -> step 2
  if (interaction.isButton() && id === `${PREFIX}next`) {
    const p = pending.get(key);
    if (!p || Date.now() - p.at > PENDING_TTL_MS) {
      pending.delete(key);
      return interaction.reply({ content: '⌛ That took too long — press the **FORM** button and start again.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildModal(1));
  }

  if (!interaction.isModalSubmit()) return;

  // Step 1 submitted
  if (id === `${PREFIX}step0`) {
    const answers = {};
    for (const q of STEPS[0]) answers[q.id] = interaction.fields.getTextInputValue(q.id).trim();
    pending.set(key, { answers, at: Date.now() });
    return interaction.reply({
      content: '✅ Part 1 saved. Press **Continue** for the last questions.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}next`).setLabel('Continue').setStyle(ButtonStyle.Success),
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Step 2 submitted -> deliver everything
  if (id === `${PREFIX}step1`) {
    const p = pending.get(key);
    if (!p || Date.now() - p.at > PENDING_TTL_MS) {
      pending.delete(key);
      return interaction.reply({ content: '⌛ That took too long — press the **FORM** button and start again.', flags: MessageFlags.Ephemeral });
    }
    const answers = { ...p.answers };
    for (const q of STEPS[1]) answers[q.id] = interaction.fields.getTextInputValue(q.id).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    pending.delete(key);
    const r = await deliver(interaction, answers);
    return interaction.editReply(r.posted || r.sent
      ? '✅ Your form has been submitted. Thank you!'
      : '❌ I couldn\'t deliver your form. Please tell an admin.');
  }
}

module.exports = { onChannelCreate, handleInteraction, PREFIX };
