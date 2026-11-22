const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { canManageBot } = require('./access');
const auto = require('./auto-responder');

module.exports = {
  data: new SlashCommandBuilder().setName('auto-list').setDescription('Show all auto-replies in this server'),

  async execute(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ Only admins can use /auto-list.', flags: MessageFlags.Ephemeral });
    }
    const entries = Object.values(auto.getAll(interaction.guildId));
    if (!entries.length) {
      return interaction.reply({ content: 'No auto-replies yet. Add one with `/auto`.', flags: MessageFlags.Ephemeral });
    }
    const kind = (e) => [
      e.text ? 'embed' : null,
      e.file ? ((e.file.contentType || '').startsWith('video/') ? 'video' : (e.file.contentType || '').startsWith('image/') ? 'image' : 'file') : null,
    ].filter(Boolean).join(' + ');
    let desc = '';
    for (const e of entries) {
      const line = `• \`${e.trigger}\` — ${kind(e)}\n`;
      if ((desc + line).length > 3900) { desc += '…and more'; break; }
      desc += line;
    }
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`🤖 Auto-replies (${entries.length}/${auto.MAX_TRIGGERS})`).setDescription(desc);
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
