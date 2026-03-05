const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getServer, setServer, getConfig } = require('../../utils/database');
const { registrationOpenEmbed, registrationClosedEmbed, errorEmbed, successEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

const openData = new SlashCommandBuilder()
  .setName('open')
  .setDescription('Open team registration (Admin only)')
  .addIntegerOption(opt =>
    opt.setName('slots')
      .setDescription('Max number of slots (default: from config)')
      .setMinValue(1)
      .setMaxValue(500)
  );

const closeData = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close team registration (Admin only)');

async function executeOpen(interaction) {
  if (!isActivated(interaction.guildId)) {
    return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
  }
  if (!await isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
  }

  const config = getConfig(interaction.guildId);
  const maxSlots = interaction.options.getInteger('slots') || config.max_slots || 100;

  setServer(interaction.guildId, {
    registration_open: true,
    max_slots: maxSlots,
    opened_at: new Date().toISOString()
  });

  const embed = registrationOpenEmbed(maxSlots);

  // Post in registration channel if configured
  if (config.register_channel) {
    try {
      const channel = await interaction.guild.channels.fetch(config.register_channel);
      if (channel) await channel.send({ embeds: [embed] });
    } catch {}
  }

  await interaction.reply({
    embeds: [successEmbed('Registration Opened', `Registration is now open with **${maxSlots}** slots!`)],
    ephemeral: true
  });
}

async function executeClose(interaction) {
  if (!isActivated(interaction.guildId)) {
    return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
  }
  if (!await isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
  }

  setServer(interaction.guildId, { registration_open: false });

  const config = getConfig(interaction.guildId);
  const embed = registrationClosedEmbed();

  if (config.register_channel) {
    try {
      const channel = await interaction.guild.channels.fetch(config.register_channel);
      if (channel) await channel.send({ embeds: [embed] });
    } catch {}
  }

  await interaction.reply({
    embeds: [successEmbed('Registration Closed', 'Teams can no longer register.')],
    ephemeral: true
  });
}

module.exports = [
  { data: openData, execute: executeOpen },
  { data: closeData, execute: executeClose }
];
