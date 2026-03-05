const { EmbedBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig
} = require('../utils/database');

// ── In-memory stores ──────────────────────────────────────────────────────────
const confirmSessions   = new Map();
const persistentSlotIds = new Map();
const teamCardMap       = new Map(); // messageId → { guildId, teamIndex }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPersistentSlotListId(guildId)       { return persistentSlotIds.get(guildId) || {}; }
function setPersistentSlotListId(guildId, data) { persistentSlotIds.set(guildId, { ...getPersistentSlotListId(guildId), ...data }); }
function clearPersistentSlotListIds(guildId)    { persistentSlotIds.delete(guildId); }
function registerTeamCard(messageId, guildId, teamIndex) { teamCardMap.set(messageId, { guildId, teamIndex }); }
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
}
function getConfirmSession(guildId) { return confirmSessions.get(guildId) || null; }

// ── Emoji maps ────────────────────────────────────────────────────────────────
const LOBBY_EMOJIS = { '🅰️':'A', '🅱️':'B', '🇨':'C', '🇩':'D', '🇪':'E', '🇫':'F' };

// ── Circled number emoji display ──────────────────────────────────────────────
const CIRCLED_NUMBERS = [
  '①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳',
  '㉑','㉒','㉓','㉔','㉕'
];
function numEmoji(n) {
  if (n >= 1 && n <= 25) return CIRCLED_NUMBERS[n - 1];
  return String(n);
}

// ── Find next available slot in a lobby (fills gaps in order) ─────────────────
function getNextAvailableSlot(slots, lobbyLetter, settings) {
  const { lobbies: numLobbies, slots: totalSlots, first_slot: firstSlot = 1 } = settings;
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);
  const lastSlot      = firstSlot + slotsPerLobby - 1;
  const taken         = new Set(
    slots.filter(t => t.lobby === lobbyLetter && t.lobby_slot).map(t => t.lobby_slot)
  );
  for (let s = firstSlot; s <= lastSlot; s++) {
    if (!taken.has(s)) return s;
  }
  return null; // full
}

// ── Build team card embed ─────────────────────────────────────────────────────
function buildTeamCardEmbed(team, queueNum) {
  const playerMentions = (team.players || [team.manager_id]).map(id => `<@${id}>`).join(' ');

  if (team.lobby && team.lobby_slot) {
    // Assigned state — show lobby + slot prominently, ❌ instruction
    return new EmbedBuilder()
      .setColor(0x00FF7F)
      .setTitle(`✅ [${team.team_tag}] ${team.team_name}`)
      .setDescription(playerMentions)
      .addFields(
        { name: '🏟️ Lobby', value: `**${team.lobby}**`,               inline: true },
        { name: '🎯 Slot',  value: numEmoji(team.lobby_slot),          inline: true },
        { name: '​',        value: '*React ❌ to remove slot*',         inline: false },
      )
      .setFooter({ text: `Queue #${queueNum}` })
      .setTimestamp();
  }

  // Unassigned state
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`[${team.team_tag}] ${team.team_name}`)
    .setDescription(playerMentions)
    .setFooter({ text: `Queue #${queueNum} — React with lobby letter to assign` })
    .setTimestamp();
}

// ── Build per-lobby slot list embed (posted in each lobby's OWN channel) ──────
function buildLobbySlotList(slots, settings, lobbyLetter) {
  const { lobbies: numLobbies, slots: totalSlots, first_slot: firstSlot = 1 } = settings;
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);

  const lobbyTeams = slots
    .filter(t => t.lobby === lobbyLetter)
    .sort((a, b) => a.lobby_slot - b.lobby_slot);

  const lines = [];
  for (let i = 0; i < slotsPerLobby; i++) {
    const slotNum = firstSlot + i;
    const team    = lobbyTeams.find(t => t.lobby_slot === slotNum);
    const e       = numEmoji(slotNum);
    if (team) {
      const mgr = `<@${team.manager_id || team.captain_id}>`;
      if (team.confirmed === true)       lines.push(`${e} __[${team.team_tag}] ${team.team_name}__ ${mgr}`);
      else if (team.confirmed === false)  lines.push(`${e} ~~[${team.team_tag}] ${team.team_name}~~ ${mgr}`);
      else                               lines.push(`${e} [${team.team_tag}] ${team.team_name} ${mgr}`);
    } else {
      lines.push(`${e}`);
    }
  }

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('Slots')
    .setDescription(lines.join('\n') || '*No teams assigned yet*')
    .setTimestamp();
}

// ── Build overall slot list embed (admin overview) ────────────────────────────
function buildPersistentSlotList(slots, settings, lobbyFilter = null) {
  const { scrim_name, lobbies: numLobbies, slots: totalSlots, first_slot: firstSlot = 1 } = settings;
  const lobbyLetters  = ['A','B','C','D','E','F'].slice(0, numLobbies);
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);
  const toShow        = lobbyFilter ? [lobbyFilter] : lobbyLetters;

  const fields = [];
  for (const letter of toShow) {
    const lobbyTeams = slots.filter(t => t.lobby === letter).sort((a, b) => a.lobby_slot - b.lobby_slot);
    const lines = [];
    for (let i = 0; i < slotsPerLobby; i++) {
      const slotNum = firstSlot + i;
      const team    = lobbyTeams.find(t => t.lobby_slot === slotNum);
      const e       = numEmoji(slotNum);
      if (team) {
        const mgr = `<@${team.manager_id || team.captain_id}>`;
        if (team.confirmed === true)       lines.push(`${e} __[${team.team_tag}] ${team.team_name}__ ${mgr}`);
        else if (team.confirmed === false)  lines.push(`${e} ~~[${team.team_tag}] ${team.team_name}~~ ${mgr}`);
        else                               lines.push(`${e} [${team.team_tag}] ${team.team_name} ${mgr}`);
      } else {
        lines.push(`${e}`);
      }
    }
    fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n') || '*Empty*', inline: false });
  }

  const unassigned = slots.filter(t => !t.lobby);
  if (!lobbyFilter && unassigned.length > 0) {
    fields.push({
      name:  '⏳ Unassigned',
      value: unassigned.map(t => `• [${t.team_tag}] ${t.team_name} <@${t.manager_id || t.captain_id}>`).join('\n'),
      inline: false,
    });
  }

  const assigned    = slots.filter(t => t.lobby).length;
  const unassignedC = slots.length - assigned;
  const title       = lobbyFilter ? `📋 ${scrim_name} — LOBBY ${lobbyFilter}` : `📋 ${scrim_name} — SLOT LIST`;

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(title)
    .addFields(...(fields.length ? fields : [{ name: 'No slots yet', value: '*No teams assigned*' }]));

  if (!lobbyFilter) {
    embed.addFields({ name: '📊', value: `✅ Assigned: **${assigned}** | ⏳ Unassigned: **${unassignedC}** | Total: **${slots.length}**` });
  }
  return embed.setTimestamp();
}

// ── Build confirm slot list ───────────────────────────────────────────────────
function buildConfirmSlotList(slots, settings) {
  const { scrim_name, lobbies: numLobbies } = settings;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);

  const fields = [];
  for (const letter of lobbyLetters) {
    const teams = slots.filter(t => t.lobby === letter).sort((a, b) => a.lobby_slot - b.lobby_slot);
    if (teams.length === 0) continue;
    const lines = teams.map(t => {
      const e   = numEmoji(t.lobby_slot);
      const mgr = `<@${t.manager_id || t.captain_id}>`;
      if (t.confirmed === true)  return `${e} __[${t.team_tag}] ${t.team_name}__ ${mgr}`;
      if (t.confirmed === false) return `${e} ~~[${t.team_tag}] ${t.team_name}~~ ${mgr}`;
      return `${e} [${t.team_tag}] ${t.team_name} ${mgr}`;
    });
    fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n'), inline: true });
  }

  const confirmed = slots.filter(t => t.confirmed === true).length;
  const cancelled = slots.filter(t => t.confirmed === false).length;
  const pending   = slots.filter(t => t.lobby && t.confirmed === undefined).length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 ${scrim_name} — CONFIRM YOUR SLOTS`)
    .addFields(...(fields.length ? fields : [{ name: 'No assignments yet', value: 'Admin must assign slots first.' }]))
    .addFields({ name: '📊', value: `✅ **${confirmed}** confirmed | ❌ **${cancelled}** cancelled | ⏳ **${pending}** pending` })
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

  // ── Team card reactions (admin only) ──────────────────────────────────────
  const cardInfo = teamCardMap.get(message.id);
  if (cardInfo) {
    const config = getConfig(guild.id);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const isAdmin = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    (config.admin_role && member.roles.cache.has(config.admin_role));
    if (!isAdmin) {
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    const data      = getRegistrations(guild.id);
    const settings  = getScrimSettings(guild.id);
    const lobbyConf = getLobbyConfig(guild.id);
    const team      = data.slots[cardInfo.teamIndex];
    if (!team) return;

    // ── ❌ = remove/unassign slot ─────────────────────────────────────────
    if (emoji === '❌') {
      if (!team.lobby) {
        try { await reaction.users.remove(user.id); } catch {}
        return;
      }

      // Strip lobby role from all players
      const lc = lobbyConf[team.lobby];
      if (lc?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lc.role_id).catch(() => {});
          } catch {}
        }
      }

      // Remove the lobby letter reaction visually
      const assignedEmoji = Object.keys(LOBBY_EMOJIS).find(e => LOBBY_EMOJIS[e] === team.lobby);
      if (assignedEmoji) try { await message.reactions.cache.get(assignedEmoji)?.users.remove(user.id); } catch {}

      delete team.lobby;
      delete team.lobby_slot;
      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data);

      // Remove admin's ❌ so it stays clean and ready to use again
      try { await reaction.users.remove(user.id); } catch {}

      await updateTeamCardEmbed(message, team, cardInfo.teamIndex + 1);
      await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
      return;
    }

    // ── Lobby letter = assign to that lobby ──────────────────────────────
    if (!LOBBY_EMOJIS[emoji]) {
      // Ignore anything else
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    const newLobby  = LOBBY_EMOJIS[emoji];
    const prevLobby = team.lobby;

    // If switching lobbies, free old slot and strip old role
    if (prevLobby && prevLobby !== newLobby) {
      if (lobbyConf[prevLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lobbyConf[prevLobby].role_id).catch(() => {});
          } catch {}
        }
      }
      delete team.lobby;
      delete team.lobby_slot;
    }

    // Auto-assign next available slot (fills gaps in order)
    const nextSlot = getNextAvailableSlot(data.slots, newLobby, settings);
    if (nextSlot === null) {
      // Lobby full — remove reaction
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    team.lobby      = newLobby;
    team.lobby_slot = nextSlot;

    // Remove other lobby letter reactions (only keep the assigned one)
    for (const e of Object.keys(LOBBY_EMOJIS)) {
      if (e !== emoji) try { await message.reactions.cache.get(e)?.users.remove(user.id); } catch {}
    }

    // Assign lobby role to all players
    if (lobbyConf[newLobby]?.role_id) {
      for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
        try {
          const m = await guild.members.fetch(playerId);
          await m.roles.add(lobbyConf[newLobby].role_id).catch(() => {});
        } catch {}
      }
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);

    await updateTeamCardEmbed(message, team, cardInfo.teamIndex + 1);
    await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
    return;
  }

  // ── /confirm reactions ────────────────────────────────────────────────────
  const session = getConfirmSession(guild.id);
  if (!session || message.id !== session.confirmMessageId) return;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config    = getConfig(guild.id);
  const settings  = getScrimSettings(guild.id);
  const lobbyConf = getLobbyConfig(guild.id);
  const data      = getRegistrations(guild.id);
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
  await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
}

// ── Handle reaction remove ────────────────────────────────────────────────────
// NOTE: We no longer use reaction REMOVE to unassign — ❌ add is the action.
// This handler only cleans up /confirm reactions.
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

  // /confirm unreact
  const session = getConfirmSession(guild.id);
  if (!session || message.id !== session.confirmMessageId) return;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config    = getConfig(guild.id);
  const settings  = getScrimSettings(guild.id);
  const lobbyConf = getLobbyConfig(guild.id);
  const data      = getRegistrations(guild.id);
  const ti        = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (ti === -1) return;

  if (emoji === '✅' && data.slots[ti].confirmed === true)  delete data.slots[ti].confirmed;
  if (emoji === '❌' && data.slots[ti].confirmed === false) delete data.slots[ti].confirmed;

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
}

// ── Post/update slot list in a lobby's own channel ───────────────────────────
async function postToLobbyChannel(guild, lobbyLetter, lobbyConf, settings, data) {
  const lc = lobbyConf[lobbyLetter];
  if (!lc?.channel_id) return;
  try {
    const ch    = await guild.channels.fetch(lc.channel_id);
    const embed = buildLobbySlotList(data.slots, settings, lobbyLetter);
    const ids   = getPersistentSlotListId(guild.id);
    const key   = `lobby_${lobbyLetter}`;

    if (ids[key]) {
      try {
        const existing = await ch.messages.fetch(ids[key]);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {}
    }

    const msgs     = await ch.messages.fetch({ limit: 20 });
    const existing = msgs.find(m => m.author.bot && m.embeds[0]?.title === 'Slots');
    if (existing) {
      setPersistentSlotListId(guild.id, { [key]: existing.id });
      await existing.edit({ embeds: [embed] });
    } else {
      const newMsg = await ch.send({ embeds: [embed] });
      setPersistentSlotListId(guild.id, { [key]: newMsg.id });
      try { await newMsg.pin(); } catch {}
    }
  } catch (err) {
    console.error(`⚠️ Lobby ${lobbyLetter} channel post error:`, err.message);
  }
}

// ── Refresh all slot lists ────────────────────────────────────────────────────
async function refreshAllSlotLists(guild, config, settings, lobbyConf, data) {
  const ids          = getPersistentSlotListId(guild.id);
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, settings.lobbies || 4);

  // Overall admin overview
  const overallChannelId = config.idpass_channel;
  if (overallChannelId && ids.overall) {
    try {
      const ch  = await guild.channels.fetch(overallChannelId);
      const msg = await ch.messages.fetch(ids.overall);
      await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
    } catch {}
  }

  // Per-lobby channels
  for (const letter of lobbyLetters) {
    const lc  = lobbyConf[letter];
    const key = `lobby_${letter}`;
    if (!lc?.channel_id) continue;
    if (ids[key]) {
      try {
        const ch  = await guild.channels.fetch(lc.channel_id);
        const msg = await ch.messages.fetch(ids[key]);
        await msg.edit({ embeds: [buildLobbySlotList(data.slots, settings, letter)] });
      } catch {
        await postToLobbyChannel(guild, letter, lobbyConf, settings, data);
      }
    } else {
      if (data.slots.some(t => t.lobby === letter)) {
        await postToLobbyChannel(guild, letter, lobbyConf, settings, data);
      }
    }
  }
}

async function refreshConfirmList(guild, session, settings, data) {
  try {
    const ch  = await guild.channels.fetch(session.channelId);
    const msg = await ch.messages.fetch(session.slotListMessageId);
    await msg.edit({ embeds: [buildConfirmSlotList(data.slots, settings)] });
  } catch {}
}

// ── Update team card embed after assignment/unassignment ─────────────────────
async function updateTeamCardEmbed(message, team, queueNum) {
  try {
    await message.edit({ embeds: [buildTeamCardEmbed(team, queueNum)] });
  } catch {}
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  registerTeamCard,
  buildPersistentSlotList,
  buildLobbySlotList,
  buildConfirmSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  clearPersistentSlotListIds,
  refreshAllSlotLists,
  postToLobbyChannel,
};
