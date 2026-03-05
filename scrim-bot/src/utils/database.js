const fs = require('fs');
const path = require('path');

// Railway Volume mounts at /data by default.
// If no volume is attached, falls back to local ./data folder.
// To add a volume in Railway: Service → Volumes → Add Volume → Mount Path: /data
const DATA_DIR = process.env.DATA_DIR || '/data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Data directory created at: ${DATA_DIR}`);
  } catch (err) {
    // If /data isn't writable (no volume), fall back to local
    const fallback = path.join(__dirname, '../../data');
    fs.mkdirSync(fallback, { recursive: true });
    console.warn(`⚠️  Could not use ${DATA_DIR}, falling back to ${fallback}`);
    console.warn('   Add a Railway Volume at /data to persist data across deploys!');
    module.exports._dataDir = fallback;
  }
}

function getDataDir() {
  // Check if /data is writable
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
  // Write to a temp file first, then rename — prevents corruption on crash
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
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
