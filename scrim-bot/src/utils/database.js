const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    const fallback = path.join(__dirname, '../../data');
    fs.mkdirSync(fallback, { recursive: true });
  }
}

function getDataDir() {
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return DATA_DIR;
  } catch {
    return path.join(__dirname, '../../data');
  }
}

function getFilePath(name) {
  return path.join(getDataDir(), `${name}.json`);
}

function readDB(name) {
  const filePath = getFilePath(name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({}), 'utf8');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeDB(name, data) {
  const filePath = getFilePath(name);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ── Servers ───────────────────────────────────────────────────────────────────
function getServer(guildId) {
  return readDB('servers')[guildId] || null;
}
function setServer(guildId, data) {
  const db = readDB('servers');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('servers', db);
  return db[guildId];
}

// ── Config (channels, roles, sheet) ──────────────────────────────────────────
function getConfig(guildId) {
  return readDB('configs')[guildId] || {};
}
function setConfig(guildId, data) {
  const db = readDB('configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('configs', db);
  return db[guildId];
}

// ── Scrim settings (name, lobbies, slots, first_slot, etc) ───────────────────
function getScrimSettings(guildId) {
  const defaults = {
    scrim_name:  'SCRIM',
    lobbies:     4,
    slots:       16,
    first_slot:  1,
  };
  const db = readDB('scrim_settings');
  return { ...defaults, ...(db[guildId] || {}) };
}
function setScrimSettings(guildId, data) {
  const db = readDB('scrim_settings');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('scrim_settings', db);
  return db[guildId];
}

// ── Registrations ─────────────────────────────────────────────────────────────
function getRegistrations(guildId) {
  return readDB('registrations')[guildId] || { slots: [], waitlist: [] };
}
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

// ── Matches ───────────────────────────────────────────────────────────────────
function getMatches(guildId) {
  return readDB('matches')[guildId] || {};
}
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

module.exports = {
  getServer, setServer,
  getConfig, setConfig,
  getScrimSettings, setScrimSettings,
  getRegistrations, setRegistrations, clearRegistrations,
  getMatches, setMatch, clearMatches,
};
