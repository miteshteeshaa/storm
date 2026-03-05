const { EmbedBuilder } = require('discord.js');
const { getConfig, getRegistrations, setRegistrations } = require('../utils/database');

// Tracks which message is the "CONFIRM YOUR SLOTS" message per guild
// { guildId: { messageId, channelId, slotListMessageId } }
const confirmSessions = new Map();

function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
  console.log(`📌 Confirm session registered for guild ${guildId}`);
}

function getConfirmSession(guildId) {
  return confirmSessions.get(guildId) || null;
}

// ── Rebuild the slot list embed with underline/strikethrough formatting ────────
function buildSlotListEmbed(slots, maxSlots) {
  const lines = slots.map((t, i) => {
    const num  = String(i + 1).padStart(2, ' ');
    const tag  = `[${t.team_tag}]`;
    const name = t.team_name;
    const mgr  = `<@${t.manager_id || t.captain_id}>`;

    if (t.confirmed === true) {
      // Underline = confirmed ✅
      return `**${num}** __${tag} ${name}__ ${mgr}`;
    } else if (t.confirmed === false) {
      // Strikethrough = cancelled ❌
      return `**${num}** ~~${tag} ${name}~~ ${mgr}`;
    } else {
      // Pending
      return `**${num}** ${tag} ${name} ${mgr}`;
    }
  });

  const confirmed  = slots.filter(t => t.confirmed === true).length;
  const cancelled  = slots.filter(t => t.confirmed === false).length;
  const pending    = slots.filter(t => t.confirmed === undefined).length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 SLOT LIST — ${slots.length}/${maxSlots} Slots`)
    .setDescription(lines.join('\n') || 'No teams registered.')
    .addFields({
      name: '📊 Status',
      value: `✅ Confirmed: **${confirmed}** | ❌ Cancelled: **${cancelled}** | ⏳ Pending: **${pending}**`,
    })
    .setTimestamp();
}

// ── Handle reactions ──────────────────────────────────────────────────────────
async function handleReactionAdd(reaction, user) {
  if (user.bot) return;

  // Fetch partial reaction/message if needed
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild   = message.guild;
  if (!guild) return;

  const session = getConfirmSession(guild.id);
  if (!session) return;
  if (message.id !== session.confirmMessageId) return;

  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config = getConfig(guild.id);
  const data   = getRegistrations(guild.id);

  // Find team by manager/captain discord ID
  const teamIndex = data.slots.findIndex(
    t => (t.manager_id === user.id || t.captain_id === user.id)
  );

  if (teamIndex === -1) return; // User has no registered team

  const wasConfirmed = data.slots[teamIndex].confirmed;

  if (emoji === '✅') {
    data.slots[teamIndex].confirmed = true;
    // Remove their ❌ reaction if they had one
    try {
      const crossReaction = message.reactions.cache.get('❌');
      if (crossReaction) await crossReaction.users.remove(user.id);
    } catch {}
  } else if (emoji === '❌') {
    data.slots[teamIndex].confirmed = false;
    // Remove their ✅ reaction if they had one
    try {
      const tickReaction = message.reactions.cache.get('✅');
      if (tickReaction) await tickReaction.users.remove(user.id);
    } catch {}
  }

  setRegistrations(guild.id, data);

  // Update the slot list message
  try {
    const channel      = await guild.channels.fetch(session.channelId);
    const slotListMsg  = await channel.messages.fetch(session.slotListMessageId);
    const maxSlots     = config.max_slots || 100;
    await slotListMsg.edit({ embeds: [buildSlotListEmbed(data.slots, maxSlots)] });
  } catch (err) {
    console.error('⚠️ Failed to update slot list:', err.message);
  }
}

async function handleReactionRemove(reaction, user) {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild   = message.guild;
  if (!guild) return;

  const session = getConfirmSession(guild.id);
  if (!session) return;
  if (message.id !== session.confirmMessageId) return;

  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return;

  const data = getRegistrations(guild.id);
  const config = getConfig(guild.id);

  const teamIndex = data.slots.findIndex(
    t => (t.manager_id === user.id || t.captain_id === user.id)
  );
  if (teamIndex === -1) return;

  // Only reset if removing the reaction that matches their current state
  if (emoji === '✅' && data.slots[teamIndex].confirmed === true) {
    delete data.slots[teamIndex].confirmed;
  } else if (emoji === '❌' && data.slots[teamIndex].confirmed === false) {
    delete data.slots[teamIndex].confirmed;
  }

  setRegistrations(guild.id, data);

  try {
    const channel     = await guild.channels.fetch(session.channelId);
    const slotListMsg = await channel.messages.fetch(session.slotListMessageId);
    const maxSlots    = config.max_slots || 100;
    await slotListMsg.edit({ embeds: [buildSlotListEmbed(data.slots, maxSlots)] });
  } catch {}
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  buildSlotListEmbed,
};
