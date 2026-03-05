const { getServer, getConfig } = require('./database');

async function isAdmin(interaction) {
  // Discord server owner is always admin
  if (interaction.guild.ownerId === interaction.user.id) return true;

  // Check if user has Administrator permission
  if (interaction.member.permissions.has('Administrator')) return true;

  // Check configured admin role
  const config = getConfig(interaction.guildId);
  if (config.admin_role && interaction.member.roles.cache.has(config.admin_role)) return true;

  return false;
}

function isActivated(guildId) {
  const server = getServer(guildId);
  return server && server.active === true;
}

function isRegistrationOpen(guildId) {
  const server = getServer(guildId);
  return server && server.registration_open === true;
}

module.exports = { isAdmin, isActivated, isRegistrationOpen };
