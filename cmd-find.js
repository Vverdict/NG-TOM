const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { canManageBot } = require('./access');

// ---------------------------------------------------------------------------
// /find [from_year] [to_year]
// Lists every (non-bot) member of this server whose DISCORD ACCOUNT was
// created between from_year and to_year (default 2016 → 2019) and DMs the
// list to the owner, 20 @mentions per message, oldest accounts first.
//
// Who receives the DM: FIND_DM_USER_ID env var, otherwise the ID below.
// Who may run it: server admins / ALLOWED_USER_IDS / TOURNAMENT ELITE role.
// ---------------------------------------------------------------------------

const DEFAULT_DM_USER_ID = '1491373546885349437';
const PER_MESSAGE = 20;
const DELAY_MS = 1100; // gap between DMs so we never hit Discord's rate limit

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('find')
    .setDescription('DM the owner every member whose Discord account was created in a year range')
    .addIntegerOption(opt =>
      opt.setName('from_year')
        .setDescription('First account-creation year (default 2016)')
        .setMinValue(2015)
        .setMaxValue(new Date().getUTCFullYear())
        .setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('to_year')
        .setDescription('Last account-creation year (default 2019)')
        .setMinValue(2015)
        .setMaxValue(new Date().getUTCFullYear())
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Use this inside a server.', flags: MessageFlags.Ephemeral });
    }
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ You need Manage Server (or the TOURNAMENT ELITE role) to use this.', flags: MessageFlags.Ephemeral });
    }

    const fromYear = interaction.options.getInteger('from_year') ?? 2016;
    const toYear = interaction.options.getInteger('to_year') ?? 2019;
    if (fromYear > toYear) {
      return interaction.reply({ content: '❌ `from_year` must be the same as or earlier than `to_year`.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const startMs = Date.UTC(fromYear, 0, 1, 0, 0, 0);
    const endMs = Date.UTC(toYear, 11, 31, 23, 59, 59, 999);

    // Pull the full member list (needs the Server Members intent — already on).
    let members;
    try {
      members = await interaction.guild.members.fetch({ time: 120_000 });
    } catch (err) {
      console.error('[find] members.fetch failed:', err.message);
      return interaction.editReply('❌ Couldn\'t load the member list (timed out or missing the Server Members intent). Try again in a minute.');
    }

    const matches = [...members.values()]
      .filter(m => !m.user.bot && m.user.createdTimestamp >= startMs && m.user.createdTimestamp <= endMs)
      .sort((a, b) => a.user.createdTimestamp - b.user.createdTimestamp);

    const range = fromYear === toYear ? `${fromYear}` : `${fromYear}–${toYear}`;
    if (!matches.length) {
      return interaction.editReply(`No members in **${interaction.guild.name}** have an account created in ${range}.`);
    }

    const targetId = (process.env.FIND_DM_USER_ID || '').match(/\d{15,25}/)?.[0] || DEFAULT_DM_USER_ID;
    let target;
    try {
      target = await interaction.client.users.fetch(targetId);
    } catch {
      return interaction.editReply(`❌ I couldn't find the user \`${targetId}\` to DM.`);
    }

    const pages = Math.ceil(matches.length / PER_MESSAGE);
    await interaction.editReply(`🔎 Found **${matches.length}** members with accounts from ${range}. Sending ${pages} DM${pages === 1 ? '' : 's'} to <@${targetId}>…`);

    try {
      await target.send({
        content: `📋 **${interaction.guild.name}** — accounts created ${range}\nTotal: **${matches.length}** (oldest first, ${PER_MESSAGE} per message)`,
      });
      for (let i = 0; i < matches.length; i += PER_MESSAGE) {
        const chunk = matches.slice(i, i + PER_MESSAGE);
        await target.send({
          // Mentions must be allowed (the default) or Discord can't resolve the
          // names in a DM and shows "@unknown-user". Nobody gets pinged — the
          // mentioned members aren't in this DM. Username added as a fallback.
          content: chunk.map(m => `<@${m.id}> ${m.user.username}`).join('\n'),
        });
        if (i + PER_MESSAGE < matches.length) await sleep(DELAY_MS);
      }
    } catch (err) {
      console.error(`[find] DM to ${targetId} failed:`, err.code ?? '', err.message);
      return interaction.editReply('❌ I couldn\'t DM that user — they need to allow DMs from server members (or share a server with the bot) and not have blocked it.');
    }

    return interaction.editReply(`✅ Sent **${matches.length}** members (accounts from ${range}) to <@${targetId}> in ${pages} message${pages === 1 ? '' : 's'}.`);
  },
};
