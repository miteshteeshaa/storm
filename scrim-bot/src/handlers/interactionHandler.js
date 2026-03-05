const { errorEmbed } = require('../utils/embeds');

module.exports = async (client, interaction) => {
  // ─── Slash Commands ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error executing /${interaction.commandName}:`, err);
      const errEmbed = errorEmbed('Command Error', 'Something went wrong. Please try again.\n`' + err.message + '`');
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ embeds: [errEmbed] });
        } else {
          await interaction.reply({ embeds: [errEmbed], ephemeral: true });
        }
      } catch {}
    }
    return;
  }
};
