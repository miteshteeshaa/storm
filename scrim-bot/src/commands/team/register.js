const { SlashCommandBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations, getScrimSettings,
  getSessions, getSessionConfig, getSessionServer, getSessionByChannel,
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isAdmin } = require('../../utils/permissions');
const { syncTeamsToSheet } = require('../../utils/sheets');
const { registerTeamCard, LOBBY_EMOJI_IDS } = require('../../handlers/reactionHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your team for the scrim')
    .addStringOption(opt => opt.setName('team_name').setDescription('Full team name').setRequired(true))
    .addStringOption(opt => opt.setName('team_tag').setDescription('Short tag e.g. ZRX').setRequired(true).setMaxLength(20))
    .addUserOption(opt => opt.setName('manager').setDescription('Team manager/captain').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Player 2').setRequired(false))
    .addUserOption(opt => opt.setName('player3').setDescription('Player 3').setRequired(false))
    .addUserOption(opt => opt.setName('player4').setDescription('Player 4').setRequired(false))
    .addUserOption(opt => opt.setName('player5').setDescription('Player 5').setRequired(false)),

  async execute(interaction) {
    try {
      if (!isActivated(interaction.guildId))
        return interaction.reply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active.')], ephemeral: true });

      const config    = getConfig(interaction.guildId);
      const adminUser = await isAdmin(interaction);
      const sessions  = getSessions(interaction.guildId);

      // Resolve which session this channel belongs to
      const sessionId = getSessionByChannel(interaction.guildId, interaction.channelId);

      if (!sessionId) {
        const regChannels = sessions
          .map(s => getSessionConfig(interaction.guildId, s.id).register_channel)
          .filter(Boolean)
          .map(id => `<#${id}>`)
          .join(', ');
        const hint = regChannels
          ? `Please use one of the registration channels: ${regChannels}`
          : 'No registration channels have been configured yet. Ask an admin to set up sessions.';
        return interaction.reply({ embeds: [errorEmbed('Wrong Channel', hint)], ephemeral: true });
      }

      // Registration open check — admins bypass
      const sessionServer = getSessionServer(interaction.guildId, sessionId);
      if (!sessionServer?.registration_open && !adminUser) {
        const session = sessions.find(s => s.id === sessionId);
        return interaction.reply({
          embeds: [errorEmbed('Registration Closed', `Registration for **${session?.name || sessionId}** is currently closed.`)],
          ephemeral: true,
        });
      }

      const sessionCfg = getSessionConfig(interaction.guildId, sessionId);
      const settings   = getScrimSettings(interaction.guildId, sessionId);
      const data       = getRegistrations(interaction.guildId, sessionId);

      const teamName  = interaction.options.getString('team_name').trim().slice(0, 50);
      const teamTag   = interaction.options.getString('team_tag').toUpperCase().trim();
      const manager   = interaction.options.getUser('manager');
      const captainId = interaction.user.id;

      const players = [manager];
      for (const key of ['player2', 'player3', 'player4', 'player5']) {
        const p = interaction.options.getUser(key);
        if (p && !players.find(x => x.id === p.id)) players.push(p);
      }

      const isWaitlist = data.slots.length >= settings.slots;
      const queueNum   = data.slots.length + 1;

      const team = {
        team_name:  teamName,
        team_tag:   teamTag,
        captain_id: captainId,
        manager_id: manager.id,
        players:    players.map(p => p.id),
        timestamp:  new Date().toISOString(),
        lobby:      null,
        lobby_slot: null,
      };

      // Always push to slots — admin assigns to lobby from slot allocation
      // isWaitlist is only used for the confirmation message label
      data.slots.push(team);
      setRegistrations(interaction.guildId, data, sessionId);

      const session     = sessions.find(s => s.id === sessionId);
      const sessionName = session?.name || sessionId;
      const confirmText = isWaitlist
        ? `⏳ **[${teamTag}] ${teamName}** added to waitlist for **${sessionName}**! (#${queueNum}) — Admin will assign your slot.`
        : `✅ **[${teamTag}] ${teamName}** registered for **${sessionName}**! (#${queueNum})`;
      await interaction.reply({ content: confirmText });

      // Background: roles
      try {
        const member = interaction.member;
        if (config.registered_role) member.roles.add(config.registered_role).catch(() => {});
        if (isWaitlist) {
          if (config.waitlist_role) member.roles.add(config.waitlist_role).catch(() => {});
        } else {
          if (config.slot_role)     member.roles.add(config.slot_role).catch(() => {});
          if (config.waitlist_role) member.roles.remove(config.waitlist_role).catch(() => {});
        }
      } catch {}

      // Background: sheet sync
      if (sessionCfg.spreadsheet_id) {
        syncTeamsToSheet(sessionCfg.spreadsheet_id, data.slots, settings.slots_per_lobby || 24).catch(() => {});
      }

      // Background: team card in slot-allocation channel — always post
      if (sessionCfg.slotlist_channel) {
        try {
          const ch = await interaction.guild.channels.fetch(sessionCfg.slotlist_channel);
          if (ch) {
            const playerMentions = players.map(p => `<@${p.id}>`).join(' ');
            const teamIndex      = data.slots.length - 1;
            const cardText       = `[${teamTag}] ${teamName} ${playerMentions}`;
            const msg            = await ch.send({ content: cardText });
            registerTeamCard(msg.id, interaction.guildId, teamIndex, sessionId);

            (async () => {
              const numLobbies = settings.lobbies || 4;
              const ALPHA_NAMES = ['ALPHABET_A','ALPHABET_B','ALPHABET_C','ALPHABET_D','ALPHABET_E',
                                   'ALPHABET_F','ALPHABET_G','ALPHABET_H','ALPHABET_I','ALPHABET_J'];
              for (let i = 0; i < numLobbies; i++) {
                const name = ALPHA_NAMES[i];
                const id   = LOBBY_EMOJI_IDS[name];
                try { await msg.react(`${name}:${id}`); } catch {}
                await new Promise(r => setTimeout(r, 150));
              }
            })();
          }
        } catch (err) {
          console.error('⚠️ Could not post team card:', err.message);
        }
      }

    } catch (err) {
      console.error('❌ /register error:', err);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ embeds: [errorEmbed('Error', err.message)], ephemeral: true });
        } else {
          await interaction.reply({ embeds: [errorEmbed('Error', err.message)], ephemeral: true });
        }
      } catch {}
    }
  }
};
