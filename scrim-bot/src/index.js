require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { loadCommands, deployCommands } = require('./handlers/commandHandler');
const interactionHandler = require('./handlers/interactionHandler');
const http = require('http');

// ─── Keep-alive server (start FIRST so Railway sees a port) ──────────────────
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
    console.error(`   Go to Railway → Variables tab and add: ${key}`);
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
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
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

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', (interaction) => interactionHandler(client, interaction));

// ─── Anti-crash ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err?.message || err);
});

// ─── Login ────────────────────────────────────────────────────────────────────
console.log('🔑 Attempting Discord login...');
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ LOGIN FAILED:', err.message);
  console.error('   Check your DISCORD_TOKEN in Railway Variables');
  process.exit(1);
});
