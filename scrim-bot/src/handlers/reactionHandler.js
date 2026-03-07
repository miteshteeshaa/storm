const { EmbedBuilder } = require('discord.js');
const { syncTeamsToSheet } = require('../utils/sheets');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig,
  getConfirmSessions: dbGetConfirmSessions, setConfirmSessions: dbSetConfirmSessions,
  getSlotListIds, setSlotListIds,
  getTeamCards, setTeamCard,
} = require('../utils/database');

// ── Confirm sessions — persisted to disk ──────────────────────────────────────
function registerConfirmSession(guildId, confirmMessageId, channelId, lobbyLetter) {
  const existing = dbGetConfirmSessions(guildId);
  const idx = existing.findIndex(s => s.channelId === channelId);
  const session = { confirmMessageId, channelId, lobbyLetter };
  if (idx >= 0) existing[idx] = session;
  else existing.push(session);
  dbSetConfirmSessions(guildId, existing);
}
function getConfirmSessions(guildId) { return dbGetConfirmSessions(guildId); }
function getConfirmSession(guildId)  { return getConfirmSessions(guildId)[0] || null; }

// ── Slot list message IDs — persisted to disk ─────────────────────────────────
function getPersistentSlotListId(guildId)       { return getSlotListIds(guildId); }
function setPersistentSlotListId(guildId, data) { setSlotListIds(guildId, data); }

// ── Team card map — persisted to disk so restarts don't lose card→team mapping ─
function registerTeamCard(messageId, guildId, teamIndex) {
  setTeamCard(guildId, messageId, teamIndex);
}
function lookupTeamCard(messageId, guildId) {
  const cards = getTeamCards(guildId);
  if (cards[messageId] !== undefined) return { guildId, teamIndex: cards[messageId] };
  return null;
}

// ── Emoji maps ────────────────────────────────────────────────────────────────
// Regional indicator letters A–J → lobby letter
const LOBBY_EMOJIS = {
  '🇦': 'A', '🇧': 'B', '🇨': 'C', '🇩': 'D', '🇪': 'E',
  '🇫': 'F', '🇬': 'G', '🇭': 'H', '🇮': 'I', '🇯': 'J',
};
const LOBBY_EMOJI_LIST = ['🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯'];

// Maps custom emoji name → slot number (1-30)
// ⚠️ After uploading the emoji pack to your Discord server, replace each ID below
// with the actual Discord emoji ID (right-click emoji → Copy ID in developer mode)
const SLOT_EMOJIS = {
  'num_01': 1,  'num_02': 2,  'num_03': 3,  'num_04': 4,  'num_05': 5,
  'num_06': 6,  'num_07': 7,  'num_08': 8,  'num_09': 9,  'num_10': 10,
  'num_11': 11, 'num_12': 12, 'num_13': 13, 'num_14': 14, 'num_15': 15,
  'num_16': 16, 'num_17': 17, 'num_18': 18, 'num_19': 19, 'num_20': 20,
  'num_21': 21, 'num_22': 22, 'num_23': 23, 'num_24': 24, 'num_25': 25,
  'num_26': 26, 'num_27': 27, 'num_28': 28, 'num_29': 29, 'num_30': 30,
};

// Emoji IDs for reacting on team cards — must match SLOT_EMOJIS names above
// Format: { name, id } where id is the Discord snowflake from your server
// ⚠️ Fill in these IDs after uploading the emoji pack to your Discord server
const SLOT_EMOJI_LIST = [
  { name: 'num_01', id: 'REPLACE_ME' },
  { name: 'num_02', id: 'REPLACE_ME' },
  { name: 'num_03', id: 'REPLACE_ME' },
  { name: 'num_04', id: 'REPLACE_ME' },
  { name: 'num_05', id: 'REPLACE_ME' },
  { name: 'num_06', id: 'REPLACE_ME' },
  { name: 'num_07', id: 'REPLACE_ME' },
  { name: 'num_08', id: 'REPLACE_ME' },
  { name: 'num_09', id: 'REPLACE_ME' },
  { name: 'num_10', id: 'REPLACE_ME' },
  { name: 'num_11', id: 'REPLACE_ME' },
  { name: 'num_12', id: 'REPLACE_ME' },
  { name: 'num_13', id: 'REPLACE_ME' },
  { name: 'num_14', id: 'REPLACE_ME' },
  { name: 'num_15', id: 'REPLACE_ME' },
  { name: 'num_16', id: 'REPLACE_ME' },
  { name: 'num_17', id: 'REPLACE_ME' },
  { name: 'num_18', id: 'REPLACE_ME' },
  { name: 'num_19', id: 'REPLACE_ME' },
  { name: 'num_20', id: 'REPLACE_ME' },
  { name: 'num_21', id: 'REPLACE_ME' },
  { name: 'num_22', id: 'REPLACE_ME' },
  { name: 'num_23', id: 'REPLACE_ME' },
  { name: 'num_24', id: 'REPLACE_ME' },
  { name: 'num_25', id: 'REPLACE_ME' },
  { name: 'num_26', id: 'REPLACE_ME' },
  { name: 'num_27', id: 'REPLACE_ME' },
  { name: 'num_28', id: 'REPLACE_ME' },
  { name: 'num_29', id: 'REPLACE_ME' },
  { name: 'num_30', id: 'REPLACE_ME' },
];

// Unicode circled numbers for slot display (works in every server, no custom emojis needed)
const SLOT_DISPLAY = {
   1: '①',  2: '②',  3: '③',  4: '④',  5: '⑤',
   6: '⑥',  7: '⑦',  8: '⑧',  9: '⑨', 10: '⑩',
  11: '⑪', 12: '⑫', 13: '⑬', 14: '⑭', 15: '⑮',
  16: '⑯', 17: '⑰', 18: '⑱', 19: '⑲', 20: '⑳',
  21: '㉑', 22: '㉒', 23: '㉓', 24: '㉔', 25: '㉕',
};

function numEmoji(n) {
  return SLOT_DISPLAY[n] || `**${n}**`;
}

// ── Find the next available slot in a lobby ───────────────────────────────────
// Returns the lowest slot number not already taken. Fills gaps first.
function nextAvailableSlot(slots, lobby, settings) {
  const first         = settings.first_slot || 1;
  const slotsPerLobby = settings.slots_per_lobby || 24;
  const taken         = new Set(
    slots.filter(t => t.lobby === lobby && t.lobby_slot).map(t => t.lobby_slot)
  );
  for (let s = first; s < first + slotsPerLobby; s++) {
    if (!taken.has(s)) return s;
  }
  return null; // lobby is full
}

// ── Build overall/lobby slot list embed ───────────────────────────────────────
function buildPersistentSlotList(slots, settings, lobbyFilter = null) {
  const { scrim_name, lobbies: numLobbies, slots: totalSlots, slots_per_lobby, first_slot = 1 } = settings;
  const lobbyLetters  = ['A','B','C','D','E','F'].slice(0, numLobbies);
  const slotsPerLobby = slots_per_lobby || Math.ceil(totalSlots / numLobbies);

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
        if (team.confirmed === true)       lines.push(`${emoji} __[${team.team_tag}] ${team.team_name}__ ${mgr}`);
        else if (team.confirmed === false)  lines.push(`${emoji} ~~[${team.team_tag}] ${team.team_name}~~ ${mgr}`);
        else                               lines.push(`${emoji} [${team.team_tag}] ${team.team_name} ${mgr}`);
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

  const title = lobbyFilter
    ? `📋 ${scrim_name} — LOBBY ${lobbyFilter}`
    : `📋 ${scrim_name} — SLOT LIST`;

  const assigned    = slots.filter(t => t.lobby).length;
  const unassignedC = slots.length - assigned;

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(title)
    .addFields(...fields);

  if (!lobbyFilter) {
    embed.addFields({ name: '📊', value: `✅ Assigned: **${assigned}** | ⏳ Unassigned: **${unassignedC}** | Total: **${slots.length}**` });
  }

  return embed.setTimestamp();
}

// ── Build confirm slot list ───────────────────────────────────────────────────
function buildConfirmSlotList(slots, settings, lobbyFilter = null) {
  const { scrim_name, lobbies: numLobbies } = settings;
  const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
  const toShow = lobbyFilter ? [lobbyFilter] : lobbyLetters;

  const lobbyGroups = {};
  for (const l of toShow) lobbyGroups[l] = [];
  for (const t of slots) { if (t.lobby && lobbyGroups[t.lobby]) lobbyGroups[t.lobby].push(t); }

  const fields = [];
  for (const letter of toShow) {
    const teams = (lobbyGroups[letter] || []).sort((a, b) => a.lobby_slot - b.lobby_slot);
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

  // Stats scoped to the filtered lobby only
  const scopedSlots = lobbyFilter ? slots.filter(t => t.lobby === lobbyFilter) : slots;
  const confirmed = scopedSlots.filter(t => t.confirmed === true).length;
  const cancelled = scopedSlots.filter(t => t.confirmed === false).length;
  const pending   = scopedSlots.filter(t => t.lobby && t.confirmed === undefined).length;

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

  console.log(`[REACTION] emoji=${emoji} user=${user.id} msg=${message.id} guild=${guild.id}`);

  // ── ADMIN assigning slot on team card ─────────────────────────────────────
  const cardInfo = lookupTeamCard(message.id, guild.id);
  console.log(`[REACTION] cardInfo=`, cardInfo);
  if (cardInfo) {
    const config = getConfig(guild.id);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) { console.log('[REACTION] member not found'); return; }
    const isAdmin = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    (config.admin_role && member.roles.cache.has(config.admin_role));
    console.log(`[REACTION] isAdmin=${isAdmin}`);
    if (!isAdmin) {
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    const data      = getRegistrations(guild.id);
    const settings  = getScrimSettings(guild.id);
    const lobbyConf = getLobbyConfig(guild.id);
    const team      = data.slots[cardInfo.teamIndex];
    console.log(`[REACTION] teamIndex=${cardInfo.teamIndex} team=`, team?.team_name);
    if (!team) return;

    const prevLobby = team.lobby;

    // ── Lobby letter emoji → assign lobby ─────────────────────────────────
    if (LOBBY_EMOJIS[emoji] !== undefined) {
      const newLobby   = LOBBY_EMOJIS[emoji];
      const settings   = getScrimSettings(guild.id);
      const numLobbies = settings.lobbies || 4;

      // Ignore if this lobby letter is out of range for configured lobbies
      const validLetters = LOBBY_EMOJI_LIST.slice(0, numLobbies);
      if (!validLetters.includes(emoji)) {
        try { await reaction.users.remove(user.id); } catch {}
        return;
      }

      // Remove other lobby letter reactions from this card (only one lobby at a time)
      for (const le of LOBBY_EMOJI_LIST) {
        if (le !== emoji) {
          const r = message.reactions.cache.find(r => r.emoji.name === le);
          if (r) try { await r.users.remove(user.id); } catch {}
        }
      }

      const prevLobby = team.lobby;

      // Remove old lobby role if switching lobbies
      if (prevLobby && prevLobby !== newLobby && lobbyConf[prevLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lobbyConf[prevLobby].role_id).catch(() => {});
          } catch {}
        }
      }

      team.lobby = newLobby;
      // Auto-assign next available slot when lobby is first set
      if (!team.lobby_slot || prevLobby !== newLobby) {
        const autoSlot = nextAvailableSlot(data.slots, newLobby, settings);
        if (autoSlot) team.lobby_slot = autoSlot;
        else delete team.lobby_slot;
      }

      // Add new lobby role if configured
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
      await updateTeamCardEmbed(message, team);
      await refreshAllSlotLists(guild, config, settings, lobbyConf, data, team.lobby);
      if (team.lobby && team.lobby_slot && lobbyConf[team.lobby]?.channel_id) {
        await postToLobbyChannel(guild, team, lobbyConf, settings, data);
      }
      // Sheet sync in background — don't block slot list update
      syncSheet(guild, config, data).catch(() => {});
      return;
    }

    if (SLOT_EMOJIS[emoji] !== undefined) {
      const slotNum = SLOT_EMOJIS[emoji];

      // If no lobby set yet, can't assign slot number
      if (!team.lobby) {
        try { await reaction.users.remove(user.id); } catch {}
        return;
      }

      const newLobby = team.lobby;

      // Check slot isn't already taken by another team
      const slotTaken = data.slots.find(
        (t, idx) => idx !== cardInfo.teamIndex && t.lobby === newLobby && t.lobby_slot === slotNum
      );
      if (slotTaken) {
        try { await reaction.users.remove(user.id); } catch {}
        return;
      }

      // Remove other godsent emoji reactions from this card (only one slot at a time)
      for (const emojiName of Object.keys(SLOT_EMOJIS)) {
        if (emojiName !== emoji) {
          const r = message.reactions.cache.find(r => r.emoji.name === emojiName);
          if (r) try { await r.users.remove(user.id); } catch {}
        }
      }

      team.lobby_slot = slotNum;

      // Add lobby role if configured
      if (lobbyConf[newLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.add(lobbyConf[newLobby].role_id).catch(() => {});
          } catch {}
        }
      }

    } else {
      // Not a slot emoji — ignore
      return;
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);

    await updateTeamCardEmbed(message, team);
    await refreshAllSlotLists(guild, config, settings, lobbyConf, data, team.lobby);
    if (team.lobby && team.lobby_slot && lobbyConf[team.lobby]?.channel_id) {
      await postToLobbyChannel(guild, team, lobbyConf, settings, data);
    }
    // Sheet sync in background
    syncSheet(guild, config, data).catch(() => {});
    return;
  }

  // ── TEAM confirming on /confirm message ───────────────────────────────────
  const sessions   = getConfirmSessions(guild.id);
  const session    = sessions.find(s => s.confirmMessageId === message.id);
  if (!session) return;
  if (emoji !== '✅' && emoji !== '❌') {
    try { await reaction.users.remove(user.id); } catch {}
    return;
  }

  const config    = getConfig(guild.id);
  const settings  = getScrimSettings(guild.id);
  const lobbyConf = getLobbyConfig(guild.id);
  const data      = getRegistrations(guild.id);

  // Only the registered captain or manager of a team in THIS lobby can react
  const teamIndex = data.slots.findIndex(t =>
    (t.captain_id === user.id || t.manager_id === user.id) &&
    t.lobby === session.lobbyLetter
  );
  if (teamIndex === -1) {
    // Not a registered captain/manager for this lobby — remove their reaction
    try { await reaction.users.remove(user.id); } catch {}
    return;
  }

  if (emoji === '✅') {
    data.slots[teamIndex].confirmed = true;
  } else {
    // ❌ = mark as cancelled (crossed out) — admin will manually remove from slot list
    data.slots[teamIndex].confirmed = false;
  }

  setRegistrations(guild.id, data);
  // Update the persistent slot list in all lobby channels (underline/strikethrough)
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
  const emoji = reaction.emoji.name;

  const cardInfo = lookupTeamCard(message.id, guild.id);
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

    // Removing a lobby letter emoji = unassign the lobby (and slot)
    if (LOBBY_EMOJIS[emoji] !== undefined && team.lobby === LOBBY_EMOJIS[emoji]) {
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
    }

    // Removing a godsent slot emoji = unassign slot number from this team
    if (SLOT_EMOJIS[emoji] !== undefined && team.lobby_slot === SLOT_EMOJIS[emoji]) {
      const lc = lobbyConf[team.lobby];
      if (lc?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lc.role_id).catch(() => {});
          } catch {}
        }
      }
      delete team.lobby_slot;
    }

    data.slots[cardInfo.teamIndex] = team;
    setRegistrations(guild.id, data);
    await updateTeamCardEmbed(message, team);
    await refreshAllSlotLists(guild, config, settings, lobbyConf, data);
    await syncSheet(guild, config, data);
    return;
  }

  // Confirm reactions are auto-removed when added — nothing to handle on remove.
  // Just return.
}


// ── Post/update lobby-specific slot list in lobby channel ─────────────────────
async function postToLobbyChannel(guild, team, lobbyConf, settings, data) {
  const lc = lobbyConf[team.lobby];
  if (!lc?.channel_id) return;

  try {
    const ch    = await guild.channels.fetch(lc.channel_id);
    const embed = buildPersistentSlotList(data.slots, settings, team.lobby);
    const msgKey = `lobby_${team.lobby}`;
    const ids    = getPersistentSlotListId(guild.id);

    // 1. Try editing by stored message ID (fast path)
    if (ids[msgKey]) {
      try {
        const existing = await ch.messages.fetch(ids[msgKey]);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {
        // Message deleted or inaccessible — clear stale ID and fall through
        setPersistentSlotListId(guild.id, { [msgKey]: null });
      }
    }

    // 2. Scan channel for any existing bot slot list for this lobby and delete all of them
    const msgs = await ch.messages.fetch({ limit: 50 });
    const botId = guild.client?.user?.id;
    const existing = msgs.filter(m =>
      m.author.id === botId &&
      m.embeds?.[0]?.title?.includes(`Lobby ${team.lobby}`)
    );
    for (const [, m] of existing) {
      try { await m.delete(); } catch {}
    }

    // 3. Post fresh message (no pin — pin system messages break scan logic)
    const newMsg = await ch.send({ embeds: [embed] });
    setPersistentSlotListId(guild.id, { [msgKey]: newMsg.id });
  } catch (err) {
    console.error(`⚠️ Lobby channel post error:`, err.message);
  }
}

// ── Sync to Google Sheet ──────────────────────────────────────────────────────
async function syncSheet(guild, config, data) {
  try {
    if (config.spreadsheet_id) {
      await syncTeamsToSheet(config.spreadsheet_id, data.slots || []);
    }
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
}

// ── Refresh all slot lists ────────────────────────────────────────────────────
async function refreshAllSlotLists(guild, config, settings, lobbyConf, data, onlyLobby = null) {
  const ids = getPersistentSlotListId(guild.id);
  const botId = guild.client?.user?.id;
  const LOBBY_LETTERS = ['A','B','C','D','E','F','G','H','I','J']
    .slice(0, settings.lobbies || 4)
    .filter(l => !onlyLobby || l === onlyLobby);

  // Run all lobby refreshes in parallel — much faster than sequential
  await Promise.all(LOBBY_LETTERS.map(async letter => {
    const lc     = lobbyConf[letter];
    const msgKey = `lobby_${letter}`;
    if (!lc?.channel_id) return;

    try {
      const ch    = await guild.channels.fetch(lc.channel_id);
      const embed = buildPersistentSlotList(data.slots, settings, letter);

      if (ids[msgKey]) {
        try {
          const msg = await ch.messages.fetch(ids[msgKey]);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          setPersistentSlotListId(guild.id, { [msgKey]: null });
        }
      }

      const msgs = await ch.messages.fetch({ limit: 50 });
      const existing = msgs.find(m =>
        m.author.id === botId &&
        m.embeds?.[0]?.title?.includes(`Lobby ${letter}`)
      );
      if (existing) {
        setPersistentSlotListId(guild.id, { [msgKey]: existing.id });
        await existing.edit({ embeds: [embed] });
      }
    } catch {}
  }));
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
      ? `🏟️ Lobby **${team.lobby}**${team.lobby_slot ? `  •  🎯 Slot **${team.lobby_slot}**` : '  •  ⏳ slot pending'}`
      : '⏳ Unassigned';

    const updated = EmbedBuilder.from(old)
      .setColor(team.lobby && team.lobby_slot ? 0x00FF7F : team.lobby ? 0xFFAA00 : 0x5865F2)
      .setDescription(`${old.description || ''}\n\n${lobbyText}`)
      .setFooter({ text: old.footer?.text?.split(' |')[0] || '' });
    await message.edit({ embeds: [updated] });
  } catch {}
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  getConfirmSessions,
  registerTeamCard,
  buildPersistentSlotList,
  buildConfirmSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  refreshAllSlotLists,
  SLOT_EMOJI_LIST,
};
