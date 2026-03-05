const { SlashCommandBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, clearRegistrations,
  setServer, clearMatches, getScrimSettings
} = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { extractSheetId, writeRegistrationSheet } = require('../../utils/sheets');
const {
  buildPersistentSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
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
    .setDescription('Clear all registrations and reset slot list (Admin only)')
    .addBooleanOption(opt =>
      opt.setName('confirm').setDescription('Set to true to confirm').setRequired(true)
    ),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    if (!interaction.options.getBoolean('confirm')) {
      return interaction.reply({ embeds: [errorEmbed('Cancelled', 'Set `confirm` to `true` to proceed.')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);
    const data     = getRegistrations(interaction.guildId);
    const allTeams = [...data.slots, ...data.waitlist];

    // ── Collect all role IDs to strip ─────────────────────────────────────────
    const roleIds = [
      config.slot_role,
      config.waitlist_role,
      config.registered_role,
      config.idpass_role,
    ].filter(Boolean);

    // FIX: Strip roles from ALL players (captain + all tagged players), not just captain
    for (const team of allTeams) {
      // Collect every player ID on the team
      const playerIds = new Set();
      if (team.captain_id) playerIds.add(team.captain_id);
      if (team.manager_id) playerIds.add(team.manager_id);
      if (team.players)    team.players.forEach(id => playerIds.add(id));

      for (const playerId of playerIds) {
        try {
          const member = await interaction.guild.members.fetch(playerId);
          for (const roleId of roleIds) {
            await member.roles.remove(roleId).catch(() => {});
          }
        } catch {} // Member may have left the server
      }
    }

    // ── Clear data ────────────────────────────────────────────────────────────
    clearRegistrations(interaction.guildId);
    clearMatches(interaction.guildId);
    setServer(interaction.guildId, { registration_open: false });

    // ── Reset the persistent slot list embed (do NOT delete it) ──────────────
    const channelId  = config.idpass_channel || config.slotlist_channel;
    const ids        = getPersistentSlotListId(interaction.guildId);
    const existingId = ids.overall;

    if (channelId && existingId) {
      try {
        const ch  = await interaction.guild.channels.fetch(channelId);
        const msg = await ch.messages.fetch(existingId);
        await msg.edit({ embeds: [buildPersistentSlotList([], settings)] });
      } catch {
        setPersistentSlotListId(interaction.guildId, { overall: null });
      }
    }

    // ── Bulk-delete messages in registration, slot allocation & waitlist channels
    // Discord only allows bulk delete for messages < 14 days old
    const channelsToClear = [
      config.register_channel,
      config.slotlist_channel,
      config.waitlist_channel,
    ].filter(Boolean);

    let clearedChannels = 0;
    for (const chId of channelsToClear) {
      try {
        const ch = await interaction.guild.channels.fetch(chId);
        if (!ch) continue;

        // Fetch up to 100 messages and bulk delete (Discord limit per call)
        // Loop until no more messages or they're too old
        let deleted = 0;
        while (true) {
          const messages = await ch.messages.fetch({ limit: 100 });
          // Filter out messages older than 14 days (Discord won't bulk delete them)
          const deletable = messages.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size === 0) break;
          await ch.bulkDelete(deletable, true).catch(() => {});
          deleted += deletable.size;
          if (deletable.size < 100) break; // No more messages to delete
        }
        clearedChannels++;
      } catch {} // Channel may not exist or bot lacks permissions
    }

    return interaction.editReply({
      embeds: [successEmbed(
        'Registration Cleared',
        `All **${allTeams.length}** teams removed.\n` +
        `Roles stripped from all players.\n` +
        `Slot list reset — ready for next scrim!\n` +
        `**${clearedChannels}** channel(s) cleared.\n\n` +
        `Run \`/open\` to start a new registration.`
      )]
    });
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
