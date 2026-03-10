// ── matchResultHandler.js ─────────────────────────────────────────────────────
// Listens for messages in configured match_channel(s).
//
// Trigger format:  admin posts a message like "A1" or "b3" WITH an image
//                  attachment in the session's match_channel.
//
// Flow:
//   1. Parse lobby letter + match number from the message text (e.g. "A1" → A, 1)
//   2. Download the attached screenshot
//   3. Send to Google Cloud Vision API (free tier: 1,000/month)
//      — uses same service account already configured for Sheets
//   4. Parse OCR text → extract teams: [{ tag, kills, placement }]
//      — PUBG Mobile results screen lists teams by placement with player rows
//      — each player row: "playerName   N eliminations"
//      — team tag = shared case-insensitive prefix of player names
//   5. Match extracted tags against registered teams (prefix match)
//   6. Enforce ≥2 player rule: teams with <2 players detected = 0 pts
//   7. writeMatchResult() → Google Sheet
//   8. Reply with a confirmation embed showing what was written

const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const {
  getSessions, getSessionConfig,
  getRegistrations, getScrimSettings, getConfig,
} = require('../utils/database');
const { writeMatchResult } = require('../utils/sheets');

// Returns the longest common prefix shared by all strings in the array
function commonPrefix(strings) {
  if (!strings || strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === '') return '';
    }
  }
  return prefix;
}

// Admin check for Message objects (not Interactions)
async function isAdminMessage(message) {
  if (!message.guild || !message.member) return false;
  if (message.guild.ownerId === message.author.id) return true;
  if (message.member.permissions.has('Administrator')) return true;
  const config = getConfig(message.guild.id);
  if (config.admin_role && message.member.roles.cache.has(config.admin_role)) return true;
  return false;
}

// ── Regex to detect trigger message ──────────────────────────────────────────
// Matches: A1, b3, C12, a 1, B 2  (letter then optional space then digits)
const TRIGGER_RE = /^([A-Ja-j])\s*(\d{1,2})$/;

// ── Google Vision API ─────────────────────────────────────────────────────────
async function runVision(imageBuffer) {
  const credentials = getGoogleCredentials();
  const token       = await getAccessToken(credentials);

  const body = JSON.stringify({
    requests: [{
      image:    { content: imageBuffer.toString('base64') },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'vision.googleapis.com',
      path:     '/v1/images:annotate',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.responses?.[0]?.fullTextAnnotation?.text || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Vision API response parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Google auth helpers ───────────────────────────────────────────────────────
function getGoogleCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try { return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch { throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON'); }
  }
  // Build creds from individual env vars (fallback)
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('No Google credentials found. Set GOOGLE_CREDENTIALS_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY');
  return { client_email: email, private_key: key };
}

async function getAccessToken(credentials) {
  // JWT grant for service account
  const { client_email, private_key } = credentials;
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   client_email,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const jwt   = await signJWT(payload, private_key);
  const body  = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`OAuth error: ${parsed.error_description || parsed.error}`));
          resolve(parsed.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function signJWT(payload, privateKey) {
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${body}`);
  const sig = sign.sign(privateKey, 'base64url');
  return `${header}.${body}.${sig}`;
}

// ── Download image from Discord CDN ──────────────────────────────────────────
function downloadImage(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === 'https:' ? https : http;
    lib.get(urlStr, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── OCR text → structured results ────────────────────────────────────────────
// PUBG Mobile end-screen structure (from OCR):
//
//   [placement number on left, e.g. "1", "2", "3"...]
//   playerName    N eliminations   (repeated per player in that team)
//
// We walk line by line:
//   - A line that is a bare integer (1–25) = new team placement
//   - A line matching "... N elimination(s)" = player row → accumulate kills
//   - When placement changes, save the previous team
//
// Tag extraction: all players in a team share a common prefix → that IS the tag.
// We find the longest common prefix of all player names in the group,
// then compare it case-insensitively against registered team tags.

function parseOCRText(rawText) {
  // ── Step 1: Normalize OCR artifacts ──────────────────────────────────────
  const normalized = rawText
    // Strip accents/diacritics early: aès→aes, ŁOKI→LOKI
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Superscript digits/letters appended to names: wargod¹ → wargod1, m¹KING → m1KING
    .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]/g, d => String.fromCharCode('0'.charCodeAt(0) + '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079'.indexOf(d)))
    // Normalize all tag separators to a single space:
    //   GX\CeeOl → GX CeeOl, x9G·JOOTA → x9G JOOTA, Sh→TAAKEYE → Sh TAAKEYE
    //   TRT×name → TRT name, NVX|704 → NVX 704, APEX✗LUNNA → APEX LUNNA
    .replace(/[\\\u00B7\u2022\u2192\u2193\u00D7\u00D7\xD7\u2715\u2716|]+/g, ' ')
    // Kill-count normalizations
    .replace(/\bDal?[oi]m[oi]?nations?\b/gi, '0 eliminations')
    .replace(/\bDel?[oi]m[oi]?nations?\b/gi, '0 eliminations')
    .replace(/\b([Ol])\b(?=\s+eliminations?)/gi, '0')
    .replace(/\bI\b(?=\s+elimination)/g, '1')
    .replace(/\b(\d)\s*elims?\b/gi, '$1 eliminations')
    // Strip non-latin non-digit chars that appear inside names (Korean, Chinese, symbols)
    // but KEEP the rest of the name intact — just strip the exotic char
    .replace(/[^\x00-\x7F\u00C0-\u024F\s]/g, '');

  // ── Step 2: Tokenize ───────────────────────────────────────────────────────
  const lines = normalized
    .split('\n')
    .map(l => l.trim())
    // Collapse internal multiple spaces (e.g. "S K Y R A" → "SKYRA" handled below)
    .filter(Boolean);

  // ── Step 3: Regex patterns ─────────────────────────────────────────────────
  const noiseRe     = /^(PUBG|MOBILE|Continue)$/i;
  const junkRe      = /^(SQUAD|SOLO|DUO|LOBBY|MATCH|RESULT)$/i;
  const elimRe      = /^(.+?)\s+(\d+)\s+eliminations?$/i;   // "name N eliminations"
  const killsOnlyRe = /^(\d+)\s+eliminations?$/i;            // "N eliminations"
  const pureNumRe   = /^(\d{1,2})$/;                         // bare 1-25
  // "9 TB HAIDER" — digit(s) then space then non-digit text
  const gluedRe     = /^(\d{1,2})\s+([^\d].*)$/;
  // Spaced-letter names like "S K Y R A" — all single chars separated by spaces
  const spacedLettersRe = /^([A-Za-z0-9] ){2,}[A-Za-z0-9]$/;

  // ── Step 4: Build segments (one per placement) ────────────────────────────
  const segments = [];
  let seg = null;

  function flushSeg() {
    if (seg && (seg.nameLines.length || seg.killLines.length)) segments.push(seg);
  }

  for (const rawLine of lines) {
    // Collapse spaced-letter names before anything else: "S K Y R A" → "SKYRA"
    const line = spacedLettersRe.test(rawLine)
      ? rawLine.replace(/\s+/g, '')
      : rawLine;

    if (noiseRe.test(line)) continue;

    // Kill-only line — always goes to current segment
    const killsOnly = killsOnlyRe.exec(line);
    if (killsOnly) {
      if (seg) seg.killLines.push(parseInt(killsOnly[1]));
      continue;
    }

    // Full "name N eliminations" inline
    const elimMatch = elimRe.exec(line);
    if (elimMatch) {
      const name = elimMatch[1].trim();
      const kills = parseInt(elimMatch[2]);
      if (seg && name.length >= 2 && !junkRe.test(name)) {
        seg.nameLines.push(name);
        seg.killLines.push(kills);
      }
      continue;
    }

    // Bare placement number — highest priority boundary marker
    const pureNum = pureNumRe.exec(line);
    if (pureNum) {
      const p = parseInt(pureNum[1]);
      if (p >= 1 && p <= 25) {
        flushSeg();
        seg = { placement: p, nameLines: [], killLines: [] };
        continue;
      }
      // Not 1-25 (e.g. score 200) — skip
      continue;
    }

    // "9 TB HAIDER" — placement glued to first player name on same line
    const glued = gluedRe.exec(line);
    if (glued) {
      const p = parseInt(glued[1]);
      const name = glued[2].trim();
      if (p >= 1 && p <= 25 && name.length >= 2) {
        flushSeg();
        seg = { placement: p, nameLines: [name], killLines: [] };
        continue;
      }
    }

    // Junk UI labels
    if (junkRe.test(line)) continue;

    // Plain player name
    if (seg && line.length >= 2) {
      seg.nameLines.push(line);
    }
  }
  flushSeg();

  // ── Step 5: Segments → teams, deduplicate by placement ────────────────────
  const teams = [];
  const seenPlacements = new Set();

  for (const s of segments) {
    if (seenPlacements.has(s.placement)) continue;
    const players = [];
    const count = Math.max(s.nameLines.length, s.killLines.length);
    for (let i = 0; i < count; i++) {
      const name  = s.nameLines[i];
      const kills = s.killLines[i] ?? 0;
      if (name && name.length >= 2) players.push({ name, kills });
    }
    if (players.length > 0) {
      seenPlacements.add(s.placement);
      teams.push({ placement: s.placement, players });
    }
  }

  return teams;
}


// ── Tag detection: majority vote ─────────────────────────────────────────────
// For each registered tag, count how many players in this group have a name
// that starts with that tag (case-insensitive).
// The tag with the most matching players wins, as long as >= 2 players match it.
// This handles stand-ins or players with differently-prefixed names.

function detectTagByMajority(players, registeredSlots) {
  // Normalize an OCR-read player name for tag prefix matching.
  // Strips everything non-alphanumeric so separators (space, dot, arrow, backslash,
  // superscript digits, etc.) don't break the startsWith check.
  function normalizeOCR(str) {
    return str
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accents: aès→aes
      .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]/g, d => // superscripts: ¹→1
        String.fromCharCode('0'.charCodeAt(0) + '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079'.indexOf(d)))
      .replace(/[^\x00-\x7F\u00C0-\u024F]/g, '')          // strip CJK/symbols
      .toLowerCase()
      .replace(/^[il](?=[a-z0-9])/, '1')                    // leading I/l misread: Itke→1tke, ITE→1te
      .replace(/^aes(?=[a-z0-9])/i, 'aes')                // keep aes prefix before stripping
      .replace(/[^a-z0-9]/g, '');                          // strip all punctuation/spaces
  }

  // Normalize a registered tag the same way
  function normalizeTag(str) {
    return str
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  const normalizedNames = players.map(p => normalizeOCR(p.name));

  let bestSlot  = null;
  let bestCount = 0;

  for (const slot of registeredSlots) {
    if (!slot.lobby || !slot.team_tag) continue;
    const tag   = normalizeTag(slot.team_tag);
    if (!tag) continue;
    const count = normalizedNames.filter(n => n.startsWith(tag)).length;
    if (count >= 1 && count > bestCount) {
      bestCount = count;
      bestSlot  = slot;
    }
  }

  return { slot: bestSlot, matchCount: bestCount, tag: bestSlot ? bestSlot.team_tag : null };
}


// ── Match OCR teams → registered slots ──────────────────────────────────────────────
// For each OCR team, use majority vote across all registered tags to find
// the best matching team. Returns:
// [{ lobby_slot, placement, kills, matched_tag, team_name,
//    player_count, match_count, disqualified }]

function matchTeamsToSlots(ocrTeams, registeredSlots) {
  const results  = [];
  const usedSlots = new Set(); // prevent same slot being written twice

  for (const ocrTeam of ocrTeams) {
    const { placement, players } = ocrTeam;
    const totalKills  = players.reduce((s, p) => s + p.kills, 0);
    const playerCount = players.length;

    const { slot, matchCount, tag } = detectTagByMajority(players, registeredSlots);

    // No registered tag matched any player — skip
    if (!slot) continue;

    // Skip if this slot was already matched by a better/earlier OCR team
    if (usedSlots.has(slot.lobby_slot)) continue;
    usedSlots.add(slot.lobby_slot);

    // >=2 player rule: fewer than 2 total visible players = 0 kills, placement stands
    const effectiveKills = playerCount >= 2 ? totalKills : 0;

    results.push({
      lobby_slot:   slot.lobby_slot,
      placement,
      kills:        effectiveKills,
      matched_tag:  slot.team_tag,
      team_name:    slot.team_name,
      player_count: playerCount,
      match_count:  matchCount,
      disqualified: playerCount < 2,
    });
  }

  return results;
}
// ── Main message handler ──────────────────────────────────────────────────────
async function handleMatchResultMessage(message) {
  // Ignore bots
  if (message.author.bot) return;
  if (!message.guild)     return;

  const guildId   = message.guild.id;
  const channelId = message.channel.id;
  const content   = message.content.trim();

  // Must match trigger pattern
  const triggerMatch = TRIGGER_RE.exec(content);
  if (!triggerMatch) return;

  // Collect ALL image attachments
  const imageAttachments = [...message.attachments.values()].filter(a =>
    a.contentType?.startsWith('image/') ||
    /\.(png|jpg|jpeg|webp)$/i.test(a.name || '')
  );
  if (imageAttachments.length === 0) return;

  // Find which session owns this channel (match_channel)
  const sessions = getSessions(guildId);
  let sessionId  = null;
  for (const s of sessions) {
    const cfg = getSessionConfig(guildId, s.id);
    if (cfg.match_channel === channelId) { sessionId = s.id; break; }
  }
  if (!sessionId) return;  // This channel isn't a match results channel

  // Admin check
  const adminOk = await isAdminMessage(message).catch(() => false);
  if (!adminOk) {
    return message.reply({ content: '❌ Only admins can submit match results.' });
  }

  const lobbyLetter = triggerMatch[1].toUpperCase();
  const matchNumber = parseInt(triggerMatch[2]);

  // Validate lobby letter is configured
  const settings = getScrimSettings(guildId, sessionId);
  const numLobbies = settings.lobbies || 4;
  const validLobbies = Array.from({ length: numLobbies }, (_, i) => String.fromCharCode(65 + i));
  if (!validLobbies.includes(lobbyLetter)) {
    return message.reply({ content: `❌ Lobby **${lobbyLetter}** is not configured. Valid lobbies: ${validLobbies.join(', ')}` });
  }

  const sessionCfg = getSessionConfig(guildId, sessionId);
  if (!sessionCfg.spreadsheet_id) {
    return message.reply({ content: `❌ No Google Sheet linked for this session. Run \`/link\` first.` });
  }

  // Acknowledge immediately so the admin knows it's working
  const processingMsg = await message.reply({ content: `⏳ Processing **Lobby ${lobbyLetter} — Match ${matchNumber}** (${imageAttachments.length} screenshot${imageAttachments.length > 1 ? 's' : ''})...` });

  try {
    // 1. Download + OCR all images, concatenate text
    const ocrParts = await Promise.all(
      imageAttachments.map(async (att) => {
        const buf = await downloadImage(att.url);
        return await runVision(buf);
      })
    );
    if (!ocrParts.some(Boolean)) throw new Error('Vision API returned no text. Is the Vision API enabled in your Google Cloud project?');

    // Parse each screenshot independently then merge — avoids cross-screenshot bleeding
    const allTeams = [];
    const seenPlacements = new Set();
    for (const part of ocrParts) {
      if (!part) continue;
      console.log(`[matchResult] Raw OCR text for ${lobbyLetter}${matchNumber}:\n${part}`);
      const teamsFromPage = parseOCRText(part);
      for (const t of teamsFromPage) {
        if (!seenPlacements.has(t.placement)) {
          seenPlacements.add(t.placement);
          allTeams.push(t);
        }
      }
    }
    const rawText = ocrParts.filter(Boolean).join('\n'); // kept for error message only

    if (allTeams.length === 0) {
      throw new Error('Could not extract any team data from the screenshots. Make sure the images show the full results screen.');
    }

    // 4. Get registered teams for this lobby
    const data      = getRegistrations(guildId, sessionId);
    const lobbySlots = data.slots.filter(t => t.lobby === lobbyLetter && t.lobby_slot);

    if (lobbySlots.length === 0) {
      throw new Error(`No teams are assigned to Lobby ${lobbyLetter}. Assign teams first using team card reactions.`);
    }

    // 5. Match OCR teams → registered slots
    const matchedResults = matchTeamsToSlots(allTeams, lobbySlots);

    if (matchedResults.length === 0) {
      // Show what OCR found so admin can debug
      const ocrSummary = allTeams.slice(0, 8).map(t => {
        const prefix = commonPrefix(t.players.map(p => p.name));
        return `P${t.placement}: \`${prefix || '?'}\` (${t.players.length} players)`;
      }).join('\n');
      throw new Error(
        `Could not match any OCR teams to registered tags.\n\n` +
        `**OCR detected (top 8):**\n${ocrSummary}\n\n` +
        `**Registered tags in Lobby ${lobbyLetter}:**\n` +
        lobbySlots.map(s => `\`${s.team_tag}\``).join(', ')
      );
    }

    // 6. Write to sheet
    await writeMatchResult(
      sessionCfg.spreadsheet_id,
      lobbyLetter,
      matchNumber,
      matchedResults  // [{ lobby_slot, placement, kills }]
    );

    // 7. Build confirmation embed
    const matched    = matchedResults.filter(r => !r.disqualified);
    const disqualified = matchedResults.filter(r => r.disqualified);
    const unmatched  = allTeams.length - matchedResults.length;

    // Sort by placement for display
    const sorted = [...matchedResults].sort((a, b) => a.placement - b.placement);
    const medals = ['🥇', '🥈', '🥉'];

    const rows = sorted.map((r, i) => {
      const medal = medals[r.placement - 1] || `#${r.placement}`;
      const dq    = r.disqualified ? ' *(< 2 players — 0 kills)*' : '';
        const sub = r.match_count < r.player_count ? ` *(${r.match_count}/${r.player_count} tag match)*` : '';
      return `${medal} **[${r.matched_tag}]** ${r.team_name} — ${r.kills} kills${dq}${sub}`;
    }).join('\n');

    const embed = new (require('discord.js').EmbedBuilder)()
      .setColor(disqualified.length > 0 ? 0xFFAA00 : 0x00FF7F)
      .setTitle(`✅ Lobby ${lobbyLetter} — Match ${matchNumber} Written`)
      .setDescription(rows || 'No results.')
      .addFields(
        { name: '📊 Teams written',   value: `${matchedResults.length}`, inline: true },
        { name: '⚠️ Disqualified',    value: `${disqualified.length} (< 2 players)`, inline: true },
        { name: '❓ Unmatched (OCR)', value: `${unmatched}`, inline: true },
      )
      .setFooter({ text: `Sheet updated · ${new Date().toLocaleTimeString()}` })
      .setTimestamp();

    await processingMsg.edit({ content: '', embeds: [embed] });

    // Log for debugging
    console.log(`[matchResult] Lobby ${lobbyLetter} Match ${matchNumber}: wrote ${matchedResults.length} teams, ${disqualified.length} DQ'd`);

  } catch (err) {
    console.error('[matchResult] Error:', err);
    await processingMsg.edit({
      content: '',
      embeds: [
        new (require('discord.js').EmbedBuilder)()
          .setColor(0xFF4444)
          .setTitle('❌ Match Result Failed')
          .setDescription(err.message || 'Unknown error')
          .setTimestamp(),
      ],
    });
  }
}

module.exports = { handleMatchResultMessage };
