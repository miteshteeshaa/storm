const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, EmbedBuilder,
} = require('discord.js');
const { getConfig, setConfig, getScrimSettings, setScrimSettings, getLobbyConfig, setLobbyConfig } = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

const CHANNEL_FIELDS = {
  register_channel:    'Registration Channel',
  slotlist_channel:    'Slot Allocation Channel',
  waitlist_channel:    'Waitlist Channel',
  results_channel:     'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  idpass_channel:      'Overall Slot List Channel',
  admin_channel:       'Admin Channel',
};

const ROLE_FIELDS = {
  admin_role:      'Admin Role',
  registered_role: 'Registered Role',
  slot_role:       'Slot Holder Role',
  waitlist_role:   'Waitlist Role',
};

function buildStepMenu(settings) {
  const numLobbies = settings.lobbies || 4;
  const lobbyOptions = ['A','B','C','D','E','F'].slice(0, numLobbies).flatMap(l => [
    { label: `🏟️ Lobby ${l} — Channel`, value: `lobby_channel_${l}`, description: `Set the private channel for Lobby ${l}` },
    { label: `🎭 Lobby ${l} — Role`,    value: `lobby_role_${l}`,    description: `Set the role for Lobby ${l} access` },
  ]);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_step')
      .setPlaceholder('⚙️ What do you want to configure?')
      .addOptions([
        { label: '🏆 Scrim Name',             value: 'scrim_name',          description: 'Name of the scrim event' },
        { label: '🏟️ Number of Lobbies',      value: 'lobbies',             description: 'How many lobbies (A, B, C...)' },
        { label: '🎯 Total Slots',             value: 'slots',               description: 'Total teams in the scrim' },
        { label: '🔢 First Slot Number',       value: 'first_slot',          description: 'Starting slot number per lobby' },
        { label: '📝 Registration Channel',   value: 'register_channel',    description: 'Where teams submit /register' },
        { label: '🎯 Slot Allocation Channel', value: 'slotlist_channel',    description: 'Where team cards are posted for admin' },
        { label: '📋 Overall Slot List',       value: 'idpass_channel',      description: 'Shows all lobbies combined' },
        { label: '⏳ Waitlist Channel',        value: 'waitlist_channel',    description: 'Waitlist channel' },
        { label: '📊 Results Channel',         value: 'results_channel',     description: 'Results channel' },
        { label: '🏆 Leaderboard Channel',     value: 'leaderboard_channel', description: 'Leaderboard channel' },
        { label: '🛡️ Admin Channel',           value: 'admin_channel',       description: 'Admin channel' },
        { label: '👑 Admin Role',              value: 'admin_role',          description: 'Who can use admin commands' },
        { label: '✅ Registered Role',         value: 'registered_role',     description: 'Auto-given on registration' },
        { label: '🎯 Slot Holder Role',        value: 'slot_role',           description: 'Given when registered' },
        { label: '⏳ Waitlist Role',           value: 'waitlist_role',       description: 'Given to waitlisted teams' },
        { label: '📋 Google Sheet URL',        value: 'sheet_url',           description: 'Link to Google Sheet' },
        ...lobbyOptions,
        { label: '📦 View Current Config',     value: 'view_config',         description: 'See full configuration' },
      ])
  );
}

function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
  );
}

function buildConfigEmbed(config, settings, lobbyConf) {
  const ch = id => id ? `<#${id}>` : '`Not Set`';
  const ro = id => id ? `<@&${id}>` : '`Not Set`';
  const numLobbies = settings.lobbies || 4;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);

  const lobbyLines = lobbyLetters.map(l => {
    const lc = lobbyConf[l] || {};
    return `**Lobby ${l}:** ${lc.channel_id ? `<#${lc.channel_id}>` : '`No Channel`'} | ${lc.role_id ? `<@&${lc.role_id}>` : '`No Role`'}`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ BOT CONFIGURATION')
    .addFields(
      { name: '🎮 Scrim Settings', value: `🏆 Name: \`${settings.scrim_name}\`\n🏟️ Lobbies: \`${numLobbies}\`\n🎯 Total Slots: \`${settings.slots}\`\n🔢 First Slot: \`${settings.first_slot}\``, inline: false },
      { name: '🏟️ Lobby Channels & Roles', value: lobbyLines, inline: false },
      {
        name: '📢 Channels',
        value: [
          `📝 Registration: ${ch(config.register_channel)}`,
          `🎯 Slot Allocation: ${ch(config.slotlist_channel)}`,
          `📋 Overall Slot List: ${ch(config.idpass_channel)}`,
          `⏳ Waitlist: ${ch(config.waitlist_channel)}`,
          `📊 Results: ${ch(config.results_channel)}`,
          `🏆 Leaderboard: ${ch(config.leaderboard_channel)}`,
          `🛡️ Admin: ${ch(config.admin_channel)}`,
        ].join('\n'), inline: false,
      },
      {
        name: '🎭 General Roles',
        value: [
          `👑 Admin: ${ro(config.admin_role)}`,
          `✅ Registered: ${ro(config.registered_role)}`,
          `🎯 Slot Holder: ${ro(config.slot_role)}`,
          `⏳ Waitlist: ${ro(config.waitlist_role)}`,
        ].join('\n'), inline: false,
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
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const fresh = () => ({
      config:    getConfig(interaction.guildId),
      settings:  getScrimSettings(interaction.guildId),
      lobbyConf: getLobbyConfig(interaction.guildId),
    });

    const { config, settings, lobbyConf } = fresh();
    const msg = await interaction.reply({
      embeds: [buildConfigEmbed(config, settings, lobbyConf)],
      components: [buildStepMenu(settings)],
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
      const { config: cfg, settings: stg, lobbyConf: lc } = fresh();

      // ── Lobby channel ────────────────────────────────────────────────────
      if (value.startsWith('lobby_channel_')) {
        const letter = value.replace('lobby_channel_', '');
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`pick_lobby_channel_${letter}`)
                .setPlaceholder(`Select private channel for Lobby ${letter}`)
                .addChannelTypes(ChannelType.GuildText)
            ),
            buildBackRow(),
          ],
        });
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });
          continue;
        }
        setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], channel_id: j.values[0] } });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── Lobby role ───────────────────────────────────────────────────────
      } else if (value.startsWith('lobby_role_')) {
        const letter = value.replace('lobby_role_', '');
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId(`pick_lobby_role_${letter}`)
                .setPlaceholder(`Select role for Lobby ${letter} access`)
            ),
            buildBackRow(),
          ],
        });
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });
          continue;
        }
        setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], role_id: j.values[0] } });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── Scrim settings modals ────────────────────────────────────────────
      } else if (['scrim_name','lobbies','slots','first_slot'].includes(value)) {
        const labels = {
          scrim_name: ['Scrim Name', 'e.g. SUNGOLD LEAGUE', stg.scrim_name],
          lobbies:    ['Number of Lobbies', 'e.g. 4', String(stg.lobbies)],
          slots:      ['Total Slots', 'e.g. 24', String(stg.slots)],
          first_slot: ['First Slot Number', 'e.g. 1', String(stg.first_slot)],
        };
        const [label, placeholder, currentVal] = labels[value];
        await i.showModal(
          new ModalBuilder().setCustomId(`scrim_modal_${value}`).setTitle(`Set ${label}`)
            .addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val').setLabel(label)
                .setStyle(TextInputStyle.Short).setPlaceholder(placeholder)
                .setRequired(true).setValue(currentVal)
            ))
        );
        let m;
        try { m = await interaction.awaitModalSubmit({ filter: x => x.customId === `scrim_modal_${value}` && x.user.id === interaction.user.id, time: 120_000 }); }
        catch { continue; }
        const raw = m.fields.getTextInputValue('val').trim();
        if (['lobbies','slots','first_slot'].includes(value)) {
          const num = parseInt(raw);
          if (!isNaN(num) && num >= 1) setScrimSettings(interaction.guildId, { [value]: num });
        } else {
          setScrimSettings(interaction.guildId, { [value]: raw });
        }
        const r = fresh();
        await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── Channel picker ───────────────────────────────────────────────────
      } else if (CHANNEL_FIELDS[value]) {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder().setCustomId('pick_channel')
                .setPlaceholder(`Select the ${CHANNEL_FIELDS[value]}`).addChannelTypes(ChannelType.GuildText)
            ),
            buildBackRow(),
          ],
        });
        const pf = value;
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }
        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });
          continue;
        }
        setConfig(interaction.guildId, { [pf]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── Role picker ──────────────────────────────────────────────────────
      } else if (ROLE_FIELDS[value]) {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('pick_role').setPlaceholder(`Select the ${ROLE_FIELDS[value]}`)
            ),
            buildBackRow(),
          ],
        });
        const pf = value;
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }
        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });
          continue;
        }
        setConfig(interaction.guildId, { [pf]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── Sheet URL modal ──────────────────────────────────────────────────
      } else if (value === 'sheet_url') {
        await i.showModal(
          new ModalBuilder().setCustomId('config_sheet_modal').setTitle('📋 Google Sheet URL')
            .addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('sheet_url_input').setLabel('Paste Google Sheet URL')
                .setStyle(TextInputStyle.Short).setPlaceholder('https://docs.google.com/spreadsheets/d/...')
                .setRequired(true).setValue(cfg.sheet_url || '')
            ))
        );
        let m;
        try { m = await interaction.awaitModalSubmit({ filter: x => x.customId === 'config_sheet_modal' && x.user.id === interaction.user.id, time: 120_000 }); }
        catch { continue; }
        setConfig(interaction.guildId, { sheet_url: m.fields.getTextInputValue('sheet_url_input') });
        const r = fresh();
        await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });

      // ── View / Back ──────────────────────────────────────────────────────
      } else {
        const r = fresh();
        await i.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildStepMenu(r.settings)] });
      }
    }
  },
};
