const tournamentWizard = require('./tournament-wizard-handlers');

module.exports = {
  name: 'open',
  description: 'Open a tournament group channel so its players can chat and send files — run it inside the group channel (staff / Manage Server)',
  // Not adminOnly: tournament Staff-role members may use it too — the handler checks.
  async execute(message) {
    return tournamentWizard.handleGroupChatToggle(message, true);
  },
};
