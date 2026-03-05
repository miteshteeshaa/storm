const { SlashCommandBuilder } = require('discord.js');
const { getServer, getConfig, getRegistrations, setRegistrations } = require('../../utils/database');
const { teamRegisteredEmbed, errorEmbed, slotListEmbed } = require('../../utils/embeds');
const { isActivated, isRegistrationOpen } = require('../../utils/permissions');
const { writeRegistrationSheet, extractSheetId } = require('../../utils/sheets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your team for the scrim')
    .addStringOption(opt =>
      opt.setName('team_name').setDescription('Your team name').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('team_tag').setDescription('Short team tag (e.g. TA)').setRequired(true).setMaxLength(6)
    )
    .addStringOption(opt =>
      opt.setName('captain_name').setDescription('Captain in-game name').setRequired(true)
    ),

  async execute(interaction) {
    // Delete user message (for slash commands, defer+delete original)
    await interaction.deferReply({ ephemeral: true });

    if (!isActivated(interaction.guildId)) {
      return interaction.editReply({ embeds: [errorEmbed('Bot Not Active', 'The scrim bot is not active on this server.')] });
    }

    if (!isRegistrationOpen(interaction.guildId)) {
      return interaction.editReply({ embeds: [errorEmbed('Registration Closed', 'Registration is currently closed. Wait for the admin to open it.')] });
    }

    const config = getConfig(interaction.guildId);
    const server = getServer(interaction.guildId);
    const maxSlots = server.max_slots || 100;
    const data = getRegistrations(interaction.guildId);

    const teamName = interaction.options.getString('team_name');
    const teamTag = interaction.options.getString('team_tag').toUpperCase();
    const captainName = interaction.options.getString('captain_name');
    const captainId = interaction.user.id;

    // ─── Duplicate Checks ─────────────────────────────────────────────────────
    const allTeams = [...data.slots, ...data.waitlist];

    if (allTeams.find(t => t.captain_id === captainId)) {
      return interaction.editReply({
        embeds: [errorEmbed('Already Registered', 'You have already registered a team. Each user can only register once.')]
      });
    }

    if (allTeams.find(t => t.team_name.toLowerCase() === teamName.toLowerCase())) {
      return interaction.editReply({
        embeds: [errorEmbed('Team Name Taken', `A team named **${teamName}** is already registered.`)]
      });
    }

    if (allTeams.find(t => t.team_tag.toLowerCase() === teamTag.toLowerCase())) {
      return interaction.editReply({
        embeds: [errorEmbed('Tag Taken', `The tag **${teamTag}** is already in use.`)]
      });
    }

    // ─── Slot or Waitlist ──────────────────────────────────────────────────────
    const isWaitlist = data.slots.length >= maxSlots;

    const team = {
      team_name: teamName,
      team_tag: teamTag,
      captain_name: captainName,
      captain_id: captainId,
      timestamp: new Date().toISOString(),
      lobby: null,
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

    // ─── Role Assignment ───────────────────────────────────────────────────────
    try {
      const member = interaction.member;

      if (config.registered_role) await member.roles.add(config.registered_role).catch(() => {});

      if (!isWaitlist) {
        if (config.slot_role) await member.roles.add(config.slot_role).catch(() => {});
        if (config.idpass_role) await member.roles.add(config.idpass_role).catch(() => {});
        if (config.waitlist_role) await member.roles.remove(config.waitlist_role).catch(() => {});
      } else {
        if (config.waitlist_role) await member.roles.add(config.waitlist_role).catch(() => {});
      }
    } catch {}

    // ─── Auto-sync to Sheet ────────────────────────────────────────────────────
    if (config.sheet_url) {
      try {
        const sheetId = extractSheetId(config.sheet_url);
        if (sheetId) await writeRegistrationSheet(sheetId, data.slots);
      } catch {}
    }

    // ─── Post to slot/waitlist channel ───────────────────────────────────────
    const targetChannel = isWaitlist ? config.waitlist_channel : config.slotlist_channel;
    if (targetChannel) {
      try {
        const channel = await interaction.guild.channels.fetch(targetChannel);
        if (channel) {
          await channel.send({
            embeds: [slotListEmbed(data.slots, data.waitlist)]
          });
        }
      } catch {}
    }

    return interaction.editReply({
      embeds: [teamRegisteredEmbed(team, slotNumber, isWaitlist)]
    });
  }
};
