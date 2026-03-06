const { EmbedBuilder } = require('discord.js');
const { syncTeamsToSheet } = require('../utils/sheets');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig
} = require('../utils/database');

// ── In-memory stores ──────────────────────────────────────────────────────────
const persistentSlotIds = new Map(); // guildId → { overall: msgId, lobby_A: msgId, ... }
const teamCardMap       = new Map(); // messageId → { guildId, teamIndex }
const confirmSessions   = new Map();

// ── Exports for other modules ─────────────────────────────────────────────────
function getPersistentSlotListId(guildId)       { return persistentSlotIds.get(guildId) || {}; }
function setPersistentSlotListId(guildId, data) { persistentSlotIds.set(guildId, { ...getPersistentSlotListId(guildId), ...data }); }
function registerTeamCard(messageId, guildId, teamIndex) { teamCardMap.set(messageId, { guildId, teamIndex }); }
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
}
function getConfirmSession(guildId) { return confirmSessions.get(guildId) || null; }

// ── Lobby emoji → letter map (A–J) ────────────────────────────────────────────
const LOBBY_EMOJIS = {
  '🅐':'A','🅑':'B','🅒':'C','🅓':'D','🅔':'E',
  '🅕':'F','🅖':'G','🅗':'H','🅘':'I','🅙':'J',
};

// ── Number emoji builder ──────────────────────────────────────────────────────
function numEmoji(n) {
  const digits = { 0:'0️⃣',1:'1️⃣',2:'2️⃣',3:'3️⃣',4:'4️⃣',5:'5️⃣',6:'6️⃣',7:'7️⃣',8:'8️⃣',9:'9️⃣' };
  const basic  = {1:'1️⃣',2:'2️⃣',3:'3️⃣',4:'4️⃣',5:'5️⃣',6:'6️⃣',7:'7️⃣',8:'8️⃣',9:'9️⃣',10:'🔟'};
  if (basic[n]) return basic[n];
  return String(n).split('').map(d => digits[parseInt(d)] || d).join('');
}

// ── Get next available slot in a lobby ───────────────────────────────────────
function getNextSlot(slots, lobby, settings) {
  const first         = settings.first_slot || 1;
  const slotsPerLobby = settings.slots_per_lobby || 24;
  const used          = new Set(slots.filter(t => t.lobby === lobby).map(t => t.lobby_slot));
  for (let s = first; s < first + slotsPerLobby; s++) {
    if (!used.has(s)) return s;
  }
  return null; // lobby full
}

// ── Build slot list embed ─────────────────────────────────────────────────────
function buildPersistentSlotList(slots, settings, lobbyFilter = null) {
  const { scrim_name, lobbies: numLobbies, slots_per_lobby, first_slot = 1 } = settings;
  const lobbyLetters  = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
  const slotsPerLobby = slots_per_lobby || 24;

  const lobbyGroups = {};
  for (const l of lobbyLetters) lobbyGroups[l] = [];
  for (const t of slots) {
    if (t.lobby && lobbyGroups[t.lobby]) lobbyGroups[t.lobby].push(t);
  }

  const toShow = lobbyFilter ? [lobbyFilter] : lobbyLetters;
  const fields = [];

  for (const letter of toShow) {
    const teams = (lobbyGroups[letter] || []).sort((a, b) => a.lobby_slot - b.lobby_slot);
    const lines = [];
    for (let s = first_slot; s < first_slot + slotsPerLobby; s++) {
      const team  = teams.find(t => t.lobby_slot === s);
      const emoji = numEmoji(s);
      if (team) {
        const mgr = `<@${team.manager_id || team.captain_id}>`;
        lines.push(`${emoji} [${team.team_tag}] ${team.team_name} ${mgr}`);
      } else {
        lines.push(`${emoji}`);
      }
    }
    fields.push({ name: `🏟️ Lobby ${letter}`, value: lines.join('\n') || '*Empty*', inline: !lobbyFilter });
  }

  const unassigned = slots.filter(t => !t.lobby);
  if (!lobbyFilter && unassigned.length > 0) {
    fields.push({
      name: '⏳ Unassigned',
      value: unassigned.map(t => `• [${t.team_tag}] ${t.team_name} <@${t.manager_id || t.captain_id}>`).join('\n'),
      inline: false,
    });
  }

  const title    = lobbyFilter ? `📋 ${scrim_name} — LOBBY ${lobbyFilter}` : `📋 ${scrim_name} — SLOT LIST`;
  const assigned = slots.filter(t => t.lobby).length;

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(title)
    .addFields(...fields);

  if (!lobbyFilter) {
    embed.addFields({ name: '📊', value: `✅ Assigned: **${assigned}** | ⏳ Unassigned: **${unassigned.length}** | Total: **${slots.length}**` });
  }

  return embed.setTimestamp();
}

// ── Build confirm slot list ───────────────────────────────────────────────────
function buildConfirmSlotList(slots, settings) {
  const { scrim_name, lobbies: numLobbies } = settings;
  const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);

  const lobbyGroups = {};
  for (const l of lobbyLetters) lobbyGroups[l] = [];
  for (const t of slots) { if (t.lobby && lobbyGroups[t.lobby]) lobbyGroups[t.lobby].push(t); }

  const fields = [];
  for (const letter of lobbyLetters) {
    const teams = lobbyGroups[letter].sort((a, b) => a.lobby_slot - b.lobby_slot);
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

// ── Update team card after assignment ─────────────────────────────────────────
async function updateTeamCard(message, team) {
  try {
    const old = message.embeds[0];
    if (!old) return;

    const builder = EmbedBuilder.from(old);

    if (team.lobby && team.lobby_slot !== undefined) {
      builder
        .setColor(0x00FF7F)
        .setFooter({ text: `Lobby ${team.lobby} · ${numEmoji(team.lobby_slot)}  (slot ${team.lobby_slot})` });
    } else {
      builder
        .setColor(0x5865F2)
        .setFooter({ text: old.footer?.text?.split(' |')[0] || '' });
    }

    await message.edit({ embeds: [builder] });

    // ❌ appears only after slot assigned
    if (team.lobby && team.lobby_slot !== undefined) {
      if (!message.reactions.cache.has('❌')) {
        try { await message.react('❌'); } catch {}
      }
    } else {
      try { await message.reactions.cache.get('❌')?.remove(); } catch {}
    }
  } catch (err) {
    console.error('updateTeamCard error:', err.message);
  }
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

  // ── Team card ─────────────────────────────────────────────────────────────
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

    // ── ❌ = remove from slot list ───────────────────────────────────────
    if (emoji === '❌') {
      const prevLobby = team.lobby;

      if (prevLobby && lobbyConf[prevLobby]?.role_id) {
        for (const pid of [...new Set([team.captain_id, team.manager_id, ...(team.players || [])])].filter(Boolean)) {
          try { const m = await guild.members.fetch(pid); await m.roles.remove(lobbyConf[prevLobby].role_id).catch(() => {}); } catch {}
        }
      }

      delete team.lobby;
      delete team.lobby_slot;
      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data);

      await updateTeamCard(message, team);

      // Remove all lobby reactions then re-add so admin can reassign
      for (const e of Object.keys(LOBBY_EMOJIS)) {
        try { await message.reactions.cache.get(e)?.remove(); } catch {}
      }
      const numLobbies  = settings.lobbies || 4;
      const lobbyEmojis = Object.keys(LOBBY_EMOJIS).slice(0, numLobbies);
      for (const e of lobbyEmojis) { try { await message.react(e); } catch {} }

      await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
      await syncSheet(guild, config, data);
      return;
    }

    // ── Lobby letter = instant assign next slot ──────────────────────────
    if (LOBBY_EMOJIS[emoji]) {
      const newLobby  = LOBBY_EMOJIS[emoji];
      const prevLobby = team.lobby;

      // Strip old lobby role
      if (prevLobby && prevLobby !== newLobby && lobbyConf[prevLobby]?.role_id) {
        for (const pid of [...new Set([team.captain_id, team.manager_id, ...(team.players || [])])].filter(Boolean)) {
          try { const m = await guild.members.fetch(pid); await m.roles.remove(lobbyConf[prevLobby].role_id).catch(() => {}); } catch {}
        }
      }

      const nextSlot = getNextSlot(data.slots, newLobby, settings);
      if (nextSlot === null) {
        try { await reaction.users.remove(user.id); } catch {}
        return;
      }

      team.lobby      = newLobby;
      team.lobby_slot = nextSlot;
      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data);

      // Remove other lobby letter reactions
      for (const e of Object.keys(LOBBY_EMOJIS)) {
        if (e !== emoji) { try { await message.reactions.cache.get(e)?.remove(); } catch {} }
      }

      // Give lobby role
      if (lobbyConf[newLobby]?.role_id) {
        for (const pid of [...new Set([team.captain_id, team.manager_id, ...(team.players || [])])].filter(Boolean)) {
          try { const m = await guild.members.fetch(pid); await m.roles.add(lobbyConf[newLobby].role_id).catch(() => {}); } catch {}
        }
      }

      await updateTeamCard(message, team);
      await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
      await postToLobbyChannel(guild, team, lobbyConf, settings, data);
      await syncSheet(guild, config, data);
    }

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
  const ti        = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (ti === -1) return;

  if (emoji === '✅') {
    data.slots[ti].confirmed = true;
    try { await message.reactions.cache.get('❌')?.users.remove(user.id); } catch {}
  } else {
    data.slots[ti].confirmed = false;
    try { await message.reactions.cache.get('✅')?.users.remove(user.id); } catch {}
  }

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
  await syncSheet(guild, config, data);
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

  const session = getConfirmSession(guild.id);
  if (!session || message.id !== session.confirmMessageId) return;

  const emoji = reaction.emoji.name;
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
  await syncSheet(guild, config, data);
}

// ── Post/update slot list in lobby channel ────────────────────────────────────
async function postToLobbyChannel(guild, team, lobbyConf, settings, data) {
  const lc = lobbyConf[team.lobby];
  if (!lc?.channel_id) return;
  try {
    const ch     = await guild.channels.fetch(lc.channel_id);
    const embed  = buildPersistentSlotList(data.slots, settings, team.lobby);
    const ids    = getPersistentSlotListId(guild.id);
    const msgKey = `lobby_${team.lobby}`;

    if (ids[msgKey]) {
      try {
        const existing = await ch.messages.fetch(ids[msgKey]);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {}
    }

    const newMsg = await ch.send({ embeds: [embed] });
    setPersistentSlotListId(guild.id, { [msgKey]: newMsg.id });
    try { await newMsg.pin(); } catch {}
  } catch (err) {
    console.error('postToLobbyChannel error:', err.message);
  }
}

// ── Refresh all slot lists ────────────────────────────────────────────────────
async function refreshAllSlotLists(guild, config, settings, lobbyConf, data) {
  const ids              = getPersistentSlotListId(guild.id);
  const overallChannelId = config.idpass_channel || config.slotlist_channel;

  if (overallChannelId && ids.overall) {
    try {
      const ch  = await guild.channels.fetch(overallChannelId);
      const msg = await ch.messages.fetch(ids.overall);
      await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
    } catch {}
  }

  const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, settings.lobbies || 4);
  for (const letter of lobbyLetters) {
    const lc     = lobbyConf[letter];
    const msgKey = `lobby_${letter}`;
    if (!lc?.channel_id || !ids[msgKey]) continue;
    try {
      const ch  = await guild.channels.fetch(lc.channel_id);
      const msg = await ch.messages.fetch(ids[msgKey]);
      await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings, letter)] });
    } catch {}
  }
}

async function refreshConfirmList(guild, session, settings, data) {
  try {
    const ch  = await guild.channels.fetch(session.channelId);
    const msg = await ch.messages.fetch(session.slotListMessageId);
    await msg.edit({ embeds: [buildConfirmSlotList(data.slots, settings)] });
  } catch {}
}

async function syncSheet(guild, config, data) {
  try {
    if (config.spreadsheet_id) {
      await syncTeamsToSheet(config.spreadsheet_id, data.slots || []);
    }
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
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
  refreshAllSlotLists,
};
