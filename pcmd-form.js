const { buildPickerPayload, isOwner } = require('./staff-form');

// !form — pick a person; the bot DMs them the "Get to know you" form.
// Owner only (user id in staff-form.js / STAFF_FORM_OWNER_ID) — not even other admins.
module.exports = {
  name: 'form',
  aliases: ['staffform', 'infoform'],
  description: 'Send the staff info form to a player\'s DM — usage: !form',
  adminOnly: true,

  async execute(message) {
    if (!isOwner(message.author.id)) return message.reply('❌ Only the owner can use this command.').catch(() => {});
    await message.channel.send(buildPickerPayload());
    await message.delete().catch(() => {}); // tidy: remove the !form message itself
  },
};
