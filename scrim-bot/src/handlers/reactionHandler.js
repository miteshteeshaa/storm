const { EmbedBuilder } = require('discord.js');
const { getConfig, getRegistrations, setRegistrations, getScrimSettings } = require('../utils/database');

// In-memory stores
const confirmSessions    = new Map(); // guildId → { confirmMessageId, channelId, slotListMessageId }
const persistentSlotIds  = new Map(); // guildId → messageId of the always-visible slot list

// ── Persistent slot list ──────────────────────────────────────────────────────
function getPersistentSlotListId(guildId)          { return persistentSlotIds.get(guildId) || null; }
function setPersistentSlotListId(guildId, msgId)   { persistentSlotIds.set(guildId, msgId); }

// ── Confirm session ───────────────────────────────────────────────────────────
function registerConfirmSession(guildId, confirmMessageId, channelId, slotListMessageId) {
  confirmSessions.set(guildId, { confirmMessageId, channelId, slotListMessageId });
}
function getConfirmSession(guildId) { return confirmSessions.get(guildId) || null; }

// ── Number emoji helper ───────────────────────────────────────────────────────
function numEmoji(n) {
  const map = {
    0:'0️⃣',1:'1️⃣',2:'2️⃣',3:'3️⃣',4:'4️⃣',5:'5️⃣',
    6:'6️⃣',7:'7️⃣',8:'8️⃣',9:'9️⃣',10:'🔟',
  };
  if (map[n]) return map[n];
  // For numbers > 10, combine digits
  return String(n).split('').map(d => map[parseInt(d)] || d).join('');
}

// ── Build the persistent slot list (idpass channel) ───────────────────────────
// Shows all slots from first_slot to first_slot+slots-1
// Fills in team names as they register
function buildPersistentSlotList(slots, settings) {
  const { scrim_name, first_slot, slots: totalSlots } = settings;
  const lines = [];

  for (let i = 0; i < totalSlots; i++) {
    const slotNum = first_slot + i;
    const team    = slots[i];
    const emoji   = numEmoji(slotNum);

    if (team) {
      if (team.confirmed === true) {
        lines.push(`${emoji} __[${team.team_tag}] ${team.team_name}__ <@${team.manager_id || team.captain_id}>`);
      } else if (team.confirmed === false) {
        lines.push(`${emoji} ~~[${team.team_tag}] ${team.team_name}~~ <@${team.manager_id || team.captain_id}>`);
      } else {
        lines.push(`${emoji} [${team.team_tag}] ${team.team_name} <@${team.manager_id || team.captain_id}>`);
      }
    } else {
      lines.push(`${emoji}`); // empty slot
    }
  }

  const confirmed = slots.filter(t => t?.confirmed === true).length;
  const cancelled = slots.filter(t => t?.confirmed === false).length;
  const pending   = slots.filter(t => t && t.confirmed === undefined).length;
  const empty     = totalSlots - slots.length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 ${scrim_name} — SLOT LIST`)
    .addFields({ name: 'Slots', value: lines.join('\n') || '*No teams yet.*' })
    .addFields({
      name: '📊 Status',
      value: `✅ **${confirmed}** confirmed | ❌ **${cancelled}** cancelled | ⏳ **${pending}** pending | 🔓 **${empty}** open`,
    })
    .setTimestamp();
}

// ── Build confirm-phase slot list (slotlist channel) ─────────────────────────
function buildConfirmSlotList(slots, settings) {
  const { scrim_name, first_slot, slots: totalSlots } = settings;
  const lines = slots.map((t, i) => {
    const slotNum = first_slot + i;
    const emoji   = numEmoji(slotNum);
    const mgr     = `<@${t.manager_id || t.captain_id}>`;
    if (t.confirmed === true)  return `${emoji} __[${t.team_tag}] ${t.team_name}__ ${mgr}`;
    if (t.confirmed === false) return `${emoji} ~~[${t.team_tag}] ${t.team_name}~~ ${mgr}`;
    return `${emoji} [${t.team_tag}] ${t.team_name} ${mgr}`;
  });

  const confirmed = slots.filter(t => t.confirmed === true).length;
  const cancelled = slots.filter(t => t.confirmed === false).length;
  const pending   = slots.filter(t => t.confirmed === undefined).length;

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`📋 ${scrim_name} — CONFIRM YOUR SLOTS`)
    .setDescription(lines.join('\n') || '*No teams registered.*')
    .addFields({
      name: '📊 Status',
      value: `✅ **${confirmed}** confirmed | ❌ **${cancelled}** cancelled | ⏳ **${pending}** pending`,
    })
    .setTimestamp();
}

// ── Reaction handlers ─────────────────────────────────────────────────────────
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
  if (!session || message.id !== session.confirmMessageId) return;

  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config   = getConfig(guild.id);
  const settings = getScrimSettings(guild.id);
  const data     = getRegistrations(guild.id);

  // Find team — allow multiple registrations per user (find by manager_id)
  // For confirm, we match by captain_id (the person who ran /register)
  const teamIndex = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (teamIndex === -1) return;

  if (emoji === '✅') {
    data.slots[teamIndex].confirmed = true;
    try { await message.reactions.cache.get('❌')?.users.remove(user.id); } catch {}
  } else {
    data.slots[teamIndex].confirmed = false;
    try { await message.reactions.cache.get('✅')?.users.remove(user.id); } catch {}
  }

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshPersistentList(guild, config, settings, data);
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
  if (!session || message.id !== session.confirmMessageId) return;

  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return;

  const config   = getConfig(guild.id);
  const settings = getScrimSettings(guild.id);
  const data     = getRegistrations(guild.id);

  const teamIndex = data.slots.findIndex(t => t.captain_id === user.id || t.manager_id === user.id);
  if (teamIndex === -1) return;

  if (emoji === '✅' && data.slots[teamIndex].confirmed === true)  delete data.slots[teamIndex].confirmed;
  if (emoji === '❌' && data.slots[teamIndex].confirmed === false) delete data.slots[teamIndex].confirmed;

  setRegistrations(guild.id, data);
  await refreshConfirmList(guild, session, settings, data);
  await refreshPersistentList(guild, config, settings, data);
}

async function refreshConfirmList(guild, session, settings, data) {
  try {
    const ch  = await guild.channels.fetch(session.channelId);
    const msg = await ch.messages.fetch(session.slotListMessageId);
    await msg.edit({ embeds: [buildConfirmSlotList(data.slots, settings)] });
  } catch {}
}

async function refreshPersistentList(guild, config, settings, data) {
  const channelId = config.idpass_channel || config.slotlist_channel;
  if (!channelId) return;
  const existingId = getPersistentSlotListId(guild.id);
  if (!existingId) return;
  try {
    const ch  = await guild.channels.fetch(channelId);
    const msg = await ch.messages.fetch(existingId);
    await msg.edit({ embeds: [buildPersistentSlotList(data.slots, settings)] });
  } catch {}
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
  registerConfirmSession,
  getConfirmSession,
  buildPersistentSlotList,
  buildConfirmSlotList,
  getPersistentSlotListId,
  setPersistentSlotListId,
  refreshPersistentList,
};
