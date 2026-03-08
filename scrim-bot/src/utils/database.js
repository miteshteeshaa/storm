const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch { fs.mkdirSync(path.join(__dirname, '../../data'), { recursive: true }); }
}

function getDataDir() {
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return DATA_DIR; }
  catch { return path.join(__dirname, '../../data'); }
}

function getFilePath(name) { return path.join(getDataDir(), `${name}.json`); }

function readDB(name) {
  const p = getFilePath(name);
  if (!fs.existsSync(p)) { fs.writeFileSync(p, '{}', 'utf8'); return {}; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeDB(name, data) {
  const p = getFilePath(name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(p + '.tmp', p);
}

// ── Session key helper ────────────────────────────────────────────────────────
// Sessions are stored under guildId keys scoped by sessionId suffix.
// sessionId is a short slug like 'afternoon', 'evening', 'morning'.
// Global (non-session) data uses plain guildId keys.

const MAX_SESSIONS = 3;

function sessionKey(guildId, sessionId) { return `${guildId}:${sessionId}`; }

// ── Global server state (shared) ──────────────────────────────────────────────
function getServer(guildId) { return readDB('servers')[guildId] || null; }
function setServer(guildId, data) {
  const db = readDB('servers');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('servers', db);
  return db[guildId];
}

// ── Global config (shared: admin_role, registered_role, waitlist_role, registration_role) ──
function getConfig(guildId) { return readDB('configs')[guildId] || {}; }
function setConfig(guildId, data) {
  const db = readDB('configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('configs', db);
  return db[guildId];
}

// ── Session registry — list of { id, name } per guild ────────────────────────
function getSessions(guildId) { return readDB('sessions')[guildId] || []; }
function setSessions(guildId, sessions) {
  const db = readDB('sessions');
  db[guildId] = sessions;
  writeDB('sessions', db);
}
function getSession(guildId, sessionId) {
  return getSessions(guildId).find(s => s.id === sessionId) || null;
}
function upsertSession(guildId, sessionId, name) {
  const sessions = getSessions(guildId);
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) sessions[idx].name = name;
  else sessions.push({ id: sessionId, name });
  setSessions(guildId, sessions);
}
function deleteSession(guildId, sessionId) {
  const sessions = getSessions(guildId).filter(s => s.id !== sessionId);
  setSessions(guildId, sessions);
}

// ── Resolve sessionId from a channel ID ──────────────────────────────────────
// Looks through all sessions' register_channel to find which session owns the channel
function getSessionByChannel(guildId, channelId) {
  const sessions = getSessions(guildId);
  for (const s of sessions) {
    const cfg = getSessionConfig(guildId, s.id);
    if (cfg.register_channel === channelId) return s.id;
  }
  return null;
}

// ── Per-session config (register_channel, slotlist_channel, sheet_url, spreadsheet_id) ──
function getSessionConfig(guildId, sessionId) { return readDB('session_configs')[sessionKey(guildId, sessionId)] || {}; }
function setSessionConfig(guildId, sessionId, data) {
  const db  = readDB('session_configs');
  const key = sessionKey(guildId, sessionId);
  db[key]   = { ...db[key], ...data };
  writeDB('session_configs', db);
  return db[key];
}

// ── Per-session server state (registration_open) ─────────────────────────────
function getSessionServer(guildId, sessionId) { return readDB('session_servers')[sessionKey(guildId, sessionId)] || null; }
function setSessionServer(guildId, sessionId, data) {
  const db  = readDB('session_servers');
  const key = sessionKey(guildId, sessionId);
  db[key]   = { ...db[key], ...data };
  writeDB('session_servers', db);
  return db[key];
}

// ── Per-session scrim settings ────────────────────────────────────────────────
function getScrimSettings(guildId, sessionId) {
  const defaults = { scrim_name: 'SCRIM', lobbies: 4, slots_per_lobby: 24, slots: 96, first_slot: 1 };
  if (sessionId) {
    return { ...defaults, ...(readDB('session_scrim_settings')[sessionKey(guildId, sessionId)] || {}) };
  }
  // Legacy fallback (no session)
  return { ...defaults, ...(readDB('scrim_settings')[guildId] || {}) };
}
function setScrimSettings(guildId, data, sessionId) {
  if (sessionId) {
    const db  = readDB('session_scrim_settings');
    const key = sessionKey(guildId, sessionId);
    db[key]   = { ...db[key], ...data };
    const updated = db[key];
    if (data.slots_per_lobby || data.lobbies) {
      updated.slots = (updated.slots_per_lobby || 24) * (updated.lobbies || 4);
    }
    writeDB('session_scrim_settings', db);
    return updated;
  }
  // Legacy fallback
  const db = readDB('scrim_settings');
  db[guildId] = { ...db[guildId], ...data };
  const updated = db[guildId];
  if (data.slots_per_lobby || data.lobbies) {
    updated.slots = (updated.slots_per_lobby || 24) * (updated.lobbies || 4);
  }
  writeDB('scrim_settings', db);
  return updated;
}

// ── Per-session lobby config ──────────────────────────────────────────────────
function getLobbyConfig(guildId, sessionId) {
  if (sessionId) return readDB('session_lobby_configs')[sessionKey(guildId, sessionId)] || {};
  return readDB('lobby_configs')[guildId] || {};
}
function setLobbyConfig(guildId, data, sessionId) {
  if (sessionId) {
    const db  = readDB('session_lobby_configs');
    const key = sessionKey(guildId, sessionId);
    db[key]   = { ...db[key], ...data };
    writeDB('session_lobby_configs', db);
    return db[key];
  }
  const db = readDB('lobby_configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('lobby_configs', db);
  return db[guildId];
}

// ── Per-session registrations ─────────────────────────────────────────────────
function getRegistrations(guildId, sessionId) {
  if (sessionId) return readDB('session_registrations')[sessionKey(guildId, sessionId)] || { slots: [], waitlist: [] };
  return readDB('registrations')[guildId] || { slots: [], waitlist: [] };
}
function setRegistrations(guildId, data, sessionId) {
  if (sessionId) {
    const db  = readDB('session_registrations');
    db[sessionKey(guildId, sessionId)] = data;
    writeDB('session_registrations', db);
    return;
  }
  const db = readDB('registrations');
  db[guildId] = data;
  writeDB('registrations', db);
}
function clearRegistrations(guildId, sessionId) {
  if (sessionId) {
    const db  = readDB('session_registrations');
    db[sessionKey(guildId, sessionId)] = { slots: [], waitlist: [] };
    writeDB('session_registrations', db);
    return;
  }
  const db = readDB('registrations');
  db[guildId] = { slots: [], waitlist: [] };
  writeDB('registrations', db);
}

// ── Per-session matches ───────────────────────────────────────────────────────
function getMatches(guildId, sessionId) {
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  return readDB('matches')[key] || {};
}
function setMatch(guildId, lobbyId, data, sessionId) {
  const db  = readDB('matches');
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  if (!db[key]) db[key] = {};
  db[key][lobbyId] = data;
  writeDB('matches', db);
}
function clearMatches(guildId, sessionId) {
  const db  = readDB('matches');
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  db[key]   = {};
  writeDB('matches', db);
}

// ── Per-session confirm sessions ──────────────────────────────────────────────
function getConfirmSessions(guildId, sessionId) {
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  return readDB('confirm_sessions')[key] || [];
}
function setConfirmSessions(guildId, sessions, sessionId) {
  const db  = readDB('confirm_sessions');
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  db[key]   = sessions;
  writeDB('confirm_sessions', db);
}

// ── Per-session slot list message IDs ────────────────────────────────────────
function getSlotListIds(guildId, sessionId) {
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  return readDB('slot_list_ids')[key] || {};
}
function setSlotListIds(guildId, data, sessionId) {
  const db  = readDB('slot_list_ids');
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  db[key]   = { ...(db[key] || {}), ...data };
  writeDB('slot_list_ids', db);
}

// ── Per-session team cards ────────────────────────────────────────────────────
function getTeamCards(guildId, sessionId) {
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  return readDB('team_cards')[key] || {};
}
function setTeamCard(guildId, messageId, teamIndex, sessionId) {
  const db  = readDB('team_cards');
  const key = sessionId ? sessionKey(guildId, sessionId) : guildId;
  if (!db[key]) db[key] = {};
  db[key][messageId] = teamIndex;
  writeDB('team_cards', db);
}
// Lookup which session a team card message belongs to
function getTeamCardSession(guildId, messageId) {
  const sessions = getSessions(guildId);
  for (const s of sessions) {
    const cards = getTeamCards(guildId, s.id);
    if (cards[messageId] !== undefined) return { sessionId: s.id, teamIndex: cards[messageId] };
  }
  // Legacy fallback
  const legacy = readDB('team_cards')[guildId] || {};
  if (legacy[messageId] !== undefined) return { sessionId: null, teamIndex: legacy[messageId] };
  return null;
}

module.exports = {
  MAX_SESSIONS,
  getServer, setServer,
  getConfig, setConfig,
  // Session management
  getSessions, setSessions, getSession, upsertSession, deleteSession,
  getSessionByChannel,
  getSessionConfig, setSessionConfig,
  getSessionServer, setSessionServer,
  // Per-session (pass sessionId as last arg; omit for legacy single-session)
  getScrimSettings, setScrimSettings,
  getLobbyConfig, setLobbyConfig,
  getRegistrations, setRegistrations, clearRegistrations,
  getMatches, setMatch, clearMatches,
  getConfirmSessions, setConfirmSessions,
  getSlotListIds, setSlotListIds,
  getTeamCards, setTeamCard, getTeamCardSession,
};
