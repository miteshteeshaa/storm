// ── /results command ──────────────────────────────────────────────────────────
// Pulls final standings from Google Sheet and generates a results image

const {
  SlashCommandBuilder, AttachmentBuilder,
  ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { getConfig, getScrimSettings } = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { generateResultsImage } = require('../../utils/imageGenerator');
const { getSheetStandings } = require('../../utils/sheets');
const fs   = require('fs');
const path = require('path');

// Scoring table (placement → points) matching your sheet
const PLACEMENT_PTS = {
  1:10, 2:6, 3:5, 4:4, 5:3, 6:2, 7:1, 8:1,
  9:0, 10:0, 11:0, 12:0, 13:0, 14:0, 15:0,
  16:0, 17:0, 18:0, 19:0, 20:0, 21:0, 22:0, 23:0, 24:0,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('results')
    .setDescription('Generate and post the final results image (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
      const config   = getConfig(interaction.guildId);
      const settings = getScrimSettings(interaction.guildId);

      // Check template exists
      const templatePath = config.results_template_path;
      if (!templatePath || !fs.existsSync(templatePath)) {
        return interaction.editReply({
          embeds: [errorEmbed('No Template', 'No results template uploaded. Use `/config` → "Results Template" to upload one.')],
        });
      }

      // Check sheet configured
      if (!config.spreadsheet_id) {
        return interaction.editReply({
          embeds: [errorEmbed('No Sheet', 'No Google Sheet linked. Run `/sheet` first.')],
        });
      }

      // ── Step 1: Ask which lobby (or all) ─────────────────────────────────
      const numLobbies  = settings.lobbies || 4;
      const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);

      const lobbyOptions = [
        { label: 'All Lobbies (combined)', value: 'ALL' },
        ...lobbyLetters.map(l => ({ label: `Lobby ${l}`, value: l })),
      ];

      const lobbyRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('results_lobby_pick')
          .setPlaceholder('Which lobby?')
          .addOptions(lobbyOptions)
      );

      await interaction.editReply({
        content: '**Step 1 — Select a lobby:**',
        components: [lobbyRow],
        embeds: [],
      });

      let lobbyPick;
      try {
        lobbyPick = await interaction.fetchReply().then(msg =>
          msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 })
        );
      } catch {
        await interaction.editReply({ content: 'Timed out.', components: [] });
        return;
      }

      const lobbyValue = lobbyPick.values[0]; // 'ALL' or 'A', 'B', etc.
      await lobbyPick.deferUpdate();

      await interaction.editReply({
        content: `⏳ Fetching standings for **${lobbyValue === 'ALL' ? 'All Lobbies' : `Lobby ${lobbyValue}`}**...`,
        components: [],
        embeds: [],
      });

      // Pull standings from sheet
      const lobbyFilter = lobbyValue === 'ALL' ? null : lobbyValue;
      const standings = await getSheetStandings(config.spreadsheet_id, settings.slots_per_lobby || 24, lobbyFilter);

      if (!standings || standings.length === 0) {
        return interaction.editReply({ embeds: [errorEmbed('No Data', 'No match data found in the Google Sheet yet.')] });
      }

      // Sort by total descending
      standings.sort((a, b) => b.total - a.total);
      standings.forEach((t, i) => {
        t.rank = i + 1;
        // wins = number of match wins (rank 1 finishes) pulled from sheet, default 0
        if (t.wins === undefined) t.wins = 0;
      });

      // Logo path for chicken dinner
      const logoPath = config.chicken_dinner_logo_path || null;

      // Generate image
      const imageBuffer = await generateResultsImage(
        templatePath,
        standings,
        config.results_font_color   || '#FFFFFF',
        config.results_accent_color || '#FFD700',
        logoPath
      );

      // Ask admin which channel to post in
      const channelRow = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('results_channel_pick')
          .setPlaceholder('Select channel to post results in')
          .addChannelTypes(ChannelType.GuildText)
      );

      const previewAttachment = new AttachmentBuilder(imageBuffer, { name: 'results_preview.png' });

      await interaction.editReply({
        content: '**Preview — select a channel to post:**',
        files: [previewAttachment],
        components: [channelRow],
        embeds: [],
      });

      // Wait for channel selection
      let pick;
      try {
        pick = await interaction.fetchReply().then(msg =>
          msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 })
        );
      } catch {
        await interaction.editReply({ content: 'Timed out.', files: [], components: [] });
        return;
      }

      const targetChannelId = pick.values[0];
      await pick.deferUpdate();

      // Post to selected channel
      const targetChannel = await interaction.guild.channels.fetch(targetChannelId);
      const finalAttachment = new AttachmentBuilder(imageBuffer, { name: 'results.png' });
      await targetChannel.send({ files: [finalAttachment] });

      await interaction.editReply({
        content: `✅ Results posted in <#${targetChannelId}>!`,
        files: [],
        components: [],
        embeds: [],
      });

    } catch (err) {
      console.error('Results error:', err);
      await interaction.editReply({
        embeds: [errorEmbed('Error', `Something went wrong: ${err.message}`)],
        files: [],
        components: [],
      });
    }
  },
};
