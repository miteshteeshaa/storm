const { EmbedBuilder } = require('discord.js');
const { getConfig, getRegistrations, setRegistrations, getScrimSettings } = require('../utils/database');

// ── In-memory stores ──────────────────────────────────────────────────────────
const confirmSessions   = new Map(); // guildId → { confirmMessageId, channelId, slotListMessageId }
const persistentSlotIds = new Map(); // guildId → messageId of always-visible slot list
const teamCardMap       = new Map(); // messageId → { guildId, teamIndex } for admin slot assignment

// ── Persistent slot list helpers ──────────────────────────────────────────────
function getPersistentSlotListId(guildId)        { return persistentSlotIds.get(guildId) || null; }
function setPersistentSlotListId(guildId, msgId) { persistentSlotIds.set(guildId, msgId); }

// ── Team card map (links message → team) ─────────────────────────────────────
function registerTeamCard(messageId, guildId, teamIndex) {
  teamCardMap.set(messageId, { guildId, teamIndex });
}

// ── Confirm session helpers ───────────────────────────────────────────────────
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
}
function getConfirmSession(guildId) { return confirmSessions.get(guildId) || null; }

// ── Lobby letters ─────────────────────────────────────────────────────────────
const LOBBY_EMOJIS = {
  '🅰️': 'A',
  '🅱️': 'B',
  '🇨':  'C',
  '🇩':  'D',
  '🇪':  'E',
  '🇫':  'F',
};

const NUMBER_EMOJIS = {
  '1️⃣': 1, '2️⃣': 2, '3️⃣': 3, '4️⃣': 4, '5️⃣': 5,
  '6️⃣': 6, '7️⃣': 7, '8️⃣': 8, '9️⃣': 9, '🔟': 10,
};

// ── Number emoji display ──────────────────────────────────────────────────────
function numEmoji(n) {
  const map = {
    0:'0️⃣',1:'1️⃣',2:'2️⃣',3:'3️⃣',4:'4️⃣',5:'5️⃣',
    6:'6️⃣',7:'7️⃣',8:'8️⃣',9:'9️⃣',10:'🔟',
  };
  if (map[n]) return map[n];
  return String(n).split('').map(d => map[parseInt(d)] || d).join('');
}

// ── Build the persistent slot list (idpass channel) ───────────────────────────
// Groups by lobby, shows assigned teams with their slot number
function buildPersistentSlotList(slots, settings) {
  const { scrim_name, lobbies: numLobbies, slots: totalSlots, first_slot } = settings;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);

  // Group assigned teams by lobby
  const lobbyGroups = {};
  for (const letter of lobbyLetters) lobbyGroups[letter] = [];

  for (const team of slots) {
    if (team.lobby && team.lobby_slot && lobbyGroups[team.lobby]) {
      lobbyGroups[team.lobby].push(team);
    }
  }

  const fields = [];
  for (const letter of lobbyLetters) {
    const teams = lobbyGroups[letter].sort((a, b) => a.lobby_slot - b.lobby_slot);
    const lines = [];

    for (let s = 1; s <= slotsPerLobby; s++) {
      const team = teams.find(t => t.lobby_slot === s);
      const emoji = numEmoji(s);
      if (team) {
        if (team.confirmed === true)       lines.push(`${emoji} __[${team.team_tag}] ${team.team_name}__ <@${team.manager_id || team.captain_id}>`);
        else if (team.confirmed === false) lines.push(`${emoji} ~~[${team.team_tag}] ${team.team_name}~~ <@${team.manager_id || team.captain_id}>`);
        else                               lines.push(`${emoji} [${team.team_tag}] ${team.team_name} <@${team.manager_id || team.captain_id}>`);
      } else {
        lines.push(`${emoji}`);
      }
    }

    fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n'), inline: true });
  }

  // Unassigned teams
  const unassigned = slots.filter(t => !t.lobby);
  if (unassigned.length > 0) {
    fields.push({
      name: '⏳ Unassigned',
      value: unassigned.map(t => `• [${t.team_tag}] ${t.team_name} <@${t.manager_id || t.captain_id}>`).join('\n'),
      inline: false,
    });
  }

  const assigned   = slots.filter(t => t.lobby).length;
  const unassignedCount = slots.length - assigned;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 ${scrim_name} — SLOT LIST`)
    .addFields(...fields)
    .addFields({
      name: '📊 Status',
      value: `✅ Assigned: **${assigned}** | ⏳ Unassigned: **${unassignedCount}** | Total: **${slots.length}**`,
    })
    .setTimestamp();
}

// ── Build confirm slot list ───────────────────────────────────────────────────
function buildConfirmSlotList(slots, settings) {
  const { scrim_name, lobbies: numLobbies, slots: totalSlots } = settings;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);

  const lobbyGroups = {};
  for (const letter of lobbyLetters) lobbyGroups[letter] = [];
  for (const team of slots) {
    if (team.lobby && lobbyGroups[team.lobby]) lobbyGroups[team.lobby].push(team);
  }

  const fields = [];
  for (const letter of lobbyLetters) {
    const teams = lobbyGroups[letter].sort((a, b) => a.lobby_slot - b.lobby_slot);
    const lines = teams.map(t => {
      const emoji = numEmoji(t.lobby_slot);
      const mgr   = `<@${t.manager_id || t.captain_id}>`;
      if (t.confirmed === true)       return `${emoji} __[${t.team_tag}] ${t.team_name}__ ${mgr}`;
      if (t.confirmed === false)      return `${emoji} ~~[${t.team_tag}] ${t.team_name}~~ ${mgr}`;
      return `${emoji} [${t.team_tag}] ${t.team_name} ${mgr}`;
    });
    if (lines.length > 0) fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n'), inline: true });
  }

  const confirmed = slots.filter(t => t.confirmed === true).length;
  const cancelled = slots.filter(t => t.confirmed === false).length;
  const pending   = slots.filter(t => t.lobby && t.confirmed === undefined).length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 ${scrim_name} — CONFIRM YOUR SLOTS`)
    .addFields(...(fields.length > 0 ? fields : [{ name: 'No assigned teams yet', value: 'Admin must assign slots first.' }]))
    .addFields({ name: '📊 Status', value: `✅ **${confirmed}** confirmed | ❌ **${cancelled}** cancelled | ⏳ **${pending}** pending` })
    .setTimestamp();
}

// ── Handle reaction add ───────────────────────────────────────────────────────
async function handleReactionAdd(reaction, user) {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild   = message.guild;
  if (!guild) return;

  const emoji = reaction.emoji.name;

  // ── ADMIN: assigning lobby/slot on a team card ────────────────────────────
  const cardInfo = teamCardMap.get(message.id);
  if (cardInfo) {
    // Check if reactor is admin
    const config = getConfig(guild.id);
    if (!config.admin_role) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const isAdmin = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    member.roles.cache.has(config.admin_role);
    if (!isAdmin) {
      // Non-admin reacted — remove their reaction silently
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    const data     = getRegistrations(guild.id);
    const settings = getScrimSettings(guild.id);
    const team     = data.slots[cardInfo.teamIndex];
    if (!team) return;

    if (LOBBY_EMOJIS[emoji]) {
      // Admin assigned a lobby letter
      team.lobby = LOBBY_EMOJIS[emoji];
      // Remove other lobby reactions by admin
      for (const [e, l] of Object.entries(LOBBY_EMOJIS)) {
        if (e !== emoji) {
          try { await message.reactions.cache.get(e)?.users.remove(user.id); } catch {}
        }
      }
    } else if (NUMBER_EMOJIS[emoji] !== undefined) {
      // Admin assigned a slot number
      team.lobby_slot = NUMBER_EMOJIS[emoji];
      // Remove other number reactions by admin
      for (const [e] of Object.entries(NUMBER_EMOJIS)) {
        if (e !== emoji) {
          try { await message.reactions.cache.get(e)?.users.remove(user.id); } catch {}
        }
      }
    } else {
      return; // Not a relevant emoji
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);

    // Update team card embed to show assigned lobby+slot
    await updateTeamCardEmbed(message, team);

    // Update persistent slot list
    await refreshPersistentList(guild, config, settings, data);
    return;
  }

  // ── TEAM CONFIRM: reacting on confirm message ─────────────────────────────
  const session = getConfirmSession(guild.id);
  if (!session || message.id !== session.confirmMessageId) return;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config   = getConfig(guild.id);
  const settings = getScrimSettings(guild.id);
  const data     = getRegistrations(guild.id);

  const teamIndex = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (teamIndex === -1) return;

  if (emoji === '✅') {
    data.slots[teamIndex].confirmed = true;
    try { await message.reactions.cache.get('❌')?.users.remove(user.id); } catch {}
  } else {
    data.slots[teamIndex].confirmed = false;
    try { await message.reactions.cache.get('✅')?.users.remove(user.id); } catch {}
  }

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshPersistentList(guild, config, settings, data);
}

// ── Handle reaction remove ────────────────────────────────────────────────────
async function handleReactionRemove(reaction, user) {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild   = message.guild;
  if (!guild) return;

  const emoji = reaction.emoji.name;

  // ── ADMIN removing lobby/slot assignment ──────────────────────────────────
  const cardInfo = teamCardMap.get(message.id);
  if (cardInfo) {
    const config = getConfig(guild.id);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const isAdmin = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    (config.admin_role && member.roles.cache.has(config.admin_role));
    if (!isAdmin) return;

    const data     = getRegistrations(guild.id);
    const settings = getScrimSettings(guild.id);
    const team     = data.slots[cardInfo.teamIndex];
    if (!team) return;

    if (LOBBY_EMOJIS[emoji] && team.lobby === LOBBY_EMOJIS[emoji]) {
      delete team.lobby;
      delete team.lobby_slot;
    } else if (NUMBER_EMOJIS[emoji] !== undefined && team.lobby_slot === NUMBER_EMOJIS[emoji]) {
      delete team.lobby_slot;
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);
    await updateTeamCardEmbed(message, team);
    await refreshPersistentList(guild, config, settings, data);
    return;
  }

  // ── TEAM removing confirm reaction ────────────────────────────────────────
  const session = getConfirmSession(guild.id);
  if (!session || message.id !== session.confirmMessageId) return;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config   = getConfig(guild.id);
  const settings = getScrimSettings(guild.id);
  const data     = getRegistrations(guild.id);
  const teamIndex = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (teamIndex === -1) return;

  if (emoji === '✅' && data.slots[teamIndex].confirmed === true)  delete data.slots[teamIndex].confirmed;
  if (emoji === '❌' && data.slots[teamIndex].confirmed === false) delete data.slots[teamIndex].confirmed;

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshPersistentList(guild, config, settings, data);
}

// ── Update team card embed to show current assignment ────────────────────────
async function updateTeamCardEmbed(message, team) {
  try {
    const old    = message.embeds[0];
    if (!old) return;

    const lobbyText = team.lobby
      ? `Lobby **${team.lobby}** ${team.lobby_slot ? `— Slot **${team.lobby_slot}**` : '*(slot pending)*'}`
      : '*(unassigned)*';

    const updated = EmbedBuilder.from(old)
      .setColor(team.lobby && team.lobby_slot ? 0x00FF7F : 0x5865F2)
      .setFooter({ text: `${old.footer?.text || ''} | ${lobbyText}` });

    await message.edit({ embeds: [updated] });
  } catch {}
}

// ── Refresh confirm list message ──────────────────────────────────────────────
async function refreshConfirmList(guild, session, settings, data) {
  try {
    const ch  = await guild.channels.fetch(session.channelId);
    const msg = await ch.messages.fetch(session.slotListMessageId);
    await msg.edit({ embeds: [buildConfirmSlotList(data.slots, settings)] });
  } catch {}
}

// ── Refresh persistent slot list ──────────────────────────────────────────────
async function refreshPersistentList(guild, config, settings, data) {
  const channelId  = config.idpass_channel || config.slotlist_channel;
  const existingId = getPersistentSlotListId(guild.id);
  if (!channelId || !existingId) return;
  try {
    const ch  = await guild.channels.fetch(channelId);
    const msg = await ch.messages.fetch(existingId);
    await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
  } catch {}
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  registerTeamCard,
  buildPersistentSlotList,
  buildConfirmSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  refreshPersistentList,
};
