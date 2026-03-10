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


function parseOCRText(rawText, registeredTags = []) {
  // Normalize common OCR misreads + OCR symbol artifacts
  const normalized = rawText
    // ── Step 1: Normalize "N eliminations" variants before any other transforms ──
    // French: "2 éliminations" → "2 eliminations", "Délimination" → "0 eliminations"
    .replace(/(\d+)\s*[eé]liminations?/gi, '$1 eliminations')  // "2 éliminations" / "1élimination"
    .replace(/[DdOo][eéaà][lL]?[iI]?[mM]inations?/gi, '0 eliminations')  // Délimination, Dalimination, Deliminations
    // Strip Arabic/CJK-only lines (appear as player names on some screens)
    .replace(/^[\u0600-\u06FF\u0750-\u077F\u4E00-\u9FFF\u3040-\u30FF]+[\s\u0600-\u06FF\u0750-\u077F\u4E00-\u9FFF\u3040-\u30FF]*$/gm, '')
    // Standard kill-count normalizations (handle I/O misreads before and after accent strip)
    .replace(/\bO\b(?=\s+[eé]liminations?)/gi, '0')
    .replace(/\bI\b(?=\s+[eé]liminations?)/g,  '1')
    // Re-apply number élimination after I/O substitution
    .replace(/(\d+)\s*[eé]liminations?/gi, '$1 eliminations')
    .replace(/\b(\d)\s*elim\b/gi, '$1 eliminations')
    // Partial OCR misreads like "3 R" where "eliminations" became a single letter
    .replace(/^(\d)\s+[A-Z]$/gm, '$1 eliminations')
    // Strip score glued to kills line: "2 eliminations 15" → "2 eliminations"
    .replace(/(\d+\s+eliminations?)\s+\d+\s*$/gi, '$1')
    // Normalize arrow/dash separators OCR reads between tag and name
    .replace(/([A-Za-z0-9])[→—–]([A-Za-z])/g, '$1$2');

  const lines = normalized
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const teams  = [];
  let current  = null;

  const elimRe      = /^(.+?)\s+(\d+)\s+eliminations?$/i;
  const killsOnlyRe = /^(\d+)\s+eliminations?$/i;
  const placeRe     = /^(\d{1,2})$/;
  const noiseRe     = /^(PUBG|MOBILE|Continuer?|CONTINUE)$/i;
  const junkRe      = /^(SQUAD|SOLO|DUO|TEAM|LOBBY|MATCH|RESULT)/i;
  const scoreRe     = /^\d{3,}$/; // 3+ digit numbers (190, 200, 210) are scores not placements

  // Track which placements we've already seen to avoid duplicates
  const seenPlacements = new Set();

  // Helper: flush current team
  function flushTeam() {
    if (!current) return;
    const { placement, names, kills } = current;
    const players = [];
    const count = Math.max(names.length, kills.length);
    for (let i = 0; i < count; i++) {
      const name = names[i];
      const k    = kills[i] ?? 0;
      if (name && name.length >= 2 && !junkRe.test(name)) {
        players.push({ name, kills: k });
      }
    }
    if (players.length > 0) teams.push({ placement, players });
    current = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (noiseRe.test(line)) continue;

    // Skip 3+ digit score numbers (190, 200, 210 etc.)
    if (scoreRe.test(line)) continue;

    // Check if line is a bare placement number (1-25)
    const placeMatch = placeRe.exec(line);
    if (placeMatch) {
      const p = parseInt(placeMatch[1]);
      if (p >= 1 && p <= 25 && !seenPlacements.has(p)) {
        // Look ahead: is the next non-empty line a player name (not kills-only or another number)?
        // This confirms this number is a placement, not a stray number mid-team.
        // If the immediate next line is a score (190, 200, 210), peek one more line —
        // scores sometimes appear between a placement number and the first player name.
        const remainingLines = lines.slice(i + 1).filter(l => l.trim().length > 0);
        let nextLine = remainingLines[0];
        // If next line is a score, skip it and check the line after
        if (nextLine && scoreRe.test(nextLine)) {
          nextLine = remainingLines[1];
        }
        const nextIsKillsOnly = nextLine && killsOnlyRe.test(nextLine);
        const nextIsPlacement = nextLine && placeRe.test(nextLine) &&
          parseInt(nextLine) >= 1 && parseInt(nextLine) <= 25;

        if (!nextIsKillsOnly && !nextIsPlacement) {
          flushTeam();
          seenPlacements.add(p);
          current = { placement: p, names: [], kills: [] };
          continue;
        }
      }
      // Not a valid placement — skip this bare number
      continue;
    }

    // "9 TB HAIDER" — placement number glued to player name on same line
    const gluedPlaceRe = /^(\d{1,2})\s+(.+)$/;
    const gluedMatch = gluedPlaceRe.exec(line);
    if (gluedMatch) {
      const p = parseInt(gluedMatch[1]);
      const rest = gluedMatch[2].trim();
      if (p >= 1 && p <= 25 && !seenPlacements.has(p) &&
          !/^\d+$/.test(rest) && !killsOnlyRe.test(line)) {
        flushTeam();
        seenPlacements.add(p);
        current = { placement: p, names: [rest], kills: [] };
        continue;
      }
      // Fall through to name handling
    }

    // If no team started yet and this looks like a player name, it's placement 1 (champion panel)
    if (!current) {
      if (line.length >= 2 && !/^\d+$/.test(line) && !junkRe.test(line)) {
        seenPlacements.add(1);
        current = { placement: 1, names: [], kills: [] };
        // Fall through to process this line as a player name below
      } else {
        continue;
      }
    }

    // Full "name N eliminations" on one line
    const elimMatch = elimRe.exec(line);
    if (elimMatch) {
      const playerName = elimMatch[1].trim();
      if (!junkRe.test(playerName) && playerName.length >= 2) {
        current.names.push(playerName);
        current.kills.push(parseInt(elimMatch[2]));
      }
      continue;
    }

    // Kills-only line
    const killsOnly = killsOnlyRe.exec(line);
    if (killsOnly) {
      current.kills.push(parseInt(killsOnly[1]));
      continue;
    }

    // Junk UI label
    if (junkRe.test(line)) continue;

    // Anything else that looks like a name
    if (line.length >= 2 && !/^\d+$/.test(line)) {
      current.names.push(line);
    }
  }
  flushTeam();

  // ── Tag-based re-splitting of bloated segments ───────────────────────────────
  // PUBG Mobile results screen has TWO COLUMNS side by side. Google Vision reads
  // row-by-row, so players from two different teams get INTERLEAVED into one segment:
  //   rgeEKLAVYAA  |  vpeSPRYZEN   → both land in same placement group
  //   rge LAKSH    |  vpeDADA      → same group
  // Fix: for any segment with 5+ players, use registered tags to assign each player
  // to a tag cluster, then emit a separate team for each cluster with 2+ members.

  function playerMatchesTag(playerName, tag) {
    // Case-insensitive, accent-stripped, tag can appear anywhere in the name.
    // Short tags (≤3 chars) must match at a word boundary to avoid false positives
    // e.g. tag "77" should NOT match "BEAST77", but "XEL" should match "XEL FATAL".
    const n = playerName.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^[il](?=\d)/, '1');
    const t = tag.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^[il](?=\d)/, '1');
    if (t.length <= 3) {
      // Must appear at start, end, or surrounded by non-alphanumeric chars
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      return re.test(n);
    }
    return n.includes(t);
  }

  const expandedTeams = [];
  for (const team of teams) {
    // Only try to split large groups (5+ players = likely 2 teams merged)
    if (team.players.length < 5 || registeredTags.length === 0) {
      expandedTeams.push(team);
      continue;
    }

    // Assign each player to the best matching registered tag
    const tagGroups = new Map(); // tag → players[]
    const unmatched = [];
    for (const p of team.players) {
      const matched = registeredTags.filter(t => playerMatchesTag(p.name, t));
      if (matched.length === 1) {
        if (!tagGroups.has(matched[0])) tagGroups.set(matched[0], []);
        tagGroups.get(matched[0]).push(p);
      } else if (matched.length > 1) {
        // Multiple tags match — pick longest (most specific)
        const best = matched.sort((a, b) => b.length - a.length)[0];
        if (!tagGroups.has(best)) tagGroups.set(best, []);
        tagGroups.get(best).push(p);
      } else {
        unmatched.push(p);
      }
    }

    const validGroups = [...tagGroups.entries()].filter(([, ps]) => ps.length >= 2);

    if (validGroups.length <= 1) {
      // Can't meaningfully split — keep as-is
      expandedTeams.push(team);
      continue;
    }

    // Sort groups by order of first appearance in original player list
    const playerOrder = team.players.map(p => {
      for (const t of registeredTags) {
        if (playerMatchesTag(p.name, t) && tagGroups.get(t)?.length >= 2) return t;
      }
      return null;
    });
    const firstSeen = new Map();
    for (const t of playerOrder) {
      if (t && !firstSeen.has(t)) firstSeen.set(t, firstSeen.size);
    }
    validGroups.sort(([a], [b]) => (firstSeen.get(a) ?? 99) - (firstSeen.get(b) ?? 99));

    for (let ci = 0; ci < validGroups.length; ci++) {
      const [, ps] = validGroups[ci];
      expandedTeams.push({ placement: ci === 0 ? team.placement : null, players: ps });
    }

    // Orphan players: append to whichever valid group has the closest tag
    if (unmatched.length > 0 && validGroups.length > 0) {
      const lastTeam = expandedTeams[expandedTeams.length - 1];
      for (const p of unmatched) lastTeam.players.push(p);
    }
  }

  // Replace teams with expanded version
  teams.length = 0;
  teams.push(...expandedTeams);

  // ── Cross-team player deduplication ──────────────────────────────────────────
  // PUBG Mobile shows a persistent "winner panel" on every scroll page, so
  // placement-1 players appear in EVERY page's OCR — they get appended to
  // whichever team group is last on each page, creating bloated groups.
  //
  // Fix: when the same player name appears in multiple placement groups,
  // keep them only in the group where they share the most prefix-mates.
  // Ties broken by lowest placement (earliest = most likely correct assignment).

  const nameToTeamIdx = new Map();
  for (let ti = 0; ti < teams.length; ti++) {
    for (const p of teams[ti].players) {
      const key = p.name.toLowerCase().trim();
      if (!nameToTeamIdx.has(key)) nameToTeamIdx.set(key, []);
      nameToTeamIdx.get(key).push(ti);
    }
  }

  const playerHomeTeam = new Map();
  for (const [name, idxList] of nameToTeamIdx) {
    if (idxList.length === 1) { playerHomeTeam.set(name, idxList[0]); continue; }
    const prefix3 = name.slice(0, 3);
    let bestIdx = idxList[0], bestScore = -1;
    for (const ti of idxList) {
      const score = teams[ti].players.filter(p => p.name.toLowerCase().startsWith(prefix3)).length;
      if (score > bestScore || (score === bestScore && teams[ti].placement < teams[bestIdx].placement)) {
        bestScore = score; bestIdx = ti;
      }
    }
    playerHomeTeam.set(name, bestIdx);
  }

  const dedupedTeams = teams.map((team, ti) => ({
    placement: team.placement,
    players: team.players.filter(p => playerHomeTeam.get(p.name.toLowerCase().trim()) === ti),
  })).filter(t => t.players.length > 0);

  return dedupedTeams;
}


// ── Tag detection: majority vote ─────────────────────────────────────────────
// For each registered tag, count how many players in this group have a name
// that starts with that tag (case-insensitive).
// The tag with the most matching players wins, as long as >= 2 players match it.
// This handles stand-ins or players with differently-prefixed names.

function tagMatchesName(playerName, tag) {
  // Shared tag-matching: case-insensitive, accent-stripped.
  // Short tags (≤3 chars) require either:
  //   - match at the start or end of the name (glued prefix/suffix like "rgeEKLAVYAA", "DEKU-TGB")
  //   - OR surrounded by non-alphanumeric chars (standalone like "77 KING")
  // This prevents "77" matching "BEAST77" while still matching "rge" in "rgeEKLAVYAA".
  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^[il](?=\d)/, '1');
  }
  const n = norm(playerName);
  const t = norm(tag);
  if (t.length <= 3) {
    // Allow at start or end of string (glued tag), or surrounded by non-alphanumeric
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Tag at the very start of name = prefix tag (rgeEKLAVYAA, SRMASTER, vpeSPRYZEN)
    if (n.startsWith(t)) return true;
    // Tag elsewhere must be surrounded by non-alphanumeric on both sides (DEKU-TGB, XKS SPIRIT, 77 KING)
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    return re.test(n);
  }
  return n.includes(t);
}

function detectTagByMajority(players, registeredSlots) {
  // Normalize OCR misreads
  function normalizeOCR(str) {
    return str.toLowerCase()
      .replace(/^[il](?=\d)/, '1')           // "Itke" → "1tke"
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents: "aès" → "aes"
  }

  const names = players.map(p => normalizeOCR(p.name));

  let bestTag   = null;
  let bestSlot  = null;
  let bestCount = 0;

  for (const slot of registeredSlots) {
    if (!slot.lobby || !slot.team_tag) continue;
    const tag   = slot.team_tag.toLowerCase();
    const count = names.filter(n => tagMatchesName(n, tag)).length;
    // Need at least 1 matching player, and must beat current best
    if (count >= 1 && count > bestCount) {
      bestCount = count;
      bestTag   = tag;
      bestSlot  = slot;
    }
  }

  return { slot: bestSlot, matchCount: bestCount, tag: bestTag };
}

// ── Match OCR teams → registered slots ──────────────────────────────────────────────
// For each OCR team, use majority vote across all registered tags to find
// the best matching team. Returns:
// [{ lobby_slot, placement, kills, matched_tag, team_name,
//    player_count, match_count, disqualified }]

function matchTeamsToSlots(ocrTeams, registeredSlots, rawText = '') {
  const results   = [];
  const usedSlots = new Set(); // prevent same slot being written twice

  // ── Pass 1: match OCR segments → registered slots ────────────────────────
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
      rescued:      false,
    });
  }

  // ── Pass 2: rescue unmatched registered teams from raw OCR text ───────────
  // Every registered team was in the match. If segment parsing missed them
  // (bad boundary detection, interleaving, etc.) we scan the raw OCR lines
  // directly for any line that contains their tag, collect kills, and write
  // them with placement=0 (unknown) so the sheet still gets their kill data.
  if (rawText) {
    const elimRe  = /^(.+?)\s+(\d+)\s+eliminations?$/i;
    const killsRe = /^(\d+)\s+eliminations?$/i;

    function normalizeOCR(str) {
      return str.toLowerCase()
        .replace(/^[il](?=\d)/, '1')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    // Build a deduplicated map of playerName → kills from the raw text
    // (handles duplicate OCR pages — same player appears on multiple scroll pages)
    const allPlayersMap = new Map(); // normalizedName → { name, kills }
    for (const line of lines) {
      const em = elimRe.exec(line);
      if (em) {
        const key = normalizeOCR(em[1].trim());
        if (!allPlayersMap.has(key)) {
          allPlayersMap.set(key, { name: em[1].trim(), kills: parseInt(em[2]) });
        }
      }
    }

    for (const slot of registeredSlots) {
      if (!slot.team_tag || usedSlots.has(slot.lobby_slot)) continue;

      const tag = normalizeOCR(slot.team_tag);

      // Find all players in raw OCR whose name contains this tag (prefix or suffix)
      const tagPlayers = [...allPlayersMap.values()].filter(p =>
        tagMatchesName(p.name, tag)
      );

      if (tagPlayers.length === 0) continue; // truly not found in OCR at all

      const totalKills  = tagPlayers.reduce((s, p) => s + p.kills, 0);
      const playerCount = tagPlayers.length;

      // Try to find which OCR segment these players came from to recover placement
      // If this team was identified as the champion, force placement 1
      let recoveredPlacement = null;
      const championEntry = ocrTeams.find(t => t._championTag &&
        normalizeOCR(t._championTag) === tag);
      if (championEntry) {
        recoveredPlacement = 1;
      } else {
        for (const ocrTeam of ocrTeams) {
          const found = ocrTeam.players.some(p =>
            normalizeOCR(p.name).includes(tag)
          );
          if (found && ocrTeam.placement != null) {
            recoveredPlacement = ocrTeam.placement;
            break;
          }
        }
      }

      usedSlots.add(slot.lobby_slot);
      results.push({
        lobby_slot:   slot.lobby_slot,
        placement:    recoveredPlacement,
        kills:        playerCount >= 2 ? totalKills : 0,
        matched_tag:  slot.team_tag,
        team_name:    slot.team_name,
        player_count: playerCount,
        match_count:  tagPlayers.length,
        disqualified: playerCount < 2,
        rescued:      true, // flag: found via raw scan, not clean segment
      });
    }
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
    // 1. Download + OCR all images, keeping per-page text separate
    const ocrParts = await Promise.all(
      imageAttachments.map(async (att) => {
        const buf = await downloadImage(att.url);
        return await runVision(buf);
      })
    );
    const rawText = ocrParts.filter(Boolean).join('\n');
    if (!rawText) throw new Error('Vision API returned no text. Is the Vision API enabled in your Google Cloud project?');

    console.log(`[matchResult] Raw OCR text for ${lobbyLetter}${matchNumber}:\n${rawText}`);

    // 3. Get registered teams for this lobby (needed before parsing for tag-aware detection)
    const data       = getRegistrations(guildId, sessionId);
    const lobbySlots = data.slots.filter(t => t.lobby === lobbyLetter && t.lobby_slot);

    if (lobbySlots.length === 0) {
      throw new Error(`No teams are assigned to Lobby ${lobbyLetter}. Assign teams first using team card reactions.`);
    }

    console.log(`[matchResult] Lobby ${lobbyLetter}: ${lobbySlots.length} registered slots — tags: ${lobbySlots.map(s => s.team_tag).join(', ')}`);

    // 4. Parse OCR → teams (pass registered tags for smarter boundary detection)
    const registeredTags = lobbySlots
      .filter(s => s.team_tag)
      .map(s => s.team_tag.toLowerCase()
        .replace(/^[il](?=\d)/, '1')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const ocrTeams = parseOCRText(rawText, registeredTags);
    if (ocrTeams.length === 0) {
      throw new Error('Could not extract any team data from the screenshot. Make sure the image shows the full results screen.');
    }

    // 4b. Champion detection: the #1 team's players appear in the persistent left panel
    // on EVERY scroll page, so their tag shows up in more OCR pages than anyone else.
    // If no team was parsed as placement 1, find the registered tag that appears in
    // the most separate OCR pages and force it to placement 1.
    const hasPlacement1 = ocrTeams.some(t => t.placement === 1);
    if (!hasPlacement1 && ocrParts.length > 1) {
      function normTag(s) {
        return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^[il](?=\d)/, '1');
      }
      // Count how many pages each registered tag appears in
      const tagPageCount = new Map();
      for (const slot of lobbySlots) {
        if (!slot.team_tag) continue;
        const tag = normTag(slot.team_tag);
        let count = 0;
        for (const page of ocrParts) {
          if (!page) continue;
          if (tagMatchesName(page, tag)) count++;
        }
        tagPageCount.set(slot.team_tag, count);
      }
      // The tag appearing in the most pages is the champion
      const sorted = [...tagPageCount.entries()].sort((a, b) => b[1] - a[1]);
      const [championTag, pageCount] = sorted[0] || [];
      // Only apply if it appears in majority of pages (>= half) — avoids false positives
      if (championTag && pageCount >= Math.ceil(ocrParts.filter(Boolean).length / 2)) {
        console.log(`[matchResult] Champion detected via page-frequency: ${championTag} (${pageCount}/${ocrParts.filter(Boolean).length} pages)`);
        // If this team already exists in ocrTeams with wrong/null placement, fix it
        const existing = ocrTeams.find(t => {
          return t.players.some(p => normTag(p.name).includes(normTag(championTag)));
        });
        if (existing) {
          existing.placement = 1;
        } else {
          // Build a minimal entry so Pass 2 raw scan picks it up with placement 1
          ocrTeams.unshift({ placement: 1, players: [], _championTag: championTag });
        }
      }
    }

    // 5. Match OCR teams → registered slots (+ raw-text rescue pass)
    const matchedResults = matchTeamsToSlots(ocrTeams, lobbySlots, rawText);

    if (matchedResults.length === 0) {
      // Show what OCR found so admin can debug
      const ocrSummary = ocrTeams.slice(0, 8).map(t => {
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
    const matched       = matchedResults.filter(r => !r.disqualified);
    const disqualified  = matchedResults.filter(r => r.disqualified);
    const rescued       = matchedResults.filter(r => r.rescued);
    // Truly unmatched = registered slots with no OCR data at all
    const matchedSlots  = new Set(matchedResults.map(r => r.lobby_slot));
    const trulyUnmatched = lobbySlots.filter(s => !matchedSlots.has(s.lobby_slot));

    // Sort by placement for display (placement 0 = unknown, goes at end)
    const sorted = [...matchedResults].sort((a, b) => {
      if (a.placement == null && b.placement == null) return 0;
      if (a.placement == null) return 1;
      if (b.placement == null) return -1;
      return a.placement - b.placement;
    });
    const medals = ['🥇', '🥈', '🥉'];

    const rows = sorted.map((r) => {
      const placementStr = r.placement != null ? (medals[r.placement - 1] || `#${r.placement}`) : `#?`;
      const dq    = r.disqualified ? ' *(< 2 players — 0 kills)*' : '';
      const sub   = r.match_count < r.player_count ? ` *(${r.match_count}/${r.player_count} tag match)*` : '';
      const flag  = r.rescued ? ' ⚠️' : '';
      return `${placementStr} **[${r.matched_tag}]** ${r.team_name} — ${r.kills} kills${dq}${sub}${flag}`;
    }).join('\n');

    // List truly unmatched teams (not found in OCR at all)
    const unmatchedNote = trulyUnmatched.length > 0
      ? '\n\n**❌ Not found in OCR:**\n' + trulyUnmatched.map(s => `• [${s.team_tag}] ${s.team_name}`).join('\n')
      : '';

    const embed = new (require('discord.js').EmbedBuilder)()
      .setColor(trulyUnmatched.length > 0 ? 0xFF4444 : disqualified.length > 0 ? 0xFFAA00 : 0x00FF7F)
      .setTitle(`✅ Lobby ${lobbyLetter} — Match ${matchNumber} Written`)
      .setDescription((rows || 'No results.') + unmatchedNote)
      .addFields(
        { name: '📊 Teams written',        value: `${matchedResults.length}`, inline: true },
        { name: '⚠️ Rescued (raw scan)',   value: `${rescued.length}`,        inline: true },
        { name: '❌ Not found in OCR',     value: `${trulyUnmatched.length}`, inline: true },
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
