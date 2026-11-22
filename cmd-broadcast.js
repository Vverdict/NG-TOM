const { SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { canManageBot } = require('./access');

// ---------------------------------------------------------------------------
// /broadcast — send a message to any channel from wherever you are.
//   channel : where to post it
//   message : the text (type \n for a new line)
//   image   : optional picture to attach
//   embed   : optional — post it as an embed instead of plain text
// Admin-only (same rule as the rest of the bot). @everyone / @here are NOT
// pinged; user and role mentions work.
// ---------------------------------------------------------------------------
module.exports = {
  data: new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('Send a message to another channel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to send it')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)
      .setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('The message (type \\n for a new line)').setMaxLength(2000).setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Optional image / file to attach'))
    .addBooleanOption(o => o.setName('embed').setDescription('Send it as an embed')),

  async execute(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ Only admins can use /broadcast.', flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getChannel('channel', true);
    const text = interaction.options.getString('message', true).replace(/\\n/g, '\n');
    const file = interaction.options.getAttachment('image');
    const asEmbed = interaction.options.getBoolean('embed') || false;

    const channel = await interaction.guild.channels.fetch(target.id).catch(() => null);
    const me = interaction.guild.members.me;
    const perms = channel && me ? channel.permissionsFor(me) : null;
    if (!channel || !perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({ content: `❌ I can't send messages in <#${target.id}> — check my permissions there.`, flags: MessageFlags.Ephemeral });
    }

    const payload = { allowedMentions: { parse: ['users', 'roles'] } };
    if (asEmbed) {
      const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(text.slice(0, 4000));
      if (file && (file.contentType || '').startsWith('image/')) embed.setImage(file.url);
      else if (file) payload.files = [file.url];
      payload.embeds = [embed];
    } else {
      payload.content = text;
      if (file) payload.files = [file.url];
    }

    try {
      const sent = await channel.send(payload);
      return interaction.reply({ content: `✅ Sent to <#${channel.id}>. ${sent.url}`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      return interaction.reply({ content: `❌ Couldn't send it: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};
