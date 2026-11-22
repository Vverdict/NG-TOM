const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { canManageBot } = require('./access');

// /clear amount:<1-500> [user:@someone]
// Deletes the last N messages in the channel it's used in (optionally only one
// person's). Discord only lets bots bulk-delete messages newer than 14 days,
// and pinned messages are always skipped.
const MAX_AMOUNT = 500;
const MAX_SCAN = 1500;                         // messages looked through when filtering by user
const TOO_OLD_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete the last few messages in this channel')
    .addIntegerOption(opt =>
      opt.setName('amount')
        .setDescription(`How many messages to delete (1-${MAX_AMOUNT})`)
        .setMinValue(1)
        .setMaxValue(MAX_AMOUNT)
        .setRequired(true))
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Only delete messages from this person (optional)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    const member = interaction.member;
    const allowed = canManageBot(member) || member.permissions.has(PermissionFlagsBits.ManageMessages);
    if (!allowed) {
      return interaction.reply({ content: '❌ You need the Manage Messages permission to use this.', flags: MessageFlags.Ephemeral });
    }

    const channel = interaction.channel;
    if (!channel || typeof channel.bulkDelete !== 'function') {
      return interaction.reply({ content: '❌ I can only clear messages in a normal text channel.', flags: MessageFlags.Ephemeral });
    }

    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms || !botPerms.has(PermissionFlagsBits.ManageMessages) || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
      return interaction.reply({
        content: '❌ I need **Manage Messages** and **Read Message History** in this channel to do that.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const amount = interaction.options.getInteger('amount');
    const onlyUser = interaction.options.getUser('user');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let deleted = 0;
    let scanned = 0;
    let before;
    let hitOldMessages = false;

    try {
      while (deleted < amount && scanned < MAX_SCAN) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        scanned += batch.size;
        before = batch.last().id;

        const now = Date.now();
        let pool = [...batch.values()].filter(m =>
          !m.pinned
          && now - m.createdTimestamp < TOO_OLD_MS
          && (!onlyUser || m.author.id === onlyUser.id));
        pool = pool.slice(0, amount - deleted);

        if (pool.length) {
          const res = await channel.bulkDelete(pool, true);
          deleted += res.size !== undefined ? res.size : pool.length;
        }

        // Everything further back is older than 14 days — Discord won't let us delete it.
        if (now - batch.last().createdTimestamp >= TOO_OLD_MS) {
          hitOldMessages = true;
          break;
        }
        if (!onlyUser && !pool.length && batch.size < 100) break;
      }
    } catch (err) {
      console.error('[clear] Failed to delete messages:', err);
      const partial = deleted ? ` (deleted ${deleted} before it failed)` : '';
      return interaction.editReply({ content: `❌ Something went wrong while deleting messages${partial}.` });
    }

    let text = deleted
      ? `🧹 Deleted **${deleted}** message${deleted === 1 ? '' : 's'}${onlyUser ? ` from ${onlyUser.username}` : ''}.`
      : 'Nothing to delete — no matching messages found.';
    if (deleted < amount && hitOldMessages) {
      text += ' The rest are older than 14 days, which Discord doesn\'t allow bots to bulk-delete.';
    }
    return interaction.editReply({ content: text });
  },
};
