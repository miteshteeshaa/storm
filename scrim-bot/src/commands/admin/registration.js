const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  setSessionServer, getConfig, getSessionConfig, getRegistrations,
  getScrimSettings, getLobbyConfig, getSessions, getSessionByChannel,
} = require('../../utils/database');
const { errorEmbed, successEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { registerConfirmSession } = require('../../handlers/reactionHandler');
const { applyRegistrationChannelPerms } = require('./config');

// ── Resolve session: first try channel auto-detect, then session option, then single-session fallback ──
async function resolveSession(interaction) {
  const sessions = getSessions(interaction.guildId);
  if (sessions.length === 0) {
    await interaction.reply({ embeds: [errorEmbed('No Sessions', 'No sessions configured. Use `/config` to create sessions.')], ephemeral: true });
    return null;
  }

  // 1. Auto-detect from the channel the command was used in
  const byChannel = getSessionByChannel(interaction.guildId, interaction.channelId);
  if (byChannel) {
    const s = sessions.find(s => s.id === byChannel);
    if (s) return { sessionId: s.id, sessionName: s.name };
  }

  // 2. Explicit session option (for /confirm which is run from any channel)
  const sessionOpt = interaction.options?.getString?.('session');
  if (sessionOpt) {
    const found = sessions.find(s => s.id === sessionOpt);
    if (!found) {
      await interaction.reply({ embeds: [errorEmbed('Invalid Session', `Session \`${sessionOpt}\` not found.`)], ephemeral: true });
      return null;
    }
    return { sessionId: found.id, sessionName: found.name };
  }

  // 3. Single session — auto-select
  if (sessions.length === 1) return { sessionId: sessions[0].id, sessionName: sessions[0].name };

  // 4. Multiple sessions, no match — ask admin to run from the correct channel
  const regChannels = sessions
    .map(s => getSessionConfig(interaction.guildId, s.id).register_channel)
    .filter(Boolean)
    .map(id => `<#${id}>`)
    .join(', ');
  await interaction.reply({
    embeds: [errorEmbed('Run from Registration Channel', `Please run this command from the session's registration channel to auto-detect it.\nRegistration channels: ${regChannels || 'none configured'}`)],
    ephemeral: true,
  });
  return null;
}

function sessionOption(opt) {
  return opt.setName('session').setDescription('Which session to target (or run from registration channel to auto-detect)').setRequired(false);
}

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

    const picked = await resolveSession(interaction);
    if (!picked) return;
    const { sessionId, sessionName } = picked;

    const config     = getConfig(interaction.guildId);
    const sessionCfg = getSessionConfig(interaction.guildId, sessionId);
    const settings   = getScrimSettings(interaction.guildId, sessionId);
    const maxSlots   = interaction.options.getInteger('slots') || settings.slots;

    setSessionServer(interaction.guildId, sessionId, {
      registration_open: true,
      max_slots: maxSlots,
      opened_at: new Date().toISOString(),
    });

    // Open registration channel permissions
    if (sessionCfg.register_channel && config.registration_role) {
      await applyRegistrationChannelPerms(interaction.guild, sessionCfg.register_channel, config.registration_role, true);
    }

    // Plain text announcement tagging the registration role
    if (sessionCfg.register_channel) {
      try {
        const ch        = await interaction.guild.channels.fetch(sessionCfg.register_channel);
        const roleMention = config.registration_role ? `<@&${config.registration_role}>` : '';
        const announcement = `REGISTRATION IS NOW OPENED ${roleMention}`.trim();
        if (ch) await ch.send({ content: announcement });
      } catch {}
    }

    await interaction.reply({
      embeds: [successEmbed('Registration Opened', `**${sessionName}** open with **${maxSlots}** slots across **${settings.lobbies}** lobbies!`)],
      ephemeral: true,
    });
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

    const picked = await resolveSession(interaction);
    if (!picked) return;
    const { sessionId, sessionName } = picked;

    const config     = getConfig(interaction.guildId);
    const sessionCfg = getSessionConfig(interaction.guildId, sessionId);
    const data       = getRegistrations(interaction.guildId, sessionId);

    setSessionServer(interaction.guildId, sessionId, { registration_open: false });

    // Close registration channel permissions
    if (sessionCfg.register_channel && config.registration_role) {
      await applyRegistrationChannelPerms(interaction.guild, sessionCfg.register_channel, config.registration_role, false);
    }

    if (sessionCfg.register_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(sessionCfg.register_channel);
        if (ch) await ch.send({ content: `🔒 **${sessionName} — REGISTRATION CLOSED**` });
      } catch {}
    }

    await interaction.reply({
      embeds: [successEmbed('Registration Closed', `**${sessionName}** closed. **${data.slots.length}** teams registered.\nRun \`/confirm\` when ready for slot confirmation.`)],
      ephemeral: true,
    });
  }
};

// ── /confirm ──────────────────────────────────────────────────────────────────
const confirmCmd = {
  data: new SlashCommandBuilder()
    .setName('confirm')
    .setDescription('Post CONFIRM YOUR SLOTS in all lobby channels (Admin only)')
    .addStringOption(sessionOption),
  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const picked = await resolveSession(interaction);
    if (!picked) return;
    const { sessionId, sessionName } = picked;

    const settings  = getScrimSettings(interaction.guildId, sessionId);
    const data      = getRegistrations(interaction.guildId, sessionId);
    const lobbyConf = getLobbyConfig(interaction.guildId, sessionId);

    if (data.slots.length === 0) return interaction.reply({ embeds: [errorEmbed('No Teams', 'No registered teams.')], ephemeral: true });

    const LOBBY_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const lobbyChannels = [];
    for (const letter of LOBBY_LETTERS.slice(0, settings.lobbies || 4)) {
      const chId = lobbyConf[letter]?.channel_id;
      if (chId) lobbyChannels.push({ chId, letter });
    }

    if (lobbyChannels.length === 0) return interaction.reply({ embeds: [errorEmbed('No Lobby Channels', 'No lobby channels configured for this session.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const confirmText = `✅ — Confirms your slot | ❌ — Cancels your slot\n*Only your registered manager/captain can react.*`;

    const posted = [];
    const errors = [];

    for (const { chId, letter } of lobbyChannels) {
      try {
        const ch = await interaction.guild.channels.fetch(chId);
        if (!ch) { errors.push(`<#${chId}> not found`); continue; }

        const confirmMsg = await ch.send({ content: confirmText });
        await confirmMsg.react('✅');
        await confirmMsg.react('❌');

        registerConfirmSession(interaction.guildId, confirmMsg.id, chId, letter, sessionId);
        posted.push(`<#${chId}>`);
      } catch (err) {
        console.error(`❌ /confirm error in channel ${chId}:`, err.message);
        errors.push(`<#${chId}>: ${err.message}`);
      }
    }

    const desc = posted.length
      ? `Confirmation posted in: ${posted.join(', ')}` + (errors.length ? `\n\n⚠️ Failed: ${errors.join(', ')}` : '') + '\n\nTeams can now react to confirm/cancel.'
      : `Failed to post:\n${errors.join('\n')}`;

    await interaction.editReply({
      embeds: [posted.length ? successEmbed('Confirm Posted!', desc) : errorEmbed('Error', desc)],
    });
  }
};

module.exports = [openCmd, closeCmd, confirmCmd];
