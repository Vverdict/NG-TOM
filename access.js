// Who may use the bot's admin features (the !tournament panel, every admin
// button, !export_tournament, ...). Normally that's "Manage Server". Anyone
// whose Discord user ID is listed in the ALLOWED_USER_IDS environment variable
// (comma-separated, e.g. in Railway → Variables) can use them too, in every
// server the bot is in — no Manage Server needed.
const { PermissionFlagsBits } = require('discord.js');

// Every 15–25 digit run in the variable counts as an ID, so quotes, spaces,
// commas, newlines, "<@123…>" mentions etc. around the IDs don't break it.
function envAllowedIds() {
  return [...new Set((process.env.ALLOWED_USER_IDS || '').match(/\d{15,25}/g) || [])];
}

// TOURNAMENT_USER_IDS — "tournament friends". They may use the !tournament
// panel (every button in it) and see/use the tournament channels, and nothing
// else: they are NOT in ALLOWED_USER_IDS, so they get no report DMs or any other
// DM the bot sends to ALLOWED_USER_IDS, and no access to the staff panel,
// /broadcast, /auto, the screenshot-verify panel, etc.
function envTournamentUserIds() {
  return [...new Set((process.env.TOURNAMENT_USER_IDS || '').match(/\d{15,25}/g) || [])];
}

function isTournamentUser(userId) {
  return envTournamentUserIds().includes(String(userId));
}

// Server admins / ALLOWED_USER_IDS / ELITE role, plus the tournament friends.
// Used ONLY for the tournament panel itself (never for reports or DMs).
function canManageTournament(member) {
  if (!member) return false;
  return canManageBot(member) || isTournamentUser(member.id);
}

// Everyone who gets access to tournament channels (ALLOWED_USER_IDS + friends).
function envTournamentChannelIds() {
  return [...new Set([...envAllowedIds(), ...envTournamentUserIds()])];
}

function isAllowedUser(userId) {
  return envAllowedIds().includes(String(userId));
}

// Manage Server OR listed in ALLOWED_USER_IDS — real server admins only.
function canManageServer(member) {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || isAllowedUser(member.id);
}

// Full access to the tournament bot: server admins, plus anyone holding the
// TOURNAMENT ELITE role (created by /create-role). Every admin check in the
// bot goes through this (the !tournament panel, every panel button, exports).
function canManageBot(member) {
  return canManageServer(member) || hasTournamentEliteRole(member);
}

// The TOURNAMENT ADMIN role (created by /create-role) — matched by name, so it
// keeps working if the role is deleted and re-created. What it may do is
// decided in tournament-wizard-handlers.js (a short list of panel buttons).
const TOURNAMENT_ADMIN_ROLE_NAME = 'TOURNAMENT ADMIN';

function hasTournamentAdminRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return member.roles.cache.some(r => r.name.toLowerCase() === TOURNAMENT_ADMIN_ROLE_NAME.toLowerCase());
}

// The TOURNAMENT ELITE role — matched by name, like TOURNAMENT ADMIN.
const TOURNAMENT_ELITE_ROLE_NAME = 'TOURNAMENT ELITE';

function hasTournamentEliteRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return member.roles.cache.some(r => r.name.toLowerCase() === TOURNAMENT_ELITE_ROLE_NAME.toLowerCase());
}

// Global lock on the whole bot. Nobody — not even the server owner — gets a
// response from any command, button, select, modal, or the AI chat unless
// their Discord ID is listed in ALLOWED_USER_IDS (Railway → Variables) or
// they hold TOURNAMENT ADMIN / TOURNAMENT ELITE. This is checked once, right
// at the top of messageCreate and interactionCreate in index.js, before
// anything else runs.
function canUseBot(member) {
  if (!member) return false;
  return isAllowedUser(member.id) || hasTournamentAdminRole(member) || hasTournamentEliteRole(member);
}

// Silent denial: when someone without permission clicks / uses something, the
// bot shows NOTHING. Discord still requires every interaction to be
// acknowledged, so buttons/selects are deferred silently (no message, no
// "interaction failed"); slash commands and modals get an invisible
// ephemeral defer that is deleted straight away.
async function silentDeny(interaction) {
  try {
    if (!interaction || interaction.replied || interaction.deferred) return null;
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) return null;
    if (typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ ephemeral: true });
      await interaction.deleteReply().catch(() => {});
    }
  } catch (_) { /* nothing to show, nothing to log */ }
  return null;
}

module.exports = { silentDeny, envAllowedIds, envTournamentUserIds, envTournamentChannelIds, isTournamentUser, canManageTournament, isAllowedUser, canManageServer, canManageBot, hasTournamentAdminRole, hasTournamentEliteRole, canUseBot };
