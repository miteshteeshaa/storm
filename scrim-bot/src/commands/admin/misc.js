const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, clearRegistrations,
  setServer, clearMatches, getScrimSettings, getLobbyConfig
} = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { extractSheetId, writeRegistrationSheet } = require('../../utils/sheets');
const {
  buildLobbySlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  clearPersistentSlotListIds,
  postToLobbyChannel,
} = require('../../handlers/reactionHandler');

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
      await writeRegistrationSheet(extractSheetId(config.sheet_url), data.slots, interaction.client);
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
    .setDescription('Clear a lobby or all registrations (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config     = getConfig(interaction.guildId);
    const settings   = getScrimSettings(interaction.guildId);
    const lobbyConf  = getLobbyConfig(interaction.guildId);
    const numLobbies = settings.lobbies || 4;
    const lobbyLetters = ['A','B','C','D','E','F','G','H','I','J'].slice(0, numLobbies);

    // ── Build select menu with individual lobbies + Clear All ─────────────────
    const options = lobbyLetters.map(l => ({
      label: `Clear Lobby ${l}`,
      value: `clear_lobby_${l}`,
      description: `Remove all Lobby ${l} teams and reset its slot list`,
    }));
    options.push({
      label: 'Clear All',
      value: 'clear_all',
      description: 'Remove ALL teams, clear ALL channels, close registration',
    });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('clear_select')
        .setPlaceholder('Select what to clear...')
        .addOptions(options)
    );

    // Send ephemeral reply with the select menu
    await interaction.reply({
      embeds: [{ color: 0xFF6600, description: '⚠️ **Select what to clear:**' }],
      components: [row],
      ephemeral: true,
      fetchReply: true,
    });

    // Collect the selection directly from the interaction (works with ephemeral)
    let choice;
    try {
      const sel = await interaction.awaitMessageComponent({
        filter: x => x.customId === 'clear_select' && x.user.id === interaction.user.id,
        time: 60_000,
      });
      choice = sel.values[0];
      // Acknowledge the component interaction immediately
      await sel.deferUpdate();
    } catch {
      return interaction.editReply({ embeds: [errorEmbed('Timed Out', 'No selection made.')], components: [] });
    }

    // ── Helper: delete all recent messages in a channel ───────────────────────
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
    async function purgeChannel(chId) {
      try {
        const ch = await interaction.guild.channels.fetch(chId);
        if (!ch) return;
        let keepGoing = true;
        while (keepGoing) {
          const messages = await ch.messages.fetch({ limit: 100 });
          if (messages.size === 0) break;
          const deletable = messages.filter(m => Date.now() - m.createdTimestamp < TWO_WEEKS);
          if (deletable.size === 0) break;
          if (deletable.size === 1) await deletable.first().delete().catch(() => {});
          else await ch.bulkDelete(deletable, true).catch(() => {});
          if (messages.size < 100 && deletable.size === messages.size) keepGoing = false;
        }
      } catch {}
    }

    // ── Helper: strip roles from a list of teams ──────────────────────────────
    const roleIds = [config.slot_role, config.waitlist_role, config.registered_role, config.idpass_role].filter(Boolean);
    async function stripRoles(teams) {
      for (const team of teams) {
        const ids = new Set([team.captain_id, team.manager_id, ...(team.players || [])].filter(Boolean));
        for (const playerId of ids) {
          try {
            const m = await interaction.guild.members.fetch(playerId);
            for (const rId of roleIds) await m.roles.remove(rId).catch(() => {});
          } catch {}
        }
        // Also strip lobby role
        if (team.lobby && lobbyConf[team.lobby]?.role_id) {
          const ids2 = new Set([team.captain_id, team.manager_id, ...(team.players || [])].filter(Boolean));
          for (const playerId of ids2) {
            try {
              const m = await interaction.guild.members.fetch(playerId);
              await m.roles.remove(lobbyConf[team.lobby].role_id).catch(() => {});
            } catch {}
          }
        }
      }
    }

    // ── CLEAR SINGLE LOBBY ────────────────────────────────────────────────────
    if (choice.startsWith('clear_lobby_')) {
      const letter = choice.replace('clear_lobby_', '');
      const data   = getRegistrations(interaction.guildId);

      // Find teams in this lobby
      const lobbyTeams   = data.slots.filter(t => t.lobby === letter);
      const remainSlots  = data.slots.filter(t => t.lobby !== letter);

      // Strip lobby role from removed teams
      await stripRoles(lobbyTeams);

      // Clear their slot assignment but keep them in the queue as unassigned
      // (or remove them completely — here we remove from slots entirely)
      data.slots = remainSlots;
      setRegistrations(interaction.guildId, data);

      // Clear in-memory message ID for this lobby so a fresh embed posts
      // Set to null explicitly — merge-based set would re-add deleted keys
      setPersistentSlotListId(interaction.guildId, { [`lobby_${letter}`]: null });

      // Clear the lobby's channel messages
      const lc = lobbyConf[letter];
      if (lc?.channel_id) await purgeChannel(lc.channel_id);

      // Post fresh empty slot list in lobby channel
      if (lc?.channel_id) {
        await postToLobbyChannel(interaction.guild, letter, lobbyConf, settings, data);
      }

      return interaction.editReply({
        embeds: [successEmbed(
          `Lobby ${letter} Cleared`,
          `**${lobbyTeams.length}** team(s) removed from Lobby ${letter}.\n` +
          `Lobby roles stripped. Slot list reset.`
        )],
        components: [],
      });
    }

    // ── CLEAR ALL ─────────────────────────────────────────────────────────────
    if (choice === 'clear_all') {
      const data    = getRegistrations(interaction.guildId);
      const allTeams = [...data.slots, ...data.waitlist];

      await stripRoles(allTeams);

      clearRegistrations(interaction.guildId);
      clearMatches(interaction.guildId);
      setServer(interaction.guildId, { registration_open: false });
      clearPersistentSlotListIds(interaction.guildId);

      // Purge all channels
      const lobbyChannelIds = lobbyLetters.map(l => lobbyConf[l]?.channel_id).filter(Boolean);
      const allChannels = [...new Set([
        config.register_channel,
        config.slotlist_channel,
        config.waitlist_channel,
        ...lobbyChannelIds,
      ].filter(Boolean))];

      for (const chId of allChannels) await purgeChannel(chId);

      // Post fresh empty slot lists in all configured lobby channels
      const freshData = getRegistrations(interaction.guildId);
      for (const letter of lobbyLetters) {
        if (!lobbyConf[letter]?.channel_id) continue;
        await postToLobbyChannel(interaction.guild, letter, lobbyConf, settings, freshData);
      }

      return interaction.editReply({
        embeds: [successEmbed(
          'All Cleared',
          `**${allTeams.length}** team(s) removed.\n` +
          `All channels cleared. Fresh slot lists posted.\n` +
          `Run \`/open\` to start a new registration.`
        )],
        components: [],
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
