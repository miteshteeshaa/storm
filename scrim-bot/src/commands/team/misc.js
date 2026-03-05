const { SlashCommandBuilder } = require('discord.js');
const { getConfig, getRegistrations, clearRegistrations, setServer, getServer, clearMatches } = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { extractSheetId, writeRegistrationSheet } = require('../../utils/sheets');

// ─── /notify ─────────────────────────────────────────────────────────────────
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

    const msg = interaction.options.getString('message');
    const config = getConfig(interaction.guildId);
    const data = getRegistrations(interaction.guildId);

    const allTeams = [...data.slots, ...data.waitlist];
    if (allTeams.length === 0) {
      return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams found.')], ephemeral: true });
    }

    // Ping registered role if set
    const mention = config.registered_role ? `<@&${config.registered_role}>` : '@everyone';
    const channel = config.register_channel
      ? await interaction.guild.channels.fetch(config.register_channel).catch(() => null)
      : interaction.channel;

    if (channel) {
      await channel.send({
        content: `${mention}\n📣 **ADMIN NOTICE:** ${msg}`
      });
    }

    return interaction.reply({ embeds: [successEmbed('Notification Sent', `Message sent to ${allTeams.length} registered teams.`)], ephemeral: true });
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
      const sheetId = extractSheetId(config.sheet_url);
      await writeRegistrationSheet(sheetId, data.slots);
      return interaction.editReply({ embeds: [successEmbed('Sheet Updated', `Pushed **${data.slots.length}** teams to the Google Sheet.`)] });
    } catch (e) {
      return interaction.editReply({ embeds: [errorEmbed('Sheet Error', `Failed: ${e.message}`)] });
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
    .setDescription('Clear all registrations and reset for next scrim (Admin only)')
    .addBooleanOption(opt =>
      opt.setName('confirm').setDescription('Type true to confirm').setRequired(true)
    ),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const confirm = interaction.options.getBoolean('confirm');
    if (!confirm) return interaction.reply({ embeds: [errorEmbed('Cancelled', 'Clear cancelled. Set confirm to `true` to proceed.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const config = getConfig(interaction.guildId);
    const data = getRegistrations(interaction.guildId);
    const allTeams = [...data.slots, ...data.waitlist];

    // Remove roles from all registered members
    for (const team of allTeams) {
      try {
        const member = await interaction.guild.members.fetch(team.captain_id);
        const toRemove = [config.slot_role, config.waitlist_role, config.registered_role, config.idpass_role].filter(Boolean);
        for (const roleId of toRemove) {
          await member.roles.remove(roleId).catch(() => {});
        }
      } catch {}
    }

    clearRegistrations(interaction.guildId);
    clearMatches(interaction.guildId);
    setServer(interaction.guildId, { registration_open: false });

    return interaction.editReply({
      embeds: [successEmbed('Registration Cleared', `All **${allTeams.length}** teams removed.\nRoles stripped. Ready for next scrim!\n\nRun \`/open\` to start a new registration.`)]
    });
  }
};

// ─── /deactivate ─────────────────────────────────────────────────────────────
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
