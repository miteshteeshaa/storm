const { REST, Routes, Collection } = require('discord.js');
const path = require('path');
const fs = require('fs');

async function loadCommands(client) {
  client.commands = new Collection();

  const commandFiles = [];

  // Recursively find all .js files in commands/
  function walk(dir) {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (file.endsWith('.js')) commandFiles.push(full);
    }
  }

  walk(path.join(__dirname, '../commands'));

  for (const file of commandFiles) {
    const mod = require(file);

    // Some files export arrays of commands
    const cmds = Array.isArray(mod) ? mod : [mod];
    for (const cmd of cmds) {
      if (cmd.data && cmd.execute) {
        client.commands.set(cmd.data.name, cmd);
        console.log(`  ✅ Loaded: /${cmd.data.name}`);
      }
    }
  }
}

async function deployCommands(client) {
  const commands = [];
  client.commands.forEach(cmd => commands.push(cmd.data.toJSON()));

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log(`\n🔄 Deploying ${commands.length} slash commands globally...`);
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Commands deployed!\n');
  } catch (err) {
    console.error('❌ Failed to deploy commands:', err);
  }
}

module.exports = { loadCommands, deployCommands };
