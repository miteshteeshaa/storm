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
  EmbedBuilder,
} = require('discord.js');
const { getConfig, setConfig, getScrimSettings, setScrimSettings } = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

const CHANNEL_FIELDS = {
  register_channel:    'Registration Channel',
  slotlist_channel:    'Slot Allocation Channel',
  waitlist_channel:    'Waitlist Channel',
  results_channel:     'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  idpass_channel:      'ID/Pass Channel (Slot List)',
  admin_channel:       'Admin Channel',
};

const ROLE_FIELDS = {
  admin_role:      'Admin Role',
  registered_role: 'Registered Role',
  slot_role:       'Slot Holder Role',
  waitlist_role:   'Waitlist Role',
  idpass_role:     'ID/Pass Role',
};

function buildStepMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_step')
      .setPlaceholder('⚙️ What do you want to configure?')
      .addOptions([
        // Scrim Settings
        { label: '🏆 Scrim Name',             value: 'scrim_name',          description: 'Name of the scrim event' },
        { label: '🏟️ Number of Lobbies',      value: 'lobbies',             description: 'How many lobbies' },
        { label: '🎯 Slots per Lobby',         value: 'slots',               description: 'How many slots total' },
        { label: '🔢 First Slot Number',       value: 'first_slot',          description: 'Starting slot number (e.g. 1 or 10)' },
        // Channels
        { label: '📝 Registration Channel',   value: 'register_channel',    description: 'Where teams submit /register' },
        { label: '🎯 Slot Allocation Channel', value: 'slotlist_channel',    description: 'Where team cards are posted' },
        { label: '⏳ Waitlist Channel',        value: 'waitlist_channel',    description: 'Where waitlist is posted' },
        { label: '📊 Results Channel',         value: 'results_channel',     description: 'Where results are posted' },
        { label: '🏆 Leaderboard Channel',     value: 'leaderboard_channel', description: 'Where leaderboard is posted' },
        { label: '🔐 ID/Pass Channel',         value: 'idpass_channel',      description: 'Always-visible slot list + ID/Pass' },
        { label: '🛡️ Admin Channel',           value: 'admin_channel',       description: 'Admin control channel' },
        // Roles
        { label: '👑 Admin Role',              value: 'admin_role',          description: 'Who can use admin commands' },
        { label: '✅ Registered Role',         value: 'registered_role',     description: 'Auto-given on registration' },
        { label: '🎯 Slot Holder Role',        value: 'slot_role',           description: 'Given to confirmed slots' },
        { label: '⏳ Waitlist Role',           value: 'waitlist_role',       description: 'Given to waitlisted teams' },
        { label: '🔐 ID/Pass Role',            value: 'idpass_role',         description: 'Gets access to ID/Pass channel' },
        { label: '📋 Google Sheet URL',        value: 'sheet_url',           description: 'Link to Google Sheet' },
        { label: '📦 View Current Config',     value: 'view_config',         description: 'See current configuration' },
      ])
  );
}

function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
  );
}

function buildConfigEmbed(config, settings) {
  const ch = id => id ? `<#${id}>` : '`Not Set`';
  const ro = id => id ? `<@&${id}>` : '`Not Set`';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ BOT CONFIGURATION')
    .addFields(
      {
        name: '🎮 Scrim Settings',
        value: [
          `🏆 Name: \`${settings.scrim_name}\``,
          `🏟️ Lobbies: \`${settings.lobbies}\``,
          `🎯 Slots: \`${settings.slots}\``,
          `🔢 First Slot: \`${settings.first_slot}\``,
        ].join('\n'),
        inline: false,
      },
      {
        name: '📢 Channels',
        value: [
          `📝 Registration: ${ch(config.register_channel)}`,
          `🎯 Slot Allocation: ${ch(config.slotlist_channel)}`,
          `⏳ Waitlist: ${ch(config.waitlist_channel)}`,
          `📊 Results: ${ch(config.results_channel)}`,
          `🏆 Leaderboard: ${ch(config.leaderboard_channel)}`,
          `🔐 ID/Pass: ${ch(config.idpass_channel)}`,
          `🛡️ Admin: ${ch(config.admin_channel)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎭 Roles',
        value: [
          `👑 Admin: ${ro(config.admin_role)}`,
          `✅ Registered: ${ro(config.registered_role)}`,
          `🎯 Slot Holder: ${ro(config.slot_role)}`,
          `⏳ Waitlist: ${ro(config.waitlist_role)}`,
          `🔐 ID/Pass: ${ro(config.idpass_role)}`,
        ].join('\n'),
        inline: false,
      },
      { name: '📊 Google Sheet', value: config.sheet_url ? `[Open Sheet](${config.sheet_url})` : '`Not Set`', inline: false },
    )
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the scrim bot (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) {
      return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    }
    if (!await isAdmin(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });
    }

    const config   = getConfig(interaction.guildId);
    const settings = getScrimSettings(interaction.guildId);

    const msg = await interaction.reply({
      embeds: [buildConfigEmbed(config, settings)],
      components: [buildStepMenu()],
      ephemeral: true,
      fetchReply: true,
    });

    while (true) {
      let i;
      try {
        i = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 300_000 });
      } catch {
        try { await msg.edit({ components: [] }); } catch {}
        return;
      }

      const customId = i.customId;
      const value    = i.values?.[0] ?? customId;
      const cfg      = getConfig(interaction.guildId);
      const stg      = getScrimSettings(interaction.guildId);

      // ── Scrim settings modals ─────────────────────────────────────────────
      if (['scrim_name', 'lobbies', 'slots', 'first_slot'].includes(value)) {
        const labels = {
          scrim_name:  ['Scrim Name', 'e.g. SUNGOLD LEAGUE'],
          lobbies:     ['Number of Lobbies', 'e.g. 4'],
          slots:       ['Total Slots', 'e.g. 16'],
          first_slot:  ['First Slot Number', 'e.g. 1 or 10'],
        };
        const [label, placeholder] = labels[value];
        const currentVal = String(stg[value] ?? '');

        await i.showModal(
          new ModalBuilder()
            .setCustomId(`scrim_setting_${value}`)
            .setTitle(`Set ${label}`)
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('setting_input')
                  .setLabel(label)
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder(placeholder)
                  .setRequired(true)
                  .setValue(currentVal)
              )
            )
        );

        let m;
        try {
          m = await interaction.awaitModalSubmit({
            filter: x => x.customId === `scrim_setting_${value}` && x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch { continue; }

        const raw = m.fields.getTextInputValue('setting_input').trim();
        if (['lobbies', 'slots', 'first_slot'].includes(value)) {
          const num = parseInt(raw);
          if (isNaN(num) || num < 1) {
            await m.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });
            continue;
          }
          setScrimSettings(interaction.guildId, { [value]: num });
        } else {
          setScrimSettings(interaction.guildId, { [value]: raw });
        }

        await m.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });

      // ── Channel picker ────────────────────────────────────────────────────
      } else if (CHANNEL_FIELDS[value]) {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg)],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId('config_channel_pick')
                .setPlaceholder(`Select the ${CHANNEL_FIELDS[value]}`)
                .addChannelTypes(ChannelType.GuildText)
            ),
            buildBackRow(),
          ],
        });

        const pendingField = value;
        let j;
        try {
          j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 });
        } catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (j.customId === 'config_back') {
          await j.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });
          continue;
        }
        setConfig(interaction.guildId, { [pendingField]: j.values[0] });
        await j.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });

      // ── Role picker ───────────────────────────────────────────────────────
      } else if (ROLE_FIELDS[value]) {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg)],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId('config_role_pick')
                .setPlaceholder(`Select the ${ROLE_FIELDS[value]}`)
            ),
            buildBackRow(),
          ],
        });

        const pendingField = value;
        let j;
        try {
          j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 });
        } catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (j.customId === 'config_back') {
          await j.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });
          continue;
        }
        setConfig(interaction.guildId, { [pendingField]: j.values[0] });
        await j.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });

      // ── Sheet URL modal ───────────────────────────────────────────────────
      } else if (value === 'sheet_url') {
        await i.showModal(
          new ModalBuilder()
            .setCustomId('config_sheet_modal')
            .setTitle('📋 Google Sheet URL')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('sheet_url_input')
                  .setLabel('Paste your Google Sheet URL')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('https://docs.google.com/spreadsheets/d/...')
                  .setRequired(true)
                  .setValue(cfg.sheet_url || '')
              )
            )
        );

        let m;
        try {
          m = await interaction.awaitModalSubmit({
            filter: x => x.customId === 'config_sheet_modal' && x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch { continue; }

        setConfig(interaction.guildId, { sheet_url: m.fields.getTextInputValue('sheet_url_input') });
        await m.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });

      // ── View / Back ───────────────────────────────────────────────────────
      } else {
        await i.update({ embeds: [buildConfigEmbed(getConfig(interaction.guildId), getScrimSettings(interaction.guildId))], components: [buildStepMenu()] });
      }
    }
  },
};
