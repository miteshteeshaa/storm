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

            // React with lobby letter emojis first (🇦🇧🇨... up to numLobbies)
            const numLobbies = settings.lobbies || 4;
            const LOBBY_EMOJI_LIST = ['🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯'];
            for (let i = 0; i < numLobbies; i++) {
              try { await msg.react(LOBBY_EMOJI_LIST[i]); } catch {}
              await new Promise(r => setTimeout(r, 250));
            }

            // React with godsent slot emojis — one per slot in the lobby
            const SLOT_EMOJIS = [
              { name: 'godsent_01', id: '786762092941541386' },
              { name: 'godsent_02', id: '786762092941279232' },
              { name: 'godsent_03', id: '786762092765511711' },
              { name: 'godsent_04', id: '786762093197393992' },
              { name: 'godsent_05', id: '786762093289537546' },
              { name: 'godsent_06', id: '786762093369098250' },
              { name: 'godsent_07', id: '786762093360709692' },
              { name: 'godsent_08', id: '786762093264502785' },
              { name: 'godsent_09', id: '786762093113114625' },
              { name: 'godsent_10', id: '786762093251919952' },
              { name: 'godsent_11', id: '786762093214171176' },
              { name: 'godsent_12', id: '786762093259915328' },
              { name: 'godsent_13', id: '786762093340262410' },
              { name: 'godsent_14', id: '786762093276692511' },
              { name: 'godsent_15', id: '786762093373554688' },
              { name: 'godsent_16', id: '786762093269090314' },
              { name: 'godsent_17', id: '786762093289275442' },
              { name: 'godsent_18', id: '786762093260570644' },
              { name: 'godsent_19', id: '786762093276692512' },
              { name: 'godsent_20', id: '786762093113901067' },
              { name: 'godsent_21', id: '786762093075890207' },
              { name: 'godsent_22', id: '786762093349044245' },
              { name: 'godsent_23', id: '786762093239074827' },
              { name: 'godsent_24', id: '786762093587464212' },
              { name: 'godsent_25', id: '786762093122158603' },
            ];
            const slotsPerLobby = settings.slots_per_lobby || 24;
            const emojiCount = Math.min(slotsPerLobby, SLOT_EMOJIS.length);
            for (let i = 0; i < emojiCount; i++) {
              try { await msg.react(`${SLOT_EMOJIS[i].name}:${SLOT_EMOJIS[i].id}`); } catch {}
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
