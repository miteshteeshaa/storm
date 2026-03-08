const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require(‘discord.js’);
const {
getConfig, setConfig, getRegistrations, setRegistrations, clearRegistrations,
setServer, clearMatches, getScrimSettings, getLobbyConfig,
getSessions, getSessionConfig, setSessionConfig, setSessionServer, setSlotListIds,
} = require(’../../utils/database’);
const { successEmbed, errorEmbed, infoEmbed } = require(’../../utils/embeds’);
const { isAdmin, isActivated } = require(’../../utils/permissions’);
const { clearTeamsFromSheet, createServerSheet, syncTeamsToSheet } = require(’../../utils/sheets’);
const {
buildPersistentSlotList,
getPersistentSlotListId,
setPersistentSlotListId,
} = require(’../../handlers/reactionHandler’);

// ── Helper: bulk delete messages in a channel ─────────────────────────────────
async function purgeChannel(guild, channelId) {
if (!channelId) return 0;
try {
const ch = await guild.channels.fetch(channelId);
if (!ch) return 0;
let deleted = 0;
const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;

```
while (true) {
  const msgs = await ch.messages.fetch({ limit: 100 });
  if (msgs.size === 0) break;

  const recent = msgs.filter(m => m.createdTimestamp > cutoff);
  const old    = msgs.filter(m => m.createdTimestamp <= cutoff);

  // Bulk delete recent messages (Discord API limit: < 14 days)
  if (recent.size > 1)  { await ch.bulkDelete(recent).catch(() => {}); deleted += recent.size; }
  else if (recent.size === 1) { await recent.first().delete().catch(() => {}); deleted++; }

  // Individually delete old messages (bulkDelete won't work on these)
  for (const [, msg] of old) {
    await msg.delete().catch(() => {});
    deleted++;
    await new Promise(r => setTimeout(r, 300)); // avoid rate limit
  }

  if (msgs.size < 100) break;
}
return deleted;
```

} catch (err) {
console.error(‘⚠️ purgeChannel error:’, err.message);
return 0;
}
}

// ── Helper: post fresh empty slot list in a lobby channel ─────────────────────
async function postFreshLobbySlotList(guild, letter, lobbyConf, settings, sessionId = null) {
const lc = lobbyConf[letter];
if (!lc?.channel_id) return;
try {
const ch     = await guild.channels.fetch(lc.channel_id);
const botId  = guild.client?.user?.id;
const msgKey = `lobby_${letter}`;

```
// Delete ALL bot slot list messages for this lobby
const msgs = await ch.messages.fetch({ limit: 50 });
const toDelete = msgs.filter(m =>
  m.author.id === botId &&
  m.embeds?.[0]?.title?.includes(`Lobby ${letter}`)
);
for (const [, m] of toDelete) {
  try { await m.delete(); } catch {}
}

// Also nuke by stored ID
const ids = getPersistentSlotListId(guild.id, sessionId);
if (ids[msgKey]) {
  try { const old = await ch.messages.fetch(ids[msgKey]); await old.delete(); } catch {}
}

const embed = buildPersistentSlotList([], settings, letter);
const msg   = await ch.send({ embeds: [embed] });
setPersistentSlotListId(guild.id, { [msgKey]: msg.id }, sessionId);
```

} catch (err) {
console.error(‘postFreshLobbySlotList error:’, err.message);
}
}

// ─── /notify ──────────────────────────────────────────────────────────────────
const notifyCmd = {
data: new SlashCommandBuilder()
.setName(‘notify’)
.setDescription(‘Notify all registered teams (Admin only)’)
.addStringOption(opt => opt.setName(‘message’).setDescription(‘Message to send’).setRequired(true)),
async execute(interaction) {
if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed(‘Not Activated’, ‘Run `/activate` first.’)], ephemeral: true });
if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed(‘Access Denied’, ‘Admin only.’)], ephemeral: true });

```
const msg     = interaction.options.getString('message');
const config  = getConfig(interaction.guildId);
const data    = getRegistrations(interaction.guildId);
const all     = [...data.slots, ...data.waitlist];
if (all.length === 0) return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams.')], ephemeral: true });

const mention = config.registered_role ? `<@&${config.registered_role}>` : '@everyone';
const channel = config.register_channel
  ? await interaction.guild.channels.fetch(config.register_channel).catch(() => null)
  : interaction.channel;
if (channel) await channel.send({ content: `${mention}\n📣 **ADMIN NOTICE:** ${msg}` });

return interaction.reply({ embeds: [successEmbed('Notification Sent', `Sent to ${all.length} registered teams.`)], ephemeral: true });
```

},
};

// ─── /sheet ───────────────────────────────────────────────────────────────────
const sheetCmd = {
data: new SlashCommandBuilder()
.setName(‘sheet’)
.setDescription(‘Push all registered teams to Google Sheet (Admin only)’),
async execute(interaction) {
if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed(‘Not Activated’, ‘Run `/activate` first.’)], ephemeral: true });
if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed(‘Access Denied’, ‘Admin only.’)], ephemeral: true });

```
// Defer immediately before any async work
await interaction.deferReply({ ephemeral: true });

try {
  const sessions = getSessions(interaction.guildId);
  if (sessions.length === 0) {
    return interaction.editReply({ embeds: [errorEmbed('No Sessions', 'No sessions configured.')] });
  }

  const results = [];
  for (const s of sessions) {
    const sessionCfg = getSessionConfig(interaction.guildId, s.id);
    if (!sessionCfg.spreadsheet_id) { results.push(`**${s.name}** — no sheet linked`); continue; }
    const data     = getRegistrations(interaction.guildId, s.id);
    const assigned = data.slots.filter(t => t.lobby).length;
    if (assigned === 0) { results.push(`**${s.name}** — no assigned teams to sync`); continue; }
    await syncTeamsToSheet(sessionCfg.spreadsheet_id, data.slots);
    results.push(`**${s.name}** — synced **${assigned}** team(s) ✅`);
  }

  return interaction.editReply({
    embeds: [successEmbed('Sheet Updated ✅', results.join('\n'))],
  });
} catch (e) {
  console.error('❌ /sheet error:', e);
  return interaction.editReply({ embeds: [errorEmbed('Sheet Error', e.message)] });
}
```

},
};

// ─── /link ────────────────────────────────────────────────────────────────────
const linkCmd = {
data: new SlashCommandBuilder()
.setName(‘link’)
.setDescription(‘Get (or auto-generate) Google Sheets for all sessions (Admin only)’),
async execute(interaction) {
if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed(‘Not Activated’, ‘Run `/activate` first.’)], ephemeral: true });
if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed(‘Access Denied’, ‘Admin only.’)], ephemeral: true });

```
await interaction.deferReply({ ephemeral: true });

const sessions = getSessions(interaction.guildId);
if (sessions.length === 0) {
  return interaction.editReply({ embeds: [errorEmbed('No Sessions', 'No sessions configured. Use `/config` to create sessions first.')] });
}

const fields = [];
const toCreate = []; // sessions that need a new sheet

for (const s of sessions) {
  const sessionCfg = getSessionConfig(interaction.guildId, s.id);
  if (sessionCfg.spreadsheet_id && sessionCfg.sheet_url) {
    fields.push({ name: `📋 ${s.name}`, value: `[Open Sheet](${sessionCfg.sheet_url})`, inline: true });
  } else {
    toCreate.push(s);
    fields.push({ name: `📋 ${s.name}`, value: '⏳ Generating…', inline: true });
  }
}

await interaction.editReply({
  embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📊 Session Google Sheets').addFields(...fields).setTimestamp()],
});

// Generate sheets for sessions that don't have one yet
if (toCreate.length > 0) {
  const { setSessionConfig } = require('../../utils/database');
  for (const s of toCreate) {
    try {
      const settings      = getScrimSettings(interaction.guildId, s.id);
      const numLobbies    = settings.lobbies || 4;
      const lobbyLetters  = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
      const slotsPerLobby = settings.slots_per_lobby || 24;
      const scrimName     = settings.scrim_name || s.name;

      const { spreadsheetId, url } = await createServerSheet(scrimName, slotsPerLobby, lobbyLetters, 150);
      setSessionConfig(interaction.guildId, s.id, { spreadsheet_id: spreadsheetId, sheet_url: url });

      // Sync any existing registrations
      const data = getRegistrations(interaction.guildId, s.id);
      if (data.slots.length > 0) {
        await syncTeamsToSheet(spreadsheetId, data.slots).catch(() => {});
      }

      // Update that field to show the real link
      const idx = fields.findIndex(f => f.name === `📋 ${s.name}`);
      if (idx >= 0) fields[idx].value = `[Open Sheet](${url})`;
    } catch (err) {
      console.error(`❌ /link sheet generation error for session ${s.id}:`, err);
      const idx = fields.findIndex(f => f.name === `📋 ${s.name}`);
      if (idx >= 0) fields[idx].value = `❌ Failed: ${err.message}`;
    }
  }

  // Final update with all links resolved
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00C851)
        .setTitle('📊 Session Google Sheets')
        .addFields(...fields)
        .setFooter({ text: 'Links are permanent. Reset via /config → Reset Sheet Link.' })
        .setTimestamp(),
    ],
  });
}
```

},
};

// ─── /clear ───────────────────────────────────────────────────────────────────
const clearCmd = {
data: new SlashCommandBuilder()
.setName(‘clear’)
.setDescription(‘Clear registrations and reset channels (Admin only)’),

async execute(interaction) {
if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed(‘Not Activated’, ‘Run `/activate` first.’)], ephemeral: true });
if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed(‘Access Denied’, ‘Admin only.’)], ephemeral: true });

```
const sessions = getSessions(interaction.guildId);
if (sessions.length === 0) {
  return interaction.reply({ embeds: [errorEmbed('No Sessions', 'No sessions configured. Use `/config` to create sessions.')], ephemeral: true });
}

// ── Step 1: Pick session ──────────────────────────────────────────────
const sessionOptions = sessions.map((s, i) => ({
  label: `${String.fromCharCode(65 + i)} — ${s.name}`,
  value: s.id,
}));

const sessionMenu = new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
    .setCustomId('clear_session_pick')
    .setPlaceholder('Select a session to clear')
    .addOptions(sessionOptions)
);

const msg = await interaction.reply({
  content: '**Step 1 — Select a session:**',
  components: [sessionMenu],
  ephemeral: true,
  fetchReply: true,
});

let sessionPick;
try {
  sessionPick = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 });
} catch {
  return interaction.editReply({ content: 'Timed out.', components: [] });
}

const sessionId   = sessionPick.values[0];
const sessionInfo = sessions.find(s => s.id === sessionId);
const sessionName = sessionInfo.name;

// ── Step 2: Pick what to clear ────────────────────────────────────────
const settings     = getScrimSettings(interaction.guildId, sessionId);
const numLobbies   = settings.lobbies || 4;
const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);

const targetOptions = [
  { label: '🗑️ ALL — Clear everything', value: 'all', description: 'All lobbies, registration, slot allocation' },
  ...lobbyLetters.map(l => ({ label: `🏟️ Lobby ${l} only`, value: l })),
];

const targetMenu = new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
    .setCustomId('clear_target_pick')
    .setPlaceholder(`What to clear in ${sessionName}?`)
    .addOptions(targetOptions)
);

await sessionPick.update({
  content: `**Step 2 — What to clear in ${sessionName}?**`,
  components: [targetMenu],
});

let targetPick;
try {
  targetPick = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 });
} catch {
  return interaction.editReply({ content: 'Timed out.', components: [] });
}

const target = targetPick.values[0];
await targetPick.update({ content: `⏳ Clearing **${sessionName}**...`, components: [] });

// ── Load session data ─────────────────────────────────────────────────
const config     = getConfig(interaction.guildId);
const sessionCfg = getSessionConfig(interaction.guildId, sessionId);
const lobbyConf  = getLobbyConfig(interaction.guildId, sessionId);
const data       = getRegistrations(interaction.guildId, sessionId);

// ── CLEAR ALL ─────────────────────────────────────────────────────────
if (target === 'all') {
  const allTeams = [...data.slots, ...data.waitlist];

  const roleIds = [config.slot_role, config.waitlist_role, config.registered_role].filter(Boolean);
  for (const l of lobbyLetters) if (lobbyConf[l]?.role_id) roleIds.push(lobbyConf[l].role_id);
  for (const team of allTeams) {
    for (const pid of [...new Set([team.captain_id, ...(team.players || [])])]) {
      try {
        const m = await interaction.guild.members.fetch(pid);
        for (const r of roleIds) await m.roles.remove(r).catch(() => {});
      } catch {}
    }
  }

  clearRegistrations(interaction.guildId, sessionId);
  clearMatches(interaction.guildId, sessionId);
  setSessionServer(interaction.guildId, sessionId, { registration_open: false });
  setSlotListIds(interaction.guildId, {}, sessionId);

  if (sessionCfg.spreadsheet_id) {
    try { await clearTeamsFromSheet(sessionCfg.spreadsheet_id, settings.slots_per_lobby || 24, null); } catch (e) { console.error('Sheet clear error:', e.message); }
  }

  const regDeleted  = await purgeChannel(interaction.guild, sessionCfg.register_channel);
  const slotDeleted = await purgeChannel(interaction.guild, sessionCfg.slotlist_channel);

  for (const l of lobbyLetters) {
    if (lobbyConf[l]?.channel_id) await purgeChannel(interaction.guild, lobbyConf[l].channel_id);
  }
  for (const l of lobbyLetters) {
    await postFreshLobbySlotList(interaction.guild, l, lobbyConf, settings, sessionId);
  }

  return interaction.editReply({
    content: null,
    embeds: [new EmbedBuilder()
      .setColor(0x00FF7F).setTitle(`🗑️ CLEARED — ${sessionName} — ALL`)
      .setDescription(
        `✅ **${allTeams.length}** teams removed\n` +
        `🧹 Registration: **${regDeleted}** messages deleted\n` +
        `🧹 Slot allocation: **${slotDeleted}** messages deleted\n` +
        `📋 Fresh slot lists posted in all lobby channels\n` +
        `🎭 All roles stripped\n` +
        `📊 Sheet team data cleared (structure & link preserved)\n\n` +
        `Run \`/open\` from the registration channel to start a new registration.`
      ).setTimestamp()
    ],
    components: [],
  });

// ── CLEAR SPECIFIC LOBBY ──────────────────────────────────────────────
} else {
  const letter  = target;
  const lc      = lobbyConf[letter];
  const removed = data.slots.filter(t => t.lobby === letter);
  data.slots    = data.slots.filter(t => t.lobby !== letter);
  setRegistrations(interaction.guildId, data, sessionId);

  if (lc?.role_id) {
    for (const team of removed) {
      for (const pid of [...new Set([team.captain_id, ...(team.players || [])])]) {
        try { const m = await interaction.guild.members.fetch(pid); await m.roles.remove(lc.role_id).catch(() => {}); } catch {}
      }
    }
  }

  if (sessionCfg.spreadsheet_id) {
    try { await clearTeamsFromSheet(sessionCfg.spreadsheet_id, settings.slots_per_lobby || 24, [letter]); } catch (e) { console.error('Sheet clear error:', e.message); }
  }

  const lobbyDeleted = lc?.channel_id ? await purgeChannel(interaction.guild, lc.channel_id) : 0;
  setSlotListIds(interaction.guildId, { [`lobby_${letter}`]: null }, sessionId);
  await postFreshLobbySlotList(interaction.guild, letter, lobbyConf, settings, sessionId);

  return interaction.editReply({
    content: null,
    embeds: [new EmbedBuilder()
      .setColor(0xFFAA00).setTitle(`🏟️ CLEARED — ${sessionName} — LOBBY ${letter}`)
      .setDescription(
        `✅ **${removed.length}** teams unassigned from Lobby ${letter}\n` +
        `🧹 Lobby channel: **${lobbyDeleted}** messages deleted\n` +
        `📋 Fresh slot list posted in Lobby ${letter} channel\n` +
        `🎭 Lobby ${letter} role stripped\n` +
        `📊 Sheet: Lobby ${letter} tab data cleared`
      ).setTimestamp()
    ],
    components: [],
  });
}
```

},
};

// ─── /deactivate ──────────────────────────────────────────────────────────────
const deactivateCmd = {
data: new SlashCommandBuilder()
.setName(‘deactivate’)
.setDescription(‘Deactivate the scrim bot (Admin only)’),
async execute(interaction) {
if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed(‘Access Denied’, ‘Admin only.’)], ephemeral: true });
setServer(interaction.guildId, { active: false });
return interaction.reply({ embeds: [errorEmbed(‘Bot Deactivated’, ‘Scrim bot is now inactive. Run `/activate` to re-enable.’)] });
},
};

module.exports = [notifyCmd, sheetCmd, linkCmd, clearCmd, deactivateCmd];
