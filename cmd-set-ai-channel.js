const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-ai-channel')
    .setDescription('Choose a channel where the bot replies to any message like a helpful human')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The channel where the AI helper should chat with members')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');

    if (!require('./ai-chat').hasAnyProvider()) {
      return interaction.reply({
        content: '⚠️ No AI key is set in this bot\'s environment yet, so the AI helper can\'t actually reply. Add `GEMINI_API_KEYS` (or a free `GROQ_API_KEY` from https://console.groq.com/keys) to your Railway Variables and restart the bot — then this will start working.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.aiChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: `✅ The AI helper will now reply to every message posted in ${channel}. The AI will not reply in any other channel. Use \`/disable-ai-channel\` to turn this off.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
