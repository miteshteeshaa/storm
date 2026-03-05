const { google } = require('googleapis');

function getAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function getSheets(spreadsheetId) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return res.data.sheets.map(s => s.properties.title);
}

async function ensureSheetExists(spreadsheetId, sheetName) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const existing = await getSheets(spreadsheetId);
  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    });
  }
}

async function writeRegistrationSheet(spreadsheetId, teams, client) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(spreadsheetId, 'Registration');

  const headers = [['Slot', 'Team Name', 'Tag', 'Captain', 'Discord ID', 'Lobby', 'Kills', 'Placement', 'Total Points']];

  // FIX: Resolve captain display name from Discord ID
  const rows = await Promise.all(teams.map(async (t, i) => {
    let captainName = t.captain_name || t.captain_id; // fallback to ID if name not stored
    // If we have a client and captain_id, try to get username
    if (client && t.captain_id) {
      try {
        const user = await client.users.fetch(t.captain_id);
        captainName = user.displayName || user.username || t.captain_id;
      } catch {
        captainName = t.captain_id;
      }
    }
    return [
      i + 1,
      t.team_name,
      t.team_tag || '',
      captainName,
      t.captain_id,
      t.lobby || '',
      '',
      '',
      ''
    ];
  }));

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Registration!A1:Z1000'
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Registration!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [...headers, ...rows] }
  });
}

// FIX: readLobbyResults now accepts lobby LETTER (A, B, C...) not a number
async function readLobbyResults(spreadsheetId, lobbyLetter) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Registration!A1:I1000'
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header   = rows[0];
  const slotIdx  = header.indexOf('Slot');
  const nameIdx  = header.indexOf('Team Name');
  const lobbyIdx = header.indexOf('Lobby');
  const killsIdx = header.indexOf('Kills');
  const placIdx  = header.indexOf('Placement');

  // FIX: Compare with lobby letter (e.g. 'A', 'B') not lobby number
  return rows.slice(1)
    .filter(r => r[lobbyIdx] && r[lobbyIdx].toString().trim().toUpperCase() === lobbyLetter.toString().trim().toUpperCase())
    .map(r => ({
      slot:      r[slotIdx],
      team_name: r[nameIdx],
      lobby:     r[lobbyIdx],
      kills:     parseInt(r[killsIdx]) || 0,
      placement: parseInt(r[placIdx])  || 0,
    }));
}

async function writeLeaderboard(spreadsheetId, leaderboard) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(spreadsheetId, 'Leaderboard');

  const matchCount   = Math.max(...leaderboard.map(t => t.matches.length), 0);
  const matchHeaders = Array.from({ length: matchCount }, (_, i) => `Match ${i + 1}`);
  const headers      = [['Rank', 'Team Name', ...matchHeaders, 'Total Points']];

  const rows = leaderboard.map((t, i) => [
    i + 1,
    t.team_name,
    ...t.matches,
    t.total
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Leaderboard!A1:Z1000'
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Leaderboard!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [...headers, ...rows] }
  });
}

module.exports = {
  extractSheetId,
  writeRegistrationSheet,
  readLobbyResults,
  writeLeaderboard,
  ensureSheetExists
};
