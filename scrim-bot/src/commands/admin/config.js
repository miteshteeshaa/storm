const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require('discord.js');
const { getConfig, setConfig } = require('../../utils/database');
const { configEmbed, errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

const CHANNEL_FIELDS = {
  register_channel: 'Registration Channel',
  slotlist_channel: 'Slot List Channel',
  waitlist_channel: 'Waitlist Channel',
  results_channel: 'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  idpass_channel: 'ID/Pass Channel',
  admin_channel: 'Admin Channel',
};

const ROLE_FIELDS = {
  admin_role: 'Admin Role',
  registered_role: 'Registered Role',
  slot_role: 'Slot Holder Role',
  waitlist_role: 'Waitlist Role',
  idpass_role: 'ID/Pass Role',
};

function buildStepMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_step_select')
      .setPlaceholder('⚙️ What do you want to configure?')
      .addOptions([
        { label: '📝 Registration Channel', value: 'register_channel', description: 'Where teams submit /register' },
        { label: '🎯 Slot List Channel', value: 'slotlist_channel', description: 'Where slot list is posted' },
        { label: '⏳ Waitlist Channel', value: 'waitlist_channel', description: 'Where waitlist is posted' },
        { label: '📊 Results Channel', value: 'results_channel', description: 'Where match results are posted' },
        { label: '🏆 Leaderboard Channel', value: 'leaderboard_channel', description: 'Where leaderboard is posted' },
        { label: '🔐 ID/Pass Channel', value: 'idpass_channel', description: 'Room ID/Password channel' },
        { label: '🛡️ Admin Channel', value: 'admin_channel', description: 'Admin control channel' },
        { label: '👑 Admin Role', value: 'admin_role', description: 'Role that can use admin commands' },
        { label: '✅ Registered Role', value: 'registered_role', description: 'Auto-given on registration' },
        { label: '🎯 Slot Holder Role', value: 'slot_role', description: 'Given to confirmed slots' },
        { label: '⏳ Waitlist Role', value: 'waitlist_role', description: 'Given to waitlisted teams' },
        { label: '🔐 ID/Pass Role', value: 'idpass_role', description: 'Allows viewing ID/Pass channel' },
        { label: '📋 Google Sheet URL', value: 'sheet_url', description: 'Link to Google Sheet' },
        { label: '🎮 Max Slots & Lobbies', value: 'slots_lobbies', description: 'Set slot count and lobby count' },
        { label: '📦 View Current Config', value: 'view_config', description: 'See current configuration' },
      ])
  );
}

function buildBackButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('config_back')
      .setLabel('⬅️ Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the scrim bot (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) {
      return interaction.reply({
        embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')],
        ephemeral: true
      });
    }

    if (!await isAdmin(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('Access Denied', 'You need the Admin role.')],
        ephemeral: true
      });
    }

    const reply = await interaction.reply({
      embeds: [configEmbed(getConfig(interaction.guildId))],
      components: [buildStepMenu()],
      ephemeral: true,
      fetchReply: true
    });

    // Single collector handles ALL component interactions
    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: 300_000
    });

    collector.on('collect', async (i) => {
      const customId = i.customId;
      const value = i.values?.[0] || customId;

      // Channel field selected from step menu
      if (Object.keys(CHANNEL_FIELDS).includes(value)) {
        await i.deferUpdate();
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`channel_pick_${value}`)
                .setPlaceholder(`Select the ${CHANNEL_FIELDS[value]}`)
                .addChannelTypes(ChannelType.GuildText)
            ),
            buildBackButton()
          ]
        });

      // Role field selected from step menu
      } else if (Object.keys(ROLE_FIELDS).includes(value)) {
        await i.deferUpdate();
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId(`role_pick_${value}`)
                .setPlaceholder(`Select the ${ROLE_FIELDS[value]}`)
            ),
            buildBackButton()
          ]
        });

      // Channel was chosen from picker
      } else if (customId.startsWith('channel_pick_')) {
        await i.deferUpdate();
        const field = customId.replace('channel_pick_', '');
        setConfig(interaction.guildId, { [field]: i.values[0] });
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()]
        });

      // Role was chosen from picker
      } else if (customId.startsWith('role_pick_')) {
        await i.deferUpdate();
        const field = customId.replace('role_pick_', '');
        setConfig(interaction.guildId, { [field]: i.values[0] });
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()]
        });

      // Sheet URL modal
      } else if (value === 'sheet_url') {
        const modal = new ModalBuilder()
          .setCustomId('config_sheet_modal')
          .setTitle('📋 Google Sheet URL');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('sheet_url_input')
              .setLabel('Paste your Google Sheet URL')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('https://docs.google.com/spreadsheets/d/...')
              .setRequired(true)
              .setValue(getConfig(interaction.guildId).sheet_url || '')
          )
        );
        await i.showModal(modal);

      // Slots & Lobbies modal
      } else if (value === 'slots_lobbies') {
        const cfg = getConfig(interaction.guildId);
        const modal = new ModalBuilder()
          .setCustomId('config_slots_modal')
          .setTitle('🎮 Max Slots & Lobbies');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_slots_input')
              .setLabel('Maximum Slots (teams in scrim)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(cfg.max_slots || 100))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_lobbies_input')
              .setLabel('Number of Lobbies')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(cfg.max_lobbies || 10))
          )
        );
        await i.showModal(modal);

      // Back / View config
      } else if (value === 'view_config' || customId === 'config_back') {
        await i.deferUpdate();
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()]
        });
      }
    });

    // Modal submissions
    const modalHandler = async (modalInt) => {
      if (!modalInt.isModalSubmit()) return;
      if (modalInt.user.id !== interaction.user.id) return;
      if (!['config_sheet_modal', 'config_slots_modal'].includes(modalInt.customId)) return;

      if (modalInt.customId === 'config_sheet_modal') {
        const url = modalInt.fields.getTextInputValue('sheet_url_input');
        setConfig(interaction.guildId, { sheet_url: url });
      } else if (modalInt.customId === 'config_slots_modal') {
        const slots = parseInt(modalInt.fields.getTextInputValue('max_slots_input')) || 100;
        const lobbies = parseInt(modalInt.fields.getTextInputValue('max_lobbies_input')) || 10;
        setConfig(interaction.guildId, { max_slots: slots, max_lobbies: lobbies });
      }

      await modalInt.update({
        embeds: [configEmbed(getConfig(interaction.guildId))],
        components: [buildStepMenu()]
      });
    };

    interaction.client.on('interactionCreate', modalHandler);

    collector.on('end', () => {
      interaction.client.off('interactionCreate', modalHandler);
      try { reply.edit({ components: [] }); } catch {}
    });
  }
};
