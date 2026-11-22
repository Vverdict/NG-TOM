const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('disable-ai')
    .setDescription('Turn the AI off completely — it will stay silent for everyone, even the owner')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    if (store.settings.aiDisabled) {
      return interaction.reply({
        content: 'ℹ️ The AI is already disabled. Use `/enable-ai` to turn it back on.',
        flags: MessageFlags.Ephemeral,
      });
    }

    store.settings.aiDisabled = true;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: '🔇 The AI is now completely disabled. It will not reply to anyone (owner and allowed users included). Use `/enable-ai` to turn it back on.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
