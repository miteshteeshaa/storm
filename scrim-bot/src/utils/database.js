const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getFilePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Servers ────────────────────────────────────────────────────────────────
function getServer(guildId) {
  const db = readDB('servers');
  return db[guildId] || null;
}

function setServer(guildId, data) {
  const db = readDB('servers');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('servers', db);
  return db[guildId];
}

// ─── Config ─────────────────────────────────────────────────────────────────
function getConfig(guildId) {
  const db = readDB('configs');
  return db[guildId] || {};
}

function setConfig(guildId, data) {
  const db = readDB('configs');
  db[guildId] = { ...db[guildId], ...data };
  writeDB('configs', db);
  return db[guildId];
}

// ─── Registrations ───────────────────────────────────────────────────────────
function getRegistrations(guildId) {
  const db = readDB('registrations');
  return db[guildId] || { slots: [], waitlist: [] };
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

// ─── Matches ─────────────────────────────────────────────────────────────────
function getMatches(guildId) {
  const db = readDB('matches');
  return db[guildId] || {};
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
  getRegistrations, setRegistrations, clearRegistrations,
  getMatches, setMatch, clearMatches
};
