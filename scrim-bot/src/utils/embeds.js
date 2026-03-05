const { EmbedBuilder } = require('discord.js');

const COLORS = {
  success: 0x00FF7F,
  error: 0xFF4444,
  info: 0x5865F2,
  warning: 0xFFAA00,
  gold: 0xFFD700,
  dark: 0x2B2D31,
};

function successEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function errorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function infoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function registrationOpenEmbed(maxSlots) {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🎮 SCRIM REGISTRATION IS NOW OPEN!')
    .setDescription('Use `/register` to register your team!')
    .addFields(
      { name: '📋 Available Slots', value: `\`${maxSlots}\``, inline: true },
      { name: '📌 Command', value: '`/register`', inline: true }
    )
    .setFooter({ text: 'First come, first served! Overflow goes to waitlist.' })
    .setTimestamp();
}

function registrationClosedEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('🔒 REGISTRATION CLOSED')
    .setDescription('Registration has been closed by the admin.')
    .setTimestamp();
}

function teamRegisteredEmbed(team, slot, isWaitlist) {
  const color = isWaitlist ? COLORS.warning : COLORS.success;
  const status = isWaitlist ? '⏳ Added to Waitlist' : '✅ Slot Confirmed';
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(status)
    .addFields(
      { name: '🏷️ Team Name', value: team.team_name, inline: true },
      { name: '🔖 Tag', value: team.team_tag || 'N/A', inline: true },
      { name: '👤 Captain', value: team.captain_name, inline: true },
      { name: isWaitlist ? '📋 Waitlist Position' : '🎯 Slot Number', value: `#${slot}`, inline: true }
    )
    .setFooter({ text: isWaitlist ? 'You will be notified if a slot opens.' : 'Good luck in the scrim!' })
    .setTimestamp();
}

function slotListEmbed(slots, waitlist) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('📋 SCRIM SLOT LIST')
    .setTimestamp();

  if (slots.length === 0) {
    embed.addFields({ name: '🎯 Slots', value: 'No teams registered yet.' });
  } else {
    const slotText = slots.map((t, i) =>
      `\`${String(i + 1).padStart(2, '0')}\` **${t.team_name}** [\`${t.team_tag || 'N/A'}\`] — ${t.captain_name}`
    ).join('\n');
    embed.addFields({ name: `🎯 Confirmed Slots (${slots.length})`, value: slotText });
  }

  if (waitlist.length > 0) {
    const waitText = waitlist.map((t, i) =>
      `\`${String(i + 1).padStart(2, '0')}\` **${t.team_name}** — ${t.captain_name}`
    ).join('\n');
    embed.addFields({ name: `⏳ Waitlist (${waitlist.length})`, value: waitText });
  }

  return embed;
}

function resultEmbed(lobbyNumber, results) {
  const PLACEMENT_POINTS = [15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
  const medals = ['🥇', '🥈', '🥉'];

  const sorted = [...results].sort((a, b) => b.total - a.total);

  const resultText = sorted.map((t, i) => {
    const medal = medals[i] || `\`${String(i + 1).padStart(2, '0')}\``;
    return `${medal} **${t.team_name}** — ${t.total} pts *(${t.kills} kills + ${t.placement_pts} placement)*`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`🏆 LOBBY ${lobbyNumber} RESULTS`)
    .setDescription(resultText || 'No results found.')
    .setFooter({ text: `Kill Points: 1pt each | Placement: 1st=15, 2nd=12, 3rd=10...` })
    .setTimestamp();
}

function leaderboardEmbed(leaderboard) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = leaderboard.slice(0, 25).map((t, i) => {
    const rank = medals[i] || `\`#${String(i + 1).padStart(2, '0')}\``;
    return `${rank} **${t.team_name}** — **${t.total} pts**`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('🏆 OVERALL LEADERBOARD')
    .setDescription(rows || 'No data yet.')
    .setFooter({ text: 'Updated automatically after each lobby result.' })
    .setTimestamp();
}

function configEmbed(config) {
  const ch = (id) => id ? `<#${id}>` : '`Not Set`';
  const ro = (id) => id ? `<@&${id}>` : '`Not Set`';

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ BOT CONFIGURATION')
    .addFields(
      { name: '📢 Channels', value: [
        `📝 Registration: ${ch(config.register_channel)}`,
        `🎯 Slot List: ${ch(config.slotlist_channel)}`,
        `⏳ Waitlist: ${ch(config.waitlist_channel)}`,
        `📊 Results: ${ch(config.results_channel)}`,
        `🏆 Leaderboard: ${ch(config.leaderboard_channel)}`,
        `🔐 ID/Pass: ${ch(config.idpass_channel)}`,
        `🛡️ Admin: ${ch(config.admin_channel)}`,
      ].join('\n'), inline: false },
      { name: '🎭 Roles', value: [
        `👑 Admin: ${ro(config.admin_role)}`,
        `✅ Registered: ${ro(config.registered_role)}`,
        `🎯 Slot Holder: ${ro(config.slot_role)}`,
        `⏳ Waitlist: ${ro(config.waitlist_role)}`,
        `🔐 ID/Pass: ${ro(config.idpass_role)}`,
      ].join('\n'), inline: false },
      { name: '📊 Google Sheet', value: config.sheet_url ? `[Open Sheet](${config.sheet_url})` : '`Not Set`', inline: false },
      { name: '🎮 Max Slots', value: `\`${config.max_slots || 100}\``, inline: true },
      { name: '🗂️ Max Lobbies', value: `\`${config.max_lobbies || 10}\``, inline: true },
    )
    .setTimestamp();
}

module.exports = {
  successEmbed, errorEmbed, infoEmbed,
  registrationOpenEmbed, registrationClosedEmbed,
  teamRegisteredEmbed, slotListEmbed,
  resultEmbed, leaderboardEmbed, configEmbed,
  COLORS
};
