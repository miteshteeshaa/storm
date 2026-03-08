const { EmbedBuilder } = require('discord.js');
const { syncTeamsToSheet } = require('../utils/sheets');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig, getSessionConfig,
  getConfirmSessions: dbGetConfirmSessions, setConfirmSessions: dbSetConfirmSessions,
  getSlotListIds, setSlotListIds,
  getTeamCards, setTeamCard, getTeamCardSession,
} = require('../utils/database');

// ── Per-guild reaction lock — prevents duplicate slot assignment on rapid reacts ──
const reactionLocks = new Map(); // guildId → Promise
async function withLock(guildId, fn) {
  const prev = reactionLocks.get(guildId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => { resolve = r; });
  reactionLocks.set(guildId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    if (reactionLocks.get(guildId) === next) reactionLocks.delete(guildId);
  }
}

// ── Confirm sessions — persisted to disk ──────────────────────────────────────
// Sessions now carry a sessionId so the reaction handler knows which scrim session to update
function registerConfirmSession(guildId, confirmMessageId, channelId, lobbyLetter, sessionId = null) {
  const existing = dbGetConfirmSessions(guildId);
  const idx = existing.findIndex(s => s.channelId === channelId && s.sessionId === sessionId);
  const session = { confirmMessageId, channelId, lobbyLetter, sessionId };
  if (idx >= 0) existing[idx] = session;
  else existing.push(session);
  dbSetConfirmSessions(guildId, existing);
}
function getConfirmSessions(guildId) { return dbGetConfirmSessions(guildId); }
function getConfirmSession(guildId)  { return getConfirmSessions(guildId)[0] || null; }

// ── Slot list message IDs — persisted to disk ─────────────────────────────────
function getPersistentSlotListId(guildId, sessionId)       { return getSlotListIds(guildId, sessionId); }
function setPersistentSlotListId(guildId, data, sessionId) { setSlotListIds(guildId, data, sessionId); }

// ── Team card map — persisted to disk so restarts don't lose card→team mapping ─
function registerTeamCard(messageId, guildId, teamIndex, sessionId = null) {
  setTeamCard(guildId, messageId, teamIndex, sessionId);
}
function lookupTeamCard(messageId, guildId) {
  return getTeamCardSession(guildId, messageId);
}

// ── Emoji maps ────────────────────────────────────────────────────────────────
// Custom ALPHABET emoji → lobby letter
const LOBBY_EMOJIS = {
  'ALPHABET_A': 'A', 'ALPHABET_B': 'B', 'ALPHABET_C': 'C', 'ALPHABET_D': 'D', 'ALPHABET_E': 'E',
  'ALPHABET_F': 'F', 'ALPHABET_G': 'G', 'ALPHABET_H': 'H', 'ALPHABET_I': 'I', 'ALPHABET_J': 'J',
};
const LOBBY_EMOJI_LIST = [
  'ALPHABET_A', 'ALPHABET_B', 'ALPHABET_C', 'ALPHABET_D', 'ALPHABET_E',
  'ALPHABET_F', 'ALPHABET_G', 'ALPHABET_H', 'ALPHABET_I', 'ALPHABET_J',
];
const LOBBY_EMOJI_IDS = {
  'ALPHABET_A': '1479856260131193088',
  'ALPHABET_B': '1479856358802067488',
  'ALPHABET_C': '1479856470240526477',
  'ALPHABET_D': '1479856666844463250',
  'ALPHABET_E': '1479856766689743080',
  'ALPHABET_F': '1479856965873045618',
  'ALPHABET_G': '1479857067207561359',
  'ALPHABET_H': '1479857168219111475',
  'ALPHABET_I': '1479857401359368294',
  'ALPHABET_J': '1479857550303428669',
};

// Maps custom emoji name → slot number (1-30)
const SLOT_EMOJIS = {
  '309551':    1, '449812':    2, 'num_3':     3, '730734':    4, '979255':    5,
  '363176':    6, '906647':    7, '471908':    8, '225589':    9, '297510':   10,
  '8707711':  11, '9006012':  12, '5759813':  13, '8449714':  14, '5880615':  15,
  '7229116':  16, '1209217':  17, '1247418':  18, '7056819':  19, '3659020':  20,
  '26614521': 21, '79660622': 22, '7841623':  23, '76300424': 24, '13699925': 25,
  '11262626': 26, '16010527': 27, '76306228': 28, '67755429': 29, '65811430': 30,
};

// Emoji list for reacting on team cards (slot 3 ID missing — add it when you have it)
const SLOT_EMOJI_LIST = [
  { name: '309551',    id: '1479861605398482975' },  // 1
  { name: '449812',    id: '1479861721391824978' },  // 2
  { name: 'num_3',     id: '1479861250136477878' },  // 3
  { name: '730734',    id: '1479861997481758730' },  // 4
  { name: '979255',    id: '1479862249450504335' },  // 5
  { name: '363176',    id: '1479861643411193990' },  // 6
  { name: '906647',    id: '1479862210036629788' },  // 7
  { name: '471908',    id: '1479861761044910282' },  // 8
  { name: '225589',    id: '1479861527509995531' },  // 9
  { name: '297510',    id: '1479861328909701282' },  // 10
  { name: '8707711',   id: '1479862138360041718' },  // 11
  { name: '9006012',   id: '1479862174594760815' },  // 12
  { name: '5759813',   id: '1479861820050247853' },  // 13
  { name: '8449714',   id: '1479862102046015640' },  // 14
  { name: '5880615',   id: '1479861879802302577' },  // 15
  { name: '7229116',   id: '1479861956415328460' },  // 16
  { name: '1209217',   id: '1479861398006796388' },  // 17
  { name: '1247418',   id: '1479861436955103514' },  // 18
  { name: '7056819',   id: '1479861917727326280' },  // 19
  { name: '3659020',   id: '1479861686226780241' },  // 20
  { name: '26614521',  id: '1479862409710665880' },  // 21
  { name: '79660622',  id: '1479862661134024714' },  // 22
  { name: '7841623',   id: '1479862045095755847' },  // 23
  { name: '76300424',  id: '1479862584134991924' },  // 24
  { name: '13699925',  id: '1479862331767914578' },  // 25
  { name: '11262626',  id: '1479862290823118918' },  // 26
  { name: '16010527',  id: '1479862370581872650' },  // 27
  { name: '76306228',  id: '1479862620835021003' },  // 28
  { name: '67755429',  id: '1479862539071525097' },  // 29
  { name: '65811430',  id: '1479862456950980670' },  // 30
];

// Build a lookup: slot number → Discord emoji string <:name:id>
const SLOT_DISPLAY = {};
for (const e of SLOT_EMOJI_LIST) {
  const slotNum = SLOT_EMOJIS[e.name];
  if (slotNum) SLOT_DISPLAY[slotNum] = `<:${e.name}:${e.id}>`;
}

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

    const allLines = [];
    for (let s = first_slot; s < first_slot + slotsPerLobby; s++) {
      const team  = teams.find(t => t.lobby_slot === s);
      const emoji = numEmoji(s);
      if (team) {
        const mentions = [...new Set([team.captain_id, team.manager_id].filter(Boolean))]
          .map(id => `<@${id}>`).join(' ');
        const line = `${emoji} **[${team.team_tag}] ${team.team_name}** ${mentions}`;
        if (team.confirmed === true)       allLines.push(`__${line}__`);
        else if (team.confirmed === false)  allLines.push(`~~${line}~~`);
        else                               allLines.push(line);
      } else {
        allLines.push(`${emoji} —`);
      }
    }

    // Single column — chunk into ≤1024-char fields to stay under Discord limit
    const chunks = [];
    let current  = '';
    for (const line of allLines) {
      const next = current ? current + '\n' + line : line;
      if (next.length > 1024) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);

    chunks.forEach((chunk, i) => {
      fields.push({
        name: i === 0 ? `🏟️ Lobby ${letter}` : '\u200b',
        value: chunk,
        inline: false,
      });
    });
  }

  const unassigned = slots.filter(t => !t.lobby);
  if (!lobbyFilter && unassigned.length > 0) {
    fields.push({
      name: '⏳ Unassigned',
      value: unassigned.map(t => {
        const mentions = [...new Set([t.captain_id, t.manager_id].filter(Boolean))].map(id => `<@${id}>`).join(' ');
        return `• [${t.team_tag}] ${t.team_name} ${mentions}`;
      }).join('\n'),
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
      const e        = numEmoji(t.lobby_slot);
      const mentions = [...new Set([t.captain_id, t.manager_id].filter(Boolean))].map(id => `<@${id}>`).join(' ');
      if (t.confirmed === true)  return `${e} __[${t.team_tag}] ${t.team_name}__ ${mentions}`;
      if (t.confirmed === false) return `${e} ~~[${t.team_tag}] ${t.team_name}~~ ${mentions}`;
      return `${e} [${t.team_tag}] ${t.team_name} ${mentions}`;
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

    await withLock(guild.id, async () => {
    const sessionId = cardInfo.sessionId;
    const data      = getRegistrations(guild.id, sessionId);
    const settings  = getScrimSettings(guild.id, sessionId);
    const lobbyConf = getLobbyConfig(guild.id, sessionId);
    const team      = data.slots[cardInfo.teamIndex];
    console.log(`[REACTION] teamIndex=${cardInfo.teamIndex} team=`, team?.team_name);
    if (!team) return;

    const prevLobby = team.lobby;

    // ── Lobby letter emoji → assign lobby ─────────────────────────────────
    if (LOBBY_EMOJIS[emoji] !== undefined) {
      const newLobby   = LOBBY_EMOJIS[emoji];
      const numLobbies = settings.lobbies || 4;

      const validLetters = LOBBY_EMOJI_LIST.slice(0, numLobbies);
      if (!validLetters.includes(emoji)) {
        reaction.users.remove(user.id).catch(() => {});
        return;
      }

      const prevLobby = team.lobby;

      // ── Duplicate check: same tag+name already has a slot in any lobby ──────
      const duplicate = data.slots.find((t, idx) =>
        idx !== cardInfo.teamIndex &&
        t.lobby && t.lobby_slot &&
        t.team_tag === team.team_tag &&
        t.team_name === team.team_name
      );
      if (duplicate) {
        // Flash ⚠️ for 2 seconds then remove it — do NOT assign slot
        reaction.users.remove(user.id).catch(() => {});
        (async () => {
          try {
            await message.react('⚠️');
            await new Promise(r => setTimeout(r, 2000));
            const warningReaction = message.reactions.cache.get('⚠️');
            if (warningReaction) await warningReaction.remove().catch(() => {});
          } catch {}
        })();
        return;
      }

      team.lobby = newLobby;
      // Clear old slot BEFORE calling nextAvailableSlot so this team's own
      // previous slot isn't counted as taken, allowing correct gap-filling
      delete team.lobby_slot;
      data.slots[cardInfo.teamIndex] = team;
      // Auto-assign lowest free slot in the chosen lobby
      const autoSlot = nextAvailableSlot(data.slots, newLobby, settings);
      console.log(`[SLOT] lobby=${newLobby} autoSlot=${autoSlot} team=${team.team_name}`);
      if (autoSlot) team.lobby_slot = autoSlot;
      else console.warn(`[SLOT] Lobby ${newLobby} is full — no slot assigned`);

      // Save immediately
      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data, sessionId);

      // Update card + slot list instantly (these are the visible changes)
      await Promise.all([
        updateTeamCardEmbed(message, team),
        refreshAllSlotLists(guild, config, settings, lobbyConf, data, team.lobby, sessionId),
        team.lobby && team.lobby_slot && lobbyConf[team.lobby]?.channel_id
          ? postToLobbyChannel(guild, team, lobbyConf, settings, data, sessionId)
          : Promise.resolve(),
      ]);

      // Background: clean up reactions, roles, sheet
      (async () => {
        try {
          // ── If slot assigned: show lobby emoji + slot emoji + ❌ ──────────────
          if (team.lobby_slot) {
            await message.reactions.removeAll().catch(() => {});
            // Add assigned lobby letter emoji
            const lobbyEmojiName = `ALPHABET_${team.lobby}`;
            const lobbyEmojiId   = LOBBY_EMOJI_IDS[lobbyEmojiName];
            if (lobbyEmojiId) await message.react(`${lobbyEmojiName}:${lobbyEmojiId}`).catch(() => {});
            await new Promise(r => setTimeout(r, 200));
            // Add slot number emoji
            const slotEmoji = SLOT_EMOJI_LIST[team.lobby_slot - 1];
            if (slotEmoji) await message.react(`${slotEmoji.name}:${slotEmoji.id}`).catch(() => {});
            await new Promise(r => setTimeout(r, 200));
            // Add ❌ to allow unassign
            await message.react('❌').catch(() => {});
          } else {
            // Lobby full — just remove the other lobby letter reactions, keep this one
            for (const le of LOBBY_EMOJI_LIST.filter(le => le !== emoji)) {
              const r = message.reactions.cache.find(r => r.emoji.name === le);
              if (r) await r.users.remove(user.id).catch(() => {});
            }
          }
        } catch {}

        // Role management
        try {
          if (prevLobby && prevLobby !== newLobby && lobbyConf[prevLobby]?.role_id) {
            for (const pid of (team.players || [team.manager_id, team.captain_id])) {
              guild.members.fetch(pid).then(m => m.roles.remove(lobbyConf[prevLobby].role_id)).catch(() => {});
            }
          }
          if (lobbyConf[newLobby]?.role_id) {
            for (const pid of (team.players || [team.manager_id, team.captain_id])) {
              guild.members.fetch(pid).then(m => m.roles.add(lobbyConf[newLobby].role_id)).catch(() => {});
            }
          }
        } catch {}

        // Sheet sync
        syncSheet(guild, config, data, sessionId).catch(() => {});
      })();
      return;
    }

    // ── Admin adds ❌ on a card = unassign slot & lobby ──────────────────────
    if (emoji === '❌') {
      const oldLobby = team.lobby;
      if (!oldLobby && !team.lobby_slot) {
        // Already unassigned — ignore
        reaction.users.remove(user.id).catch(() => {});
        return;
      }

      // Remove lobby role from all players
      if (oldLobby && lobbyConf[oldLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lobbyConf[oldLobby].role_id).catch(() => {});
          } catch {}
        }
      }

      delete team.lobby;
      delete team.lobby_slot;
      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data, sessionId);

      // Update embed + slotlist immediately
      await updateTeamCardEmbed(message, team);
      await refreshAllSlotLists(guild, config, settings, lobbyConf, data, null, sessionId);
      await syncSheet(guild, config, data, sessionId);

      // Restore lobby letter emojis
      try {
        await message.reactions.removeAll();
        const numLobbies = settings.lobbies || 4;
        for (let idx = 0; idx < numLobbies; idx++) {
          const name = LOBBY_EMOJI_LIST[idx];
          const id   = LOBBY_EMOJI_IDS[name];
          await message.react(`${name}:${id}`).catch(() => {});
          await new Promise(r => setTimeout(r, 150));
        }
      } catch {}
      return;
    }

    // Any other unrecognised emoji — ignore silently
    return;
    }); // end withLock
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
  const sessionId = session.sessionId || null;
  const settings  = getScrimSettings(guild.id, sessionId);
  const lobbyConf = getLobbyConfig(guild.id, sessionId);
  const data      = getRegistrations(guild.id, sessionId);

  // Find ALL slots where this user is captain or manager in THIS lobby
  const teamIndices = data.slots.reduce((acc, t, idx) => {
    if ((t.captain_id === user.id || t.manager_id === user.id) && t.lobby === session.lobbyLetter) {
      acc.push(idx);
    }
    return acc;
  }, []);

  if (teamIndices.length === 0) {
    // Not a registered captain/manager for this lobby — remove their reaction
    try { await reaction.users.remove(user.id); } catch {}
    return;
  }

  // Always remove the user's reaction immediately — keeps count at 1 (bot only)
  try { await reaction.users.remove(user.id); } catch {}

  // Determine new confirmed state based on the first slot (toggle logic)
  const firstTeam = data.slots[teamIndices[0]];
  const prevConfirmed = firstTeam.confirmed;

  let newConfirmed;
  if (emoji === '✅') {
    // If already confirmed, toggle off (undo); otherwise confirm
    newConfirmed = prevConfirmed === true ? null : true;
  } else {
    // If already cancelled, toggle off (undo); otherwise cancel
    newConfirmed = prevConfirmed === false ? null : false;
  }

  // Apply the same confirmed state to ALL of this player's slots in this lobby
  for (const idx of teamIndices) {
    data.slots[idx].confirmed = newConfirmed;
  }

  setRegistrations(guild.id, data, sessionId);
  // Update the persistent slot list in all lobby channels (underline/strikethrough)
  await refreshAllSlotLists(guild, config, settings, lobbyConf, data, null, sessionId);
  await syncSheet(guild, config, data, sessionId);

  // ── DM the player if they confirmed or cancelled ──────────────────────────
  if (newConfirmed === true || newConfirmed === false) {
    try {
      const { getSessions, getSessionConfig } = require('../utils/database');
      const sessions    = getSessions(guild.id);
      const sessionInfo = sessions.find(s => s.id === sessionId) || { name: settings.scrim_name };
      const sessionCfg  = sessionId ? getSessionConfig(guild.id, sessionId) : {};

      // Build one DM line per slot this player has in this lobby
      const dmLines = teamIndices.map(idx => {
        const t          = data.slots[idx];
        const captain    = `<@${t.captain_id || t.manager_id}>`;
        const lobbyChId  = lobbyConf[t.lobby]?.channel_id;
        const lobbyChStr = lobbyChId ? `<#${lobbyChId}>` : `Lobby ${t.lobby}`;
        const statusIcon = newConfirmed === true ? '✅' : '❌';

        return [
          `${statusIcon} __Participation in ${sessionInfo.name} successfully ${newConfirmed === true ? 'confirmed' : 'cancelled'}!__`,
          `Team: \`[${t.team_tag}]\` ${t.team_name} ${captain}`,
          `Lobby: 🏆 ${sessionInfo.name} › ${lobbyChStr}`,
        ].join('\n');
      });

      const dmContent = dmLines.join('\n\n');
      const dmUser = await guild.client.users.fetch(user.id).catch(() => null);
      if (dmUser) await dmUser.send({ content: dmContent }).catch(() => {});
    } catch {}
  }
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
    const isAdminUser = member.permissions.has('Administrator') ||
                    guild.ownerId === user.id ||
                    (config.admin_role && member.roles.cache.has(config.admin_role));
    if (!isAdminUser) return;

    const sessionId = cardInfo.sessionId;
    const data      = getRegistrations(guild.id, sessionId);
    const settings  = getScrimSettings(guild.id, sessionId);
    const lobbyConf = getLobbyConfig(guild.id, sessionId);
    const team      = data.slots[cardInfo.teamIndex];
    if (!team) return;

    // ── Admin removes ❌ = unassign slot & lobby, restore lobby letter emojis ──
    if (emoji === '❌') {
      const oldLobby = team.lobby;
      // Remove lobby role from all players
      if (oldLobby && lobbyConf[oldLobby]?.role_id) {
        for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
          try {
            const m = await guild.members.fetch(playerId);
            await m.roles.remove(lobbyConf[oldLobby].role_id).catch(() => {});
          } catch {}
        }
      }
      delete team.lobby;
      delete team.lobby_slot;

      data.slots[cardInfo.teamIndex] = team;
      setRegistrations(guild.id, data, sessionId);
      await updateTeamCardEmbed(message, team);
      await refreshAllSlotLists(guild, config, settings, lobbyConf, data, null, sessionId);
      await syncSheet(guild, config, data, sessionId);

      // Restore lobby letter emojis — remove ❌ then re-add all configured lobby letters
      try {
        await message.reactions.removeAll();
        const numLobbies = settings.lobbies || 4;
        for (let idx = 0; idx < numLobbies; idx++) {
          const name = LOBBY_EMOJI_LIST[idx];
          const id   = LOBBY_EMOJI_IDS[name];
          await message.react(`${name}:${id}`).catch(() => {});
          await new Promise(r => setTimeout(r, 150));
        }
      } catch {}
      return;
    }

    // Removing a lobby letter emoji — no-op (lobby letters are bot-managed now)
    // No slot emoji handling — slots are assigned automatically, not via emoji

    return;
  }

  // Confirm reactions are auto-removed when added — nothing to handle on remove.
  // Just return.
}


// ── Post/update lobby-specific slot list in lobby channel ─────────────────────
async function postToLobbyChannel(guild, team, lobbyConf, settings, data, sessionId = null) {
  const lc = lobbyConf[team.lobby];
  if (!lc?.channel_id) return;

  try {
    const ch    = await guild.channels.fetch(lc.channel_id);
    const embed = buildPersistentSlotList(data.slots, settings, team.lobby);
    const msgKey = `lobby_${team.lobby}`;
    const ids    = getPersistentSlotListId(guild.id, sessionId);

    // 1. Try editing by stored message ID (fast path)
    if (ids[msgKey]) {
      try {
        const existing = await ch.messages.fetch(ids[msgKey]);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {
        // Message deleted or inaccessible — clear stale ID and fall through
        setPersistentSlotListId(guild.id, { [msgKey]: null }, sessionId);
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
    setPersistentSlotListId(guild.id, { [msgKey]: newMsg.id }, sessionId);
  } catch (err) {
    console.error(`⚠️ Lobby channel post error:`, err.message);
  }
}

// ── Sync to Google Sheet ──────────────────────────────────────────────────────
async function syncSheet(guild, config, data, sessionId = null) {
  try {
    const { getSessionConfig, getScrimSettings } = require('../utils/database');
    const sessionCfg    = sessionId ? getSessionConfig(guild.id, sessionId) : {};
    const spreadsheetId = sessionCfg.spreadsheet_id || config.spreadsheet_id;
    const settings      = getScrimSettings(guild.id, sessionId);
    const slotsPerLobby = settings.slots_per_lobby || 24;
    const firstSlot     = settings.first_slot || 1;
    if (spreadsheetId) {
      await syncTeamsToSheet(spreadsheetId, data.slots || [], slotsPerLobby, firstSlot);
    }
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
}

// ── Refresh all slot lists ────────────────────────────────────────────────────
async function refreshAllSlotLists(guild, config, settings, lobbyConf, data, onlyLobby = null, sessionId = null) {
  const ids = getPersistentSlotListId(guild.id, sessionId);
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
          setPersistentSlotListId(guild.id, { [msgKey]: null }, sessionId);
        }
      }

      const msgs = await ch.messages.fetch({ limit: 50 });
      const existing = msgs.find(m =>
        m.author.id === botId &&
        m.embeds?.[0]?.title?.includes(`Lobby ${letter}`)
      );
      if (existing) {
        setPersistentSlotListId(guild.id, { [msgKey]: existing.id }, sessionId);
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
    // Cards are plain text — strip any previously appended status suffix, keep base line
    const baseContent = message.content?.split('\n')[0] || message.content || '';
    const baseLine = baseContent.replace(/\s*[\|—].*$/, '').trimEnd();
    // No text suffix — lobby/slot info shown via reactions only
    await message.edit({ content: baseLine });
  } catch {}
}

// ── Handle slot list message deletion — auto-repost ──────────────────────────
async function handleMessageDelete(message) {
  if (!message.guild) return;
  const guild   = message.guild;
  const guildId = guild.id;

  const { getSessions, getSessionConfig, getRegistrations, getScrimSettings, getLobbyConfig } = require('../utils/database');
  const sessions = getSessions(guildId);

  for (const s of sessions) {
    const sessionCfg = getSessionConfig(guildId, s.id);
    const settings   = getScrimSettings(guildId, s.id);
    const lobbyConf  = getLobbyConfig(guildId, s.id);
    const data       = getRegistrations(guildId, s.id);
    const config     = getConfig(guildId);

    // Check if it was the slot-allocation channel persistent list
    if (sessionCfg.slotlist_channel === message.channelId) {
      const ids    = getSlotListIds(guildId, s.id);
      const stored = ids['slotlist_main'];
      if (stored === message.id) {
        // Repost fresh
        try {
          const ch    = await guild.channels.fetch(sessionCfg.slotlist_channel);
          const embed = buildPersistentSlotList(data.slots, settings);
          const msg   = await ch.send({ embeds: [embed] });
          setSlotListIds(guildId, { slotlist_main: msg.id }, s.id);
        } catch (err) { console.error('Auto-repost slotlist error:', err.message); }
        return;
      }
    }

    // Check if it was a lobby slot list
    const numLobbies   = settings.lobbies || 4;
    const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
    for (const letter of lobbyLetters) {
      const chId = lobbyConf[letter]?.channel_id;
      if (!chId || chId !== message.channelId) continue;
      const ids    = getSlotListIds(guildId, s.id);
      const stored = ids[`lobby_${letter}`];
      if (stored === message.id) {
        try {
          const ch    = await guild.channels.fetch(chId);
          const embed = buildPersistentSlotList(data.slots, settings, letter);
          const msg   = await ch.send({ embeds: [embed] });
          setSlotListIds(guildId, { [`lobby_${letter}`]: msg.id }, s.id);
        } catch (err) { console.error(`Auto-repost lobby ${letter} error:`, err.message); }
        return;
      }
    }
  }
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  handleMessageDelete,
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
  LOBBY_EMOJI_IDS,
};
