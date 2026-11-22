const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { canManageBot } = require('./access');

// ---------------------------------------------------------------------------
// /find-username [min_length] [max_length] [letters_only]
// Lists every (non-bot) member of this server whose Discord USERNAME is short
// (default 3–4 characters, e.g. "abc" or "abdc") and DMs the list to the owner,
// 20 @mentions per message, shortest usernames first.
//
// Always DMs the user ID set in DM_USER_ID below. Who may run it: server
// admins / ALLOWED_USER_IDS / TOURNAMENT ELITE role.
// ---------------------------------------------------------------------------

const DM_USER_ID = '852161698298724362';
const PER_MESSAGE = 20;
const DELAY_MS = 1100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('find-username')
    .setDescription('DM the owner every member with a short (3-4 character) Discord username')
    .addIntegerOption(opt =>
      opt.setName('min_length')
        .setDescription('Shortest username length to include (default 3)')
        .setMinValue(2)
        .setMaxValue(32)
        .setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('max_length')
        .setDescription('Longest username length to include (default 4)')
        .setMinValue(2)
        .setMaxValue(32)
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('letters_only')
        .setDescription('Only usernames made purely of letters a-z (no digits, _ or .). Default: off')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Use this inside a server.', flags: MessageFlags.Ephemeral });
    }
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ You need Manage Server (or the TOURNAMENT ELITE role) to use this.', flags: MessageFlags.Ephemeral });
    }

    const minLen = interaction.options.getInteger('min_length') ?? 3;
    const maxLen = interaction.options.getInteger('max_length') ?? 4;
    const lettersOnly = interaction.options.getBoolean('letters_only') ?? false;
    if (minLen > maxLen) {
      return interaction.reply({ content: '❌ `min_length` must be the same as or smaller than `max_length`.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let members;
    try {
      members = await interaction.guild.members.fetch({ time: 120_000 });
    } catch (err) {
      console.error('[find-username] members.fetch failed:', err.message);
      return interaction.editReply('❌ Couldn\'t load the member list (timed out or missing the Server Members intent). Try again in a minute.');
    }

    const matches = [...members.values()]
      .filter(m => {
        if (m.user.bot) return false;
        const name = m.user.username || '';
        if (name.length < minLen || name.length > maxLen) return false;
        return lettersOnly ? /^[a-z]+$/i.test(name) : true;
      })
      .sort((a, b) => a.user.username.length - b.user.username.length
        || a.user.username.localeCompare(b.user.username));

    const desc = `${minLen === maxLen ? minLen : `${minLen}–${maxLen}`}-character usernames${lettersOnly ? ' (letters only)' : ''}`;
    if (!matches.length) {
      return interaction.editReply(`No members in **${interaction.guild.name}** have ${desc}.`);
    }

    const targetId = DM_USER_ID;
    let target;
    try {
      target = await interaction.client.users.fetch(targetId);
    } catch {
      return interaction.editReply(`❌ I couldn't find the user \`${targetId}\` to DM.`);
    }

    const pages = Math.ceil(matches.length / PER_MESSAGE);
    await interaction.editReply(`🔎 Found **${matches.length}** members with ${desc}. Sending ${pages} DM${pages === 1 ? '' : 's'} to <@${targetId}>…`);

    try {
      await target.send({
        content: `📋 **${interaction.guild.name}** — ${desc}\nTotal: **${matches.length}** (shortest first, ${PER_MESSAGE} per message)`,
      });
      for (let i = 0; i < matches.length; i += PER_MESSAGE) {
        const chunk = matches.slice(i, i + PER_MESSAGE);
        await target.send({
          content: chunk.map(m => `<@${m.id}> ${m.user.username}`).join('\n'),
        });
        if (i + PER_MESSAGE < matches.length) await sleep(DELAY_MS);
      }
    } catch (err) {
      console.error(`[find-username] DM to ${targetId} failed:`, err.code ?? '', err.message);
      return interaction.editReply('❌ I couldn\'t DM that user — they need to allow DMs from server members (or share a server with the bot) and not have blocked it.');
    }

    return interaction.editReply(`✅ Sent **${matches.length}** members (${desc}) to <@${targetId}> in ${pages} message${pages === 1 ? '' : 's'}.`);
  },
};
