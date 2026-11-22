// Auto-responder — when a message contains a trigger word an admin set with
// /auto add, the bot replies with the saved response: text, an embed, an image,
// a video / any file, or a mix of those.
//
// Settings live in the guild store (settings.autoResponses). Uploaded files are
// downloaded and kept on disk (next to the data file, so a Railway Volume keeps
// them) because Discord's attachment links expire after a while.
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const FILES_DIR = path.join(DATA_DIR, 'auto-files');
const MAX_TRIGGERS = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const normTrigger = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getAll(guildId) {
  const store = getGuildStore(guildId);
  return (store.settings || {}).autoResponses || {};
}

function matches(entry, content) {
  const text = content.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = entry.trigger;
  if (!t) return false;
  if (entry.match === 'exact') return text === t;
  if (entry.match === 'contains') return text.includes(t);
  // "word" (default): the trigger must stand alone, so "mgmtf" doesn't fire inside "xmgmtfx"
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

function filePathOf(entry) {
  return entry.file ? path.join(FILES_DIR, entry.file.stored) : null;
}

function deleteStoredFile(entry) {
  const p = filePathOf(entry);
  if (p) fs.promises.unlink(p).catch(() => {});
}

async function saveAttachment(guildId, attachment) {
  if (attachment.size > MAX_FILE_BYTES) throw new Error(`That file is too big (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Couldn't download the file (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error(`That file is too big (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  const safeName = (attachment.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
  const stored = `${guildId}_${Date.now()}_${safeName}`;
  await fs.promises.writeFile(path.join(FILES_DIR, stored), buf);
  return { stored, name: attachment.name || safeName, contentType: attachment.contentType || '' };
}

function addResponse(guildId, entry) {
  const store = getGuildStore(guildId);
  if (!store.settings) store.settings = {};
  if (!store.settings.autoResponses) store.settings.autoResponses = {};
  const all = store.settings.autoResponses;
  const old = all[entry.trigger];
  if (!old && Object.keys(all).length >= MAX_TRIGGERS) throw new Error(`Max ${MAX_TRIGGERS} auto-responses per server — remove one first.`);
  all[entry.trigger] = entry;
  saveGuildStore(guildId, store);
  if (old) deleteStoredFile(old);
  return !!old;
}

function removeResponse(guildId, trigger) {
  const store = getGuildStore(guildId);
  const all = (store.settings || {}).autoResponses || {};
  const key = normTrigger(trigger);
  const old = all[key];
  if (!old) return false;
  delete all[key];
  saveGuildStore(guildId, store);
  deleteStoredFile(old);
  return true;
}

function buildPayload(entry) {
  const payload = { allowedMentions: { parse: [] } };
  const fp = filePathOf(entry);
  const haveFile = fp && fs.existsSync(fp);
  const isImage = haveFile && (entry.file.contentType || '').startsWith('image/');

  if (entry.embed) {
    const embed = new EmbedBuilder().setColor(0x5865F2);
    if (entry.embed.title) embed.setTitle(entry.embed.title.slice(0, 256));
    if (entry.text) embed.setDescription(entry.text.slice(0, 4000));
    if (isImage) {
      const name = entry.file.name.replace(/[^\w.\-]+/g, '_');
      payload.files = [new AttachmentBuilder(fp, { name })];
      embed.setImage(`attachment://${name}`);
    } else if (haveFile) {
      payload.files = [new AttachmentBuilder(fp, { name: entry.file.name })]; // video etc. can't live inside an embed
    }
    payload.embeds = [embed];
  } else {
    if (entry.text) payload.content = entry.text.slice(0, 2000);
    if (haveFile) payload.files = [new AttachmentBuilder(fp, { name: entry.file.name })];
  }
  if (!payload.content && !payload.embeds && !payload.files) payload.content = '\u200b';
  return payload;
}

async function handleMessage(message) {
  if (message.author.bot || !message.guild || !message.content) return;
  const all = getAll(message.guild.id);
  const entries = Object.values(all);
  if (!entries.length) return;
  const hit = entries.find(e => matches(e, message.content));
  if (!hit) return;

  const me = message.guild.members.me;
  const perms = me ? message.channel.permissionsFor(me) : null;
  if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) return;

  const payload = buildPayload(hit);
  if (!perms.has(PermissionFlagsBits.AttachFiles)) delete payload.files;
  if (!perms.has(PermissionFlagsBits.EmbedLinks)) delete payload.embeds;
  if (!payload.content && !payload.embeds && !payload.files) return;
  // Post the answer as a normal message (not a reply), then remove the message
  // that triggered it once the answer is up.
  const sent = await message.channel.send(payload).catch(err => {
    console.warn(`[auto] Couldn't answer "${hit.trigger}": ${err.message}`);
    return null;
  });
  if (sent && perms.has(PermissionFlagsBits.ManageMessages)) {
    await message.delete().catch(() => {});
  }
}

module.exports = { handleMessage, getAll, addResponse, removeResponse, saveAttachment, normTrigger, matches, MAX_TRIGGERS };
