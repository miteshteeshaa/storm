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

function getServer(guildId) { return readDB('servers')[guildId] || null; }
function setServer(guildId, data) {
  const db = readDB('servers');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('servers', db);
  return db[guildId];
}

function getConfig(guildId) { return readDB('configs')[guildId] || {}; }
function setConfig(guildId, data) {
  const db = readDB('configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('configs', db);
  return db[guildId];
}

function getScrimSettings(guildId) {
  // slots_per_lobby: slots per lobby (default 24)
  // slots: kept for legacy but slots_per_lobby takes priority in display
  const defaults = { scrim_name: 'SCRIM', lobbies: 4, slots_per_lobby: 24, slots: 96, first_slot: 1 };
  return { ...defaults, ...(readDB('scrim_settings')[guildId] || {}) };
}
function setScrimSettings(guildId, data) {
  const db = readDB('scrim_settings');
  db[guildId] = { ...db[guildId], ...data };
  // Keep slots in sync with slots_per_lobby * lobbies for legacy compatibility
  const updated = db[guildId];
  if (data.slots_per_lobby || data.lobbies) {
    updated.slots = (updated.slots_per_lobby || 24) * (updated.lobbies || 4);
  }
  writeDB('scrim_settings', db);
  return updated;
}

function getLobbyConfig(guildId) { return readDB('lobby_configs')[guildId] || {}; }
function setLobbyConfig(guildId, data) {
  const db = readDB('lobby_configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('lobby_configs', db);
  return db[guildId];
}

function getRegistrations(guildId) { return readDB('registrations')[guildId] || { slots: [], waitlist: [] }; }
function setRegistrations(guildId, data) {
  const db = readDB('registrations');
  db[guildId] = data;
  writeDB('registrations', db);
}
function clearRegistrations(guildId) {
  const db = readDB('registrations');
  db[guildId] = { slots: [], waitlist: [] };
  writeDB('registrations', db);
}

function getMatches(guildId) { return readDB('matches')[guildId] || {}; }
function setMatch(guildId, lobbyId, data) {
  const db = readDB('matches');
  if (!db[guildId]) db[guildId] = {};
  db[guildId][lobbyId] = data;
  writeDB('matches', db);
}
function clearMatches(guildId) {
  const db = readDB('matches');
  db[guildId] = {};
  writeDB('matches', db);
}

function getConfirmSessions(guildId) { return readDB('confirm_sessions')[guildId] || []; }
function setConfirmSessions(guildId, sessions) {
  const db = readDB('confirm_sessions');
  db[guildId] = sessions;
  writeDB('confirm_sessions', db);
}

function getSlotListIds(guildId) { return readDB('slot_list_ids')[guildId] || {}; }
function setSlotListIds(guildId, data) {
  const db = readDB('slot_list_ids');
  db[guildId] = { ...(db[guildId] || {}), ...data };
  writeDB('slot_list_ids', db);
}

function getTeamCards(guildId) { return readDB('team_cards')[guildId] || {}; }
function setTeamCard(guildId, messageId, teamIndex) {
  const db = readDB('team_cards');
  if (!db[guildId]) db[guildId] = {};
  db[guildId][messageId] = teamIndex;
  writeDB('team_cards', db);
}

module.exports = {
  getServer, setServer,
  getConfig, setConfig,
  getScrimSettings, setScrimSettings,
  getLobbyConfig, setLobbyConfig,
  getRegistrations, setRegistrations, clearRegistrations,
  getMatches, setMatch, clearMatches,
  getConfirmSessions, setConfirmSessions,
  getSlotListIds, setSlotListIds,
  getTeamCards, setTeamCard,
};
