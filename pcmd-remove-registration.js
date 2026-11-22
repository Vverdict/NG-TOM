const { removePlayerRegistration } = require('./tournament-wizard-handlers');

// Usage: !remove registration @user   (also !removeregistration / !remove_registration)
// Removes the player's registration from every tournament in the server and
// takes away all their group roles + the Registered role.
module.exports = {
  name: 'removeregistration',
  aliases: ['remove_registration', 'remove'],
  description: "Remove a player's tournament registration and group roles — usage: !remove registration @user",
  adminOnly: true,

  async execute(message, args) {
    // "!remove registration @user" arrives as name "remove" + args ["registration", "<@id>"].
    if (message.content.trim().split(/\s+/)[0].slice(1).toLowerCase() === 'remove') {
      if ((args[0] || '').toLowerCase() !== 'registration') {
        return message.reply('Usage: `!remove registration @user`').catch(() => {});
      }
    }

    const target = message.mentions.users.first();
    const rawId = args.map(a => a.match(/^<@!?(\d+)>$/)?.[1] || (/^\d{15,25}$/.test(a) ? a : null)).find(Boolean);
    const userId = target?.id || rawId;
    if (!userId) {
      return message.reply('Usage: `!remove registration @user`').catch(() => {});
    }

    const results = await removePlayerRegistration(message.guild, userId, message.author.tag, message.author.id);
    if (!results.length) {
      return message.reply({ content: `❌ <@${userId}> isn't registered in any tournament.`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    const lines = results.map(r =>
      `• **${r.tournament.name}** — ${r.wholeTeam ? `team **${r.team}** removed (Group ${r.letter})` : `removed from team **${r.team}**`}`);
    return message.reply({
      content: `🗑️ <@${userId}>'s registration has been removed and their group roles taken away.\n${lines.join('\n')}`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  },
};
