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
  register_channel:    'Registration Channel',
  slotlist_channel:    'Slot List Channel',
  waitlist_channel:    'Waitlist Channel',
  results_channel:     'Results Channel',
  leaderboard_channel: 'Leaderboard Channel',
  idpass_channel:      'ID/Pass Channel',
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
        { label: '📝 Registration Channel',   value: 'register_channel',    description: 'Where teams submit /register' },
        { label: '🎯 Slot List Channel',       value: 'slotlist_channel',    description: 'Where slot list is posted' },
        { label: '⏳ Waitlist Channel',        value: 'waitlist_channel',    description: 'Where waitlist is posted' },
        { label: '📊 Results Channel',         value: 'results_channel',     description: 'Where match results are posted' },
        { label: '🏆 Leaderboard Channel',     value: 'leaderboard_channel', description: 'Where leaderboard is posted' },
        { label: '🔐 ID/Pass Channel',         value: 'idpass_channel',      description: 'Room ID/Password channel' },
        { label: '🛡️ Admin Channel',           value: 'admin_channel',       description: 'Admin control channel' },
        { label: '👑 Admin Role',              value: 'admin_role',          description: 'Role that can use admin commands' },
        { label: '✅ Registered Role',         value: 'registered_role',     description: 'Auto-given on registration' },
        { label: '🎯 Slot Holder Role',        value: 'slot_role',           description: 'Given to confirmed slots' },
        { label: '⏳ Waitlist Role',           value: 'waitlist_role',       description: 'Given to waitlisted teams' },
        { label: '🔐 ID/Pass Role',            value: 'idpass_role',         description: 'Allows viewing ID/Pass channel' },
        { label: '📋 Google Sheet URL',        value: 'sheet_url',           description: 'Link to Google Sheet' },
        { label: '🎮 Max Slots & Lobbies',     value: 'slots_lobbies',       description: 'Set slot count and lobby count' },
        { label: '📦 View Current Config',     value: 'view_config',         description: 'See current configuration' },
      ])
  );
}

function buildBackRow() {
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
        ephemeral: true,
      });
    }
    if (!await isAdmin(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('Access Denied', 'You need the Admin role.')],
        ephemeral: true,
      });
    }

    const msg = await interaction.reply({
      embeds: [configEmbed(getConfig(interaction.guildId))],
      components: [buildStepMenu()],
      ephemeral: true,
      fetchReply: true,
    });

    // ── Loop: keep listening until 5-min timeout ──────────────────────────────
    while (true) {
      // Wait for any component interaction from this user
      let i;
      try {
        i = await msg.awaitMessageComponent({
          filter: (x) => x.user.id === interaction.user.id,
          time: 300_000,
        });
      } catch {
        try { await msg.edit({ components: [] }); } catch {}
        return;
      }

      const customId = i.customId;
      const value    = i.values?.[0] ?? customId;

      // ── Channel field selected ──────────────────────────────────────────────
      if (CHANNEL_FIELDS[value]) {
        await i.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
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

        // Store which field we're setting so we can use it when channel is picked
        const pendingField = value;

        let j;
        try {
          j = await msg.awaitMessageComponent({
            filter: (x) => x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch {
          try { await msg.edit({ components: [] }); } catch {}
          return;
        }

        if (j.customId === 'config_back') {
          await j.update({
            embeds: [configEmbed(getConfig(interaction.guildId))],
            components: [buildStepMenu()],
          });
          continue;
        }

        // j is the channel select — save it
        setConfig(interaction.guildId, { [pendingField]: j.values[0] });
        await j.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()],
        });

      // ── Role field selected ─────────────────────────────────────────────────
      } else if (ROLE_FIELDS[value]) {
        await i.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
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
          j = await msg.awaitMessageComponent({
            filter: (x) => x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch {
          try { await msg.edit({ components: [] }); } catch {}
          return;
        }

        if (j.customId === 'config_back') {
          await j.update({
            embeds: [configEmbed(getConfig(interaction.guildId))],
            components: [buildStepMenu()],
          });
          continue;
        }

        setConfig(interaction.guildId, { [pendingField]: j.values[0] });
        await j.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()],
        });

      // ── Sheet URL modal ─────────────────────────────────────────────────────
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
                  .setValue(getConfig(interaction.guildId).sheet_url || '')
              )
            )
        );

        let m;
        try {
          m = await interaction.awaitModalSubmit({
            filter: (x) => x.customId === 'config_sheet_modal' && x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch { continue; }

        setConfig(interaction.guildId, { sheet_url: m.fields.getTextInputValue('sheet_url_input') });
        await m.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()],
        });

      // ── Slots & Lobbies modal ───────────────────────────────────────────────
      } else if (value === 'slots_lobbies') {
        const cfg = getConfig(interaction.guildId);
        await i.showModal(
          new ModalBuilder()
            .setCustomId('config_slots_modal')
            .setTitle('🎮 Max Slots & Lobbies')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('max_slots_input')
                  .setLabel('Maximum Slots')
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
            )
        );

        let m;
        try {
          m = await interaction.awaitModalSubmit({
            filter: (x) => x.customId === 'config_slots_modal' && x.user.id === interaction.user.id,
            time: 120_000,
          });
        } catch { continue; }

        setConfig(interaction.guildId, {
          max_slots:   parseInt(m.fields.getTextInputValue('max_slots_input'))   || 100,
          max_lobbies: parseInt(m.fields.getTextInputValue('max_lobbies_input')) || 10,
        });
        await m.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()],
        });

      // ── View / Back ─────────────────────────────────────────────────────────
      } else {
        await i.update({
          embeds: [configEmbed(getConfig(interaction.guildId))],
          components: [buildStepMenu()],
        });
      }
    }
  },
};
