const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const {
  getConfig, setConfig, getRegistrations, setRegistrations, clearRegistrations,
  setServer, clearMatches, getScrimSettings, getLobbyConfig,
  getSessions, getSessionConfig, setSessionConfig, setSessionServer, setSlotListIds,
} = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { clearTeamsFromSheet, createServerSheet, syncTeamsToSheet, resizeLobbySheet } = require('../../utils/sheets');
const {
  buildPersistentSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
} = require('../../handlers/reactionHandler');

// ── Helper: purge all messages from a channel, no delays ──────────────────────
async function purgeChannel(guild, channelId) {
  if (!channelId) return 0;
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch?.isTextBased()) return 0;
    let deleted = 0;

    // Keep fetching and bulk-deleting until channel is empty
    while (true) {
      const msgs = await ch.messages.fetch({ limit: 100 });
      if (msgs.size === 0) break;

      // bulkDelete handles up to 100 at once, filters out >14 day old messages automatically
      if (msgs.size >= 2) {
        const result = await ch.bulkDelete(msgs, true).catch(() => null);
        const bulkCount = result?.size ?? 0;
        deleted += bulkCount;

        // Any that bulkDelete couldn't handle (>14 days old) — delete via REST directly
        const remaining = msgs.filter(m => !result?.has(m.id));
        await Promise.all(remaining.map(m => m.delete().catch(() => {})));
        deleted += remaining.size;
      } else {
        await Promise.all(msgs.map(m => m.delete().catch(() => {})));
        deleted += msgs.size;
      }

      if (msgs.size < 100) break;
    }
    return deleted;
  } catch (err) {
    console.error('⚠️ purgeChannel error:', err.message);
    return 0;
  }
}

// ── Helper: strip roles from all players in parallel, no delays ───────────────
async function stripRoles(guild, playerIds, roleIds) {
  if (!playerIds.length || !roleIds.length) return;

  // Fetch all members in one bulk call
  let members = new Map();
  try {
    const fetched = await guild.members.fetch({ user: playerIds });
    members = fetched;
  } catch {
    // Fallback: fetch in parallel
    const results = await Promise.allSettled(playerIds.map(id => guild.members.fetch(id)));
    results.forEach(r => { if (r.status === 'fulfilled') members.set(r.value.id, r.value); });
  }

  // Remove all roles from all members simultaneously
  await Promise.allSettled([...members.values()].map(member =>
    Promise.allSettled(roleIds.map(roleId => member.roles.remove(roleId).catch(() => {})))
  ));
}

// ── Helper: post fresh empty slot list in a lobby channel ─────────────────────
async function postFreshLobbySlotList(guild, letter, lobbyConf, settings, sessionId = null) {
  const lc = lobbyConf[letter];
  if (!lc?.channel_id) return;
  try {
    const ch     = await guild.channels.fetch(lc.channel_id);
    const botId  = guild.client?.user?.id;
    const msgKey = `lobby_${letter}`;

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
  } catch (err) {
    console.error('postFreshLobbySlotList error:', err.message);
  }
}

// ─── /notify ──────────────────────────────────────────────────────────────────
const notifyCmd = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Notify all registered teams (Admin only)')
    .addStringOption(opt => opt.setName('message').setDescription('Message to send').setRequired(true)),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], flags: 64 });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], flags: 64 });

    const msg     = interaction.options.getString('message');
    const config  = getConfig(interaction.guildId);
    const data    = getRegistrations(interaction.guildId);
    const all     = [...data.slots, ...data.waitlist];
    if (all.length === 0) return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams.')], flags: 64 });

    const mention = config.registered_role ? `<@&${config.registered_role}>` : '@everyone';
    const channel = config.register_channel
      ? await interaction.guild.channels.fetch(config.register_channel).catch(() => null)
      : interaction.channel;
    if (channel) await channel.send({ content: `${mention}\n📣 **ADMIN NOTICE:** ${msg}` });

    return interaction.reply({ embeds: [successEmbed('Notification Sent', `Sent to ${all.length} registered teams.`)], flags: 64 });
  },
};

// ─── /sheet ───────────────────────────────────────────────────────────────────
const sheetCmd = {
  data: new SlashCommandBuilder()
    .setName('sheet')
    .setDescription('Push all registered teams to Google Sheet (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], flags: 64 });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], flags: 64 });

    // Defer immediately before any async work
    await interaction.deferReply({ flags: 64 });

    try {
      const sessions = getSessions(interaction.guildId);
      if (sessions.length === 0) {
        return interaction.editReply({ embeds: [errorEmbed('No Sessions', 'No sessions configured.')] });
      }

      const results = [];
      for (const s of sessions) {
        const sessionCfg = getSessionConfig(interaction.guildId, s.id);
        if (!sessionCfg.spreadsheet_id) { results.push(`**${s.name}** — no sheet linked`); continue; }
        const data          = getRegistrations(interaction.guildId, s.id);
        const assigned      = data.slots.filter(t => t.lobby).length;
        if (assigned === 0) { results.push(`**${s.name}** — no assigned teams to sync`); continue; }
        const settings      = getScrimSettings(interaction.guildId, s.id);
        const slotsPerLobby = settings.slots_per_lobby || 24;
        const numLobbies    = settings.lobbies || 4;
        const lobbyLetters  = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
        const firstSlot = settings.first_slot || 1;
        for (const letter of lobbyLetters) {
          try {
            console.log(`[/sheet] Resizing Lobby ${letter} to ${slotsPerLobby} slots (firstSlot=${firstSlot})...`);
            await resizeLobbySheet(sessionCfg.spreadsheet_id, letter, slotsPerLobby, 150, firstSlot);
            console.log(`[/sheet] Lobby ${letter} resize done`);
          } catch (resizeErr) {
            console.error(`[/sheet] Resize error Lobby ${letter}:`, resizeErr.message);
          }
        }
        await syncTeamsToSheet(sessionCfg.spreadsheet_id, data.slots, slotsPerLobby, firstSlot);
        results.push(`**${s.name}** — synced **${assigned}** team(s) ✅`);
      }

      return interaction.editReply({
        embeds: [successEmbed('Sheet Updated ✅', results.join('\n'))],
      });
    } catch (e) {
      console.error('❌ /sheet error:', e);
      return interaction.editReply({ embeds: [errorEmbed('Sheet Error', e.message)] });
    }
  },
};

// ─── /link ────────────────────────────────────────────────────────────────────
const linkCmd = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Get (or auto-generate) Google Sheets for all sessions (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], flags: 64 });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], flags: 64 });

    await interaction.deferReply({ flags: 64 });

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

          const firstSlotCreate = settings.first_slot || 1;
          const { spreadsheetId, url } = await createServerSheet(scrimName, slotsPerLobby, lobbyLetters, 150, firstSlotCreate);
          setSessionConfig(interaction.guildId, s.id, { spreadsheet_id: spreadsheetId, sheet_url: url });

          // Sync any existing registrations
          const data = getRegistrations(interaction.guildId, s.id);
          if (data.slots.length > 0) {
            await syncTeamsToSheet(spreadsheetId, data.slots, slotsPerLobby, firstSlotCreate).catch(() => {});
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
  },
};

// ─── /clear ───────────────────────────────────────────────────────────────────
const clearCmd = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear registrations and reset channels (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], flags: 64 });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], flags: 64 });

    const sessions = getSessions(interaction.guildId);
    if (sessions.length === 0) {
      return interaction.reply({ embeds: [errorEmbed('No Sessions', 'No sessions configured. Use `/config` to create sessions.')], flags: 64 });
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

    await interaction.reply({
      content: '**Step 1 — Select a session:**',
      components: [sessionMenu],
      flags: 64,
    });

    let sessionPick;
    try {
      sessionPick = await interaction.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 });
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
      targetPick = await interaction.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 });
    } catch {
      return interaction.editReply({ content: 'Timed out.', components: [] });
    }

    const target = targetPick.values[0];
    // Acknowledge the dropdown immediately — then use interaction.editReply for the final result
    await targetPick.deferUpdate();
    await interaction.editReply({ content: `⏳ Clearing **${sessionName}**...`, components: [], embeds: [] });

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

      const allPlayerIds = [...new Set(
        allTeams.flatMap(team => [team.captain_id, ...(team.players || [])]).filter(Boolean)
      )];
      await stripRoles(interaction.guild, allPlayerIds, roleIds);

      clearRegistrations(interaction.guildId, sessionId);
      clearMatches(interaction.guildId, sessionId);
      setSessionServer(interaction.guildId, sessionId, { registration_open: false });
      setSlotListIds(interaction.guildId, {}, sessionId);

      if (sessionCfg.spreadsheet_id) {
        try { await clearTeamsFromSheet(sessionCfg.spreadsheet_id, settings.slots_per_lobby || 24, null); } catch (e) { console.error('Sheet clear error:', e.message); }
      }

      // Purge all channels in parallel
      const [regDeleted, slotDeleted, ...lobbyDeletedArr] = await Promise.all([
        purgeChannel(interaction.guild, sessionCfg.register_channel),
        purgeChannel(interaction.guild, sessionCfg.slotlist_channel),
        ...lobbyLetters.map(l => lobbyConf[l]?.channel_id
          ? purgeChannel(interaction.guild, lobbyConf[l].channel_id)
          : Promise.resolve(0)
        ),
      ]);

      for (const l of lobbyLetters) {
        await postFreshLobbySlotList(interaction.guild, l, lobbyConf, settings, sessionId);
      }

      return interaction.editReply({
        content: '',
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
        const lobbyPlayerIds = [...new Set(
          removed.flatMap(team => [team.captain_id, ...(team.players || [])]).filter(Boolean)
        )];
        await stripRoles(interaction.guild, lobbyPlayerIds, [lc.role_id]);
      }

      if (sessionCfg.spreadsheet_id) {
        try { await clearTeamsFromSheet(sessionCfg.spreadsheet_id, settings.slots_per_lobby || 24, [letter]); } catch (e) { console.error('Sheet clear error:', e.message); }
      }

      const lobbyDeleted = lc?.channel_id ? await purgeChannel(interaction.guild, lc.channel_id) : 0;
      setSlotListIds(interaction.guildId, { [`lobby_${letter}`]: null }, sessionId);
      await postFreshLobbySlotList(interaction.guild, letter, lobbyConf, settings, sessionId);

      return interaction.editReply({
        content: '',
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
  },
};

// ─── /deactivate ──────────────────────────────────────────────────────────────
const deactivateCmd = {
  data: new SlashCommandBuilder()
    .setName('deactivate')
    .setDescription('Deactivate the scrim bot (Admin only)'),
  async execute(interaction) {
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], flags: 64 });
    setServer(interaction.guildId, { active: false });
    return interaction.reply({ embeds: [errorEmbed('Bot Deactivated', 'Scrim bot is now inactive. Run `/activate` to re-enable.')] });
  },
};

module.exports = [notifyCmd, sheetCmd, linkCmd, clearCmd, deactivateCmd];
