const { EmbedBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig
} = require('../utils/database');

// ── In-memory stores ──────────────────────────────────────────────────────────
const confirmSessions   = new Map();
const persistentSlotIds = new Map(); // guildId → { overall: msgId, A: msgId, B: msgId, ... }
const teamCardMap       = new Map(); // messageId → { guildId, teamIndex }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPersistentSlotListId(guildId)       { return persistentSlotIds.get(guildId) || {}; }
function setPersistentSlotListId(guildId, data) { persistentSlotIds.set(guildId, { ...getPersistentSlotListId(guildId), ...data }); }
function registerTeamCard(messageId, guildId, teamIndex) { teamCardMap.set(messageId, { guildId, teamIndex }); }
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
}
function getConfirmSession(guildId) { return confirmSessions.get(guildId) || null; }

// ── Emoji maps ────────────────────────────────────────────────────────────────
const LOBBY_EMOJIS = { '🅰️':'A', '🅱️':'B', '🇨':'C', '🇩':'D', '🇪':'E', '🇫':'F' };
const NUMBER_EMOJIS = {
  '1️⃣':1,'2️⃣':2,'3️⃣':3,'4️⃣':4,'5️⃣':5,
  '6️⃣':6,'7️⃣':7,'8️⃣':8,'9️⃣':9,'🔟':10,
};

// ── Circled number emoji display (① ② ③ ... ㉕) ──────────────────────────────
const CIRCLED_NUMBERS = [
  '①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳',
  '㉑','㉒','㉓','㉔','㉕'
];

function numEmoji(n) {
  if (n >= 1 && n <= 25) return CIRCLED_NUMBERS[n - 1];
  return String(n);
}

// ── Build per-lobby slot list embed (posted in each lobby's OWN channel) ──────
// Format matches screenshot: title "Slots", each line = ① [tag] name @manager
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
    const emoji   = numEmoji(slotNum);

    if (team) {
      const mgr = `<@${team.manager_id || team.captain_id}>`;
      if (team.confirmed === true)
        lines.push(`${emoji} __[${team.team_tag}] ${team.team_name}__ ${mgr}`);
      else if (team.confirmed === false)
        lines.push(`${emoji} ~~[${team.team_tag}] ${team.team_name}~~ ${mgr}`);
      else
        lines.push(`${emoji} [${team.team_tag}] ${team.team_name} ${mgr}`);
    } else {
      lines.push(`${emoji}`);
    }
  }

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('Slots')
    .setDescription(lines.join('\n') || '*No teams assigned yet*')
    .setTimestamp();
}

// ── Build overall slot list embed (admin overview — all lobbies combined) ──────
function buildPersistentSlotList(slots, settings, lobbyFilter = null) {
  const { scrim_name, lobbies: numLobbies, slots: totalSlots, first_slot: firstSlot = 1 } = settings;
  const lobbyLetters  = ['A','B','C','D','E','F'].slice(0, numLobbies);
  const slotsPerLobby = Math.ceil(totalSlots / numLobbies);
  const toShow        = lobbyFilter ? [lobbyFilter] : lobbyLetters;

  const fields = [];
  for (const letter of toShow) {
    const lobbyTeams = slots
      .filter(t => t.lobby === letter)
      .sort((a, b) => a.lobby_slot - b.lobby_slot);

    const lines = [];
    for (let i = 0; i < slotsPerLobby; i++) {
      const slotNum = firstSlot + i;
      const team    = lobbyTeams.find(t => t.lobby_slot === slotNum);
      const emoji   = numEmoji(slotNum);

      if (team) {
        const mgr = `<@${team.manager_id || team.captain_id}>`;
        if (team.confirmed === true)
          lines.push(`${emoji} __[${team.team_tag}] ${team.team_name}__ ${mgr}`);
        else if (team.confirmed === false)
          lines.push(`${emoji} ~~[${team.team_tag}] ${team.team_name}~~ ${mgr}`);
        else
          lines.push(`${emoji} [${team.team_tag}] ${team.team_name} ${mgr}`);
      } else {
        lines.push(`${emoji}`);
      }
    }
    fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n') || '*Empty*', inline: false });
  }

  // Unassigned teams
  const unassigned = slots.filter(t => !t.lobby);
  if (!lobbyFilter && unassigned.length > 0) {
    fields.push({
      name: '⏳ Unassigned',
      value: unassigned.map(t => `• [${t.team_tag}] ${t.team_name} <@${t.manager_id || t.captain_id}>`).join('\n'),
      inline: false,
    });
  }

  const title       = lobbyFilter ? `📋 ${scrim_name} — LOBBY ${lobbyFilter}` : `📋 ${scrim_name} — SLOT LIST`;
  const assigned    = slots.filter(t => t.lobby).length;
  const unassignedC = slots.length - assigned;

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
    const teams = slots
      .filter(t => t.lobby === letter)
      .sort((a, b) => a.lobby_slot - b.lobby_slot);
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

  // ── ADMIN assigning slot on team card ─────────────────────────────────────
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

    const prevLobby = team.lobby;

    if (LOBBY_EMOJIS[emoji]) {
      const newLobby = LOBBY_EMOJIS[emoji];

      // Remove old lobby role if switching
      if (prevLobby && prevLobby !== newLobby && lobbyConf[prevLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lobbyConf[prevLobby].role_id).catch(() => {});
          } catch {}
        }
      }

      team.lobby = newLobby;

      // Remove other lobby reactions
      for (const e of Object.keys(LOBBY_EMOJIS)) {
        if (e !== emoji) try { await message.reactions.cache.get(e)?.users.remove(user.id); } catch {}
      }

      // Assign new lobby role to all players
      if (lobbyConf[newLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.add(lobbyConf[newLobby].role_id).catch(() => {});
          } catch {}
        }
      }

    } else if (NUMBER_EMOJIS[emoji] !== undefined) {
      team.lobby_slot = NUMBER_EMOJIS[emoji];
      for (const e of Object.keys(NUMBER_EMOJIS)) {
        if (e !== emoji) try { await message.reactions.cache.get(e)?.users.remove(user.id); } catch {}
      }
    } else {
      return;
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);

    await updateTeamCardEmbed(message, team);
    await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
    return;
  }

  // ── TEAM confirming on /confirm message ───────────────────────────────────
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

  const cardInfo = teamCardMap.get(message.id);
  if (cardInfo) {
    const config  = getConfig(guild.id);
    const member  = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const isAdmin = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    (config.admin_role && member.roles.cache.has(config.admin_role));
    if (!isAdmin) return;

    const data      = getRegistrations(guild.id);
    const settings  = getScrimSettings(guild.id);
    const lobbyConf = getLobbyConfig(guild.id);
    const team      = data.slots[cardInfo.teamIndex];
    if (!team) return;

    if (LOBBY_EMOJIS[emoji] && team.lobby === LOBBY_EMOJIS[emoji]) {
      const lc = lobbyConf[team.lobby];
      if (lc?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lc.role_id).catch(() => {});
          } catch {}
        }
      }
      delete team.lobby;
      delete team.lobby_slot;
    } else if (NUMBER_EMOJIS[emoji] !== undefined && team.lobby_slot === NUMBER_EMOJIS[emoji]) {
      delete team.lobby_slot;
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);
    await updateTeamCardEmbed(message, team);
    await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
    return;
  }

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

// ── Post/update slot list in a single lobby's own channel ────────────────────
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

    // Search for existing bot message with "Slots" title
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

  // Overall admin overview (idpass_channel — all lobbies combined)
  const overallChannelId = config.idpass_channel;
  if (overallChannelId && ids.overall) {
    try {
      const ch  = await guild.channels.fetch(overallChannelId);
      const msg = await ch.messages.fetch(ids.overall);
      await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
    } catch {}
  }

  // Each lobby updates its OWN channel independently
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
        // Message gone — post fresh
        await postToLobbyChannel(guild, letter, lobbyConf, settings, data);
      }
    } else {
      // Only post if this lobby has at least one team assigned
      const hasTeams = data.slots.some(t => t.lobby === letter);
      if (hasTeams) {
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

async function updateTeamCardEmbed(message, team) {
  try {
    const old = message.embeds[0];
    if (!old) return;
    const lobbyText = team.lobby
      ? `Lobby **${team.lobby}**${team.lobby_slot ? ` — Slot **${team.lobby_slot}**` : ' *(slot pending)*'}`
      : '*(unassigned)*';
    const updated = EmbedBuilder.from(old)
      .setColor(team.lobby && team.lobby_slot ? 0x00FF7F : 0x5865F2)
      .setFooter({ text: `${old.footer?.text?.split(' |')[0] || ''} | ${lobbyText}` });
    await message.edit({ embeds: [updated] });
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
  refreshAllSlotLists,
  postToLobbyChannel,
};
