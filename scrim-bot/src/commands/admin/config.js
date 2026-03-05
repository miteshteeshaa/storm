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
  ComponentType,
} = require('discord.js');
const { getConfig, setConfig } = require('../../utils/database');
const { configEmbed, errorEmbed, successEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the scrim bot (Admin only)'),

  async execute(interaction) {
    // Delete the user's invocation message if possible
    if (interaction.channel.permissionsFor(interaction.guild.members.me).has('ManageMessages')) {
      try { await interaction.message?.delete(); } catch {}
    }

    if (!isActivated(interaction.guildId)) {
      return interaction.reply({
        embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')],
        ephemeral: true
      });
    }

    if (!await isAdmin(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('Access Denied', 'You need the Admin role to use this command.')],
        ephemeral: true
      });
    }

    const config = getConfig(interaction.guildId);

    // ─── Step Selector ────────────────────────────────────────────────────────
    const stepMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('config_step_select')
        .setPlaceholder('⚙️ What do you want to configure?')
        .addOptions([
          { label: '📝 Registration Channel', value: 'register_channel', emoji: '📝', description: 'Where teams submit /register' },
          { label: '🎯 Slot List Channel', value: 'slotlist_channel', emoji: '🎯', description: 'Where slot list is posted' },
          { label: '⏳ Waitlist Channel', value: 'waitlist_channel', emoji: '⏳', description: 'Where waitlist is posted' },
          { label: '📊 Results Channel', value: 'results_channel', emoji: '📊', description: 'Where match results are posted' },
          { label: '🏆 Leaderboard Channel', value: 'leaderboard_channel', emoji: '🏆', description: 'Where leaderboard is posted' },
          { label: '🔐 ID/Pass Channel', value: 'idpass_channel', emoji: '🔐', description: 'Room ID/Password channel' },
          { label: '🛡️ Admin Channel', value: 'admin_channel', emoji: '🛡️', description: 'Admin control channel' },
          { label: '👑 Admin Role', value: 'admin_role', emoji: '👑', description: 'Role that can use admin commands' },
          { label: '✅ Registered Role', value: 'registered_role', emoji: '✅', description: 'Auto-given on registration' },
          { label: '🎯 Slot Holder Role', value: 'slot_role', emoji: '🎯', description: 'Given to confirmed slots' },
          { label: '⏳ Waitlist Role', value: 'waitlist_role', emoji: '⏳', description: 'Given to waitlisted teams' },
          { label: '🔐 ID/Pass Role', value: 'idpass_role', emoji: '🔐', description: 'Allows viewing ID/Pass channel' },
          { label: '📋 Google Sheet URL', value: 'sheet_url', emoji: '📋', description: 'Link to Google Sheet' },
          { label: '🎮 Max Slots & Lobbies', value: 'slots_lobbies', emoji: '🎮', description: 'Set slot count and lobby count' },
          { label: '📦 View Current Config', value: 'view_config', emoji: '📦', description: 'See current configuration' },
        ])
    );

    const reply = await interaction.reply({
      embeds: [configEmbed(config)],
      components: [stepMenu],
      ephemeral: true,
      fetchReply: true
    });

    const collector = reply.createMessageComponentCollector({
      time: 300_000 // 5 minutes
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: '❌ This config menu is not for you.', ephemeral: true });
      }

      const val = i.values?.[0] || i.customId;

      // Defer immediately to prevent "interaction failed" timeout
      if (val !== 'sheet_url' && val !== 'slots_lobbies') {
        try { await i.deferUpdate(); } catch {}
      }

      // ─── Channel pickers ────────────────────────────────────────────────────
      const channelFields = ['register_channel', 'slotlist_channel', 'waitlist_channel', 'results_channel', 'leaderboard_channel', 'idpass_channel', 'admin_channel'];
      const roleFields = ['admin_role', 'registered_role', 'slot_role', 'waitlist_role', 'idpass_role'];

      if (channelFields.includes(val)) {
        const labels = {
          register_channel: 'Registration Channel',
          slotlist_channel: 'Slot List Channel',
          waitlist_channel: 'Waitlist Channel',
          results_channel: 'Results Channel',
          leaderboard_channel: 'Leaderboard Channel',
          idpass_channel: 'ID/Pass Channel',
          admin_channel: 'Admin Channel',
        };
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`channel_pick_${val}`)
            .setPlaceholder(`Select the ${labels[val]}`)
            .addChannelTypes(ChannelType.GuildText)
        );
        const backBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
        );
        await i.editReply({ embeds: [configEmbed(getConfig(interaction.guildId))], components: [row, backBtn] });

      } else if (val.startsWith('channel_pick_')) {
        const field = val.replace('channel_pick_', '');
        const channelId = i.values[0];
        setConfig(interaction.guildId, { [field]: channelId });
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [stepMenu]
        });

      } else if (roleFields.includes(val)) {
        const labels = {
          admin_role: 'Admin Role',
          registered_role: 'Registered Role',
          slot_role: 'Slot Holder Role',
          waitlist_role: 'Waitlist Role',
          idpass_role: 'ID/Pass Role',
        };
        const row = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(`role_pick_${val}`)
            .setPlaceholder(`Select the ${labels[val]}`)
        );
        const backBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
        );
        await i.editReply({ embeds: [configEmbed(getConfig(interaction.guildId))], components: [row, backBtn] });

      } else if (val.startsWith('role_pick_')) {
        const field = val.replace('role_pick_', '');
        const roleId = i.values[0];
        setConfig(interaction.guildId, { [field]: roleId });
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [stepMenu]
        });

      } else if (val === 'sheet_url') {
        // Modal for text input
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

      } else if (val === 'slots_lobbies') {
        const modal = new ModalBuilder()
          .setCustomId('config_slots_modal')
          .setTitle('🎮 Max Slots & Lobbies');
        const cfg = getConfig(interaction.guildId);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_slots_input')
              .setLabel('Maximum Slots (teams in scrim)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. 100')
              .setRequired(true)
              .setValue(String(cfg.max_slots || 100))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_lobbies_input')
              .setLabel('Number of Lobbies')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. 10')
              .setRequired(true)
              .setValue(String(cfg.max_lobbies || 10))
          )
        );
        await i.showModal(modal);

      } else if (val === 'view_config' || val === 'config_back') {
        await i.editReply({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [stepMenu]
        });
      }
    });

    // Handle modals
    const filter = (i) =>
      (i.customId === 'config_sheet_modal' || i.customId === 'config_slots_modal') &&
      i.user.id === interaction.user.id;

    const modalCollector = interaction.channel.createMessageComponentCollector({ filter, time: 300_000 });

    interaction.client.on('interactionCreate', async (modalInt) => {
      if (!modalInt.isModalSubmit()) return;
      if (modalInt.user.id !== interaction.user.id) return;

      if (modalInt.customId === 'config_sheet_modal') {
        const url = modalInt.fields.getTextInputValue('sheet_url_input');
        setConfig(interaction.guildId, { sheet_url: url });
        await modalInt.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [stepMenu]
        });

      } else if (modalInt.customId === 'config_slots_modal') {
        const slots = parseInt(modalInt.fields.getTextInputValue('max_slots_input')) || 100;
        const lobbies = parseInt(modalInt.fields.getTextInputValue('max_lobbies_input')) || 10;
        setConfig(interaction.guildId, { max_slots: slots, max_lobbies: lobbies });
        await modalInt.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [stepMenu]
        });
      }
    });

    collector.on('end', async () => {
      try {
        await reply.edit({ components: [] });
      } catch {}
    });
  }
};
