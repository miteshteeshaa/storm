const { SlashCommandBuilder } = require('discord.js');
const {
  getConfig, getRegistrations, setRegistrations,
  getScrimSettings, getLobbyConfig,
} = require('../../utils/database');
const { successEmbed, errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const {
  refreshAllSlotLists,
  getPersistentSlotListId,
} = require('../../handlers/reactionHandler');
const { syncTeamsToSheet } = require('../../utils/sheets');

const LOBBY_LETTERS = ['A','B','C','D','E','F','G','H','I','J'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeslot')
    .setDescription('Remove a team from a specific lobby slot (Admin only)')
    .addStringOption(opt =>
      opt.setName('lobby')
        .setDescription('Lobby letter (e.g. A, B, C...)')
        .setRequired(true)
        .addChoices(
          ...LOBBY_LETTERS.map(l => ({ name: `Lobby ${l}`, value: l }))
        )
    )
    .addIntegerOption(opt =>
      opt.setName('slot')
        .setDescription('Slot number to remove (e.g. 3)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(25)
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId))
      return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))
      return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const lobby   = interaction.options.getString('lobby').toUpperCase();
    const slotNum = interaction.options.getInteger('slot');

    const data      = getRegistrations(interaction.guildId);
    const settings  = getScrimSettings(interaction.guildId);
    const config    = getConfig(interaction.guildId);
    const lobbyConf = getLobbyConfig(interaction.guildId);

    // Validate lobby is within configured range
    const numLobbies = settings.lobbies || 4;
    if (!LOBBY_LETTERS.slice(0, numLobbies).includes(lobby)) {
      return interaction.reply({
        embeds: [errorEmbed('Invalid Lobby', `Lobby **${lobby}** is not configured. Valid lobbies: ${LOBBY_LETTERS.slice(0, numLobbies).join(', ')}`)],
        ephemeral: true,
      });
    }

    // Find the team in that lobby/slot
    const teamIndex = data.slots.findIndex(
      t => t.lobby === lobby && t.lobby_slot === slotNum
    );

    if (teamIndex === -1) {
      return interaction.reply({
        embeds: [errorEmbed('Slot Empty', `No team found in **Lobby ${lobby}**, slot **${slotNum}**. It may already be empty.`)],
        ephemeral: true,
      });
    }

    const team = data.slots[teamIndex];
    const teamLabel = `[${team.team_tag}] ${team.team_name}`;

    await interaction.deferReply({ ephemeral: true });

    // Remove lobby role from all players
    const lc = lobbyConf[lobby];
    if (lc?.role_id) {
      for (const playerId of (team.players || [team.manager_id, team.captain_id])) {
        try {
          const member = await interaction.guild.members.fetch(playerId);
          await member.roles.remove(lc.role_id).catch(() => {});
        } catch {}
      }
    }

    // Clear slot assignment (keep team in slots list as unassigned)
    delete data.slots[teamIndex].lobby;
    delete data.slots[teamIndex].lobby_slot;
    delete data.slots[teamIndex].confirmed;

    setRegistrations(interaction.guildId, data);

    // Refresh all slot list embeds
    await refreshAllSlotLists(interaction.guild, config, settings, lobbyConf, data);

    // Sync sheet in background
    if (config.spreadsheet_id) {
      syncTeamsToSheet(config.spreadsheet_id, data.slots).catch(() => {});
    }

    await interaction.editReply({
      embeds: [successEmbed(
        'Slot Removed',
        `**${teamLabel}** has been removed from **Lobby ${lobby} — Slot ${slotNum}**.\n\nThe team is now unassigned and the slot is free.`
      )],
    });
  },
};
