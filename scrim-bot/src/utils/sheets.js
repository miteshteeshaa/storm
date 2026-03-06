// ── Google Sheets utility ─────────────────────────────────────────────────────
// Uses Google Sheets API v4 with a Service Account (JWT auth)
// Required env vars: GOOGLE_SERVICE_EMAIL, GOOGLE_PRIVATE_KEY

const { google } = require('googleapis');

function getAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_EMAIL,
    null,
    privateKey,
    [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ]
  );
}

// ── Create a new sheet for a server, styled like the template ─────────────────
async function createServerSheet(scrimName, slotsPerLobby = 24) {
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // 1. Create spreadsheet
  const create = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `${scrimName} — SCRIM SHEET` },
      sheets: [{ properties: { title: 'Sheet1' } }],
    },
  });

  const spreadsheetId = create.data.spreadsheetId;
  const sheetId       = create.data.sheets[0].properties.sheetId;

  // 2. Make it publicly viewable (anyone with link can view)
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // 3. Build header + data rows
  const matchHeaders = [];
  for (let m = 1; m <= 15; m++) {
    matchHeaders.push(`${m}${ordinal(m)} Match`, '');
  }
  const subHeaders = [];
  for (let m = 0; m < 15; m++) subHeaders.push('Place', 'Kills');

  // Scoring table A1:B27
  const scoringRows = [
    ['SCORING SYSTEM', ''],
    ['1 kill', 1],
    ['1st', 10], ['2nd', 6], ['3rd', 5], ['4th', 4],
    ['5th', 3],  ['6th', 2], ['7th', 1], ['8th', 1],
    ['9th', 0],  ['10th', 0],['11th', 0],['12th', 0],
    ['13th', 0], ['14th', 0],['15th', 0],['16th', 0],
    ['17th', 0], ['18th', 0],['19th', 0],['20th', 0],
    ['21st', 0], ['22nd', 0],['23rd', 0],['24th', 0],
    ['25th', 0],
  ];

  // Row 1: headers — col A-B scoring, col D SLOT, col E TEAM NAME, col F TAG, col G+ match headers
  const row1 = ['SCORING SYSTEM', '', '', 'SLOT', 'TEAM NAME', 'TAG', ...matchHeaders];
  const row2 = ['1 kill', 1, '', 'Place', 'Kills', ...subHeaders]; // col A-B row2 repurposed

  // Actually build full value rows
  const valueRows = [row1, ['1 kill', 1, '', '', '', '', ...subHeaders]];

  // Slot rows 3..26 (slots 1..24)
  for (let s = 1; s <= slotsPerLobby; s++) {
    const scoring = scoringRows[s + 1] || ['', ''];
    const dash    = s === 1 || s >= 22 ? '-' : '';
    valueRows.push([scoring[0], scoring[1], '', s, dash, dash]);
  }

  // 4. Write all values
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: valueRows },
  });

  // 5. Formatting requests
  const fmt = [];

  // Merge A1:B1 "SCORING SYSTEM"
  fmt.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }, mergeType: 'MERGE_ALL' } });

  // Merge match header pairs in row 1 (G1:H1, I1:J1, ...)
  for (let m = 0; m < 15; m++) {
    const col = 6 + m * 2;
    fmt.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 2 }, mergeType: 'MERGE_ALL' } });
  }

  // Bold + background for header row
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Bold col headers row 2
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
    },
  });

  // Center align slot/team/tag cols
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: 2 + slotsPerLobby, startColumnIndex: 3, endColumnIndex: 6 },
      cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(horizontalAlignment)',
    },
  });

  // Freeze first 2 rows + first 4 columns
  fmt.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 2, frozenColumnCount: 4 } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fmt } });

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  return { spreadsheetId, url };
}

// ── Write team names into the sheet by slot number ────────────────────────────
// slots: array of { lobby_slot, team_name, team_tag }
async function syncTeamsToSheet(spreadsheetId, slots) {
  if (!spreadsheetId) return;
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Build a map: slot_number → { name, tag }
  const slotMap = {};
  for (const t of slots) {
    if (t.lobby_slot) slotMap[t.lobby_slot] = { name: t.team_name || '', tag: t.team_tag || '' };
  }

  // Read existing data to find max slots
  const maxSlot = Math.max(24, ...Object.keys(slotMap).map(Number));

  // Build update data for col E (Team Name) and col F (Tag) — rows 3 onward (index 2)
  const nameValues = [];
  const tagValues  = [];
  for (let s = 1; s <= maxSlot; s++) {
    const t = slotMap[s];
    nameValues.push([t ? t.name : '']);
    tagValues.push([t ? t.tag : '']);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `Sheet1!E3:E${2 + maxSlot}`, values: nameValues },
        { range: `Sheet1!F3:F${2 + maxSlot}`, values: tagValues  },
      ],
    },
  });
}

// ── Clear teams from sheet (keep structure) ───────────────────────────────────
async function clearTeamsFromSheet(spreadsheetId, slotsPerLobby = 24) {
  if (!spreadsheetId) return;
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const empty = Array.from({ length: slotsPerLobby }, () => ['']);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `Sheet1!E3:E${2 + slotsPerLobby}`, values: empty },
        { range: `Sheet1!F3:F${2 + slotsPerLobby}`, values: empty },
      ],
    },
  });
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}



// ── Read final standings from sheet ───────────────────────────────────────────
// Reads col D (slot), E (team name), F (tag), and all match columns
// Returns array of { slot, team_name, team_tag, placement_pts, kill_pts, total }
async function getSheetStandings(spreadsheetId, slotsPerLobby = 24) {
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read the scoring table from A3:B27
  const scoringRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A3:B26',
  });
  const scoringRows = scoringRes.data.values || [];
  // Build placement pts map: index 0 = 1st place
  const placementPts = scoringRows.map(r => parseInt(r[1]) || 0);

  // Read team data + match data: D3 onwards
  // Cols: D=slot, E=team_name, F=tag, G/H=match1 place/kills, I/J=match2...
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `Sheet1!D3:AJ${2 + slotsPerLobby}`,
  });
  const rows = dataRes.data.values || [];

  const standings = [];
  for (const row of rows) {
    const slot     = parseInt(row[0]);
    const teamName = row[1] || '';
    const teamTag  = row[2] || '';

    if (!teamName || teamName === '-') continue;

    let totalPlacementPts = 0;
    let totalKillPts      = 0;

    // Match data starts at index 3 (col G), pairs of [place, kills]
    for (let m = 0; m < 15; m++) {
      const placeRaw = row[3 + m * 2];
      const killsRaw = row[3 + m * 2 + 1];
      if (!placeRaw || placeRaw === '') continue;

      const place = parseInt(placeRaw);
      const kills = parseInt(killsRaw) || 0;
      if (!isNaN(place) && place >= 1 && place <= placementPts.length) {
        totalPlacementPts += placementPts[place - 1];
      }
      totalKillPts += kills;
    }

    standings.push({
      slot,
      team_name:     teamName,
      team_tag:      teamTag,
      placement_pts: totalPlacementPts,
      kill_pts:      totalKillPts,
      total:         totalPlacementPts + totalKillPts,
    });
  }

  return standings;
}

module.exports = { createServerSheet, syncTeamsToSheet, clearTeamsFromSheet, getSheetStandings };
