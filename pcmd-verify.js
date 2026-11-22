const { EmbedBuilder } = require('discord.js');
const { lookupIgn } = require('./bgmi-lookup');

// !verify <BGMI UID>  ->  looks the UID up in-game and replies with just:
//   IGN - <in-game name>
//   UID - <uid>
// It is NOT linked to tournament registrations in any way: the player doesn't
// have to be registered anywhere. Staff only (adminOnly).

module.exports = {
  name: 'verify',
  aliases: ['verifyuser', 'verify_user'],
  description: 'Show the in-game name for a BGMI UID — usage: !verify <BGMI UID>',
  adminOnly: true,

  async execute(message, args) {
    const uid = args.join('').trim();
    if (!/^\d{5,12}$/.test(uid)) {
      return message.reply('Usage: `!verify <BGMI UID>` (5-12 digits)').catch(() => {});
    }

    const ign = await lookupIgn(uid);
    if (!ign) {
      return message.reply({
        content: `❌ Couldn't find an in-game name for UID **${uid}** (wrong UID, or the lookup is unavailable right now).`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setDescription(`**IGN -** ${ign}\n**UID -** ${uid}`);
    await message.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  },
};
