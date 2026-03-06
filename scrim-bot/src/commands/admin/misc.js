const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations, clearRegistrations,
  setServer, clearMatches, getScrimSettings, getLobbyConfig
} = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { clearTeamsFromSheet } = require('../../utils/sheets');
const {
  buildPersistentSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
} = require('../../handlers/reactionHandler');

// ── Helper: bulk delete all messages in a channel ─────────────────────────────
async function purgeChannel(guild, channelId) {
  if (!channelId) return 0;
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch) return 0;
    let deleted = 0;
    // Bulk delete in batches of 100 (Discord limit)
    while (true) {
      const msgs = await ch.messages.fetch({ limit: 100 });
      if (msgs.size === 0) break;
      // Messages older than 14 days can't be bulk-deleted — delete individually
      const recent = msgs.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      const old    = msgs.filter(m => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);
      if (recent.size > 1) {
        await ch.bulkDelete(recent).catch(() => {});
        deleted += recent.size;
      } else if (recent.size === 1) {
        await recent.first().delete().catch(() => {});
        deleted++;
      }
      for (const msg of old.values()) {
        await msg.delete().catch(() => {});
        deleted++;
      }
      if (msgs.size < 100) break;
    }
    return deleted;
  } catch (err) {
    console.error(`⚠️ purgeChannel error:`, err.message);
    return 0;
  }
}

// ── Helper: post fresh empty slot list in a lobby channel ─────────────────────
async function postFreshLobbySlotList(guild, letter, lobbyConf, settings) {
  const lc = lobbyConf[letter];
  if (!lc?.channel_id) return;
  try {
    const ch    = await guild.channels.fetch(lc.channel_id);
    const embed = buildPersistentSlotList([], settings, letter);
    const msg   = await ch.send({ embeds: [embed] });
    try { await msg.pin(); } catch {}
    // Save the new message ID
    setPersistentSlotListId(guild.id, { [`lobby_${letter}`]: msg.id });
  } catch (err) {
    console.error(`⚠️ postFreshLobbySlotList error:`, err.message);
  }
}

// ─── /notify ──────────────────────────────────────────────────────────────────
const notifyCmd = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Notify all registered teams (Admin only)')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Message to send').setRequired(true)
    ),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const msg    = interaction.options.getString('message');
    const config = getConfig(interaction.guildId);
    const data   = getRegistrations(interaction.guildId);
    const all    = [...data.slots, ...data.waitlist];

    if (all.length === 0) return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams.')], ephemeral: true });

    const mention = config.registered_role ? `<@&${config.registered_role}>` : '@everyone';
    const channel = config.register_channel
      ? await interaction.guild.channels.fetch(config.register_channel).catch(() => null)
      : interaction.channel;

    if (channel) await channel.send({ content: `${mention}\n📣 **ADMIN NOTICE:** ${msg}` });

    return interaction.reply({ embeds: [successEmbed('Notification Sent', `Sent to ${all.length} registered teams.`)], ephemeral: true });
  }
};

// ─── /sheet ───────────────────────────────────────────────────────────────────
const sheetCmd = {
  data: new SlashCommandBuilder()
    .setName('sheet')
    .setDescription('Push current teams to Google Sheet (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config = getConfig(interaction.guildId);
    if (!config.sheet_url) return interaction.reply({ embeds: [errorEmbed('No Sheet', 'Set a Google Sheet URL in `/config` first.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    const data = getRegistrations(interaction.guildId);
    try {
      await writeRegistrationSheet(extractSheetId(config.sheet_url), data.slots);
      return interaction.editReply({ embeds: [successEmbed('Sheet Updated', `Pushed **${data.slots.length}** teams.`)] });
    } catch (e) {
      return interaction.editReply({ embeds: [errorEmbed('Sheet Error', e.message)] });
    }
  }
};

// ─── /link ────────────────────────────────────────────────────────────────────
const linkCmd = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Get the Google Sheet link (Admin only)'),
  async execute(interaction) {
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
    const config = getConfig(interaction.guildId);
    if (!config.sheet_url) return interaction.reply({ embeds: [errorEmbed('No Sheet', 'No sheet configured.')], ephemeral: true });
    return interaction.reply({ embeds: [infoEmbed('Google Sheet', `[📋 Click to open](${config.sheet_url})`)], ephemeral: true });
  }
};

// ─── /clear ───────────────────────────────────────────────────────────────────
const clearCmd = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear registrations and reset channels (Admin only)')
    .addStringOption(opt =>
      opt.setName('target')
        .setDescription('What to clear')
        .setRequired(true)
        .addChoices(
          { name: '🗑️ ALL — Clear everything (all lobbies, registration, slot allocation)', value: 'all' },
          { name: '🏟️ Lobby A', value: 'A' },
          { name: '🏟️ Lobby B', value: 'B' },
          { name: '🏟️ Lobby C', value: 'C' },
          { name: '🏟️ Lobby D', value: 'D' },
          { name: '🏟️ Lobby E', value: 'E' },
          { name: '🏟️ Lobby F', value: 'F' },
        )
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const target   = interaction.options.getString('target');
    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);
    const lobbyConf = getLobbyConfig(interaction.guildId);
    const data     = getRegistrations(interaction.guildId);

    await interaction.deferReply({ ephemeral: true });

    // ── CLEAR ALL ────────────────────────────────────────────────────────────
    if (target === 'all') {
      const allTeams = [...data.slots, ...data.waitlist];

      // Strip all roles from every player
      const roleIds = [config.slot_role, config.waitlist_role, config.registered_role, config.idpass_role].filter(Boolean);
      // Also strip all lobby roles
      const lobbyLetters = ['A','B','C','D','E','F'].slice(0, settings.lobbies || 4);
      for (const letter of lobbyLetters) {
        if (lobbyConf[letter]?.role_id) roleIds.push(lobbyConf[letter].role_id);
      }

      for (const team of allTeams) {
        for (const playerId of [...new Set([team.captain_id, ...(team.players || [])])]) {
          try {
            const member = await interaction.guild.members.fetch(playerId);
            for (const roleId of roleIds) await member.roles.remove(roleId).catch(() => {});
          } catch {}
        }
      }

      // Clear all data
      clearRegistrations(interaction.guildId);
      clearMatches(interaction.guildId);
      // Clear sheet teams
      const cfg = getConfig(interaction.guildId);
      const stg = getScrimSettings(interaction.guildId);
      if (cfg.spreadsheet_id) {
        try { await clearTeamsFromSheet(cfg.spreadsheet_id, stg.slots_per_lobby || 24); } catch {}
      }
      setServer(interaction.guildId, { registration_open: false });
      // Clear all stored message IDs
      setPersistentSlotListId(interaction.guildId, {});

      // Purge registration channel
      const regDeleted  = await purgeChannel(interaction.guild, config.register_channel);
      // Purge slot allocation channel
      const slotDeleted = await purgeChannel(interaction.guild, config.slotlist_channel);

      // Post fresh empty slot list in each lobby channel
      for (const letter of lobbyLetters) {
        await postFreshLobbySlotList(interaction.guild, letter, lobbyConf, settings);
      }

      // Post fresh overall slot list in overall channel (if different from slot allocation)
      const overallChannelId = config.idpass_channel;
      if (overallChannelId && overallChannelId !== config.slotlist_channel) {
        try {
          const ch    = await interaction.guild.channels.fetch(overallChannelId);
          const embed = buildPersistentSlotList([], settings);
          const msg   = await ch.send({ embeds: [embed] });
          try { await msg.pin(); } catch {}
          setPersistentSlotListId(interaction.guildId, { overall: msg.id });
        } catch {}
      }

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x00FF7F)
          .setTitle('🗑️ CLEARED — ALL')
          .setDescription(
            `✅ **${allTeams.length}** teams removed\n` +
            `🧹 Registration channel: **${regDeleted}** messages deleted\n` +
            `🧹 Slot allocation: **${slotDeleted}** messages deleted\n` +
            `📋 Fresh slot lists posted in all lobby channels\n` +
            `🎭 All roles stripped from all players\n\n` +
            `Run \`/open\` to start a new registration.`
          )
          .setTimestamp()
        ]
      });

    // ── CLEAR SPECIFIC LOBBY ─────────────────────────────────────────────────
    } else {
      const letter   = target; // 'A', 'B', etc.
      const lc       = lobbyConf[letter];

      // Remove teams assigned to this lobby
      const removed = data.slots.filter(t => t.lobby === letter);
      data.slots = data.slots.filter(t => t.lobby !== letter);
      setRegistrations(interaction.guildId, data);

      // Strip lobby role from removed teams
      if (lc?.role_id) {
        for (const team of removed) {
          for (const playerId of [...new Set([team.captain_id, ...(team.players || [])])]) {
            try {
              const member = await interaction.guild.members.fetch(playerId);
              await member.roles.remove(lc.role_id).catch(() => {});
            } catch {}
          }
        }
      }

      // Purge the lobby's private channel
      let lobbyDeleted = 0;
      if (lc?.channel_id) {
        lobbyDeleted = await purgeChannel(interaction.guild, lc.channel_id);
      }

      // Clear stored message ID for this lobby
      setPersistentSlotListId(interaction.guildId, { [`lobby_${letter}`]: null });

      // Post fresh empty slot list in lobby channel
      await postFreshLobbySlotList(interaction.guild, letter, lobbyConf, settings);

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle(`🏟️ CLEARED — LOBBY ${letter}`)
          .setDescription(
            `✅ **${removed.length}** teams unassigned from Lobby ${letter}\n` +
            `🧹 Lobby channel: **${lobbyDeleted}** messages deleted\n` +
            `📋 Fresh slot list posted in Lobby ${letter} channel\n` +
            `🎭 Lobby ${letter} role stripped from affected players`
          )
          .setTimestamp()
        ]
      });
    }
  }
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
  }
};

module.exports = [notifyCmd, sheetCmd, linkCmd, clearCmd, deactivateCmd];
