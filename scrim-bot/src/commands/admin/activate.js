const { SlashCommandBuilder } = require('discord.js');
const { setServer, getServer } = require('../../utils/database');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('activate')
    .setDescription('Activate the scrim bot for this server (Admin only)'),

  async execute(interaction) {
    // Only server owner or Administrator can activate
    if (
      interaction.guild.ownerId !== interaction.user.id &&
      !interaction.member.permissions.has('Administrator')
    ) {
      return interaction.reply({
        embeds: [errorEmbed('Access Denied', 'Only the server owner or admins can activate the bot.')],
        ephemeral: true
      });
    }

    const existing = getServer(interaction.guildId);
    if (existing && existing.active) {
      return interaction.reply({
        embeds: [infoEmbed('Already Activated', 'Scrim bot is already active on this server.\nUse `/config` to update settings.')],
        ephemeral: true
      });
    }

    setServer(interaction.guildId, {
      server_id: interaction.guildId,
      active: true,
      registration_open: false,
      created_at: new Date().toISOString()
    });

    return interaction.reply({
      embeds: [
        successEmbed(
          'Scrim Bot Activated!',
          '🎮 The scrim system is now active for this server.\n\n' +
          '**Next Steps:**\n' +
          '> 1️⃣ Run `/config` to set up channels & roles\n' +
          '> 2️⃣ Run `/open` to open registration\n' +
          '> 3️⃣ Teams can now use `/register`\n\n' +
          '*Use `/deactivate` to disable the bot at any time.*'
        )
      ]
    });
  }
};
