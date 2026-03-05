const { EmbedBuilder } = require('discord.js');
const { getConfig, getRegistrations, setRegistrations } = require('../utils/database');

// ── In-memory session stores ──────────────────────────────────────────────────
// { guildId: { confirmMessageId, channelId, slotListMessageId } }
const confirmSessions = new Map();

// { guildId: messageId } — the always-visible slot list message
const persistentSlotListIds = new Map();

// ── Persistent slot list helpers ──────────────────────────────────────────────
function getPersistentSlotListId(guildId) {
  return persistentSlotListIds.get(guildId) || null;
}

function setPersistentSlotListId(guildId, messageId) {
  persistentSlotListIds.set(guildId, messageId);
}

// ── Confirm session helpers ───────────────────────────────────────────────────
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
  console.log(`📌 Confirm session registered for guild ${guildId}`);
}

function getConfirmSession(guildId) {
  return confirmSessions.get(guildId) || null;
}

// ── Build the slot list embed ─────────────────────────────────────────────────
function buildSlotListEmbed(slots, maxSlots) {
  const lines = slots.map((t, i) => {
    const num  = String(i + 1).padStart(2, ' ');
    const tag  = `[${t.team_tag}]`;
    const name = t.team_name;
    const mgr  = `<@${t.manager_id || t.captain_id}>`;

    if (t.confirmed === true) {
      return `\`${num}\` __${tag} ${name}__ ${mgr}`;       // underline = confirmed
    } else if (t.confirmed === false) {
      return `\`${num}\` ~~${tag} ${name}~~ ${mgr}`;       // strikethrough = cancelled
    } else {
      return `\`${num}\` ${tag} ${name} ${mgr}`;           // normal = pending
    }
  });

  const confirmed = slots.filter(t => t.confirmed === true).length;
  const cancelled = slots.filter(t => t.confirmed === false).length;
  const pending   = slots.filter(t => t.confirmed === undefined).length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 SLOT LIST — ${slots.length}/${maxSlots} Slots`)
    .setDescription(lines.length > 0 ? lines.join('\n') : '*No teams registered yet.*')
    .addFields({
      name: '📊 Status',
      value: `✅ Confirmed: **${confirmed}** | ❌ Cancelled: **${cancelled}** | ⏳ Pending: **${pending}**`,
    })
    .setTimestamp();
}

// ── Handle reaction added ─────────────────────────────────────────────────────
async function handleReactionAdd(reaction, user) {
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

  const config = getConfig(guild.id);
  const data   = getRegistrations(guild.id);

  const teamIndex = data.slots.findIndex(
    t => t.manager_id === user.id || t.captain_id === user.id
  );
  if (teamIndex === -1) return;

  if (emoji === '✅') {
    data.slots[teamIndex].confirmed = true;
    try {
      const crossReaction = message.reactions.cache.get('❌');
      if (crossReaction) await crossReaction.users.remove(user.id);
    } catch {}
  } else {
    data.slots[teamIndex].confirmed = false;
    try {
      const tickReaction = message.reactions.cache.get('✅');
      if (tickReaction) await tickReaction.users.remove(user.id);
    } catch {}
  }

  setRegistrations(guild.id, data);
  await refreshSlotListMessage(guild, session, config, data);
}

// ── Handle reaction removed ───────────────────────────────────────────────────
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

  const config = getConfig(guild.id);
  const data   = getRegistrations(guild.id);

  const teamIndex = data.slots.findIndex(
    t => t.manager_id === user.id || t.captain_id === user.id
  );
  if (teamIndex === -1) return;

  if (emoji === '✅' && data.slots[teamIndex].confirmed === true) {
    delete data.slots[teamIndex].confirmed;
  } else if (emoji === '❌' && data.slots[teamIndex].confirmed === false) {
    delete data.slots[teamIndex].confirmed;
  }

  setRegistrations(guild.id, data);
  await refreshSlotListMessage(guild, session, config, data);
}

// ── Edit the slot list message ────────────────────────────────────────────────
async function refreshSlotListMessage(guild, session, config, data) {
  try {
    const ch          = await guild.channels.fetch(session.channelId);
    const slotListMsg = await ch.messages.fetch(session.slotListMessageId);
    await slotListMsg.edit({ embeds: [buildSlotListEmbed(data.slots, config.max_slots || 100)] });
  } catch (err) {
    console.error('⚠️ Failed to update slot list:', err.message);
  }
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  buildSlotListEmbed,
  getPersistentSlotListId,
  setPersistentSlotListId,
};
