const { EmbedBuilder, ActionRowBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getTournamentStore } = require('./tournament-store');
const { getGuildStore } = require('./storage');
const { groupSlotNumber } = require('./slots');
const { canManageBot, canManageTournament, hasTournamentAdminRole } = require('./access');

// "Inspect" button on the !tournament admin panel.
// Opens Discord's member picker (with its built-in search bar, same as
// Manually Add Slot). Picking a member shows the full team card(s) they're
// registered in for the tournament open in the panel (Round 1 and later
// rounds), or says they aren't registered there.

const MAX_CARDS = 10;
const USER_ID = 'tourney_inspect_user';
function sortedKeys(groups) {
  return Object.keys(groups || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function roundName(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  return (saved.displayName || '').trim() || `Round ${roundNum}`;
}

// Every team entry in the tournament: Round 1 groups plus any later rounds.
function allEntries(tournament) {
  const out = [];
  for (const letter of sortedKeys(tournament.groups)) {
    const group = tournament.groups[letter];
    (group.teams || []).forEach((team, idx) => {
      out.push({ roundNum: 1, letter, slot: groupSlotNumber(group, idx), team });
    });
  }
  for (const [key, round] of Object.entries(tournament.rounds || {})) {
    const roundNum = parseInt(key, 10);
    if (!(roundNum > 1)) continue;
    for (const letter of sortedKeys(round.groups)) {
      const group = round.groups[letter];
      (group.teams || []).forEach((team, idx) => {
        out.push({ roundNum, letter, slot: groupSlotNumber({ ...group, round: roundNum }, idx), team });
      });
    }
  }
  return out;
}

function embedFor(tournament, entry, highlightUid, highlightId) {
  const { team, roundNum, letter, slot } = entry;
  const embed = new EmbedBuilder()
    .setTitle(String(team.team || 'Unnamed team').slice(0, 256))
    .setColor(0x57F287)
    .setFooter({ text: tournament.name || 'Tournament' });
  embed.addFields(
    { name: 'Tournament', value: String(tournament.name || tournament.id || '-').slice(0, 1024), inline: true },
    { name: 'Where', value: `${roundName(tournament, roundNum)} · Group ${letter} · Slot ${slot}`, inline: true },
  );
  const owner = team.ownerId
    ? `<@${team.ownerId}>${team.ownerName ? ` (${team.ownerName})` : ''}`
    : (team.ownerName || '_unknown_');
  embed.addFields({ name: 'Owner', value: owner, inline: true });
  if (team.whatsapp) embed.addFields({ name: 'WhatsApp', value: String(team.whatsapp).slice(0, 1024), inline: true });
  const players = (team.playerIgns || []).map((ign, i) => {
    const uid = (team.playerUids || [])[i];
    const hit = highlightUid && uid === highlightUid;
    return `${hit ? '👉 ' : ''}**P${i + 1}** — ${ign}${uid ? ` (${uid})` : ''}`;
  });
  if (players.length) embed.addFields({ name: 'Players', value: players.join('\n').slice(0, 1024) });
  const tags = (team.playerIds || []).map(id => `${highlightId && id === highlightId ? '👉 ' : ''}<@${id}>`);
  if (tags.length) embed.addFields({ name: 'Discord Tags', value: tags.join(' ').slice(0, 1024) });
  return embed;
}

function buildInspectPanel(tournament) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(USER_ID)
    .setPlaceholder('Select the player to inspect')
    .setMinValues(1)
    .setMaxValues(1);
  const embed = new EmbedBuilder()
    .setTitle(`🔍 Inspect Player — ${String(tournament.name || 'Tournament').slice(0, 200)}`)
    .setColor(0x5865F2)
    .setDescription('Select a player to see their full registration details in this tournament.');
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function noTournament(interaction) {
  return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
}

// Member picked with Discord's own search bar.
async function handleInspectUserPick(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) return noTournament(interaction);

  const id = interaction.values[0];
  const matches = allEntries(tournament)
    .filter(e => e.team.ownerId === id || (e.team.playerIds || []).includes(id));
  if (!matches.length) {
    return interaction.reply({
      content: `❌ <@${id}> is **not registered** in **${tournament.name || 'this tournament'}**.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  const shown = matches.slice(0, MAX_CARDS);
  return interaction.reply({
    embeds: shown.map(e => embedFor(tournament, e, null, id)),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// "Inspect" button under a group's published slot list.
// Unlike the panel's Inspect (which searches the whole tournament by player),
// this one is scoped to the group channel it was pressed in: it lists ONLY
// that group's teams, and picking one shows the full team card.
// Who may use it: Manage Server / allowed users / TOURNAMENT ELITE, the
// TOURNAMENT ADMIN role, and the tournament's Staff role.
// ---------------------------------------------------------------------------
const GROUP_INSPECT_BUTTON = 'tourney_wizard_group_inspect';
const GROUP_INSPECT_SELECT = 'tourney_group_inspect_select';
const NOT_ALLOWED = '<a:qg_hehe128:1553059818833584298>';

function groupsOfRound(tournament, roundNum) {
  if (roundNum <= 1) return tournament.groups || {};
  const round = (tournament.rounds || {})[roundNum];
  return (round && round.groups) || {};
}

function findGroup(tournament, roundNum, letter) {
  const group = groupsOfRound(tournament, roundNum)[letter];
  return group ? { ...group, round: roundNum, teams: group.teams || [] } : null;
}

function canInspectGroup(interaction, tournament) {
  const member = interaction.member;
  if (canManageTournament(member) || hasTournamentAdminRole(member)) return true;
  const roleId = tournament && tournament.staffRoleId;
  const roles = member && member.roles;
  if (!roleId || !roles) return false;
  if (roles.cache) return roles.cache.has(roleId);
  return Array.isArray(roles) && roles.includes(roleId);
}

// The button itself — added to the published slot list message.
function buildGroupInspectRow(tournamentId, roundNum, letter) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${GROUP_INSPECT_BUTTON}:${tournamentId}:${roundNum}:${letter}`)
      .setLabel('Inspect')
      .setEmoji('🔍')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Team picker for ONE group. Discord select menus hold 25 options, so a group
// with more teams just gets several menus (max 5 rows = 125 teams).
function buildGroupInspectPicker(tournament, roundNum, letter) {
  const group = findGroup(tournament, roundNum, letter);
  const label = `${roundName(tournament, roundNum)} · Group ${letter}`;
  if (!group) return { error: '❌ That group no longer exists.' };
  if (!group.teams.length) return { error: `❌ ${label} has no registered teams yet.` };

  const rows = [];
  for (let start = 0; start < group.teams.length && rows.length < 5; start += 25) {
    const chunk = group.teams.slice(start, start + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${GROUP_INSPECT_SELECT}:${tournament.id}:${roundNum}:${letter}:${rows.length}`)
      .setPlaceholder(group.teams.length > 25
        ? `Select team(s) — slots ${groupSlotNumber(group, start)}-${groupSlotNumber(group, start + chunk.length - 1)}`
        : 'Select team(s) to inspect')
      .setMinValues(1)
      .setMaxValues(Math.min(chunk.length, MAX_CARDS))
      .addOptions(chunk.map((t, i) => ({
        label: `Slot ${groupSlotNumber(group, start + i)} — ${String(t.team || 'Unnamed team')}`.slice(0, 100),
        value: String(start + i),
      })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Inspect Teams — ${label}`)
    .setColor(0x5865F2)
    .setDescription(`Only this group's teams are listed (${group.teams.length}). Pick a team to see its full registration details.`);
  return { embeds: [embed], components: rows };
}

// Inspect button pressed on a slot list.
async function handleGroupInspectButton(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (!canInspectGroup(interaction, tournament)) {
    return interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral });
  }
  const payload = buildGroupInspectPicker(tournament, roundNum, letter);
  if (payload.error) {
    return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

// Team(s) picked from the group-only list.
async function handleGroupInspectSelect(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && findGroup(tournament, roundNum, letter);
  if (!group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }
  if (!canInspectGroup(interaction, tournament)) {
    return interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral });
  }
  const entries = interaction.values
    .map(v => parseInt(v, 10))
    .filter(i => group.teams[i])
    .slice(0, MAX_CARDS)
    .map(i => ({ roundNum, letter, slot: groupSlotNumber(group, i), team: group.teams[i] }));
  if (!entries.length) {
    return interaction.reply({ content: '❌ Those teams are no longer in this group.', flags: MessageFlags.Ephemeral });
  }
  // A new ephemeral reply, so the picker stays open for checking another team.
  return interaction.reply({
    embeds: entries.map(e => embedFor(tournament, e, null, null)),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  buildInspectPanel, handleInspectUserPick,
  buildGroupInspectRow, handleGroupInspectButton, handleGroupInspectSelect,
};
