const { buildTournamentListPayload } = require('./tournament-wizard-handlers');
const panelInactivity = require('./panel-inactivity');

module.exports = {
  name: 'tournament',
  aliases: ['tourney'],
  description: 'Post the tournament panel — create, switch between, and manage multiple tournaments (usage: !tournament)',
  adminOnly: true,
  tournamentFriendAccess: true, // TOURNAMENT_USER_IDS may run this too

  async execute(message) {
    const payload = buildTournamentListPayload(message.guildId);
    const sent = await message.channel.send(payload);
    panelInactivity.touch(sent);
    await message.delete().catch(() => {});
  },
};
