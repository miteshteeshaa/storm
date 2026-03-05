const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServer, setServer, getConfig, getRegistrations } = require('../../utils/database');
const { errorEmbed, successEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { registerConfirmSession, buildSlotListEmbed } = require('../handlers/reactionHandler');

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
  .setDescription('Close registration and post CONFIRM YOUR SLOTS (Admin only)');

async function executeOpen(interaction) {
  if (!isActivated(interaction.guildId)) {
    return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
  }
  if (!await isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
  }

  const config   = getConfig(interaction.guildId);
  const maxSlots = interaction.options.getInteger('slots') || config.max_slots || 100;

  setServer(interaction.guildId, {
    registration_open: true,
    max_slots: maxSlots,
    opened_at: new Date().toISOString(),
  });

  const embed = new EmbedBuilder()
    .setColor(0x00FF7F)
    .setTitle('🎮 SCRIM REGISTRATION IS NOW OPEN!')
    .setDescription('Use `/register` to register your team!\n\n**Required info:**\n> `team_name` — Full team name\n> `team_tag` — Short tag e.g. [TA]\n> `manager` — Tag your captain/manager')
    .addFields(
      { name: '📋 Available Slots', value: `\`${maxSlots}\``, inline: true },
      { name: '📌 Command', value: '`/register`', inline: true },
    )
    .setFooter({ text: 'First come, first served! Overflow goes to waitlist.' })
    .setTimestamp();

  if (config.register_channel) {
    try {
      const ch = await interaction.guild.channels.fetch(config.register_channel);
      if (ch) await ch.send({ embeds: [embed] });
    } catch {}
  }

  await interaction.reply({
    embeds: [successEmbed('Registration Opened', `Registration is now open with **${maxSlots}** slots!`)],
    ephemeral: true,
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

  const config   = getConfig(interaction.guildId);
  const data     = getRegistrations(interaction.guildId);
  const maxSlots = config.max_slots || 100;

  // Post CLOSED notice
  if (config.register_channel) {
    try {
      const ch = await interaction.guild.channels.fetch(config.register_channel);
      if (ch) {
        await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFF4444)
              .setTitle('🔒 REGISTRATION CLOSED')
              .setDescription('Registration has been closed. No more teams can register.')
              .setTimestamp()
          ]
        });
      }
    } catch {}
  }

  // Post slot list + CONFIRM YOUR SLOTS
  if (config.slotlist_channel && data.slots.length > 0) {
    try {
      const ch = await interaction.guild.channels.fetch(config.slotlist_channel);
      if (ch) {
        // 1. Numbered slot list — will be edited live as teams react
        const slotListMsg = await ch.send({
          embeds: [buildSlotListEmbed(data.slots, maxSlots)]
        });

        // 2. CONFIRM YOUR SLOTS message
        const confirmMsg = await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('✅ CONFIRM YOUR SLOTS')
              .setDescription(
                'React below to confirm or cancel your slot:\n\n' +
                '✅ — Confirms your slot (__underlined__ in the list above)\n' +
                '❌ — Cancels your slot (~~crossed out~~ in the list above)'
              )
              .setFooter({ text: 'Only registered team managers/captains can react.' })
          ]
        });

        await confirmMsg.react('✅');
        await confirmMsg.react('❌');

        // 3. Tell the reaction handler which message to watch
        registerConfirmSession(
          interaction.guildId,
          confirmMsg.id,
          ch.id,
          slotListMsg.id
        );
      }
    } catch (err) {
      console.error('❌ Error posting confirm message:', err.message);
    }
  }

  await interaction.reply({
    embeds: [successEmbed('Registration Closed', `**${data.slots.length}** teams registered. Confirm Your Slots posted!`)],
    ephemeral: true,
  });
}

module.exports = [
  { data: openData,  execute: executeOpen  },
  { data: closeData, execute: executeClose },
];
