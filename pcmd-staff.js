const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, MessageFlags,
} = require('discord.js');
const { canManageBot } = require('./access');
const staffActivity = require('./staff-activity');
const staffActivityExport = require('./staff-activity-export');
const staffPanelHandlers = require('./staff-panel-handlers');

// The !staff activity panel: just Daily / Weekly / Monthly buttons. Each one
// builds an Excel sheet of staff activity and DMs it to a fixed user (see
// staff-activity-export.js) instead of showing anything in the channel.
function buildStaffPanel() {
  const embed = new EmbedBuilder()
    .setTitle('📊 Staff Activity')
    .setColor(0x5865F2)
    .setDescription('Press **Daily**, **Weekly** or **Monthly** to send that period\'s staff activity Excel sheet (check-ins, check-outs, messages, VC time, work done — best staff first).');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('staffactivity_export:daily').setLabel('Daily').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('staffactivity_export:weekly').setLabel('Weekly').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('staffactivity_export:monthly').setLabel('Monthly').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function handleExportButton(interaction) {
  if (!canManageBot(interaction.member)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const kind = interaction.customId.split(':')[1];
  if (!['daily', 'weekly', 'monthly'].includes(kind)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const r = await staffActivityExport.sendExport(interaction.client, interaction.guild, kind);
    await interaction.editReply(`✅ ${r.period.label} Excel sheet (${r.count} staff) sent to <@${staffActivityExport.EXPORT_USER_ID}>.`);
  } catch (err) {
    console.error('[staff-activity] export failed:', err);
    await interaction.editReply("❌ Couldn't send the sheet — that user may have DMs closed, or the export failed. Check the bot logs.");
  }
}

module.exports = {
  name: 'staff',
  description: 'Staff control panel — !staff posts the 16-button panel. !staff role @role sets who is tracked. !staff activity posts Daily/Weekly/Monthly Excel export buttons.',
  adminOnly: true,

  async execute(message, args) {
    const { guild } = message;

    // !staff role [@role] — view or change who gets tracked.
    if ((args[0] || '').toLowerCase() === 'role') {
      const mentionedRole = message.mentions.roles.first();
      if (mentionedRole) {
        staffActivity.setStaffRoleId(guild.id, mentionedRole.id);
        return message.reply(`✅ Members with **${mentionedRole.name}** can now use the staff self-service buttons (Check-in / Check-out etc.). Messages and VC time are tracked per user ID for everyone on the staff list, not by role.`).catch(() => {});
      }
      const currentId = staffActivity.getStaffRoleId(guild.id);
      const currentRole = currentId ? guild.roles.cache.get(currentId) : null;
      return message.reply(currentRole
        ? `Activity is tracked per user ID for everyone on the staff list. **${currentRole.name}** may use the self-service buttons (the Staff Entry Form is admin-only). Change that role any time with \`!staff role @role\`.`
        : 'Activity is tracked per user ID for everyone on the staff list. Optionally run `!staff role @role` to let a role use the Entry Form to join it.'
      ).catch(() => {});
    }

    // !staff — the staff control panel (check-in, entry form, active / inactive
    // staff, promotions, work, leave, reports, rules, weekly report ...).
    if ((args[0] || '').toLowerCase() !== 'activity') {
      await message.channel.send(staffPanelHandlers.buildMainPanel(guild));
      await message.delete().catch(() => {});
      return;
    }

    // !staff activity — Daily / Weekly / Monthly Excel export buttons.
    await message.channel.send(buildStaffPanel());
  },

  handleExportButton,
};
