const staffSystem = require('./staff-system');
const staffActivity = require('./staff-activity');
const staffDmReports = require('./staff-dm-reports');

// !staffreport @staff [week|month|daily]
//   week  (default) → that staff member's last-7-days report
//   month           → that staff member's report for the current month so far
//   daily           → today's Active / Inactive / On-leave list
// The result is DM'd to the person who ran the command.
module.exports = {
  name: 'staffreport',
  aliases: ['sreport'],
  description: 'DM yourself a staff report — !staffreport @staff [week|month], or !staffreport daily for the active / inactive / leave list.',
  adminOnly: true,

  async execute(message, args) {
    const { guild } = message;
    const kind = args.map(a => a.toLowerCase()).find(a => ['week', 'weekly', 'month', 'monthly', 'daily', 'list'].includes(a)) || 'week';
    let embeds;

    if (kind === 'daily' || kind === 'list') {
      embeds = staffDmReports.buildDailyListEmbeds(guild);
    } else {
      const target = message.mentions.users.first() || (args.find(a => /^\d{15,25}$/.test(a)) && { id: args.find(a => /^\d{15,25}$/.test(a)) });
      if (!target) return message.reply('Usage: `!staffreport @staff [week|month]` — or `!staffreport daily`.').catch(() => {});
      if (!staffSystem.getMember(guild.id, target.id)) return message.reply("❌ That person isn't on the staff list.").catch(() => {});
      embeds = kind.startsWith('month')
        ? staffDmReports.monthlyCards(guild, staffActivity.currentMonthKey(), new Date().getUTCDate(), target.id)
        : staffDmReports.weeklyCards(guild, target.id);
    }

    try {
      await message.author.send({ embeds });
      await message.reply('✅ Report sent to your DMs.').catch(() => {});
    } catch {
      await message.reply("❌ I couldn't DM you — open your DMs for this server and try again.").catch(() => {});
    }
  },
};
