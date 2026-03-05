const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getServer, getConfig, getRegistrations, setRegistrations
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen } = require('../../utils/permissions');
const { writeRegistrationSheet, extractSheetId } = require('../../utils/sheets');
const { buildSlotListEmbed, getPersistentSlotListId, setPersistentSlotListId } = require('../../handlers/reactionHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your team for the scrim')
    .addStringOption(opt =>
      opt.setName('team_name').setDescription('Your team full name').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('team_tag').setDescription('Short tag e.g. ZRX').setRequired(true).setMaxLength(8)
    )
    .addUserOption(opt =>
      opt.setName('manager').setDescription('Tag your team manager/captain').setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      if (!isActivated(interaction.guildId)) {
        return interaction.editReply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active on this server.')] });
      }
      if (!isRegistrationOpen(interaction.guildId)) {
        return interaction.editReply({ embeds: [errorEmbed('Registration Closed', 'Wait for the admin to open registration.')] });
      }

      const config   = getConfig(interaction.guildId);
      const server   = getServer(interaction.guildId);
      const maxSlots = server.max_slots || config.max_slots || 100;
      const data     = getRegistrations(interaction.guildId);

      const teamName  = interaction.options.getString('team_name');
      const teamTag   = interaction.options.getString('team_tag').toUpperCase();
      const manager   = interaction.options.getUser('manager');
      const captainId = interaction.user.id;

      // ── Duplicate checks ────────────────────────────────────────────────────
      const allTeams = [...data.slots, ...data.waitlist];

      if (allTeams.find(t => t.captain_id === captainId)) {
        return interaction.editReply({ embeds: [errorEmbed('Already Registered', 'You already registered a team.')] });
      }
      if (allTeams.find(t => t.team_name.toLowerCase() === teamName.toLowerCase())) {
        return interaction.editReply({ embeds: [errorEmbed('Name Taken', `**${teamName}** is already registered.`)] });
      }
      if (allTeams.find(t => t.team_tag.toLowerCase() === teamTag.toLowerCase())) {
        return interaction.editReply({ embeds: [errorEmbed('Tag Taken', `**${teamTag}** is already in use.`)] });
      }

      // ── Slot or waitlist ────────────────────────────────────────────────────
      const isWaitlist = data.slots.length >= maxSlots;

      const team = {
        team_name:    teamName,
        team_tag:     teamTag,
        captain_name: manager.username,
        captain_id:   captainId,
        manager_id:   manager.id,
        timestamp:    new Date().toISOString(),
        lobby:        null,
      };

      let slotNumber;
      if (!isWaitlist) {
        data.slots.push(team);
        slotNumber = data.slots.length;
      } else {
        data.waitlist.push(team);
        slotNumber = data.waitlist.length;
      }

      setRegistrations(interaction.guildId, data);

      // ── Roles ───────────────────────────────────────────────────────────────
      try {
        const member = interaction.member;
        if (config.registered_role) await member.roles.add(config.registered_role).catch(() => {});
        if (!isWaitlist) {
          if (config.slot_role)     await member.roles.add(config.slot_role).catch(() => {});
          if (config.idpass_role)   await member.roles.add(config.idpass_role).catch(() => {});
          if (config.waitlist_role) await member.roles.remove(config.waitlist_role).catch(() => {});
        } else {
          if (config.waitlist_role) await member.roles.add(config.waitlist_role).catch(() => {});
        }
      } catch {}

      // ── Google Sheet ────────────────────────────────────────────────────────
      if (config.sheet_url) {
        try {
          const sheetId = extractSheetId(config.sheet_url);
          if (sheetId) await writeRegistrationSheet(sheetId, data.slots);
        } catch {}
      }

      // ── Post team card in slot-allocation channel ───────────────────────────
      const allocationChannelId = config.slotlist_channel;
      if (allocationChannelId) {
        try {
          const ch = await interaction.guild.channels.fetch(allocationChannelId);
          if (ch) {
            const card = new EmbedBuilder()
              .setColor(isWaitlist ? 0xFFAA00 : 0x5865F2)
              .setDescription(`**[${teamTag}] ${teamName}** <@${manager.id}>`)
              .setFooter({ text: isWaitlist ? `Waitlist #${slotNumber}` : `Slot #${slotNumber}` })
              .setTimestamp();

            const msg = await ch.send({ embeds: [card] });

            // Add reaction buttons like the manual bot
            for (const emoji of ['✅', '❌', '🅰️', '🅱️', '🇨', '🇩', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']) {
              try { await msg.react(emoji); } catch {}
            }
          }
        } catch (err) {
          console.error('⚠️ Could not post team card:', err.message);
        }
      }

      // ── Update the persistent live slot list (idpass channel) ───────────────
      await updatePersistentSlotList(interaction, config, data);

      // ── Reply ───────────────────────────────────────────────────────────────
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(isWaitlist ? 0xFFAA00 : 0x00FF7F)
            .setTitle(isWaitlist ? '⏳ Added to Waitlist' : '✅ Registration Confirmed!')
            .addFields(
              { name: '🏷️ Team', value: `[${teamTag}] ${teamName}`, inline: true },
              { name: '👤 Manager', value: `<@${manager.id}>`, inline: true },
              { name: isWaitlist ? '📋 Waitlist #' : '🎯 Slot #', value: `${slotNumber}`, inline: true },
            )
            .setFooter({ text: isWaitlist ? 'You will be notified if a slot opens.' : 'Good luck in the scrim!' })
            .setTimestamp()
        ]
      });

    } catch (err) {
      console.error('❌ /register error:', err);
      return interaction.editReply({ embeds: [errorEmbed('Error', err.message)] });
    }
  }
};

// ── Create or update the persistent slot list in the idpass channel ───────────
async function updatePersistentSlotList(interaction, config, data) {
  // Use idpass_channel for the always-visible slot list
  const channelId = config.idpass_channel || config.slotlist_channel;
  if (!channelId) return;

  try {
    const ch       = await interaction.guild.channels.fetch(channelId);
    if (!ch) return;

    const maxSlots = config.max_slots || 100;
    const embed    = buildSlotListEmbed(data.slots, maxSlots);

    // Check if we already have a pinned slot list message
    const existingId = getPersistentSlotListId(interaction.guildId);

    if (existingId) {
      try {
        const existing = await ch.messages.fetch(existingId);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {
        // Message was deleted, post a new one
      }
    }

    // Search recent messages for one we posted
    const msgs     = await ch.messages.fetch({ limit: 50 });
    const existing = msgs.find(m =>
      m.author.id === interaction.client.user.id &&
      m.embeds[0]?.title?.includes('SLOT LIST')
    );

    if (existing) {
      setPersistentSlotListId(interaction.guildId, existing.id);
      await existing.edit({ embeds: [embed] });
    } else {
      const newMsg = await ch.send({ embeds: [embed] });
      setPersistentSlotListId(interaction.guildId, newMsg.id);
      try { await newMsg.pin(); } catch {}
    }
  } catch (err) {
    console.error('⚠️ Could not update persistent slot list:', err.message);
  }
}
