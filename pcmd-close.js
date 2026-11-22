const tournamentWizard = require('./tournament-wizard-handlers');

module.exports = {
  name: 'close',
  description: 'Close a tournament group channel — no messages, files or threads until !open — run it inside the group channel (staff / Manage Server)',
  // Not adminOnly: tournament Staff-role members may use it too — the handler checks.
  async execute(message) {
    return tournamentWizard.handleGroupChatToggle(message, false);
  },
};
