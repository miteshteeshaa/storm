const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getServer, getConfig, getRegistrations, setRegistrations, getScrimSettings
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen } = require('../../utils/permissions');
const { writeRegistrationSheet, extractSheetId } = require('../../utils/sheets');
const {
  buildPersistentSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  registerTeamCard,
} = require('../../handlers/reactionHandler');

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
    // Defer ephemeral for the private reply to registrant
    await interaction.deferReply({ ephemeral: true });

    try {
      if (!isActivated(interaction.guildId)) return interaction.editReply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active.')] });
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
          const sheetId = extractSheetId(config.sheet_url);
          if (sheetId) await writeRegistrationSheet(sheetId, data.slots);
        } catch {}
      }

      // ── Post PUBLIC ✅ confirmation in registration channel ───────────────
      // This is the visible green checkmark everyone sees (like the manual bot)
      if (config.register_channel) {
        try {
          const regCh = await interaction.guild.channels.fetch(config.register_channel);
          if (regCh) {
            const pubEmbed = new EmbedBuilder()
              .setColor(isWaitlist ? 0xFFAA00 : 0x00FF7F)
              .setDescription(
                isWaitlist
                  ? `⏳ **[${teamTag}] ${teamName}** added to waitlist #${queueNum}`
                  : `✅ **[${teamTag}] ${teamName}** registered — waiting for slot assignment`
              )
              .setTimestamp();
            await regCh.send({ embeds: [pubEmbed] });
          }
        } catch {}
      }

      // ── Post team card in slot-allocation channel (for admin to assign) ───
      if (config.slotlist_channel) {
        try {
          const ch = await interaction.guild.channels.fetch(config.slotlist_channel);
          if (ch) {
            const playerMentions = players.map(p => `<@${p.id}>`).join(' ');
            const teamIndex      = data.slots.length - 1;

            const card = new EmbedBuilder()
              .setColor(isWaitlist ? 0xFFAA00 : 0x5865F2)
              .setDescription(`**[${teamTag}] ${teamName}** ${playerMentions}`)
              .setFooter({ text: isWaitlist ? `Waitlist #${queueNum}` : `Queue #${queueNum} — admin: react to assign lobby + slot` })
              .setTimestamp();

            const msg = await ch.send({ embeds: [card] });

            if (!isWaitlist) registerTeamCard(msg.id, interaction.guildId, teamIndex);

            const numLobbies  = settings.lobbies || 4;
            const lobbyEmojis = ['🅰️','🅱️','🇨','🇩','🇪','🇫'].slice(0, numLobbies);
            const numEmojis   = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

            for (const e of [...lobbyEmojis, ...numEmojis]) {
              try { await msg.react(e); } catch {}
            }
          }
        } catch (err) {
          console.error('⚠️ Could not post team card:', err.message);
        }
      }

      // ── Update persistent overall slot list ───────────────────────────────
      await updatePersistentSlotList(interaction, config, settings, data);

      // ── Private reply to registrant ───────────────────────────────────────
      const playerMentions = players.map(p => `<@${p.id}>`).join(', ');
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(isWaitlist ? 0xFFAA00 : 0x00FF7F)
            .setTitle(isWaitlist ? '⏳ Added to Waitlist' : '✅ Registered!')
            .setDescription('Your team card has been posted. **Admin will assign your lobby and slot.**')
            .addFields(
              { name: '🏷️ Team', value: `[${teamTag}] ${teamName}`, inline: true },
              { name: '📋 Queue #', value: `${queueNum}`, inline: true },
              { name: '👥 Players (will get lobby role)', value: playerMentions },
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

async function updatePersistentSlotList(interaction, config, settings, data) {
  const channelId = config.idpass_channel || config.slotlist_channel;
  if (!channelId) return;
  try {
    const ch    = await interaction.guild.channels.fetch(channelId);
    if (!ch) return;
    const embed = buildPersistentSlotList(data.slots, settings);

    const ids        = getPersistentSlotListId(interaction.guildId);
    const existingId = ids.overall;

    if (existingId) {
      try {
        const existing = await ch.messages.fetch(existingId);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {}
    }

    const msgs     = await ch.messages.fetch({ limit: 50 });
    const existing = msgs.find(m =>
      m.author.id === interaction.client.user.id &&
      m.embeds[0]?.title?.includes('SLOT LIST')
    );
    if (existing) {
      setPersistentSlotListId(interaction.guildId, { overall: existing.id });
      await existing.edit({ embeds: [embed] });
    } else {
      const newMsg = await ch.send({ embeds: [embed] });
      setPersistentSlotListId(interaction.guildId, { overall: newMsg.id });
      try { await newMsg.pin(); } catch {}
    }
  } catch (err) {
    console.error('⚠️ Persistent slot list error:', err.message);
  }
}
