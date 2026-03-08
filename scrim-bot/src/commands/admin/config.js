const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, EmbedBuilder,
} = require('discord.js');
const {
  getConfig, setConfig, getScrimSettings, setScrimSettings,
  getLobbyConfig, setLobbyConfig,
  getSessions, upsertSession, deleteSession, getSession,
  getSessionConfig, setSessionConfig,
  MAX_SESSIONS,
} = require('../../utils/database');
const { errorEmbed } = require('../../utils/embeds');
const { isAdmin, isActivated } = require('../../utils/permissions');
const { PermissionsBitField } = require('discord.js');

// ── Permission helpers ────────────────────────────────────────────────────────

async function applyLobbyChannelPerms(guild, channelId, roleId) {
  if (!channelId || !roleId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel:        true,
      ReadMessageHistory: true,
      SendMessages:       false,
      AddReactions:       false,
    });
  } catch (err) {
    console.error(`⚠️ applyLobbyChannelPerms error (ch:${channelId} role:${roleId}):`, err.message);
  }
}

async function applyRegistrationChannelPerms(guild, channelId, roleId, open) {
  if (!channelId || !roleId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return;
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel:            true,
      ReadMessageHistory:     true,
      SendMessages:           open ? true : false,
      UseApplicationCommands: open ? true : null,
      AddReactions:           open ? true : null,
    });
  } catch (err) {
    console.error(`⚠️ applyRegistrationChannelPerms error (ch:${channelId} role:${roleId}):`, err.message);
  }
}

// ── Shared role/channel fields ────────────────────────────────────────────────
const GLOBAL_ROLE_FIELDS = {
  admin_role:        'Admin Role',
  registration_role: 'Registration Role',
  registered_role:   'Registered Role',
  slot_role:         'Slot Holder Role',
  waitlist_role:     'Waitlist Role',
};

// ── Embed builders ────────────────────────────────────────────────────────────
function buildSessionListEmbed(sessions) {
  const lines = sessions.length
    ? sessions.map((s, i) => `**${i + 1}.** \`${s.id}\` — ${s.name}`).join('\n')
    : '*No sessions configured yet.*';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ Sessions')
    .setDescription(`You have **${sessions.length}/${MAX_SESSIONS}** sessions configured.\n\n${lines}`)
    .setFooter({ text: 'Select a session to configure it, or create a new one.' })
    .setTimestamp();
}

function buildSessionEmbed(config, settings, lobbyConf, session) {
  const ch = id => id ? `<#${id}>` : '`Not Set`';
  const ro = id => id ? `<@&${id}>` : '`Not Set`';
  const numLobbies    = settings.lobbies || 4;
  const slotsPerLobby = settings.slots_per_lobby || 24;
  const LOBBY_LETTERS = Array.from({ length: numLobbies }, (_, i) => String.fromCharCode(65 + i));

  const lobbyLines = LOBBY_LETTERS.map(l => {
    const lc = lobbyConf[l] || {};
    return `**Lobby ${l}:** ${lc.channel_id ? `<#${lc.channel_id}>` : '`No Channel`'} | ${lc.role_id ? `<@&${lc.role_id}>` : '`No Role`'}`;
  }).join('\n');

  // Session-specific config
  const sessionCfg = session._cfg || {};

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`⚙️ Session: ${session.name}`)
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
      {
        name: '📢 Session Channels',
        value: [
          `📝 Registration: ${ch(sessionCfg.register_channel)}`,
          `🎯 Slot Allocation: ${ch(sessionCfg.slotlist_channel)}`,
        ].join('\n'), inline: false,
      },
      { name: '🏟️ Lobby Channels & Roles', value: lobbyLines || '—', inline: false },
      { name: '📊 Google Sheet', value: sessionCfg.sheet_url ? `[Open Sheet](${sessionCfg.sheet_url})` : '`Not Set`', inline: false },
    )
    .setTimestamp();
}

function buildGlobalConfigEmbed(config) {
  const ro = id => id ? `<@&${id}>` : '`Not Set`';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ Global Config (Shared across sessions)')
    .addFields({
      name: '🎭 Roles',
      value: [
        `👑 Admin: ${ro(config.admin_role)}`,
        `📝 Registration: ${ro(config.registration_role)}`,
        `✅ Registered: ${ro(config.registered_role)}`,
        `🎯 Slot Holder: ${ro(config.slot_role)}`,
        `⏳ Waitlist: ${ro(config.waitlist_role)}`,
      ].join('\n'), inline: false,
    })
    .setTimestamp();
}

// ── Menu builders ─────────────────────────────────────────────────────────────
function buildMainMenu(sessions) {
  const options = [
    { label: '🌐 Global Config (Roles)', value: 'global_config', description: 'Admin, registration, registered, waitlist roles' },
    { label: '➕ Create New Session',    value: 'create_session',  description: `Up to ${MAX_SESSIONS} sessions` },
  ];
  for (const s of sessions) {
    options.push({ label: `⚙️ Configure: ${s.name}`, value: `session:${s.id}`, description: `Edit ${s.name} settings` });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('config_main')
      .setPlaceholder('What would you like to configure?')
      .addOptions(options)
  );
}

function buildSessionMenu(sessionId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`config_session_${sessionId}`)
      .setPlaceholder('Configure this session')
      .addOptions([
        { label: 'Session Name',          value: 'scrim_name',         description: 'Display name for this session' },
        { label: 'Number of Lobbies',     value: 'lobbies',            description: 'How many lobbies (A, B, C...)' },
        { label: 'Slots Per Lobby',       value: 'slots_per_lobby',    description: 'How many slots per lobby (max 25)' },
        { label: 'First Slot Number',     value: 'first_slot',         description: 'Starting slot number per lobby' },
        { label: 'Registration Channel',  value: 'register_channel',   description: 'Where teams submit /register' },
        { label: 'Slot Allocation Channel', value: 'slotlist_channel', description: 'Where team cards are posted' },
        { label: 'Set Lobby Channels',    value: 'lobby_channels',     description: 'Set private channels per lobby' },
        { label: 'Set Lobby Roles',       value: 'lobby_roles',        description: 'Set access roles per lobby' },
        { label: 'Google Sheet URL',      value: 'sheet_url',          description: 'Link to this session\'s sheet' },
        { label: 'Results Template',      value: 'results_template',   description: 'Background image for /results' },
        { label: 'Results Font Colour',   value: 'results_font_color', description: 'Text colour for /results overlay' },
        { label: '🗑️ Delete Session',     value: 'delete_session',     description: 'Remove this session entirely' },
      ])
  );
}

function buildLobbySubMenu(sessionId, type, numLobbies) {
  const LOBBY_LETTERS = Array.from({ length: numLobbies }, (_, i) => String.fromCharCode(65 + i));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`config_lobby_${type}_${sessionId}`)
      .setPlaceholder(`Select lobby to set ${type}`)
      .addOptions(LOBBY_LETTERS.map(l => ({
        label: `Lobby ${l}`,
        value: l,
        description: `Set ${type} for Lobby ${l}`,
      })))
  );
}

function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('config_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
  );
}

// ── Main command ──────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the scrim bot (Admin only)'),

  async execute(interaction) {
    if (!isActivated(interaction.guildId)) return interaction.reply({ embeds: [errorEmbed('Not Activated', 'Run `/activate` first.')], ephemeral: true });
    if (!await isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('Access Denied', 'Admin only.')], ephemeral: true });

    const guildId = interaction.guildId;

    const freshSessions = () => getSessions(guildId);
    const freshConfig   = () => getConfig(guildId);

    const sessions = freshSessions();
    const msg = await interaction.reply({
      embeds: [buildSessionListEmbed(sessions)],
      components: [buildMainMenu(sessions)],
      ephemeral: true,
      fetchReply: true,
    });

    // ── Main loop ──────────────────────────────────────────────────────────
    while (true) {
      let i;
      try {
        i = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 300_000 });
      } catch {
        try { await msg.edit({ components: [] }); } catch {}
        return;
      }

      const value = i.values?.[0] ?? i.customId;

      // ── Global config ──────────────────────────────────────────────────
      if (value === 'global_config') {
        await i.update({ embeds: [buildGlobalConfigEmbed(freshConfig())], components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('config_global_role')
              .setPlaceholder('Select role to configure')
              .addOptions(Object.entries(GLOBAL_ROLE_FIELDS).map(([k, v]) => ({ label: v, value: k })))
          ),
          buildBackRow(),
        ]});

        let j;
        try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (j.customId === 'config_back') {
          const s = freshSessions();
          await j.update({ embeds: [buildSessionListEmbed(s)], components: [buildMainMenu(s)] });
          continue;
        }

        const roleField = j.values[0];
        await j.update({ embeds: [buildGlobalConfigEmbed(freshConfig())], components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('pick_global_role').setPlaceholder(`Select ${GLOBAL_ROLE_FIELDS[roleField]}`)
          ),
          buildBackRow(),
        ]});

        let k;
        try { k = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
        catch { try { await msg.edit({ components: [] }); } catch {} return; }

        if (k.customId === 'config_back') {
          await k.update({ embeds: [buildGlobalConfigEmbed(freshConfig())], components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('config_global_role')
                .setPlaceholder('Select role to configure')
                .addOptions(Object.entries(GLOBAL_ROLE_FIELDS).map(([k2, v]) => ({ label: v, value: k2 })))
            ),
            buildBackRow(),
          ]});
          continue;
        }

        setConfig(guildId, { [roleField]: k.values[0] });
        const s = freshSessions();
        await k.update({ embeds: [buildSessionListEmbed(s)], components: [buildMainMenu(s)] });
        continue;
      }

      // ── Create new session ─────────────────────────────────────────────
      if (value === 'create_session') {
        const current = freshSessions();
        if (current.length >= MAX_SESSIONS) {
          await i.update({
            embeds: [buildSessionListEmbed(current)],
            components: [buildMainMenu(current)],
            content: `❌ Maximum of ${MAX_SESSIONS} sessions reached.`,
          });
          continue;
        }

        await i.showModal(
          new ModalBuilder().setCustomId('create_session_modal').setTitle('Create New Session')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('session_name').setLabel('Session Name (e.g. Afternoon, Evening)')
                  .setStyle(TextInputStyle.Short).setPlaceholder('Afternoon').setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('session_id').setLabel('Session ID (short slug, no spaces)')
                  .setStyle(TextInputStyle.Short).setPlaceholder('afternoon').setRequired(true).setMaxLength(20)
              ),
            )
        );

        let m;
        try { m = await interaction.awaitModalSubmit({ filter: x => x.customId === 'create_session_modal' && x.user.id === interaction.user.id, time: 120_000 }); }
        catch { continue; }

        const rawName = m.fields.getTextInputValue('session_name').trim();
        const rawId   = m.fields.getTextInputValue('session_id').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

        if (!rawId) {
          await m.deferUpdate();
          await interaction.editReply({ content: '❌ Invalid session ID. Use letters, numbers, hyphens only.', embeds: [], components: [] });
          continue;
        }

        const existingSessions = freshSessions();
        if (existingSessions.find(s => s.id === rawId)) {
          await m.deferUpdate();
          await interaction.editReply({ content: `❌ Session ID \`${rawId}\` already exists.`, embeds: [], components: [] });
          continue;
        }

        upsertSession(guildId, rawId, rawName);
        // Set default scrim settings for new session
        setScrimSettings(guildId, { scrim_name: rawName, lobbies: 4, slots_per_lobby: 24, first_slot: 1 }, rawId);

        const s = freshSessions();
        await m.deferUpdate();
        await interaction.editReply({ content: null, embeds: [buildSessionListEmbed(s)], components: [buildMainMenu(s)] });
        continue;
      }

      // ── Configure a specific session ───────────────────────────────────
      if (value.startsWith('session:')) {
        const sessionId = value.replace('session:', '');
        await configureSession(interaction, msg, guildId, sessionId);
        const s = freshSessions();
        try { await interaction.editReply({ embeds: [buildSessionListEmbed(s)], components: [buildMainMenu(s)] }); } catch {}
        continue;
      }

      // ── Back / fallback ────────────────────────────────────────────────
      const s = freshSessions();
      try { await i.update({ embeds: [buildSessionListEmbed(s)], components: [buildMainMenu(s)] }); } catch {}
    }
  },
};

// ── Session configuration sub-loop ───────────────────────────────────────────
async function configureSession(interaction, msg, guildId, sessionId) {
  const session    = getSession(guildId, sessionId);
  if (!session) return;

  const fresh = () => {
    const cfg      = getSessionConfig(guildId, sessionId);
    const settings = getScrimSettings(guildId, sessionId);
    const lobbyConf = getLobbyConfig(guildId, sessionId);
    return { cfg, settings, lobbyConf };
  };

  const { cfg, settings, lobbyConf } = fresh();
  session._cfg = cfg;

  await interaction.editReply({
    embeds: [buildSessionEmbed(getConfig(guildId), settings, lobbyConf, { ...session, _cfg: cfg })],
    components: [buildSessionMenu(sessionId), buildBackRow()],
  });

  while (true) {
    let i;
    try {
      i = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 300_000 });
    } catch { return; }

    if (i.customId === 'config_back') { await i.update({ components: [] }); return; }

    const value = i.values?.[0] ?? i.customId;
    const { cfg: c, settings: stg, lobbyConf: lc } = fresh();

    // ── Delete session ───────────────────────────────────────────────────
    if (value === 'delete_session') {
      await i.update({
        content: `⚠️ **Delete session "${session.name}"?** All session data will be lost.`,
        embeds: [], components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_delete').setLabel('Yes, Delete').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('config_back').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      let j;
      try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 60_000 }); }
      catch { return; }

      if (j.customId === 'confirm_delete') {
        deleteSession(guildId, sessionId);
        await j.update({ content: `✅ Session **${session.name}** deleted.`, embeds: [], components: [] });
        return;
      }
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await j.update({ content: null, embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Scrim settings modals ────────────────────────────────────────────
    if (['scrim_name','lobbies','slots_per_lobby','first_slot'].includes(value)) {
      const labels = {
        scrim_name:      ['Session Display Name', 'e.g. SUNGOLD EVENING',  stg.scrim_name ?? session.name],
        lobbies:         ['Number of Lobbies',     'e.g. 4',               String(stg.lobbies ?? 4)],
        slots_per_lobby: ['Slots Per Lobby',        'e.g. 24',              String(stg.slots_per_lobby ?? 24)],
        first_slot:      ['First Slot Number',      'e.g. 1',               String(stg.first_slot ?? 1)],
      };
      const [label, placeholder, currentVal] = labels[value];
      await i.showModal(
        new ModalBuilder().setCustomId(`session_modal_${value}`).setTitle(`Set ${label}`)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('val').setLabel(label)
              .setStyle(TextInputStyle.Short).setPlaceholder(placeholder)
              .setRequired(true).setValue(currentVal)
          ))
      );
      let m;
      try { m = await interaction.awaitModalSubmit({ filter: x => x.customId === `session_modal_${value}` && x.user.id === interaction.user.id, time: 120_000 }); }
      catch { continue; }

      const raw = m.fields.getTextInputValue('val').trim();
      if (['lobbies','slots_per_lobby','first_slot'].includes(value)) {
        const num = parseInt(raw);
        if (isNaN(num) || num < 1) { await m.deferUpdate(); await interaction.editReply({ content: '❌ Please enter a valid number (1 or higher).', embeds: [], components: [] }); continue; }
        if (value === 'lobbies' && num > 10) { await m.deferUpdate(); await interaction.editReply({ content: '❌ Maximum 10 lobbies (A–J).', embeds: [], components: [] }); continue; }
        if (value === 'slots_per_lobby' && num > 25) { await m.deferUpdate(); await interaction.editReply({ content: '❌ Maximum 25 slots per lobby.', embeds: [], components: [] }); continue; }
        setScrimSettings(guildId, { [value]: num }, sessionId);
      } else {
        setScrimSettings(guildId, { [value]: raw }, sessionId);
        // Also update the session display name
        if (value === 'scrim_name') upsertSession(guildId, sessionId, raw);
      }
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await m.deferUpdate();
      await interaction.editReply({ content: null, embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, name: getSession(guildId, sessionId)?.name || session.name, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Session channels (register_channel, slotlist_channel) ────────────
    if (['register_channel','slotlist_channel'].includes(value)) {
      const label = value === 'register_channel' ? 'Registration Channel' : 'Slot Allocation Channel';
      await i.update({ embeds: [], components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder().setCustomId('pick_session_channel')
            .setPlaceholder(`Select ${label}`).addChannelTypes(ChannelType.GuildText)
        ),
        buildBackRow(),
      ]});
      let j;
      try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
      catch { return; }
      if (j.customId === 'config_back') {
        const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
        await j.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
        continue;
      }
      setSessionConfig(guildId, sessionId, { [value]: j.values[0] });
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await j.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Lobby channels ───────────────────────────────────────────────────
    if (value === 'lobby_channels') {
      await i.update({ embeds: [], components: [buildLobbySubMenu(sessionId, 'channel', stg.lobbies || 4), buildBackRow()] });
      let j;
      try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
      catch { return; }
      if (j.customId === 'config_back') {
        const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
        await j.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
        continue;
      }
      const letter = j.values[0];
      await j.update({ embeds: [], components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder().setCustomId('pick_lobby_ch')
            .setPlaceholder(`Select channel for Lobby ${letter}`).addChannelTypes(ChannelType.GuildText)
        ),
        buildBackRow(),
      ]});
      let k;
      try { k = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
      catch { return; }
      if (k.customId !== 'config_back') {
        const existing = getLobbyConfig(guildId, sessionId)[letter] || {};
        setLobbyConfig(guildId, { [letter]: { ...existing, channel_id: k.values[0] } }, sessionId);
        const updated = getLobbyConfig(guildId, sessionId)[letter] || {};
        if (updated.channel_id && updated.role_id) {
          await applyLobbyChannelPerms(interaction.guild, updated.channel_id, updated.role_id);
        }
      }
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await (k.customId === 'config_back' ? k : k).update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Lobby roles ──────────────────────────────────────────────────────
    if (value === 'lobby_roles') {
      await i.update({ embeds: [], components: [buildLobbySubMenu(sessionId, 'role', stg.lobbies || 4), buildBackRow()] });
      let j;
      try { j = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
      catch { return; }
      if (j.customId === 'config_back') {
        const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
        await j.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
        continue;
      }
      const letter = j.values[0];
      await j.update({ embeds: [], components: [
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder().setCustomId('pick_lobby_role')
            .setPlaceholder(`Select role for Lobby ${letter}`)
        ),
        buildBackRow(),
      ]});
      let k;
      try { k = await msg.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id, time: 120_000 }); }
      catch { return; }
      if (k.customId !== 'config_back') {
        const existing = getLobbyConfig(guildId, sessionId)[letter] || {};
        setLobbyConfig(guildId, { [letter]: { ...existing, role_id: k.values[0] } }, sessionId);
        const updated = getLobbyConfig(guildId, sessionId)[letter] || {};
        if (updated.channel_id && updated.role_id) {
          await applyLobbyChannelPerms(interaction.guild, updated.channel_id, updated.role_id);
        }
      }
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await k.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Sheet URL ────────────────────────────────────────────────────────
    if (value === 'sheet_url') {
      await i.showModal(
        new ModalBuilder().setCustomId('session_sheet_modal').setTitle('📋 Google Sheet URL')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sheet_url_input').setLabel('Paste Google Sheet URL')
              .setStyle(TextInputStyle.Short).setPlaceholder('https://docs.google.com/spreadsheets/d/...')
              .setRequired(true).setValue(c.sheet_url || '')
          ))
      );
      let m;
      try { m = await interaction.awaitModalSubmit({ filter: x => x.customId === 'session_sheet_modal' && x.user.id === interaction.user.id, time: 120_000 }); }
      catch { continue; }
      setSessionConfig(guildId, sessionId, { sheet_url: m.fields.getTextInputValue('sheet_url_input').trim() });
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await m.deferUpdate();
      await interaction.editReply({ content: null, embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Results template upload ──────────────────────────────────────────
    if (value === 'results_template') {
      await i.update({ embeds: [], components: [], content: '📤 **Upload your results template image** (PNG/JPG, 1920x1080)\nSend it as a message attachment in this channel within 60 seconds.' });
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
        const savePath = `${templateDir}/results_template_${guildId}_${sessionId}.png`;
        const res = await fetch(attachment.url);
        await new Promise((resolve, reject) => {
          const stream = createWriteStream(savePath);
          res.body.pipe(stream);
          stream.on('finish', resolve);
          stream.on('error', reject);
        });
        setSessionConfig(guildId, sessionId, { results_template_path: savePath });
        await collected.first().delete().catch(() => {});
      } catch {}
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await interaction.editReply({ content: null, embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Results font colour ──────────────────────────────────────────────
    if (value === 'results_font_color') {
      await i.showModal(
        new ModalBuilder().setCustomId('session_font_modal').setTitle('🎨 Results Font Colour')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('font_color_input').setLabel('Text colour (hex code)')
                .setStyle(TextInputStyle.Short).setPlaceholder('#FFFFFF').setRequired(true).setValue(c.results_font_color || '#FFFFFF')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('accent_color_input').setLabel('Accent colour (hex code)')
                .setStyle(TextInputStyle.Short).setPlaceholder('#FFD700').setRequired(true).setValue(c.results_accent_color || '#FFD700')
            )
          )
      );
      let fc;
      try { fc = await interaction.awaitModalSubmit({ filter: m => m.customId === 'session_font_modal' && m.user.id === interaction.user.id, time: 60_000 }); }
      catch { continue; }
      const rawFont   = fc.fields.getTextInputValue('font_color_input').trim();
      const rawAccent = fc.fields.getTextInputValue('accent_color_input').trim();
      const hexRe = /^#([0-9A-Fa-f]{6})$/;
      if (!hexRe.test(rawFont) || !hexRe.test(rawAccent)) {
        await fc.reply({ content: '❌ Invalid hex colour — use format `#RRGGBB`', ephemeral: true });
        continue;
      }
      await fc.deferUpdate();
      setSessionConfig(guildId, sessionId, { results_font_color: rawFont, results_accent_color: rawAccent });
      const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
      await interaction.editReply({ content: null, embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] });
      continue;
    }

    // ── Back ─────────────────────────────────────────────────────────────
    if (i.customId === 'config_back') {
      await i.update({ components: [] });
      return;
    }

    // Fallback
    const { cfg: c2, settings: stg2, lobbyConf: lc2 } = fresh();
    try { await i.update({ embeds: [buildSessionEmbed(getConfig(guildId), stg2, lc2, { ...session, _cfg: c2 })], components: [buildSessionMenu(sessionId), buildBackRow()] }); } catch {}
  }
}

module.exports.applyRegistrationChannelPerms = applyRegistrationChannelPerms;
