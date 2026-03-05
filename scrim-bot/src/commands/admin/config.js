const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, EmbedBuilder,
} = require('discord.js');
const {
  getConfig, setConfig, getScrimSettings, setScrimSettings,
  getLobbyConfig, setLobbyConfig
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

// ── All configurable channels ─────────────────────────────────────────────────
const CHANNEL_FIELDS = {
  register_channel:    'Registration Channel',
  slotlist_channel:    'Accept Teams Channel',
  waitlist_channel:    'Waitlist Channel',
  results_channel:     'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  idpass_channel:      'Overall Slot List Channel',
  admin_channel:       'Admin Channel',
};

// ── All configurable roles ────────────────────────────────────────────────────
const ROLE_FIELDS = {
  admin_role:      'Admin Role',
  registered_role: 'Registered Role',
  slot_role:       'Slot Holder Role',
  waitlist_role:   'Waitlist Role',
};

// ── Build the main config embed ───────────────────────────────────────────────
function buildConfigEmbed(config, settings, lobbyConf) {
  const ch = id => id ? `<#${id}>` : '`Not Set`';
  const ro = id => id ? `<@&${id}>` : '`Not Set`';
  const numLobbies   = settings.lobbies || 4;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);

  const lobbyLines = lobbyLetters.map(l => {
    const lc = lobbyConf[l] || {};
    return `**Lobby ${l}:** ${lc.channel_id ? `<#${lc.channel_id}>` : '`No Channel`'} | ${lc.role_id ? `<@&${lc.role_id}>` : '`No Role`'}`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ BOT CONFIGURATION')
    .addFields(
      {
        name: '🎮 Scrim Settings',
        value: `🏆 Name: \`${settings.scrim_name}\`\n🏟️ Lobbies: \`${numLobbies}\`\n🎯 Total Slots: \`${settings.slots}\`\n🔢 First Slot: \`${settings.first_slot}\``,
        inline: false
      },
      { name: '🏟️ Lobby Channels & Roles', value: lobbyLines || '*None configured*', inline: false },
      {
        name: '📢 Channels',
        value: [
          `📝 Registration: ${ch(config.register_channel)}`,
          `🎯 Accept Teams: ${ch(config.slotlist_channel)}`,
          `📋 Overall Slot List: ${ch(config.idpass_channel)}`,
          `⏳ Waitlist: ${ch(config.waitlist_channel)}`,
          `📊 Results: ${ch(config.results_channel)}`,
          `🏆 Leaderboard: ${ch(config.leaderboard_channel)}`,
          `🛡️ Admin: ${ch(config.admin_channel)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎭 General Roles',
        value: [
          `👑 Admin: ${ro(config.admin_role)}`,
          `✅ Registered: ${ro(config.registered_role)}`,
          `🎯 Slot Holder: ${ro(config.slot_role)}`,
          `⏳ Waitlist: ${ro(config.waitlist_role)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '📊 Google Sheet',
        value: config.sheet_url ? `[Open Sheet](${config.sheet_url})` : '`Not Set`',
        inline: false
      },
    )
    .setTimestamp();
}

// ── Build the MAIN menu (top-level categories) ────────────────────────────────
function buildMainMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_main')
      .setPlaceholder('⚙️ What do you want to configure?')
      .addOptions([
        { label: '🎮 Scrim Settings',        value: 'menu_scrim',    description: 'Name, lobbies, slots, first slot' },
        { label: '🏟️ Lobby Channels & Roles', value: 'menu_lobbies',  description: 'Per-lobby channel and role setup' },
        { label: '📢 Channels',              value: 'menu_channels', description: 'Registration, results, waitlist...' },
        { label: '🎭 Roles',                 value: 'menu_roles',    description: 'Admin, registered, slot holder...' },
        { label: '📋 Google Sheet URL',      value: 'sheet_url',     description: 'Link to your Google Sheet' },
        { label: '📦 View Current Config',   value: 'view_config',   description: 'See the full configuration' },
      ])
  );
}

// ── Build scrim settings submenu ──────────────────────────────────────────────
function buildScrimMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_scrim')
      .setPlaceholder('🎮 Choose a scrim setting...')
      .addOptions([
        { label: '🏆 Scrim Name',       value: 'scrim_name',  description: 'Name of the scrim event' },
        { label: '🏟️ Number of Lobbies', value: 'lobbies',     description: 'How many lobbies (A, B, C...)' },
        { label: '🎯 Total Slots',       value: 'slots',       description: 'Total teams in the scrim' },
        { label: '🔢 First Slot Number', value: 'first_slot',  description: 'Starting slot number per lobby' },
      ])
  );
}

// ── Build channels submenu ────────────────────────────────────────────────────
function buildChannelsMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_channels')
      .setPlaceholder('📢 Choose a channel to set...')
      .addOptions([
        { label: '📝 Registration Channel',    value: 'register_channel',    description: 'Where teams submit /register' },
        { label: '🎯 Accept Teams Channel',    value: 'slotlist_channel',    description: 'Team cards for admin to assign' },
        { label: '📋 Overall Slot List',       value: 'idpass_channel',      description: 'Shows all lobbies combined' },
        { label: '⏳ Waitlist Channel',        value: 'waitlist_channel',    description: 'Waitlist channel' },
        { label: '📊 Results Channel',         value: 'results_channel',     description: 'Results channel' },
        { label: '🏆 Leaderboard Channel',     value: 'leaderboard_channel', description: 'Leaderboard channel' },
        { label: '🛡️ Admin Channel',           value: 'admin_channel',       description: 'Admin channel' },
      ])
  );
}

// ── Build roles submenu ───────────────────────────────────────────────────────
function buildRolesMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_roles')
      .setPlaceholder('🎭 Choose a role to set...')
      .addOptions([
        { label: '👑 Admin Role',       value: 'admin_role',      description: 'Who can use admin commands' },
        { label: '✅ Registered Role',  value: 'registered_role', description: 'Auto-given on registration' },
        { label: '🎯 Slot Holder Role', value: 'slot_role',       description: 'Given to confirmed slot teams' },
        { label: '⏳ Waitlist Role',    value: 'waitlist_role',   description: 'Given to waitlisted teams' },
      ])
  );
}

// ── Build lobbies submenu (dynamic based on lobby count) ──────────────────────
function buildLobbiesMenu(settings) {
  const numLobbies   = settings.lobbies || 4;
  const lobbyLetters = ['A','B','C','D','E','F'].slice(0, numLobbies);

  const options = lobbyLetters.flatMap(l => [
    { label: `🏟️ Lobby ${l} — Channel`, value: `lobby_channel_${l}`, description: `Private channel for Lobby ${l}` },
    { label: `🎭 Lobby ${l} — Role`,    value: `lobby_role_${l}`,    description: `Access role for Lobby ${l}` },
  ]);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_lobbies')
      .setPlaceholder('🏟️ Choose a lobby to configure...')
      .addOptions(options)
  );
}

function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
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
      components: [buildMainMenu()],
      ephemeral: true,
      fetchReply: true,
    });

    // ── Main event loop ────────────────────────────────────────────────────────
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

      // ── Main menu routing ──────────────────────────────────────────────────
      if (customId === 'config_main') {
        if (value === 'menu_scrim') {
          await i.update({ embeds: [buildConfigEmbed(cfg, stg, lc)], components: [buildScrimMenu(), buildBackRow()] });
          continue;
        }
        if (value === 'menu_lobbies') {
          await i.update({ embeds: [buildConfigEmbed(cfg, stg, lc)], components: [buildLobbiesMenu(stg), buildBackRow()] });
          continue;
        }
        if (value === 'menu_channels') {
          await i.update({ embeds: [buildConfigEmbed(cfg, stg, lc)], components: [buildChannelsMenu(), buildBackRow()] });
          continue;
        }
        if (value === 'menu_roles') {
          await i.update({ embeds: [buildConfigEmbed(cfg, stg, lc)], components: [buildRolesMenu(), buildBackRow()] });
          continue;
        }
        if (value === 'sheet_url') {
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
          await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildMainMenu()] });
          continue;
        }
        // view_config — just refresh
        const r = fresh();
        await i.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildMainMenu()] });
        continue;
      }

      // ── Back button ────────────────────────────────────────────────────────
      if (customId === 'config_back') {
        const r = fresh();
        await i.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildMainMenu()] });
        continue;
      }

      // ── Scrim settings submenu ─────────────────────────────────────────────
      if (customId === 'config_scrim') {
        const labels = {
          scrim_name: ['Scrim Name', 'e.g. SUNGOLD LEAGUE', stg.scrim_name],
          lobbies:    ['Number of Lobbies (1-6)', 'e.g. 4', String(stg.lobbies)],
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
          if (!isNaN(num) && num >= 1) {
            if (value === 'lobbies' && num > 6) {
              // Cap at 6 lobbies max
              setScrimSettings(interaction.guildId, { [value]: 6 });
            } else {
              setScrimSettings(interaction.guildId, { [value]: num });
            }
          }
        } else {
          setScrimSettings(interaction.guildId, { [value]: raw });
        }
        const r = fresh();
        // After changing lobbies, re-show lobbies menu so it rebuilds dynamically
        const backToMenu = value === 'lobbies'
          ? [buildLobbiesMenu(r.settings), buildBackRow()]
          : [buildScrimMenu(), buildBackRow()];
        await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: backToMenu });
        continue;
      }

      // ── Channels submenu ───────────────────────────────────────────────────
      if (customId === 'config_channels') {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId('pick_channel')
                .setPlaceholder(`Select the ${CHANNEL_FIELDS[value] || value}`)
                .addChannelTypes(ChannelType.GuildText)
            ),
            buildBackRow(),
          ],
        });
        const fieldKey = value;
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }
        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildChannelsMenu(), buildBackRow()] });
          continue;
        }
        setConfig(interaction.guildId, { [fieldKey]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildChannelsMenu(), buildBackRow()] });
        continue;
      }

      // ── Roles submenu ──────────────────────────────────────────────────────
      if (customId === 'config_roles') {
        await i.update({
          embeds: [buildConfigEmbed(cfg, stg, lc)],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId('pick_role')
                .setPlaceholder(`Select the ${ROLE_FIELDS[value] || value}`)
            ),
            buildBackRow(),
          ],
        });
        const fieldKey = value;
        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }
        if (j.customId === 'config_back') {
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildRolesMenu(), buildBackRow()] });
          continue;
        }
        setConfig(interaction.guildId, { [fieldKey]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildRolesMenu(), buildBackRow()] });
        continue;
      }

      // ── Lobbies submenu — channel picker ───────────────────────────────────
      if (customId === 'config_lobbies') {
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
            await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildLobbiesMenu(r.settings), buildBackRow()] });
            continue;
          }
          setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], channel_id: j.values[0] } });
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildLobbiesMenu(r.settings), buildBackRow()] });
          continue;
        }

        if (value.startsWith('lobby_role_')) {
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
            await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildLobbiesMenu(r.settings), buildBackRow()] });
            continue;
          }
          setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], role_id: j.values[0] } });
          const r = fresh();
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildLobbiesMenu(r.settings), buildBackRow()] });
          continue;
        }
      }

      // ── Fallback: just refresh main ────────────────────────────────────────
      const r = fresh();
      await i.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [buildMainMenu()] });
    }
  },
};
