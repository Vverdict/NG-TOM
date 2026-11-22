const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageBot } = require('./access');
const auto = require('./auto-responder');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('auto-remove')
    .setDescription('Delete an auto-reply')
    .addStringOption(o => o.setName('trigger').setDescription('The trigger to delete').setMaxLength(50).setRequired(true).setAutocomplete(true)),

  async autocomplete(interaction) {
    if (!canManageBot(interaction.member)) return interaction.respond([]);
    const q = auto.normTrigger(interaction.options.getFocused());
    const choices = Object.keys(auto.getAll(interaction.guildId)).filter(t => t.includes(q)).slice(0, 25).map(t => ({ name: t, value: t }));
    return interaction.respond(choices);
  },

  async execute(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ Only admins can use /auto-remove.', flags: MessageFlags.Ephemeral });
    }
    const ok = auto.removeResponse(interaction.guildId, interaction.options.getString('trigger', true));
    return interaction.reply({
      content: ok ? '🗑️ Auto-reply removed.' : '❌ No auto-reply with that trigger. Check `/auto-list`.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
