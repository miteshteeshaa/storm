const { SlashCommandBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations, getScrimSettings
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen, isAdmin } = require('../../utils/permissions');
const { syncTeamsToSheet } = require('../../utils/sheets');
const { registerTeamCard, SLOT_EMOJI_LIST, LOBBY_EMOJI_IDS } = require('../../handlers/reactionHandler');

// Send an ephemeral error — defer is already ephemeral so just editReply
async function replyError(interaction, embed) {
  return interaction.editReply({ embeds: [embed] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your team for the scrim')
    .addStringOption(opt => opt.setName('team_name').setDescription('Full team name').setRequired(true))
    .addStringOption(opt => opt.setName('team_tag').setDescription('Short tag e.g. ZRX').setRequired(true).setMaxLength(8))
    .addUserOption(opt => opt.setName('manager').setDescription('Team manager/captain').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Player 2').setRequired(false))
    .addUserOption(opt => opt.setName('player3').setDescription('Player 3').setRequired(false))
    .addUserOption(opt => opt.setName('player4').setDescription('Player 4').setRequired(false))
    .addUserOption(opt => opt.setName('player5').setDescription('Player 5').setRequired(false)),

  async execute(interaction) {
    try {
      // Validate synchronously first — no async before reply
      if (!isActivated(interaction.guildId))
        return interaction.reply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active.')], ephemeral: true });

      const config     = getConfig(interaction.guildId);
      const adminUser  = await isAdmin(interaction);

      // ── Registration channel check (applies to everyone) ──────────────────
      if (config.register_channel && interaction.channelId !== config.register_channel) {
        return interaction.reply({
          embeds: [errorEmbed('Wrong Channel', `Please use <#${config.register_channel}> to register.`)],
          ephemeral: true,
        });
      }

      // ── Registration open check (admins can bypass) ───────────────────────
      if (!isRegistrationOpen(interaction.guildId) && !adminUser)
        return interaction.reply({ embeds: [errorEmbed('Registration Closed', 'Wait for admin to open registration.')], ephemeral: true });

      const settings = getScrimSettings(interaction.guildId);
      const data     = getRegistrations(interaction.guildId);

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
      const queueNum   = isWaitlist ? data.waitlist.length + 1 : data.slots.length + 1;

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

      if (!isWaitlist) data.slots.push(team);
      else             data.waitlist.push(team);
      setRegistrations(interaction.guildId, data);

      // ── Reply immediately — no thinking bubble ────────────────────────────
      const confirmText = isWaitlist
        ? `⏳ **[${teamTag}] ${teamName}** added to waitlist! (#${queueNum})`
        : `✅ **[${teamTag}] ${teamName}** registered! (#${queueNum})`;
      await interaction.reply({ content: confirmText });

      // ── Everything below is background — won't delay the reply ───────────

      // Roles
      try {
        const member = interaction.member;
        if (config.registered_role) member.roles.add(config.registered_role).catch(() => {});
        if (!isWaitlist) {
          if (config.slot_role)     member.roles.add(config.slot_role).catch(() => {});
          if (config.waitlist_role) member.roles.remove(config.waitlist_role).catch(() => {});
        } else {
          if (config.waitlist_role) member.roles.add(config.waitlist_role).catch(() => {});
        }
      } catch {}

      // Sheet sync
      if (config.spreadsheet_id) {
        syncTeamsToSheet(config.spreadsheet_id, data.slots).catch(() => {});
      }

      // Team card in slot-allocation channel
      if (config.slotlist_channel && !isWaitlist) {
        try {
          const ch = await interaction.guild.channels.fetch(config.slotlist_channel);
          if (ch) {
            const playerMentions = players.map(p => `<@${p.id}>`).join(' ');
            const teamIndex      = data.slots.length - 1;

            // Plain text card — faster rendering, no embed needed
            const cardText = `[${teamTag}] ${teamName} ${playerMentions}`;
            const msg = await ch.send({ content: cardText });
            registerTeamCard(msg.id, interaction.guildId, teamIndex);

            // Add reactions in background — LOBBY ONLY, no slot emojis (bot auto-assigns slot)
            (async () => {
              const numLobbies = settings.lobbies || 4;
              const ALPHA_NAMES = ['ALPHABET_A','ALPHABET_B','ALPHABET_C','ALPHABET_D','ALPHABET_E','ALPHABET_F','ALPHABET_G','ALPHABET_H','ALPHABET_I','ALPHABET_J'];
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
