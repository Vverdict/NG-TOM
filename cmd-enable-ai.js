const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('enable-ai')
    .setDescription('Turn the AI back on after /disable-ai')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    if (!store.settings.aiDisabled) {
      return interaction.reply({
        content: 'ℹ️ The AI is already enabled.',
        flags: MessageFlags.Ephemeral,
      });
    }

    store.settings.aiDisabled = false;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: '✅ The AI is enabled again. It follows your `/set-ai-channel` setting.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
