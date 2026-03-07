const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations, getScrimSettings
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen } = require('../../utils/permissions');
const { syncTeamsToSheet } = require('../../utils/sheets');
const { registerTeamCard } = require('../../handlers/reactionHandler');

// Send an ephemeral error after a public defer — deletes the "thinking" bubble first
async function replyError(interaction, embed) {
  await interaction.deleteReply().catch(() => {});
  return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
    // Defer PUBLIC — this makes the slash command usage visible to everyone
    await interaction.deferReply();

    try {
      if (!isActivated(interaction.guildId))
        return replyError(interaction, errorEmbed('Bot Not Active', 'The scrim bot is not active.'));
      if (!isRegistrationOpen(interaction.guildId))
        return replyError(interaction, errorEmbed('Registration Closed', 'Wait for admin to open registration.'));

      const config   = getConfig(interaction.guildId);
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

      // ── Duplicate checks ──────────────────────────────────────────────────
      const allTeams = [...data.slots, ...data.waitlist];
      if (allTeams.find(t => t.team_tag.toLowerCase() === teamTag.toLowerCase()))
        return replyError(interaction, errorEmbed('Tag Taken', `**[${teamTag}]** is already registered.`));
      if (allTeams.find(t => t.team_name.toLowerCase() === teamName.toLowerCase()))
        return replyError(interaction, errorEmbed('Name Taken', `**${teamName}** is already registered.`));

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

      // ── Roles ─────────────────────────────────────────────────────────────
      try {
        const member = interaction.member;
        if (config.registered_role) await member.roles.add(config.registered_role).catch(() => {});
        if (!isWaitlist) {
          if (config.slot_role)     await member.roles.add(config.slot_role).catch(() => {});
          if (config.waitlist_role) await member.roles.remove(config.waitlist_role).catch(() => {});
        } else {
          if (config.waitlist_role) await member.roles.add(config.waitlist_role).catch(() => {});
        }
      } catch {}

      // ── Sync to Google Sheet (silent) ─────────────────────────────────────
      if (config.spreadsheet_id) {
        syncTeamsToSheet(config.spreadsheet_id, data.slots).catch(() => {});
      }

      // ── Post team card in slot-allocation channel ─────────────────────────
      if (config.slotlist_channel && !isWaitlist) {
        try {
          const ch = await interaction.guild.channels.fetch(config.slotlist_channel);
          if (ch) {
            const playerMentions = players.map(p => `<@${p.id}>`).join(' ');
            const teamIndex      = data.slots.length - 1;

            const card = new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle(`[${teamTag}] ${teamName}`)
              .setDescription(playerMentions)
              .setFooter({ text: `#${queueNum}` })
              .setTimestamp();

            const msg = await ch.send({ embeds: [card] });
            registerTeamCard(msg.id, interaction.guildId, teamIndex);

            const numLobbies  = settings.lobbies || 4;
            const lobbyEmojis = ['🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯'].slice(0, numLobbies);
            for (const e of lobbyEmojis) {
              try { await msg.react(e); } catch {}
              await new Promise(r => setTimeout(r, 300));
            }
          }
        } catch (err) {
          console.error('⚠️ Could not post team card:', err.message);
        }
      }

      // ── Public reply — the slash command + this reply are both visible ─────
      if (isWaitlist) {
        return interaction.editReply({
          content: `⏳ **[${teamTag}] ${teamName}** added to waitlist #${queueNum}`,
        });
      } else {
        return interaction.editReply({ content: '✅' });
      }

    } catch (err) {
      console.error('❌ /register error:', err);
      return replyError(interaction, errorEmbed('Error', err.message));
    }
  }
};
