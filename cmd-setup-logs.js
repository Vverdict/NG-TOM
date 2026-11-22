const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { canManageBot } = require('./access');
const serverLogs = require('./server-logs');

// /setup-logs create | status | set | clear
// Creates (or repairs) the 9 server-log channels in a private category and
// lets you point any category at an existing channel instead.
const choices = serverLogs.KEYS.map(k => ({ name: serverLogs.CATEGORIES[k].label, value: k }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-logs')
    .setDescription('Set up the 9 server log channels')
    .addSubcommand(s => s.setName('create').setDescription('Create the private log category and any missing log channels'))
    .addSubcommand(s => s.setName('status').setDescription('Show which log channels are active'))
    .addSubcommand(s => s.setName('set').setDescription('Send one log category to an existing channel')
      .addStringOption(o => o.setName('log').setDescription('Which log').setRequired(true).addChoices(...choices))
      .addChannelOption(o => o.setName('channel').setDescription('Text channel to log into').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('clear').setDescription('Turn off one log category (the channel is not deleted)')
      .addStringOption(o => o.setName('log').setDescription('Which log').setRequired(true).addChoices(...choices)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Use this inside a server.', flags: MessageFlags.Ephemeral });
    }
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ You need Manage Server (or the TOURNAMENT ELITE role) to use this.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'create') {
        const r = await serverLogs.setupGuild(guild);
        const lines = [`✅ Logs ready in <#${r.categoryId}>.`];
        if (r.created.length) lines.push(`Created: ${r.created.map(k => serverLogs.CATEGORIES[k].label).join(', ')}`);
        if (r.kept.length) lines.push(`Already set: ${r.kept.map(k => serverLogs.CATEGORIES[k].label).join(', ')}`);
        if (!guild.members.me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
          lines.push('⚠️ I don\'t have **View Audit Log**, so logs will show *what* happened but not *who* did it.');
        }
        return interaction.editReply(lines.join('\n'));
      }
      if (sub === 'status') {
        const rows = serverLogs.getStatus(guild).map(s => `${s.channelId ? '🟢' : '⚪'} **${s.label}** — ${s.channelId ? `<#${s.channelId}>` : 'off'}`);
        return interaction.editReply(rows.join('\n'));
      }
      if (sub === 'set') {
        const key = interaction.options.getString('log', true);
        const ch = interaction.options.getChannel('channel', true);
        serverLogs.setChannel(guild, key, ch.id);
        return interaction.editReply(`✅ **${serverLogs.CATEGORIES[key].label}** logs now go to <#${ch.id}>.`);
      }
      if (sub === 'clear') {
        const key = interaction.options.getString('log', true);
        serverLogs.clearChannel(guild, key);
        return interaction.editReply(`✅ **${serverLogs.CATEGORIES[key].label}** logs turned off.`);
      }
    } catch (err) {
      console.error('[setup-logs] failed:', err);
      return interaction.editReply(`❌ ${err.message || 'Something went wrong.'}`);
    }
  },
};
