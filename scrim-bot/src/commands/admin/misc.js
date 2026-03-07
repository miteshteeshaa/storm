const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getConfig, setConfig, getRegistrations, setRegistrations, clearRegistrations,
  setServer, clearMatches, getScrimSettings, getLobbyConfig,
} = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { clearTeamsFromSheet, createServerSheet, syncTeamsToSheet } = require('../../utils/sheets');
const {
  buildPersistentSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
} = require('../../handlers/reactionHandler');

// ── Helper: bulk delete messages in a channel ─────────────────────────────────
async function purgeChannel(guild, channelId) {
  if (!channelId) return 0;
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch) return 0;
    let deleted = 0;
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    while (true) {
      const msgs   = await ch.messages.fetch({ limit: 100 });
      if (msgs.size === 0) break;
      const recent = msgs.filter(m => m.createdTimestamp > cutoff);
      if (recent.size === 0) break;
      if (recent.size === 1) { await recent.first().delete().catch(() => {}); deleted++; }
      else { await ch.bulkDelete(recent).catch(() => {}); deleted += recent.size; }
      if (msgs.size < 100) break;
    }
    return deleted;
  } catch (err) {
    console.error('⚠️ purgeChannel error:', err.message);
    return 0;
  }
}

// ── Helper: post fresh empty slot list in a lobby channel ─────────────────────
async function postFreshLobbySlotList(guild, letter, lobbyConf, settings) {
  const lc = lobbyConf[letter];
  if (!lc?.channel_id) return;
  try {
    const ch     = await guild.channels.fetch(lc.channel_id);
    const botId  = guild.client?.user?.id;
    const msgKey = `lobby_${letter}`;

    // Delete ALL bot slot list messages for this lobby (works even after restart with no stored IDs)
    const msgs = await ch.messages.fetch({ limit: 50 });
    const toDelete = msgs.filter(m =>
      m.author.id === botId &&
      m.embeds?.[0]?.title?.includes(`Lobby ${letter}`)
    );
    for (const [, m] of toDelete) {
      try { await m.delete(); } catch {}
    }

    // Also nuke by stored ID in case it wasn't caught above
    const ids = getPersistentSlotListId(guild.id);
    if (ids[msgKey]) {
      try { const old = await ch.messages.fetch(ids[msgKey]); await old.delete(); } catch {}
    }

    // Post fresh empty slot list (no pin — pin system messages break scan logic)
    const embed = buildPersistentSlotList([], settings, letter);
    const msg   = await ch.send({ embeds: [embed] });
    setPersistentSlotListId(guild.id, { [msgKey]: msg.id });
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
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

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
  },
};

// ─── /sheet ───────────────────────────────────────────────────────────────────
// Manually push ALL registered teams to Google Sheet
const sheetCmd = {
  data: new SlashCommandBuilder()
    .setName('sheet')
    .setDescription('Push all registered teams to Google Sheet (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config = getConfig(interaction.guildId);
    if (!config.spreadsheet_id) return interaction.reply({ embeds: [errorEmbed('No Sheet', 'No sheet linked. Use `/link` to generate one.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    const data = getRegistrations(interaction.guildId);

    try {
      await syncTeamsToSheet(config.spreadsheet_id, data.slots);
      const assigned = data.slots.filter(t => t.lobby).length;
      return interaction.editReply({
        embeds: [successEmbed('Sheet Updated ✅', `Synced **${assigned}** assigned team(s) to Google Sheet.\n[📋 Open Sheet](${config.sheet_url})`)],
      });
    } catch (e) {
      console.error('❌ /sheet error:', e);
      return interaction.editReply({ embeds: [errorEmbed('Sheet Error', e.message)] });
    }
  },
};

// ─── /link ────────────────────────────────────────────────────────────────────
// Returns existing sheet link (permanent) or generates a new one if none exists.
// Link can only be reset via /config → "Reset Sheet Link".
const linkCmd = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Get (or auto-generate) the Google Sheet for this scrim (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);

    // ── Sheet already exists → return permanent link ──────────────────────
    if (config.spreadsheet_id && config.sheet_url) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📊 Scrim Google Sheet')
            .setDescription(`[📋 Click here to open the sheet](${config.sheet_url})`)
            .addFields(
              { name: '📌 Note', value: 'This link is permanent. To generate a new sheet, reset the Sheet URL in `/config`.', inline: false }
            )
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    // ── No sheet yet → auto-generate one ─────────────────────────────────
    await interaction.deferReply({ ephemeral: true });

    try {
      const numLobbies    = settings.lobbies || 4;
      const lobbyLetters  = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);
      const slotsPerLobby = settings.slots_per_lobby || 24;
      const scrimName     = settings.scrim_name || 'SCRIM';

      await interaction.editReply({
        embeds: [infoEmbed('⏳ Generating Sheet…',
          `Creating sheet for **${scrimName}** with **${numLobbies}** lobby tab(s) and **150 matches** each.\nThis may take up to a minute…`)],
      });

      const { spreadsheetId, url } = await createServerSheet(scrimName, slotsPerLobby, lobbyLetters, 150);

      // Save permanently — will NOT be overwritten by /link again
      setConfig(interaction.guildId, { spreadsheet_id: spreadsheetId, sheet_url: url });

      // Sync any teams already registered
      const data = getRegistrations(interaction.guildId);
      if (data.slots.length > 0) {
        await syncTeamsToSheet(spreadsheetId, data.slots).catch(() => {});
      }

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00C851)
            .setTitle('✅ Google Sheet Created!')
            .setDescription(`[📋 Click here to open](${url})`)
            .addFields(
              { name: '🏟️ Lobby Tabs',         value: lobbyLetters.map(l => `Lobby ${l}`).join(', '), inline: true },
              { name: '🎮 Matches per Lobby',   value: '150',                                         inline: true },
              { name: '👥 Slots per Lobby',     value: String(slotsPerLobby),                         inline: true },
              { name: '📌 Permanent Link',      value: 'Use `/link` any time to get this URL again.\nTo reset, go to `/config` → Reset Sheet Link.', inline: false },
            )
            .setFooter({ text: 'Teams sync automatically every 20 min, or use /sheet to sync now.' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('❌ /link sheet generation error:', err);
      return interaction.editReply({
        embeds: [errorEmbed('Sheet Generation Failed',
          `Could not create sheet: ${err.message}\n\nCheck that \`GOOGLE_SERVICE_EMAIL\` and \`GOOGLE_PRIVATE_KEY\` env vars are set.`)],
      });
    }
  },
};

// ─── /clear ───────────────────────────────────────────────────────────────────
// Clears Discord data + sheet DATA only (never touches the sheet link/structure)
const clearCmd = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear registrations and reset channels (Admin only)')
    .addStringOption(opt =>
      opt.setName('target').setDescription('What to clear').setRequired(true)
        .addChoices(
          { name: '🗑️ ALL — Clear everything (all lobbies, registration, slot allocation)', value: 'all' },
          { name: '🏟️ Lobby A', value: 'A' }, { name: '🏟️ Lobby B', value: 'B' },
          { name: '🏟️ Lobby C', value: 'C' }, { name: '🏟️ Lobby D', value: 'D' },
          { name: '🏟️ Lobby E', value: 'E' }, { name: '🏟️ Lobby F', value: 'F' },
          { name: '🏟️ Lobby G', value: 'G' }, { name: '🏟️ Lobby H', value: 'H' },
          { name: '🏟️ Lobby I', value: 'I' }, { name: '🏟️ Lobby J', value: 'J' },
        )
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))       return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const target    = interaction.options.getString('target');
    const config    = getConfig(interaction.guildId);
    const settings  = getScrimSettings(interaction.guildId);
    const lobbyConf = getLobbyConfig(interaction.guildId);
    const data      = getRegistrations(interaction.guildId);

    await interaction.deferReply({ ephemeral: true });

    // ── CLEAR ALL ─────────────────────────────────────────────────────────────
    if (target === 'all') {
      const allTeams     = [...data.slots, ...data.waitlist];
      const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, settings.lobbies || 4);

      // Strip roles
      const roleIds = [config.slot_role, config.waitlist_role, config.registered_role, config.idpass_role].filter(Boolean);
      for (const l of lobbyLetters) if (lobbyConf[l]?.role_id) roleIds.push(lobbyConf[l].role_id);
      for (const team of allTeams) {
        for (const pid of [...new Set([team.captain_id, ...(team.players || [])])]) {
          try { const m = await interaction.guild.members.fetch(pid); for (const r of roleIds) await m.roles.remove(r).catch(() => {}); } catch {}
        }
      }

      // Clear Discord data (NOT sheet_url / spreadsheet_id)
      clearRegistrations(interaction.guildId);
      clearMatches(interaction.guildId);
      setServer(interaction.guildId, { registration_open: false });
      setPersistentSlotListId(interaction.guildId, {});

      // Clear ONLY the team data cells in the sheet (keep structure & link)
      const cfg = getConfig(interaction.guildId);
      const stg = getScrimSettings(interaction.guildId);
      if (cfg.spreadsheet_id) {
        try { await clearTeamsFromSheet(cfg.spreadsheet_id, stg.slots_per_lobby || 24, null); } catch (e) { console.error('Sheet clear error:', e.message); }
      }

      // Purge channels
      const regDeleted  = await purgeChannel(interaction.guild, config.register_channel);
      const slotDeleted = await purgeChannel(interaction.guild, config.slotlist_channel);

      // Fresh slot lists
      for (const l of lobbyLetters) await postFreshLobbySlotList(interaction.guild, l, lobbyConf, settings);

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x00FF7F).setTitle('🗑️ CLEARED — ALL')
          .setDescription(
            `✅ **${allTeams.length}** teams removed\n` +
            `🧹 Registration: **${regDeleted}** messages deleted\n` +
            `🧹 Slot allocation: **${slotDeleted}** messages deleted\n` +
            `📋 Fresh slot lists posted in all lobby channels\n` +
            `🎭 All roles stripped\n` +
            `📊 Sheet team data cleared (structure & link preserved)\n\n` +
            `Run \`/open\` to start a new registration.`
          ).setTimestamp()
        ],
      });

    // ── CLEAR SPECIFIC LOBBY ──────────────────────────────────────────────────
    } else {
      const letter  = target;
      const lc      = lobbyConf[letter];
      const removed = data.slots.filter(t => t.lobby === letter);
      data.slots    = data.slots.filter(t => t.lobby !== letter);
      setRegistrations(interaction.guildId, data);

      // Strip lobby role
      if (lc?.role_id) {
        for (const team of removed) {
          for (const pid of [...new Set([team.captain_id, ...(team.players || [])])]) {
            try { const m = await interaction.guild.members.fetch(pid); await m.roles.remove(lc.role_id).catch(() => {}); } catch {}
          }
        }
      }

      // Clear ONLY this lobby's tab in the sheet (keep everything else)
      const cfg = getConfig(interaction.guildId);
      const stg = getScrimSettings(interaction.guildId);
      if (cfg.spreadsheet_id) {
        try { await clearTeamsFromSheet(cfg.spreadsheet_id, stg.slots_per_lobby || 24, [letter]); } catch (e) { console.error('Sheet clear error:', e.message); }
      }

      const lobbyDeleted = lc?.channel_id ? await purgeChannel(interaction.guild, lc.channel_id) : 0;
      setPersistentSlotListId(interaction.guildId, { [`lobby_${letter}`]: null });
      await postFreshLobbySlotList(interaction.guild, letter, lobbyConf, settings);

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xFFAA00).setTitle(`🏟️ CLEARED — LOBBY ${letter}`)
          .setDescription(
            `✅ **${removed.length}** teams unassigned from Lobby ${letter}\n` +
            `🧹 Lobby channel: **${lobbyDeleted}** messages deleted\n` +
            `📋 Fresh slot list posted in Lobby ${letter} channel\n` +
            `🎭 Lobby ${letter} role stripped\n` +
            `📊 Sheet: Lobby ${letter} tab data cleared (link & other lobbies preserved)`
          ).setTimestamp()
        ],
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
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
    setServer(interaction.guildId, { active: false });
    return interaction.reply({ embeds: [errorEmbed('Bot Deactivated', 'Scrim bot is now inactive. Run `/activate` to re-enable.')] });
  },
};

module.exports = [notifyCmd, sheetCmd, linkCmd, clearCmd, deactivateCmd];
