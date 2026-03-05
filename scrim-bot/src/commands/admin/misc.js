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

    // ── Strip roles from all registered members ───────────────────────────────
    const roleIds = [
      config.slot_role,
      config.waitlist_role,
      config.registered_role,
      config.idpass_role,
    ].filter(Boolean);

    for (const team of allTeams) {
      // Strip from captain
      try {
        const member = await interaction.guild.members.fetch(team.captain_id);
        for (const roleId of roleIds) await member.roles.remove(roleId).catch(() => {});
      } catch {}

      // Strip from all tagged players too
      if (team.players) {
        for (const playerId of team.players) {
          try {
            const member = await interaction.guild.members.fetch(playerId);
            for (const roleId of roleIds) await member.roles.remove(roleId).catch(() => {});
          } catch {}
        }
      }
    }

    // ── Clear data ────────────────────────────────────────────────────────────
    clearRegistrations(interaction.guildId);
    clearMatches(interaction.guildId);
    setServer(interaction.guildId, { registration_open: false });

    // ── Reset the persistent slot list embed (do NOT delete it) ──────────────
    // Shows empty numbered slots so it's ready for next scrim
    const channelId  = config.idpass_channel || config.slotlist_channel;
    const existingId = getPersistentSlotListId(interaction.guildId);

    if (channelId && existingId) {
      try {
        const ch  = await interaction.guild.channels.fetch(channelId);
        const msg = await ch.messages.fetch(existingId);
        // Pass empty slots array — will show all slot numbers empty
        await msg.edit({ embeds: [buildPersistentSlotList([], settings)] });
      } catch {
        // Message was deleted — clear the stored ID so next /register posts fresh
        setPersistentSlotListId(interaction.guildId, null);
      }
    }

    return interaction.editReply({
      embeds: [successEmbed(
        'Registration Cleared',
        `All **${allTeams.length}** teams removed.\n` +
        `Roles stripped from all players.\n` +
        `Slot list reset to empty — ready for next scrim!\n\n` +
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
