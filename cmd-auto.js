const {
  SlashCommandBuilder, MessageFlags, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
  FileUploadBuilder,
} = require('discord.js');
const { canManageBot } = require('./access');
const auto = require('./auto-responder');

// ---------------------------------------------------------------------------
// /auto — opens a form:
//     Trigger        (the word / phrase to react to)
//     Description    (the reply — sent as an embed)
//     Upload file    (optional image or video)
// Whenever someone's message contains the trigger, the bot replies with that
// embed (+ the image inside it, or the video attached next to it).
// /auto-list shows everything, /auto-remove deletes one.
// ---------------------------------------------------------------------------
const MODAL_ID = 'auto:add';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('auto')
    .setDescription('Add an auto-reply: when a trigger word is said, the bot answers automatically'),

  async execute(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ Only admins can use /auto.', flags: MessageFlags.Ephemeral });
    }
    if (typeof FileUploadBuilder !== 'function' || typeof LabelBuilder !== 'function') {
      return interaction.reply({
        content: '❌ This bot\'s discord.js is too old for forms with file upload. Run `npm install discord.js@latest` and restart.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const trigger = new TextInputBuilder()
      .setCustomId('auto_trigger')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. mgmtf')
      .setMaxLength(50)
      .setRequired(true);
    const description = new TextInputBuilder()
      .setCustomId('auto_text')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('What should the bot reply with?')
      .setMaxLength(1500)
      .setRequired(false);
    const upload = new FileUploadBuilder()
      .setCustomId('auto_file')
      .setMinValues(0)
      .setMaxValues(1)
      .setRequired(false);

    const modal = new ModalBuilder()
      .setCustomId(MODAL_ID)
      .setTitle('New auto-reply')
      .addLabelComponents(
        new LabelBuilder().setLabel('Trigger').setDescription('The word or phrase the bot should react to').setTextInputComponent(trigger),
        new LabelBuilder().setLabel('Description').setDescription('The reply, shown as an embed').setTextInputComponent(description),
        new LabelBuilder().setLabel('Upload file').setDescription('Optional image or video').setFileUploadComponent(upload),
      );
    return interaction.showModal(modal);
  },

  // Called from index.js when the form is submitted.
  async handleModal(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ Only admins can use /auto.', flags: MessageFlags.Ephemeral });
    }
    const trigger = auto.normTrigger(interaction.fields.getTextInputValue('auto_trigger'));
    const text = (interaction.fields.getTextInputValue('auto_text') || '').trim();
    let file = null;
    try {
      const files = interaction.fields.getUploadedFiles('auto_file', false);
      file = files && files.size ? files.first() : null;
    } catch { file = null; }

    if (!trigger) return interaction.reply({ content: '❌ The trigger can’t be empty.', flags: MessageFlags.Ephemeral });
    if (!text && !file) {
      return interaction.reply({ content: '❌ Add a description, a file, or both — the bot needs something to reply with.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const saved = file ? await auto.saveAttachment(interaction.guildId, file) : null;
      const replaced = auto.addResponse(interaction.guildId, {
        trigger,
        match: 'word',
        text: text || null,
        embed: text ? { title: null } : null,
        file: saved,
        createdBy: interaction.user.id,
        createdAt: Date.now(),
      });
      return interaction.editReply(`✅ ${replaced ? 'Updated' : 'Added'} auto-reply for \`${trigger}\`. Try saying it in a channel I can see.`);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  },
};
