// ── Scrim Timer Handler ───────────────────────────────────────────────────────
// Watches all lobby channels for match post messages
// Converts Mauritius time (UTC+4) → Unix timestamp → Discord timestamp
// Fires reminder DMs 30 mins before to confirmed + unconfirmed teams
// Fires countdown pings in slotlist channel starting 5 mins before ID time

const { EmbedBuilder } = require('discord.js');
const {
  getSessions, getLobbyConfig, getRegistrations,
  getScrimSettings, getSessionConfig,
} = require('../utils/database');

// ── Regex: existing ID time format (backwards compat) ─────────────────────────
// ID @ 20:20 / ID: 20:20 / id:20:20 / ID 20:20
const ID_TIME_REGEX = /\bID\s*[@:]?\s*(\d{1,2}:\d{2})\b/i;

// ── Regex: match post detection ───────────────────────────────────────────────
const CLOCK_TIME_REGEX = /⏰\s*:\s*(\d{1,2}:\d{2})/;
const MATCH_ID_REGEX   = /🆔\s*:/;
const MAP_NAMES_REGEX  = /\b(ERANGEL|MIRAMAR|SANHOK|VIKENDI|KARAKIN|LIVIK|RONDO|NUSA|METRO|INFANTRY|GOLDEN|BLAZING)\b/i;

const REMINDER_OFFSET_MS  = 30 * 60 * 1000; // 30 minutes

// ── In-memory store ───────────────────────────────────────────────────────────
// guildId → Map(lobbyLetter → timerEntry)
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

  // Detect full match post: must have map name + 🆔 + ⏰ time
  const hasMap      = MAP_NAMES_REGEX.test(message.content);
  const hasId       = MATCH_ID_REGEX.test(message.content);
  const clockMatch  = message.content.match(CLOCK_TIME_REGEX);
  const legacyMatch = message.content.match(ID_TIME_REGEX);

  const isMatchPost = hasMap && hasId && !!clockMatch;
  const isIdPost    = !!legacyMatch && !isMatchPost; // ID @ HH:MM format only
  const timeMatch   = clockMatch || legacyMatch;
  if (!timeMatch) return;

  // ── ID post format: repost with timestamp, delete original, tag admin ─────
  if (isIdPost) {
    const timeStr   = legacyMatch[1];
    const unixTs    = mauritiusTimeToUnix(timeStr);
    const reposted  = message.content.replace(
      ID_TIME_REGEX,
      (full, t) => full.replace(t, `<t:${unixTs}:t>`)
    );
    const adminTag  = `<@${message.author.id}>`;
    try {
      await message.channel.send({
        content: `${reposted}\n-# Posted by ${adminTag}`,
        allowedMentions: { parse: ['roles', 'users'] },
      });
      await message.delete().catch(() => {});
    } catch (err) {
      console.error('[scrimTimer] ID repost error:', err.message);
    }
    return; // no timer needed for ID posts
  }

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

  if (!foundLobbyLetter) return;

  const timeStr  = timeMatch[1];
  const unixTs   = mauritiusTimeToUnix(timeStr);
  const nowMs    = Date.now();
  const targetMs = unixTs * 1000;

  const settings  = getScrimSettings(guildId, foundSessionId);
  const scrimName = settings.scrim_name || 'Scrim';

  // ── For match posts: no confirmation embed, just set the timer silently ───
  // ── For ID posts: send the "Scrim Time Set" embed ─────────────────────────
  const timers  = getGuildTimers(guildId);
  const existing = timers.get(foundLobbyLetter);
  let botReplyMessageId = existing?.botReplyMessageId || null;

  if (existing?.countdownInterval) {
    clearInterval(existing.countdownInterval);
  }

  if (!isMatchPost) {
    // ── Build timestamp reply embed (ID posts only) ───────────────────────
    const replyEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('⏰ Scrim Time Set')
      .setDescription(
        `**${scrimName} — Lobby ${foundLobbyLetter}**\n\n` +
        `🕐 ID starts: <t:${unixTs}:F>\n` +
        `⏳ That's <t:${unixTs}:R>\n\n` +
        `🔔 Reminder DMs will fire **30 minutes before**\n` +
        `📣 Countdown pings will start **5 minutes before** in the slot list channel`
      )
      .setTimestamp();

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
  }

  const timerEntry = {
    unixTs,
    reminderFired:       false,
    countdownFired:      false,
    lastCountdownPingId: null,
    botReplyMessageId,
    channelId,
    sessionId:           foundSessionId,
    guildId,
    lobbyLetter:         foundLobbyLetter,
    lobbyConf:           foundLobbyConf,
    isMatchPost,
  };
  timers.set(foundLobbyLetter, timerEntry);

  const msUntilReminder = targetMs - REMINDER_OFFSET_MS - nowMs;
  console.log(`[scrimTimer] Lobby ${foundLobbyLetter} → ${timeStr} MUT (unix=${unixTs}) reminder in ${Math.round(msUntilReminder / 60000)}min`);

  // ── Only fire immediate reminder for ID posts, NOT match posts ────────────
  if (!isMatchPost && msUntilReminder <= 0 && targetMs > nowMs) {
    console.log(`[scrimTimer] Less than 30min away — firing immediately for Lobby ${foundLobbyLetter}`);
    await fireReminder(client, guildId, foundLobbyLetter, timerEntry);
  }
}

// ── Send countdown ping in lobby channel, delete previous ────────────────────
async function sendCountdownPing(client, guildId, timer, minsLeft) {
  const { lobbyConf, lobbyLetter } = timer;

  let guild;
  try { guild = await client.guilds.fetch(guildId); } catch { return; }

  const lobbyChId = lobbyConf?.channel_id;
  if (!lobbyChId) return;

  let ch;
  try { ch = await guild.channels.fetch(lobbyChId); } catch { return; }

  const roleId      = lobbyConf?.role_id;
  const roleMention = roleId ? `<@&${roleId}>` : `Lobby ${lobbyLetter}`;

  const content = minsLeft > 0
    ? `📣 STARTING IN ${String(minsLeft).padStart(2, '0')}MIN ${roleMention}`
    : `🚨 STARTING NOW ${roleMention}`;

  try {
    if (timer.lastCountdownPingId) {
      const prev = await ch.messages.fetch(timer.lastCountdownPingId).catch(() => null);
      if (prev) await prev.delete().catch(() => {});
      timer.lastCountdownPingId = null;
    }

    const sent = await ch.send({ content });
    timer.lastCountdownPingId = sent.id;

    console.log(`[scrimTimer] Countdown ping Lobby ${lobbyLetter}: ${content}`);
  } catch (err) {
    console.error('[scrimTimer] Countdown ping error:', err.message);
  }
}

// ── Fire reminder: plain text ping for match posts, embed for ID posts ────────
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

  const { sessionId, lobbyConf, unixTs, isMatchPost } = timer;
  const settings  = getScrimSettings(guildId, sessionId);
  const data      = getRegistrations(guildId, sessionId);
  const scrimName = settings.scrim_name || 'Scrim';

  const lobbyChannelId = lobbyConf?.channel_id;
  let lobbyChannel = null;
  try {
    if (lobbyChannelId) lobbyChannel = await guild.channels.fetch(lobbyChannelId).catch(() => null);
  } catch {}

  const lobbyChannelMention = lobbyChannel ? `<#${lobbyChannelId}>` : `Lobby ${lobbyLetter}`;
  const roleId = lobbyConf?.role_id || null;
  const roleMention = roleId ? `<@&${roleId}>` : `Lobby ${lobbyLetter}`;

  // ── 1. Ping lobby role in lobby channel ───────────────────────────────────
  if (lobbyChannel) {
    try {
      if (isMatchPost) {
        // ── Match post: plain text only, no embed ────────────────────────
        await lobbyChannel.send({
          content: `⏰ ID will be sent in 30 minutes ${roleMention}`,
          allowedMentions: { roles: roleId ? [roleId] : [] },
        });
      } else {
        // ── ID post: full embed ───────────────────────────────────────────
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
      }
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
          : new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle("⚠️ You Haven't Confirmed Your Slot!")
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
        const targetMs     = timer.unixTs * 1000;
        const msUntilStart = targetMs - nowMs;

        // Clean up entries for scrims that started more than 2h ago
        if (msUntilStart < -2 * 60 * 60 * 1000) {
          lobbyMap.delete(lobbyLetter);
          continue;
        }

        // ── 30-min reminder (only for ID post format, NOT match posts) ────
        if (!timer.reminderFired && !timer.isMatchPost) {
          const msUntilReminder = msUntilStart - REMINDER_OFFSET_MS;
          if (msUntilReminder <= 0 && msUntilStart > 0) {
            await fireReminder(client, guildId, lobbyLetter, timer).catch(err => {
              console.error(`[scrimTimer] Reminder error lobby=${lobbyLetter}:`, err.message);
            });
          }
        }

        // ── Countdown pings (only for match post format) ──────────────────
        if (!timer.isMatchPost) continue;
        if (timer.countdownFired) continue;

        const minsUntilStart = Math.ceil(msUntilStart / 60000);

        if (msUntilStart > -60000) {
          const minsLeft = Math.max(0, minsUntilStart);
          await sendCountdownPing(client, guildId, timer, minsLeft).catch(err => {
            console.error(`[scrimTimer] Countdown error lobby=${lobbyLetter}:`, err.message);
          });
          if (minsLeft === 0) timer.countdownFired = true;
        }
      }
    }
  }, 60 * 1000);

  console.log('⏰ Scrim timer checker started');
}

module.exports = {
  handleScrimTimeMessage,
  startScrimTimerChecker,
};
