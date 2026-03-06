// ── /results command ───────────────────────────────────────────────────────────
const {
  SlashCommandBuilder, AttachmentBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');
const { getConfig, getScrimSettings, getRegistrations } = require('../../utils/database');
const { errorEmbed, infoEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { generateResultsImage } = require('../../utils/imageGenerator');
const { getSheetStandings } = require('../../utils/sheets');
const fs   = require('fs');

const MEDALS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('results')
    .setDescription('Generate and post the final results image (Admin only)')
    .addStringOption(opt =>
      opt.setName('lobby')
        .setDescription('Which lobby (A, B, C...)')
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!isActivated(interaction.guildId))
      return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction))
      return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
      const config   = getConfig(interaction.guildId);
      const settings = getScrimSettings(interaction.guildId);

      // Check template
      const templatePath = config.results_template_path;
      if (!templatePath || !fs.existsSync(templatePath)) {
        return interaction.editReply({
          embeds: [errorEmbed('No Template', 'Upload a results template via `/config` → "Results Template Image".')],
        });
      }

      // Check sheet
      if (!config.spreadsheet_id && !config.sheet_url) {
        return interaction.editReply({
          embeds: [errorEmbed('No Sheet', 'No Google Sheet linked. Run `/config` and set the Sheet URL.')],
        });
      }

      const spreadsheetId = config.spreadsheet_id || extractSheetId(config.sheet_url);

      await interaction.editReply({ embeds: [infoEmbed('⏳ Generating...', 'Fetching standings from Google Sheet...')] });

      // Pull standings
      const lobbyFilter = interaction.options.getString('lobby')?.toUpperCase() || null;
      const standings   = await getSheetStandings(spreadsheetId, settings.slots_per_lobby || 24);

      if (!standings || standings.length === 0) {
        return interaction.editReply({ embeds: [errorEmbed('No Data', 'No match data found in the Google Sheet.')] });
      }

      // Sort + rank
      standings.sort((a, b) => b.total - a.total);
      standings.forEach((t, i) => t.rank = i + 1);

      // Generate image
      const imageBuffer       = await generateResultsImage(templatePath, standings);
      const previewAttachment = new AttachmentBuilder(imageBuffer, { name: 'results_preview.png' });

      // Channel picker
      const channelRow = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('results_channel_pick')
          .setPlaceholder('Select channel to post results in')
          .addChannelTypes(ChannelType.GuildText)
      );

      await interaction.editReply({
        content: '**Preview — select a channel to post:**',
        files: [previewAttachment],
        components: [channelRow],
        embeds: [],
      });

      // Wait for channel pick
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

      // Build announcement embed
      const scrimName = settings.scrim_name || 'SCRIM';
      const lobbyLabel = lobbyFilter ? `Lobby ${lobbyFilter}` : 'Overall';
      const dateStr   = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: undefined });

      const top3Lines = standings.slice(0, 3).map((t, i) =>
        `${MEDALS[i]} **${t.team_name}**`
      ).join('\n');

      const announcementEmbed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`Results of ${scrimName} Scrims, ${lobbyLabel} on ${dateStr}`)
        .setDescription(
          `Congratulation to **${standings[0]?.team_name}** for 1st place!\n\n` +
          top3Lines
        )
        .setTimestamp();

      // Post to target channel
      const targetChannel  = await interaction.guild.channels.fetch(targetChannelId);
      const finalAttachment = new AttachmentBuilder(imageBuffer, { name: 'results.png' });

      await targetChannel.send({
        embeds: [announcementEmbed],
        files:  [finalAttachment],
      });

      await interaction.editReply({
        content: `✅ Results posted in <#${targetChannelId}>!`,
        files: [], components: [], embeds: [],
      });

    } catch (err) {
      console.error('Results error:', err);
      await interaction.editReply({
        embeds: [errorEmbed('Error', `Something went wrong: ${err.message}`)],
        files: [], components: [],
      });
    }
  },
};

function extractSheetId(url) {
  const m = (url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}
