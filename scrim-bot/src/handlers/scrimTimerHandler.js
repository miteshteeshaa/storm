// ── Scrim Timer Handler ───────────────────────────────────────────────────────
// Watches all lobby channels for "ID @ HH:MM" style messages
// Converts Mauritius time (UTC+4) → Unix timestamp → Discord timestamp
// Fires reminder DMs 30 mins before to confirmed + unconfirmed teams
// Lobby role gets pinged in channel 30 mins before

const { EmbedBuilder } = require('discord.js');
const {
  getSessions, getLobbyConfig, getRegistrations,
  getScrimSettings,
} = require('../utils/database');

// ── Matches all ID time variants admin might type ─────────────────────────────
// ID @ 20:20 / ID: 20:20 / id:20:20 / ID 20:20 / ID@ 20:20 / ID : 20:20
const ID_TIME_REGEX = /\bID\s*[@:]?\s*(\d{1,2}:\d{2})\b/i;

const REMINDER_OFFSET_MS = 30 * 60 * 1000; // 30 minutes fixed

// ── In-memory store ───────────────────────────────────────────────────────────
// guildId → Map(lobbyLetter → { unixTs, reminderFired, botReplyMessageId, channelId, sessionId, lobbyConf })
const scrimTimers = new Map();

function getGuildTimers(guildId) {
  if (!scrimTimers.has(guildId)) scrimTimers.set(guildId, new Map());
  return scrimTimers.get(guildId);
}

// ── Convert HH:MM Mauritius time (UTC+4) → Unix seconds ──────────────────────
function mauritiusTimeToUnix(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours - 4, // Mauritius = UTC+4
    minutes,
    0,
  ));
  // If more than 2h in the past, assume it's for tomorrow
  if (d.getTime() < Date.now() - 2 * 60 * 60 * 1000) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.floor(d.getTime() / 1000);
}

// ── Handle new message in any channel ────────────────────────────────────────
async function handleScrimTimeMessage(message, client) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId   = message.guild.id;
  const channelId = message.channel.id;

  const match = message.content.match(ID_TIME_REGEX);
  if (!match) return;

  // Find which session + lobby letter this channel belongs to
  const sessions = getSessions(guildId);
  let foundSessionId   = null;
  let foundLobbyLetter = null;
  let foundLobbyConf   = null;

  for (const s of sessions) {
    const lobbyConf = getLobbyConfig(guildId, s.id);
    for (const [letter, lc] of Object.entries(lobbyConf)) {
      if (lc?.channel_id === channelId) {
        foundSessionId   = s.id;
        foundLobbyLetter = letter;
        foundLobbyConf   = lc;
        break;
      }
    }
    if (foundLobbyLetter) break;
  }

  if (!foundLobbyLetter) return; // not a recognised lobby channel — ignore

  const timeStr  = match[1];
  const unixTs   = mauritiusTimeToUnix(timeStr);
  const nowMs    = Date.now();
  const targetMs = unixTs * 1000;

  const settings  = getScrimSettings(guildId, foundSessionId);
  const scrimName = settings.scrim_name || 'Scrim';

  // ── Build timestamp reply embed ───────────────────────────────────────────
  const replyEmbed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('⏰ Scrim Time Set')
    .setDescription(
      `**${scrimName} — Lobby ${foundLobbyLetter}**\n\n` +
      `🕐 ID starts: <t:${unixTs}:F>\n` +
      `⏳ That's <t:${unixTs}:R>\n\n` +
      `🔔 Reminder DMs will fire **30 minutes before**`
    )
    .setTimestamp();

  // Edit previous bot reply if we have one, otherwise send fresh
  const timers  = getGuildTimers(guildId);
  const existing = timers.get(foundLobbyLetter);
  let botReplyMessageId = existing?.botReplyMessageId || null;

  try {
    if (botReplyMessageId) {
      const prev = await message.channel.messages.fetch(botReplyMessageId).catch(() => null);
      if (prev) {
        await prev.edit({ embeds: [replyEmbed] });
      } else {
        const sent = await message.channel.send({ embeds: [replyEmbed] });
        botReplyMessageId = sent.id;
      }
    } else {
      const sent = await message.channel.send({ embeds: [replyEmbed] });
      botReplyMessageId = sent.id;
    }
  } catch (err) {
    console.error('[scrimTimer] Reply error:', err.message);
  }

  // ── Store / update timer (always reset reminderFired on time change) ──────
  const timerEntry = {
    unixTs,
    reminderFired:    false, // reset so reminder fires again at new time
    botReplyMessageId,
    channelId,
    sessionId:        foundSessionId,
    guildId,
    lobbyLetter:      foundLobbyLetter,
    lobbyConf:        foundLobbyConf,
  };
  timers.set(foundLobbyLetter, timerEntry);

  const msUntilReminder = targetMs - REMINDER_OFFSET_MS - nowMs;
  console.log(`[scrimTimer] Lobby ${foundLobbyLetter} → ${timeStr} MUT (unix=${unixTs}) reminder in ${Math.round(msUntilReminder / 60000)}min`);

  // If already within 30 min window (but scrim hasn't started), fire immediately
  if (msUntilReminder <= 0 && targetMs > nowMs) {
    console.log(`[scrimTimer] Less than 30min away — firing immediately for Lobby ${foundLobbyLetter}`);
    await fireReminder(client, guildId, foundLobbyLetter, timerEntry);
  }
}

// ── Fire reminder: lobby channel ping + DMs ───────────────────────────────────
async function fireReminder(client, guildId, lobbyLetter, timer) {
  if (timer.reminderFired) return;
  timer.reminderFired = true;

  console.log(`[scrimTimer] Firing reminder guild=${guildId} lobby=${lobbyLetter}`);

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    console.error('[scrimTimer] Guild fetch failed:', err.message);
    return;
  }

  const { sessionId, lobbyConf, unixTs } = timer;
  const settings  = getScrimSettings(guildId, sessionId);
  const data      = getRegistrations(guildId, sessionId);
  const scrimName = settings.scrim_name || 'Scrim';

  // Fetch lobby channel
  const lobbyChannelId = lobbyConf?.channel_id;
  let lobbyChannel = null;
  try {
    if (lobbyChannelId) lobbyChannel = await guild.channels.fetch(lobbyChannelId).catch(() => null);
  } catch {}

  const lobbyChannelMention = lobbyChannel ? `<#${lobbyChannelId}>` : `Lobby ${lobbyLetter}`;
  const roleId = lobbyConf?.role_id || null;

  // ── 1. Ping lobby role in the lobby channel ───────────────────────────────
  if (lobbyChannel) {
    try {
      const roleMention = roleId ? `<@&${roleId}> ` : '';
      await lobbyChannel.send({
        content: roleMention,
        embeds: [
          new EmbedBuilder()
            .setColor(0xFF6B00)
            .setTitle('⏰ ID Starting in 30 Minutes!')
            .setDescription(
              `**${scrimName} — Lobby ${lobbyLetter}**\n\n` +
              `🕐 ID starts <t:${unixTs}:R> — <t:${unixTs}:t>\n\n` +
              `Make sure you're in the lobby and ready!`
            )
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[scrimTimer] Lobby channel ping error:', err.message);
    }
  }

  // ── 2. DM each team in this lobby ────────────────────────────────────────
  const lobbyTeams = (data.slots || []).filter(t => t.lobby === lobbyLetter && t.lobby_slot);

  for (const team of lobbyTeams) {
    const isConfirmed = team.confirmed === true;
    const playerIds   = [...new Set([team.captain_id, team.manager_id].filter(Boolean))];

    for (const playerId of playerIds) {
      try {
        const user = await client.users.fetch(playerId).catch(() => null);
        if (!user) continue;

        const dmEmbed = isConfirmed
          // ── Confirmed team ────────────────────────────────────────────────
          ? new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('⏰ ID Will Be Sent in 30 Minutes!')
              .setDescription(
                `**${scrimName}**\n` +
                `🏟️ Lobby ${lobbyLetter} › Slot **${team.lobby_slot}**\n` +
                `📢 ${lobbyChannelMention}\n\n` +
                `🕐 ID starts <t:${unixTs}:R> — <t:${unixTs}:t>\n\n` +
                `Be ready! ✅`
              )
              .setTimestamp()
          // ── Unconfirmed team ──────────────────────────────────────────────
          : new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle('⚠️ You Haven\'t Confirmed Your Slot!')
              .setDescription(
                `**${scrimName}**\n` +
                `🏟️ Lobby ${lobbyLetter} › Slot **${team.lobby_slot}**\n` +
                `📢 ${lobbyChannelMention}\n\n` +
                `🕐 ID starts <t:${unixTs}:R> — <t:${unixTs}:t>\n\n` +
                `⚠️ **Please confirm your slot NOW or you may lose it!**\n` +
                `React ✅ in the confirm channel immediately.`
              )
              .setTimestamp();

        await user.send({ embeds: [dmEmbed] }).catch(() => {
          console.warn(`[scrimTimer] Could not DM ${playerId} — DMs likely closed`);
        });

      } catch (err) {
        console.error(`[scrimTimer] DM error player=${playerId}:`, err.message);
      }
    }
  }

  console.log(`[scrimTimer] Reminder done — Lobby ${lobbyLetter}, ${lobbyTeams.length} teams processed`);
}

// ── Background checker — runs every minute ────────────────────────────────────
function startScrimTimerChecker(client) {
  setInterval(async () => {
    const nowMs = Date.now();

    for (const [guildId, lobbyMap] of scrimTimers) {
      for (const [lobbyLetter, timer] of lobbyMap) {
        if (timer.reminderFired) continue;

        const targetMs        = timer.unixTs * 1000;
        const msUntilStart    = targetMs - nowMs;
        const msUntilReminder = msUntilStart - REMINDER_OFFSET_MS;

        // Clean up entries for scrims that started more than 2h ago
        if (msUntilStart < -2 * 60 * 60 * 1000) {
          lobbyMap.delete(lobbyLetter);
          continue;
        }

        // Fire when we hit the 30-min window
        if (msUntilReminder <= 0 && msUntilStart > 0) {
          await fireReminder(client, guildId, lobbyLetter, timer).catch(err => {
            console.error(`[scrimTimer] Reminder error lobby=${lobbyLetter}:`, err.message);
          });
        }
      }
    }
  }, 60 * 1000); // check every 60 seconds

  console.log('⏰ Scrim timer checker started');
}

module.exports = {
  handleScrimTimeMessage,
  startScrimTimerChecker,
};
