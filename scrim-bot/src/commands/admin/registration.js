const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServer, setServer, getConfig, getRegistrations, getScrimSettings } = require('../../utils/database');
const { errorEmbed, successEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const {
  registerConfirmSession,
  buildConfirmSlotList,
  buildPersistentSlotList,
  getPersistentSlotListId,
} = require('../../handlers/reactionHandler');

// ── /open ─────────────────────────────────────────────────────────────────────
const openCmd = {
  data: new SlashCommandBuilder()
    .setName('open')
    .setDescription('Open team registration (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('slots').setDescription('Override max slots').setMinValue(1).setMaxValue(500)
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);
    const maxSlots = interaction.options.getInteger('slots') || settings.slots;

    setServer(interaction.guildId, { registration_open: true, max_slots: maxSlots, opened_at: new Date().toISOString() });

    const embed = new EmbedBuilder()
      .setColor(0x00FF7F)
      .setTitle(`🎮 ${settings.scrim_name} — REGISTRATION OPEN!`)
      .setDescription('Use `/register` to register your team!')
      .addFields(
        { name: '📋 Total Slots', value: `\`${maxSlots}\``, inline: true },
        { name: '🔢 Starting From', value: `Slot \`${settings.first_slot}\``, inline: true },
        { name: '🏟️ Lobbies', value: `\`${settings.lobbies}\``, inline: true },
        { name: '📌 Command', value: '`/register team_name: team_tag: manager: [players...]`', inline: false },
      )
      .setFooter({ text: 'First come, first served! Overflow goes to waitlist.' })
      .setTimestamp();

    if (config.register_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(config.register_channel);
        if (ch) await ch.send({ embeds: [embed] });
      } catch {}
    }

    await interaction.reply({ embeds: [successEmbed('Registration Opened', `Open with **${maxSlots}** slots starting from slot **${settings.first_slot}**!`)], ephemeral: true });
  }
};

// ── /close ────────────────────────────────────────────────────────────────────
const closeCmd = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close registration (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    setServer(interaction.guildId, { registration_open: false });

    const config = getConfig(interaction.guildId);
    const data   = getRegistrations(interaction.guildId);

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
                .setDescription('Registration is now closed. No more teams can register.\n\nAdmin will post **CONFIRM YOUR SLOTS** soon.')
                .setTimestamp()
            ]
          });
        }
      } catch {}
    }

    await interaction.reply({
      embeds: [successEmbed('Registration Closed', `**${data.slots.length}** teams registered.\nRun \`/confirm\` when ready to post slot confirmation.`)],
      ephemeral: true,
    });
  }
};

// ── /confirm ──────────────────────────────────────────────────────────────────
const confirmCmd = {
  data: new SlashCommandBuilder()
    .setName('confirm')
    .setDescription('Post CONFIRM YOUR SLOTS message for teams to react (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);
    const data     = getRegistrations(interaction.guildId);

    if (data.slots.length === 0) {
      return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams found.')], ephemeral: true });
    }

    const channelId = config.slotlist_channel;
    if (!channelId) {
      return interaction.reply({ embeds: [errorEmbed('No Channel', 'Set a Slot List channel in `/config` first.')], ephemeral: true });
    }

    try {
      const ch = await interaction.guild.channels.fetch(channelId);

      // 1. Post the slot list (will update live)
      const slotListMsg = await ch.send({
        embeds: [buildConfirmSlotList(data.slots, settings)]
      });

      // 2. Post CONFIRM YOUR SLOTS
      const confirmMsg = await ch.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('✅ CONFIRM YOUR SLOTS')
            .setDescription(
              'React below to confirm or cancel your slot:\n\n' +
              '✅ — Confirms your slot (__underlined__ in the list above)\n' +
              '❌ — Cancels your slot (~~crossed out~~ in the list above)\n\n' +
              '*Only your team manager/captain can react.*'
            )
            .setFooter({ text: `${settings.scrim_name} | Slot confirmation` })
        ]
      });

      await confirmMsg.react('✅');
      await confirmMsg.react('❌');

      // 3. Register the reaction session
      registerConfirmSession(interaction.guildId, confirmMsg.id, ch.id, slotListMsg.id);

      // 4. Also update the persistent list in idpass channel
      const idpassChannelId = config.idpass_channel;
      if (idpassChannelId) {
        try {
          const idCh = await interaction.guild.channels.fetch(idpassChannelId);
          const existingId = getPersistentSlotListId(interaction.guildId);
          if (existingId) {
            const existing = await idCh.messages.fetch(existingId).catch(() => null);
            if (existing) await existing.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
          }
        } catch {}
      }

      await interaction.reply({
        embeds: [successEmbed('Confirm Posted!', `Slot confirmation message posted in <#${channelId}>.\nTeams can now react to confirm/cancel their slot.`)],
        ephemeral: true,
      });

    } catch (err) {
      console.error('❌ /confirm error:', err.message);
      await interaction.reply({ embeds: [errorEmbed('Error', err.message)], ephemeral: true });
    }
  }
};

module.exports = [openCmd, closeCmd, confirmCmd];
