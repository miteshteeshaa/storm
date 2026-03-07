const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServer, setServer, getConfig, getRegistrations, getScrimSettings, getLobbyConfig } = require('../../utils/database');
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
        { name: '🏟️ Lobbies', value: `\`${settings.lobbies}\``, inline: true },
        { name: '📌 Command', value: '`/register team_name: team_tag: manager: [players...]`', inline: false },
      )
      .setFooter({ text: 'First come, first served! Overflow goes to waitlist.' })
      .setTimestamp();

    // Post PUBLIC announcement in registration channel
    if (config.register_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(config.register_channel);
        if (ch) await ch.send({ embeds: [embed] });
      } catch {}
    }

    await interaction.reply({ embeds: [successEmbed('Registration Opened', `Open with **${maxSlots}** slots across **${settings.lobbies}** lobbies!`)], ephemeral: true });
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

    if (config.register_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(config.register_channel);
        if (ch) {
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xFF4444)
                .setTitle('🔒 REGISTRATION CLOSED')
                .setDescription('Registration is now closed.\n\nAdmin will post **CONFIRM YOUR SLOTS** soon.')
                .setTimestamp()
            ]
          });
        }
      } catch {}
    }

    await interaction.reply({
      embeds: [successEmbed('Registration Closed', `**${data.slots.length}** teams registered.\nRun \`/confirm\` when ready for slot confirmation.`)],
      ephemeral: true,
    });
  }
};

// ── /confirm ──────────────────────────────────────────────────────────────────
const confirmCmd = {
  data: new SlashCommandBuilder()
    .setName('confirm')
    .setDescription('Post CONFIRM YOUR SLOTS message (Admin only)'),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const config     = getConfig(interaction.guildId);
    const settings   = getScrimSettings(interaction.guildId);
    const data       = getRegistrations(interaction.guildId);
    const lobbyConf  = getLobbyConfig(interaction.guildId);

    if (data.slots.length === 0) return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams.')], ephemeral: true });

    // Post confirm in every configured lobby channel only (not slot-allocation — that's admin-only)
    const channelIds = new Set();

    const numLobbies  = settings.lobbies || 4;
    const LOBBY_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    for (const letter of LOBBY_LETTERS.slice(0, numLobbies)) {
      const lobbyChId = lobbyConf[letter]?.channel_id;
      if (lobbyChId) channelIds.add(lobbyChId);
    }

    if (channelIds.size === 0) return interaction.reply({ embeds: [errorEmbed('No Lobby Channels', 'No lobby channels configured. Set them in `/config` → Lobby Channels & Roles.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const confirmEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('✅ CONFIRM YOUR SLOTS')
      .setDescription(
        'React below to confirm or cancel your slot:\n\n' +
        '✅ — Confirms your slot (__underlined__ in list)\n' +
        '❌ — Cancels your slot (~~crossed out~~ in list)\n\n' +
        '*Only your registered manager/captain can react.*'
      )
      .setFooter({ text: `${settings.scrim_name} | Slot confirmation` });

    const posted = [];
    const errors = [];

    for (const chId of channelIds) {
      try {
        const ch = await interaction.guild.channels.fetch(chId);
        if (!ch) { errors.push(`<#${chId}> not found`); continue; }

        // Only post the instruction embed — NO slot list embed here.
        // The persistent slot list already in each lobby channel will update in place.
        const confirmMsg = await ch.send({ embeds: [confirmEmbed] });

        await confirmMsg.react('✅');
        await confirmMsg.react('❌');

        // Register session per channel so reactions in each lobby are tracked correctly
        registerConfirmSession(interaction.guildId, confirmMsg.id, ch.id, null);

        posted.push(`<#${chId}>`);
      } catch (err) {
        console.error(`❌ /confirm error in channel ${chId}:`, err.message);
        errors.push(`<#${chId}>: ${err.message}`);
      }
    }

    const desc = posted.length
      ? `Slot confirmation posted in: ${posted.join(', ')}` +
        (errors.length ? `\n\n⚠️ Failed: ${errors.join(', ')}` : '') +
        '\n\nTeams can now react to confirm/cancel.'
      : `Failed to post in all channels:\n${errors.join('\n')}`;

    await interaction.editReply({
      embeds: [posted.length
        ? successEmbed('Confirm Posted!', desc)
        : errorEmbed('Error', desc)
      ],
    });
  }
};

module.exports = [openCmd, closeCmd, confirmCmd];
