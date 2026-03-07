const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, EmbedBuilder,
} = require('discord.js');
const { getConfig, setConfig, getScrimSettings, setScrimSettings, getLobbyConfig, setLobbyConfig } = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');

const { PermissionsBitField } = require('discord.js');

const CHANNEL_FIELDS = {
  register_channel:    'Registration Channel',
  slotlist_channel:    'Slot Allocation Channel',
  waitlist_channel:    'Waitlist Channel',
  results_channel:     'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  admin_channel:       'Admin Channel',
};

const ROLE_FIELDS = {
  admin_role:      'Admin Role',
  registered_role: 'Registered Role',
  slot_role:       'Slot Holder Role',
  waitlist_role:   'Waitlist Role',
};

// ── Apply lobby channel permissions ───────────────────────────────────────────
// Locks channel for @everyone, grants the lobby role: View, Read History, Add Reactions
async function applyLobbyChannelPerms(guild, channelId, roleId) {
  if (!channelId || !roleId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return;

    // Deny @everyone from viewing the channel
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: false,
    });

    // Grant the lobby role the required permissions
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel:        true,
      ReadMessageHistory: true,
      AddReactions:       true,
    });
  } catch (err) {
    console.error(`⚠️ applyLobbyChannelPerms error (ch:${channelId} role:${roleId}):`, err.message);
  }
}

function buildStepMenu(settings) {
  const numLobbies = settings.lobbies || 4;
  // Generate A-Z dynamically so any number of lobbies (up to 26) is supported
  const LOBBY_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const lobbyOptions = LOBBY_LETTERS.slice(0, numLobbies).flatMap(l => [
    { label: `Lobby ${l} - Channel`, value: `lobby_channel_${l}`, description: `Private channel for Lobby ${l}` },
    { label: `Lobby ${l} - Role`,    value: `lobby_role_${l}`,    description: `Role for Lobby ${l} access` },
  ]);

  const mainMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_step')
      .setPlaceholder('General Settings')
      .addOptions([
        { label: 'Scrim Name',              value: 'scrim_name',          description: 'Name of the scrim event' },
        { label: 'Number of Lobbies',       value: 'lobbies',             description: 'How many lobbies (A, B, C...)' },
        { label: 'Slots Per Lobby',         value: 'slots_per_lobby',     description: 'How many slots in EACH lobby (e.g. 24)' },
        { label: 'First Slot Number',       value: 'first_slot',          description: 'Starting slot number per lobby' },
        { label: 'Registration Channel',    value: 'register_channel',    description: 'Where teams submit /register' },
        { label: 'Slot Allocation Channel', value: 'slotlist_channel',    description: 'Where team cards are posted for admin' },
        { label: 'Waitlist Channel',        value: 'waitlist_channel',    description: 'Waitlist channel' },
        { label: 'Results Channel',         value: 'results_channel',     description: 'Results channel' },
        { label: 'Leaderboard Channel',     value: 'leaderboard_channel', description: 'Leaderboard channel' },
        { label: 'Admin Channel',           value: 'admin_channel',       description: 'Admin channel' },
        { label: 'Admin Role',              value: 'admin_role',          description: 'Who can use admin commands' },
        { label: 'Registered Role',         value: 'registered_role',     description: 'Auto-given on registration' },
        { label: 'Slot Holder Role',        value: 'slot_role',           description: 'Given when registered' },
        { label: 'Waitlist Role',           value: 'waitlist_role',       description: 'Given to waitlisted teams' },
        { label: 'Google Sheet URL',        value: 'sheet_url',           description: 'Link to Google Sheet' },
        { label: 'Results Template Image',   value: 'results_template',    description: 'Upload background image for /results' },
        { label: 'Results Font Colour',      value: 'results_font_color',  description: 'Text colour for /results overlay (hex e.g. #FFFFFF)' },
        { label: 'Chicken Dinner Logo',      value: 'chicken_dinner_logo', description: 'Upload logo shown for #1 finish teams on /results' },
        { label: 'View Current Config',     value: 'view_config',         description: 'See full configuration' },
      ])
  );

  const lobbyMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_step_lobby')
      .setPlaceholder('Lobby Channels & Roles')
      .addOptions(lobbyOptions)
  );

  return [mainMenu, lobbyMenu];
}
function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
  );
}

function buildConfigEmbed(config, settings, lobbyConf) {
  const ch = id => id ? `<#${id}>` : '`Not Set`';
  const ro = id => id ? `<@&${id}>` : '`Not Set`';
  const numLobbies    = settings.lobbies || 4;
  const slotsPerLobby = settings.slots_per_lobby || 24;
  // Generate A-Z dynamically so any number of lobbies (up to 26) is supported
  const LOBBY_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const lobbyLetters  = LOBBY_LETTERS.slice(0, numLobbies);

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
        value: [
          `🏆 Name: \`${settings.scrim_name}\``,
          `🏟️ Lobbies: \`${numLobbies}\``,
          `🎯 Slots Per Lobby: \`${slotsPerLobby}\``,
          `📊 Total Slots: \`${numLobbies * slotsPerLobby}\``,
          `🔢 First Slot: \`${settings.first_slot}\``,
        ].join('\n'),
        inline: false,
      },
      { name: '🏟️ Lobby Channels & Roles', value: lobbyLines, inline: false },
      {
        name: '📢 Channels',
        value: [
          `📝 Registration: ${ch(config.register_channel)}`,
          `🎯 Slot Allocation: ${ch(config.slotlist_channel)}`,
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
      { name: '🎨 Results Colours', value: `Text: \`${config.results_font_color || '#FFFFFF'}\`  Accent: \`${config.results_accent_color || '#FFD700'}\``, inline: false },
      { name: '🍗 Chicken Dinner Logo', value: config.chicken_dinner_logo_path ? '✅ Uploaded' : '`Not Set`', inline: false },
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
      components: [...buildStepMenu(settings)],
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
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
          continue;
        }
        setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], channel_id: j.values[0] } });
        // Apply perms if both channel and role are now set
        const updatedLc = getLobbyConfig(interaction.guildId)[letter] || {};
        if (updatedLc.channel_id && updatedLc.role_id) {
          await applyLobbyChannelPerms(interaction.guild, updatedLc.channel_id, updatedLc.role_id);
        }
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

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
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
          continue;
        }
        setLobbyConfig(interaction.guildId, { [letter]: { ...getLobbyConfig(interaction.guildId)[letter], role_id: j.values[0] } });
        // Apply perms if both channel and role are now set
        const updatedLc2 = getLobbyConfig(interaction.guildId)[letter] || {};
        if (updatedLc2.channel_id && updatedLc2.role_id) {
          await applyLobbyChannelPerms(interaction.guild, updatedLc2.channel_id, updatedLc2.role_id);
        }
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

      // ── Scrim settings modals ────────────────────────────────────────────
      } else if (['scrim_name','lobbies','slots_per_lobby','first_slot'].includes(value)) {
        const labels = {
          scrim_name:     ['Scrim Name',        'e.g. SUNGOLD LEAGUE', String(stg.scrim_name || 'SCRIM')],
          lobbies:        ['Number of Lobbies', 'e.g. 2',              String(stg.lobbies || 4)],
          slots_per_lobby:['Slots Per Lobby',   'e.g. 24',             String(stg.slots_per_lobby || 24)],
          first_slot:     ['First Slot Number', 'e.g. 1',              String(stg.first_slot || 1)],
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
        if (['lobbies','slots_per_lobby','first_slot'].includes(value)) {
          const num = parseInt(raw);
          if (value === 'lobbies' && (!isNaN(num)) && num > 10) {
            await m.reply({ content: '❌ Maximum number of lobbies is **10** (A–J). Please try again.', ephemeral: true });
            continue;
          }
          if (!isNaN(num) && num >= 1) setScrimSettings(interaction.guildId, { [value]: num });
          else {
            await m.reply({ content: '❌ Please enter a valid number (1 or higher).', ephemeral: true });
            continue;
          }
        } else {
          setScrimSettings(interaction.guildId, { [value]: raw });
        }
        const r = fresh();
        await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

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
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
          continue;
        }
        setConfig(interaction.guildId, { [pf]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

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
          await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
          continue;
        }
        setConfig(interaction.guildId, { [pf]: j.values[0] });
        const r = fresh();
        await j.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

      // ── Results template upload ─────────────────────────────────────────
      } else if (value === 'results_template') {
        await i.update({
          embeds: [],
          components: [],
          content: '📤 **Upload your results template image** (PNG/JPG, 1920x1080)\nSend it as a message attachment in this channel within 60 seconds.',
        });
        try {
          const collected = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
            max: 1, time: 60_000, errors: ['time'],
          });
          const attachment = collected.first().attachments.first();
          const { default: fetch } = require('node-fetch');
          const { createWriteStream, mkdirSync } = require('fs');
          const templateDir = process.env.DATA_DIR || '/data';
          mkdirSync(templateDir, { recursive: true });
          const savePath = `${templateDir}/results_template_${interaction.guildId}.png`;
          const res = await fetch(attachment.url);
          await new Promise((resolve, reject) => {
            const stream = createWriteStream(savePath);
            res.body.pipe(stream);
            stream.on('finish', resolve);
            stream.on('error', reject);
          });
          setConfig(interaction.guildId, { results_template_path: savePath });
          await collected.first().delete().catch(() => {});
          const r = fresh();
          await interaction.editReply({ content: null, embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
        } catch {
          const r = fresh();
          await interaction.editReply({ content: null, embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
        }
        continue;

      // ── Chicken dinner logo upload ────────────────────────────────────────
      } else if (value === 'chicken_dinner_logo') {
        await i.update({
          embeds: [],
          components: [],
          content: '🍗 **Upload your Chicken Dinner logo** (PNG with transparency recommended)\nSend it as a message attachment in this channel within 60 seconds.',
        });
        try {
          const collected = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
            max: 1, time: 60_000, errors: ['time'],
          });
          const attachment = collected.first().attachments.first();
          const { default: fetch } = require('node-fetch');
          const { createWriteStream, mkdirSync } = require('fs');
          const templateDir = process.env.DATA_DIR || '/data';
          mkdirSync(templateDir, { recursive: true });
          const savePath = `${templateDir}/chicken_dinner_logo_${interaction.guildId}.png`;
          const res = await fetch(attachment.url);
          await new Promise((resolve, reject) => {
            const stream = createWriteStream(savePath);
            res.body.pipe(stream);
            stream.on('finish', resolve);
            stream.on('error', reject);
          });
          setConfig(interaction.guildId, { chicken_dinner_logo_path: savePath });
          await collected.first().delete().catch(() => {});
          const r = fresh();
          await interaction.editReply({ content: null, embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
        } catch {
          const r = fresh();
          await interaction.editReply({ content: null, embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
        }
        continue;

      // ── Results font colour modal ────────────────────────────────────────
      } else if (value === 'results_font_color') {
        await i.showModal(
          new ModalBuilder().setCustomId('config_font_color_modal').setTitle('🎨 Results Font Colour')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('font_color_input')
                  .setLabel('Text colour (hex code)')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('#FFFFFF')
                  .setRequired(true)
                  .setValue(cfg.results_font_color || '#FFFFFF')
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('accent_color_input')
                  .setLabel('Accent colour for rank & total (hex code)')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('#FFD700')
                  .setRequired(true)
                  .setValue(cfg.results_accent_color || '#FFD700')
              )
            )
        );
        let fc;
        try {
          fc = await interaction.awaitModalSubmit({ filter: m => m.customId === 'config_font_color_modal' && m.user.id === interaction.user.id, time: 60_000 });
        } catch { continue; }
        const rawFont   = fc.fields.getTextInputValue('font_color_input').trim();
        const rawAccent = fc.fields.getTextInputValue('accent_color_input').trim();
        const hexRe = /^#([0-9A-Fa-f]{6})$/;
        if (!hexRe.test(rawFont) || !hexRe.test(rawAccent)) {
          await fc.reply({ content: '❌ Invalid hex colour — use format `#RRGGBB` (e.g. `#FFFFFF`)', ephemeral: true });
          continue;
        }
        await fc.deferUpdate();
        setConfig(interaction.guildId, { results_font_color: rawFont, results_accent_color: rawAccent });
        const r = fresh();
        await interaction.editReply({ content: null, embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
        continue;

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
        await m.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });

      // ── View / Back ──────────────────────────────────────────────────────
      } else {
        const r = fresh();
        await i.update({ embeds: [buildConfigEmbed(r.config, r.settings, r.lobbyConf)], components: [...buildStepMenu(r.settings)] });
      }
    }
  },
};
