const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('./database');

// ── Colour per action category ────────────────────────────────────────────────
const COLOURS = {
  SLOT_GIVEN:     0x5865F2, // blurple — slot assigned
  SLOT_REMOVED:   0xFEE75C, // yellow  — slot removed
  OPEN:           0x00b0f4, // blue    — registration opened
  CLOSE:          0xEB459E, // pink    — registration closed
  CONFIRM:        0x57F287, // green   — confirm run
  CLEAR:          0xED4245, // red     — session cleared
  RESULTS:        0x9B59B6, // purple  — results posted
  CONFIG:         0x95A5A6, // grey    — config changed
  LINK:           0x1ABC9C, // teal    — sheet linked
  ACTIVATE:       0x57F287,
  DEACTIVATE:     0xED4245,
};

const ICONS = {
  SLOT_GIVEN:   '🎯',
  SLOT_REMOVED: '❌',
  OPEN:         '🟢',
  CLOSE:        '🔴',
  CONFIRM:      '✅',
  CLEAR:        '🧹',
  RESULTS:      '📊',
  CONFIG:       '⚙️',
  LINK:         '🔗',
  ACTIVATE:     '⚡',
  DEACTIVATE:   '💤',
};

/**
 * Send an audit log entry to the configured log channel.
 * @param {import('discord.js').Guild} guild
 * @param {object} opts
 * @param {string}  opts.action        - Key from COLOURS/ICONS map
 * @param {string}  opts.title         - Short title line
 * @param {string}  opts.description   - Main detail text (supports markdown)
 * @param {string}  [opts.adminId]     - Discord user ID of the admin who ran the command
 * @param {string}  [opts.sessionName] - Session name if applicable
 * @param {Array}   [opts.fields]      - Extra { name, value, inline } fields
 */
async function auditLog(guild, { action, title, description, adminId, sessionName, fields = [] }) {
  try {
    const config = getConfig(guild.id);
    if (!config.log_channel) return;

    const ch = await guild.channels.fetch(config.log_channel).catch(() => null);
    if (!ch?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(COLOURS[action] ?? 0x95A5A6)
      .setTitle(`${ICONS[action] ?? '📌'} ${title}`)
      .setTimestamp();

    if (description) embed.setDescription(description);

    const stdFields = [];
    if (sessionName) stdFields.push({ name: 'Session', value: sessionName, inline: true });
    if (adminId)     stdFields.push({ name: 'By',      value: `<@${adminId}>`, inline: true });
    if (stdFields.length) embed.addFields(stdFields);
    if (fields.length)    embed.addFields(fields);

    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('[auditLog] Failed to send log:', err.message);
  }
}

module.exports = { auditLog };
