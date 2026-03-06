require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { loadCommands, deployCommands } = require('./handlers/commandHandler');
const interactionHandler = require('./handlers/interactionHandler');
const { handleReactionAdd, handleReactionRemove } = require('./handlers/reactionHandler');
const http = require('http');

// ─── Keep-alive server ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Scrim Bot is alive!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server running on port ${process.env.PORT || 3000}`);
});

// ─── Validate env ─────────────────────────────────────────────────────────────
const required = ['DISCORD_TOKEN', 'CLIENT_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ MISSING ENVIRONMENT VARIABLE: ${key}`);
    process.exit(1);
  }
}

console.log('✅ Environment variables OK');
console.log(`   CLIENT_ID: ${process.env.CLIENT_ID}`);
console.log(`   DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? '[SET]' : '[MISSING]'}`);

// ─── Create client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions, // ← needed for ✅ ❌ reactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.Reaction, // ← needed to catch reactions on older messages
  ],
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n🤖 Scrim Bot Online!`);
  console.log(`   Logged in as: ${client.user.tag}`);
  console.log(`   Serving ${client.guilds.cache.size} server(s)\n`);

  client.user.setActivity('Scrims | /activate', { type: 2 });

  await loadCommands(client);
  await deployCommands(client);
});

// ─── Slash commands & components ──────────────────────────────────────────────
client.on('interactionCreate', (interaction) => interactionHandler(client, interaction));

// ─── Reactions ────────────────────────────────────────────────────────────────
client.on('messageReactionAdd',    (reaction, user) => handleReactionAdd(reaction, user));
client.on('messageReactionRemove', (reaction, user) => handleReactionRemove(reaction, user));

// ─── Anti-crash ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err?.message || err);
});

// ─── Auto-sync sheet every 20 minutes ────────────────────────────────────────
const { getConfig: _getConfig, getRegistrations: _getRegs } = require('./utils/database');
const { syncTeamsToSheet: _syncSheet } = require('./utils/sheets');

async function autoSyncAllGuilds() {
  for (const [guildId] of client.guilds.cache) {
    try {
      const cfg  = _getConfig(guildId);
      if (!cfg.spreadsheet_id) continue;
      const data = _getRegs(guildId);
      if (!data.slots || data.slots.length === 0) continue;
      await _syncSheet(cfg.spreadsheet_id, data.slots);
      console.log(`🔄 Auto-synced sheet for guild ${guildId}`);
    } catch (err) {
      console.error(`⚠️ Auto-sync failed for guild ${guildId}:`, err.message);
    }
  }
}

setInterval(() => {
  autoSyncAllGuilds().catch(err => console.error('⚠️ Auto-sync interval error:', err.message));
}, 20 * 60 * 1000); // every 20 minutes

// ─── Login ────────────────────────────────────────────────────────────────────
console.log('🔑 Attempting Discord login...');
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ LOGIN FAILED:', err.message);
  process.exit(1);
});
