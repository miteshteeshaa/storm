const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getServer, getConfig, getRegistrations, setRegistrations, getScrimSettings
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen } = require('../../utils/permissions');
const { syncTeamsToSheet } = require('../../utils/sheets');
const { registerTeamCard } = require('../../handlers/reactionHandler');

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
    await interaction.deferReply({ ephemeral: true });

    try {
      if (!isActivated(interaction.guildId))        return interaction.editReply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active.')] });
      if (!isRegistrationOpen(interaction.guildId)) return interaction.editReply({ embeds: [errorEmbed('Registration Closed', 'Wait for admin to open registration.')] });

      const config   = getConfig(interaction.guildId);
      const settings = getScrimSettings(interaction.guildId);
      const data     = getRegistrations(interaction.guildId);

      const teamName  = interaction.options.getString('team_name');
      const teamTag   = interaction.options.getString('team_tag').toUpperCase();
      const manager   = interaction.options.getUser('manager');
      const captainId = interaction.user.id;

      const players = [manager];
      for (const key of ['player2','player3','player4','player5']) {
        const p = interaction.options.getUser(key);
        if (p && !players.find(x => x.id === p.id)) players.push(p);
      }

      // ── Duplicate checks ──────────────────────────────────────────────────
      const allTeams = [...data.slots, ...data.waitlist];
      if (allTeams.find(t => t.team_tag.toLowerCase() === teamTag.toLowerCase()))
        return interaction.editReply({ embeds: [errorEmbed('Tag Taken', `**[${teamTag}]** is already registered.`)] });
      if (allTeams.find(t => t.team_name.toLowerCase() === teamName.toLowerCase()))
        return interaction.editReply({ embeds: [errorEmbed('Name Taken', `**${teamName}** is already registered.`)] });

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

      // ── Google Sheet ──────────────────────────────────────────────────────
      if (config.sheet_url) {
        try {
          const m = (config.sheet_url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
          const sheetId = m ? m[1] : null;
          if (sheetId) await syncTeamsToSheet(sheetId, data.slots);
        } catch {}
      }



      // ── Public confirmation in registration channel ───────────────────────
      if (config.register_channel) {
        try {
          const regCh = await interaction.guild.channels.fetch(config.register_channel);
          if (regCh) {
            await regCh.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(isWaitlist ? 0xFFAA00 : 0x00FF7F)
                  .setDescription(
                    isWaitlist
                      ? `⏳ **[${teamTag}] ${teamName}** added to waitlist #${queueNum}`
                      : `✅ **[${teamTag}] ${teamName}** registered — waiting for slot assignment`
                  )
                  .setTimestamp()
              ]
            });
          }
        } catch {}
      }

      // ── Post team card in slot-allocation channel ─────────────────────────
      // Only lobby letter emojis — slot is auto-assigned when admin reacts
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

            // Add configured lobby letter emojis only (based on lobby count)
            const numLobbies  = settings.lobbies || 4;
            const lobbyEmojis = ['🅐','🅑','🅒','🅓','🅔','🅕','🅖','🅗','🅘','🅙'].slice(0, numLobbies);
            for (const e of lobbyEmojis) {
              try { await msg.react(e); } catch {}
              await new Promise(r => setTimeout(r, 300)); // avoid rate limit
            }
            // ❌ added by reactionHandler after slot is assigned
            }
          }
        } catch (err) {
          console.error('⚠️ Could not post team card:', err.message);
        }
      }


      // ── Private reply to registrant ───────────────────────────────────────
      const playerMentions = players.map(p => `<@${p.id}>`).join(', ');
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(isWaitlist ? 0xFFAA00 : 0x00FF7F)
            .setTitle(isWaitlist ? '⏳ Added to Waitlist' : '✅ Registered!')
            .setDescription('Your team has been registered. **Admin will assign your lobby and slot.**')
            .addFields(
              { name: '🏷️ Team',    value: `[${teamTag}] ${teamName}`, inline: true },
              { name: '📋 Queue #', value: `${queueNum}`,               inline: true },
              { name: '👥 Players', value: playerMentions },
            )
            .setFooter({ text: 'You will receive your lobby role once admin assigns your slot.' })
            .setTimestamp()
        ]
      });

    } catch (err) {
      console.error('❌ /register error:', err);
      return interaction.editReply({ embeds: [errorEmbed('Error', err.message)] });
    }
  }
};
