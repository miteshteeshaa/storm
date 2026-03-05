const { SlashCommandBuilder } = require('discord.js');
const { getConfig, getRegistrations, getMatches, setMatch } = require('../../utils/database');
const { resultEmbed, leaderboardEmbed, errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { extractSheetId, readLobbyResults, writeLeaderboard } = require('../../utils/sheets');

// Official placement point table
const PLACEMENT_POINTS = [15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const LOBBY_LETTERS    = ['A', 'B', 'C', 'D', 'E', 'F'];

function calcPlacementPts(placement) {
  if (!placement || placement < 1) return 0;
  return PLACEMENT_POINTS[placement - 1] || 0;
}

function buildLeaderboard(allMatches) {
  const teamMap = {};

  for (const [lobbyId, teams] of Object.entries(allMatches)) {
    for (const team of teams) {
      if (!teamMap[team.team_name]) {
        teamMap[team.team_name] = { team_name: team.team_name, matches: [], total: 0 };
      }
      teamMap[team.team_name].matches.push(team.total);
      teamMap[team.team_name].total += team.total;
    }
  }

  return Object.values(teamMap).sort((a, b) => b.total - a.total);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('result')
    .setDescription('Post results for a lobby (Admin only)')
    // FIX: Use a string option for lobby letter (A, B, C...) not a number
    .addStringOption(opt =>
      opt.setName('lobby')
        .setDescription('Lobby letter (A, B, C, D, E, F)')
        .setRequired(true)
        .addChoices(
          { name: 'Lobby A', value: 'A' },
          { name: 'Lobby B', value: 'B' },
          { name: 'Lobby C', value: 'C' },
          { name: 'Lobby D', value: 'D' },
          { name: 'Lobby E', value: 'E' },
          { name: 'Lobby F', value: 'F' },
        )
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) {
      return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    }
    if (!await isAdmin(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
    }

    // FIX: lobbyLetter is now 'A', 'B', etc. — matches what's stored in teams and sheets
    const lobbyLetter = interaction.options.getString('lobby').toUpperCase();
    const config      = getConfig(interaction.guildId);

    await interaction.deferReply({ ephemeral: false });

    // ─── Read from sheet ───────────────────────────────────────────────────────
    if (!config.sheet_url) {
      return interaction.editReply({ embeds: [errorEmbed('No Sheet', 'Configure a Google Sheet first with `/config`.')] });
    }

    let rawResults;
    try {
      const sheetId = extractSheetId(config.sheet_url);
      rawResults    = await readLobbyResults(sheetId, lobbyLetter);
    } catch (e) {
      return interaction.editReply({ embeds: [errorEmbed('Sheet Error', `Could not read sheet: ${e.message}`)] });
    }

    if (!rawResults || rawResults.length === 0) {
      return interaction.editReply({ embeds: [errorEmbed('No Data', `No teams found for Lobby ${lobbyLetter}. Make sure kills & placement are filled in the sheet.`)] });
    }

    // ─── Calculate points ──────────────────────────────────────────────────────
    const results = rawResults.map(t => {
      const placementPts = calcPlacementPts(t.placement);
      const total        = t.kills + placementPts;
      return { ...t, placement_pts: placementPts, total };
    });

    // ─── Save to memory (keyed by letter) ─────────────────────────────────────
    setMatch(interaction.guildId, lobbyLetter, results);

    // ─── Post result embed ─────────────────────────────────────────────────────
    const rEmbed = resultEmbed(lobbyLetter, results);

    if (config.results_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(config.results_channel);
        if (ch) await ch.send({ embeds: [rEmbed] });
      } catch {}
    }

    // ─── Update leaderboard ────────────────────────────────────────────────────
    const allMatches  = getMatches(interaction.guildId);
    const leaderboard = buildLeaderboard(allMatches);

    // Write leaderboard to sheet
    try {
      const sheetId = extractSheetId(config.sheet_url);
      await writeLeaderboard(sheetId, leaderboard);
    } catch {}

    // Post leaderboard embed
    const lbEmbed = leaderboardEmbed(leaderboard);
    if (config.leaderboard_channel) {
      try {
        const ch = await interaction.guild.channels.fetch(config.leaderboard_channel);
        if (ch) await ch.send({ embeds: [lbEmbed] });
      } catch {}
    }

    return interaction.editReply({ embeds: [rEmbed, lbEmbed] });
  }
};
