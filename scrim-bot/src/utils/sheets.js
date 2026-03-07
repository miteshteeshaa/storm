// ── Google Sheets utility ─────────────────────────────────────────────────────
// OAuth2 auth via GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN

const { google } = require('googleapis');

function getAuth() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN env vars.');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  console.log('✅ Using OAuth2 with refresh token');
  return oauth2Client;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return s[(v-20)%10] || s[v] || s[0];
}

// placement index 0 = 1st place
const PLACEMENT_POINTS = [10,6,5,4,3,2,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

// 0-based column index → A1 letter (AA, AB... supported)
function colLetter(idx) {
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// ── Sheet column layout ───────────────────────────────────────────────────────
// A  = placement label ("1st","2nd"...)  [scoring table]
// B  = placement pts                     [scoring table]
// C  = gap (empty)
// D  = SLOT number
// E  = TEAM NAME
// F  = TAG
// G,H = Match 1 Place, Kills
// I,J = Match 2 Place, Kills
// ...continuing for numMatches pairs...
// last-2 = TOTAL PLACE PTS
// last-1 = TOTAL KILL PTS
// last   = GRAND TOTAL

const DATA_START_COL = 6; // col G (0-indexed)

function totalCols(numMatches) {
  return {
    totalPlaceCol:  DATA_START_COL + numMatches * 2,
    totalKillCol:   DATA_START_COL + numMatches * 2 + 1,
    grandTotalCol:  DATA_START_COL + numMatches * 2 + 2,
    lastDataCol:    DATA_START_COL + numMatches * 2 + 3,
  };
}

// ── Build static value rows for a lobby tab ───────────────────────────────────
function buildValueRows(slotsPerLobby, numMatches) {
  const { totalPlaceCol, totalKillCol, grandTotalCol } = totalCols(numMatches);

  // Row 1: main headers
  const matchHeaders = [];
  for (let m = 1; m <= numMatches; m++) matchHeaders.push(`${m}${ordinal(m)} Match`, '');
  const row1 = [
    'SCORING SYSTEM', '', '',
    'SLOT', 'TEAM NAME', 'TAG',
    ...matchHeaders,
    'TOTAL PLACEMENT PTS', 'TOTAL KILL PTS', 'GRAND TOTAL',
  ];

  // Row 2: sub-headers
  const subHeaders = [];
  for (let m = 0; m < numMatches; m++) subHeaders.push('Place', 'Kills');
  const row2 = ['1 kill = 1pt', '', '', '', '', '', ...subHeaders, '', '', ''];

  // Data rows (slot 1 .. slotsPerLobby)
  const rows = [row1, row2];
  for (let s = 1; s <= slotsPerLobby; s++) {
    const label    = s === 1 ? '1st' : s === 2 ? '2nd' : s === 3 ? '3rd' : `${s}${ordinal(s)}`;
    const placePts = PLACEMENT_POINTS[s - 1] ?? 0;
    // Columns A,B = scoring table; C = gap; D = slot; E,F = team data (blank); match cols = blank
    rows.push([label, placePts, '', s, '', '', ...new Array(numMatches * 2).fill('')]);
  }
  return rows;
}

// ── Format a lobby tab ────────────────────────────────────────────────────────
async function formatLobbySheet(sheets, spreadsheetId, sheetId, slotsPerLobby, numMatches) {
  const { totalPlaceCol, totalKillCol, grandTotalCol, lastDataCol } = totalCols(numMatches);
  const fmt = [];

  // Merge A1:B1 "SCORING SYSTEM"
  fmt.push({ mergeCells: { range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:0, endColumnIndex:2 }, mergeType:'MERGE_ALL' } });

  // Merge match header pairs in row 1 (G1:H1, I1:J1 ...)
  for (let m = 0; m < numMatches; m++) {
    const col = DATA_START_COL + m * 2;
    fmt.push({ mergeCells: { range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:col, endColumnIndex:col+2 }, mergeType:'MERGE_ALL' } });
  }

  // Merge total header cells in row 1
  fmt.push({ mergeCells: { range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:totalPlaceCol, endColumnIndex:totalPlaceCol+1 }, mergeType:'MERGE_ALL' } });
  fmt.push({ mergeCells: { range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:totalKillCol,  endColumnIndex:totalKillCol+1  }, mergeType:'MERGE_ALL' } });
  fmt.push({ mergeCells: { range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:grandTotalCol, endColumnIndex:grandTotalCol+1 }, mergeType:'MERGE_ALL' } });

  // ── Row 1: dark header ──────────────────────────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:0, endRowIndex:1 },
      cell: { userEnteredFormat: {
        backgroundColor: { red:0.12, green:0.12, blue:0.12 },
        textFormat: { bold:true, foregroundColor:{ red:1,green:1,blue:1 }, fontSize:9 },
        horizontalAlignment:'CENTER', verticalAlignment:'MIDDLE',
        wrapStrategy: 'CLIP',
      }},
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  });

  // ── Row 2: sub-header ───────────────────────────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:1, endRowIndex:2 },
      cell: { userEnteredFormat: {
        backgroundColor: { red:0.22, green:0.22, blue:0.22 },
        textFormat: { bold:true, foregroundColor:{ red:0.9,green:0.9,blue:0.9 }, fontSize:8 },
        horizontalAlignment:'CENTER',
      }},
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // ── Alternating data rows ───────────────────────────────────────────────────
  for (let s = 0; s < slotsPerLobby; s++) {
    const rowIdx = 2 + s;
    const bg = s % 2 === 0
      ? { red:0.95, green:0.96, blue:0.98 }  // light blue-grey
      : { red:1,    green:1,    blue:1    };  // white
    fmt.push({
      repeatCell: {
        range: { sheetId, startRowIndex:rowIdx, endRowIndex:rowIdx+1, startColumnIndex:0, endColumnIndex:lastDataCol },
        cell: { userEnteredFormat: { backgroundColor: bg } },
        fields: 'userEnteredFormat(backgroundColor)',
      },
    });
  }

  // ── Scoring table A:B — blue tint ──────────────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:2, endRowIndex:2+slotsPerLobby, startColumnIndex:0, endColumnIndex:2 },
      cell: { userEnteredFormat: {
        backgroundColor: { red:0.78, green:0.87, blue:0.98 },
        horizontalAlignment:'CENTER', textFormat:{ fontSize:8 },
      }},
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
    },
  });

  // ── Slot/Team/Tag D:F — center ──────────────────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:2, endRowIndex:2+slotsPerLobby, startColumnIndex:3, endColumnIndex:6 },
      cell: { userEnteredFormat: { horizontalAlignment:'CENTER', textFormat:{ fontSize:9 } } },
      fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
    },
  });

  // ── Match data cells — center, small ───────────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:2, endRowIndex:2+slotsPerLobby, startColumnIndex:DATA_START_COL, endColumnIndex:totalPlaceCol },
      cell: { userEnteredFormat: { horizontalAlignment:'CENTER', textFormat:{ fontSize:8 } } },
      fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
    },
  });

  // ── Total columns — yellow highlight, bold ──────────────────────────────────
  fmt.push({
    repeatCell: {
      range: { sheetId, startRowIndex:2, endRowIndex:2+slotsPerLobby, startColumnIndex:totalPlaceCol, endColumnIndex:grandTotalCol+1 },
      cell: { userEnteredFormat: {
        backgroundColor: { red:1, green:0.95, blue:0.6 },
        horizontalAlignment:'CENTER', textFormat:{ bold:true, fontSize:9 },
      }},
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
    },
  });

  // ── Outer + inner borders ───────────────────────────────────────────────────
  fmt.push({
    updateBorders: {
      range: { sheetId, startRowIndex:0, endRowIndex:2+slotsPerLobby, startColumnIndex:0, endColumnIndex:lastDataCol },
      innerHorizontal: { style:'SOLID',        color:{ red:0.65,green:0.65,blue:0.65 } },
      innerVertical:   { style:'SOLID',        color:{ red:0.65,green:0.65,blue:0.65 } },
      top:    { style:'SOLID_MEDIUM', color:{ red:0.1,green:0.1,blue:0.1 } },
      bottom: { style:'SOLID_MEDIUM', color:{ red:0.1,green:0.1,blue:0.1 } },
      left:   { style:'SOLID_MEDIUM', color:{ red:0.1,green:0.1,blue:0.1 } },
      right:  { style:'SOLID_MEDIUM', color:{ red:0.1,green:0.1,blue:0.1 } },
    },
  });

  // ── Freeze first 2 rows + 6 cols ───────────────────────────────────────────
  fmt.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount:2, frozenColumnCount:6 } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  // ── Row height: row1=40, row2=18, data=20 ──────────────────────────────────
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'ROWS', startIndex:0, endIndex:1    }, properties:{ pixelSize:40 }, fields:'pixelSize' } });
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'ROWS', startIndex:1, endIndex:2    }, properties:{ pixelSize:18 }, fields:'pixelSize' } });
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'ROWS', startIndex:2, endIndex:2+slotsPerLobby }, properties:{ pixelSize:20 }, fields:'pixelSize' } });

  // ── Column widths ───────────────────────────────────────────────────────────
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:0, endIndex:2              }, properties:{ pixelSize:55  }, fields:'pixelSize' } }); // A:B scoring
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:2, endIndex:3              }, properties:{ pixelSize:10  }, fields:'pixelSize' } }); // C gap
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:3, endIndex:4              }, properties:{ pixelSize:40  }, fields:'pixelSize' } }); // D slot
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:4, endIndex:5              }, properties:{ pixelSize:150 }, fields:'pixelSize' } }); // E team name
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:5, endIndex:6              }, properties:{ pixelSize:60  }, fields:'pixelSize' } }); // F tag
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:DATA_START_COL, endIndex:totalPlaceCol }, properties:{ pixelSize:42  }, fields:'pixelSize' } }); // match cols
  fmt.push({ updateDimensionProperties: { range:{ sheetId, dimension:'COLUMNS', startIndex:totalPlaceCol, endIndex:grandTotalCol+1 }, properties:{ pixelSize:85  }, fields:'pixelSize' } }); // total cols

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{ requests:fmt } });
}

// ── Write TOTAL/GRAND TOTAL formulas for a lobby tab ─────────────────────────
async function writeLobbyFormulas(sheets, spreadsheetId, sheetTitle, slotsPerLobby, numMatches) {
  const { totalPlaceCol, totalKillCol, grandTotalCol } = totalCols(numMatches);
  const tpL = colLetter(totalPlaceCol);
  const tkL = colLetter(totalKillCol);
  const gtL = colLetter(grandTotalCol);

  const scoringRange = `$A$3:$B$${2 + slotsPerLobby}`;
  const formulaData  = [];

  for (let s = 1; s <= slotsPerLobby; s++) {
    const row = s + 2;
    const placeParts = [];
    const killParts  = [];
    for (let m = 0; m < numMatches; m++) {
      const pc = colLetter(DATA_START_COL + m * 2);
      const kc = colLetter(DATA_START_COL + m * 2 + 1);
      placeParts.push(`IFERROR(VLOOKUP(${pc}${row},${scoringRange},2,0),0)`);
      killParts.push(`IFERROR(VALUE(${kc}${row}),0)`);
    }
    formulaData.push({
      range:  `${sheetTitle}!${tpL}${row}:${gtL}${row}`,
      values: [[
        `=IF(E${row}="","",${placeParts.join('+')})`,
        `=IF(E${row}="","",${killParts.join('+')})`,
        `=IF(E${row}="","",${tpL}${row}+${tkL}${row})`,
      ]],
    });
  }

  // Write in batches of 50 to stay under API limits
  for (let i = 0; i < formulaData.length; i += 50) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption:'USER_ENTERED', data: formulaData.slice(i, i+50) },
    });
  }
}


// ── Protect everything EXCEPT Place & Kills columns ──────────────────────────
// Protected: A:F (scoring table, slot, team name, tag) + total columns
// Editable by anyone: only the Place & Kills match columns (G onwards, pairs)
async function protectLobbySheet(sheets, spreadsheetId, sheetId, slotsPerLobby, numMatches) {
  const { totalPlaceCol } = totalCols(numMatches);

  // The service account email is the only one that can bypass hard locks
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    || process.env.GOOGLE_SERVICE_EMAIL
    || (process.env.GOOGLE_CREDENTIALS_JSON
        ? (() => { try { return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON).client_email; } catch { return ''; } })()
        : '');

  const botOnly = serviceEmail
    ? { users: [serviceEmail], groups: [], domainUsersCanEdit: false }
    : { users: [], groups: [], domainUsersCanEdit: false };

  const requests = [];

  // ── 1. HARD LOCK: Header rows 1-2 — nobody but bot can touch ─────────────
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 2 },
        description: '🔒 Header rows — managed by bot only',
        warningOnly: false,
        editors: botOnly,
      },
    },
  });

  // ── 2. HARD LOCK: Cols A-C (scoring table + gap) data rows ───────────────
  //    Admins CAN adjust scoring values (kills/placement points) in col A:B
  //    so these get a WARNING only — they see a dialog but CAN proceed
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 2 + slotsPerLobby, startColumnIndex: 0, endColumnIndex: 3 },
        description: '⚠️ Scoring table — edit here to adjust kill/placement points',
        warningOnly: true,   // <-- admins CAN edit scoring table with a warning
      },
    },
  });

  // ── 3. HARD LOCK: Col D (slot numbers) — bot managed ─────────────────────
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 2 + slotsPerLobby, startColumnIndex: 3, endColumnIndex: 4 },
        description: '🔒 Slot numbers — managed by bot only',
        warningOnly: false,
        editors: botOnly,
      },
    },
  });

  // ── 4. HARD LOCK: Cols E-F (Team Name + TAG) — bot managed ───────────────
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 2 + slotsPerLobby, startColumnIndex: 4, endColumnIndex: 6 },
        description: '🔒 Team Name & Tag — managed by bot only, do not edit',
        warningOnly: false,
        editors: botOnly,
      },
    },
  });

  // ── 5. HARD LOCK: Total cols (auto-calculated formulas) ───────────────────
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 2 + slotsPerLobby, startColumnIndex: totalPlaceCol, endColumnIndex: totalPlaceCol + 3 },
        description: '🔒 Auto-calculated totals — do not edit',
        warningOnly: false,
        editors: botOnly,
      },
    },
  });

  // Cols G onward (match Place + Kills columns) are left FULLY OPEN for admins to enter data

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// ── Create a new spreadsheet: one tab per lobby, numMatches match columns ─────
async function createServerSheet(scrimName, slotsPerLobby = 24, lobbyLetters = ['A','B','C','D'], numMatches = 150) {
  const auth   = getAuth();
  const sheets = google.sheets({ version:'v4', auth });
  const drive  = google.drive({ version:'v3', auth });

  // 1. Create spreadsheet (in the OAuth user's Google Drive)
  const create = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `${scrimName} — SCRIM SHEET` },
      sheets: lobbyLetters.map(l => ({ properties: { title: `Lobby ${l}` } })),
    },
  });

  const spreadsheetId = create.data.spreadsheetId;
  const sheetMeta     = create.data.sheets;

  // 2. Anyone with link can EDIT
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { role: 'writer', type: 'anyone' },
    });
  } catch (permErr) {
    console.warn('⚠️ Could not set public permissions:', permErr.message);
  }

  // 3. Per-lobby: write values → format → formulas
  for (let idx = 0; idx < lobbyLetters.length; idx++) {
    const sheetId    = sheetMeta[idx].properties.sheetId;
    const sheetTitle = sheetMeta[idx].properties.title;
    const valueRows  = buildValueRows(slotsPerLobby, numMatches);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: valueRows },
    });

    await formatLobbySheet(sheets, spreadsheetId, sheetId, slotsPerLobby, numMatches);
    await writeLobbyFormulas(sheets, spreadsheetId, sheetTitle, slotsPerLobby, numMatches);
    await protectLobbySheet(sheets, spreadsheetId, sheetId, slotsPerLobby, numMatches);
  }

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

// ── Sync team names into the correct lobby tab(s) ────────────────────────────
// slots: full array from registrations — grouped by lobby automatically
async function syncTeamsToSheet(spreadsheetId, slots) {
  if (!spreadsheetId || !slots || slots.length === 0) return;

  const auth   = getAuth();
  const sheets = google.sheets({ version:'v4', auth });

  // Discover available tabs
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const tabSet = new Set(meta.data.sheets.map(s => s.properties.title));

  // Group by lobby
  const byLobby = {};
  for (const t of slots) {
    if (!t.lobby) continue;
    if (!byLobby[t.lobby]) byLobby[t.lobby] = [];
    byLobby[t.lobby].push(t);
  }

  const updateData = [];

  for (const [letter, teams] of Object.entries(byLobby)) {
    const sheetTitle = `Lobby ${letter}`;
    if (!tabSet.has(sheetTitle)) continue;

    const maxSlot    = Math.max(24, ...teams.map(t => t.lobby_slot || 0));
    const nameValues = Array.from({ length: maxSlot }, () => ['']);
    const tagValues  = Array.from({ length: maxSlot }, () => ['']);

    for (const t of teams) {
      const s = t.lobby_slot;
      if (s >= 1 && s <= maxSlot) {
        nameValues[s - 1] = [t.team_name || ''];
        tagValues[s - 1]  = [t.team_tag  || ''];
      }
    }

    updateData.push(
      { range: `${sheetTitle}!E3:E${2 + maxSlot}`, values: nameValues },
      { range: `${sheetTitle}!F3:F${2 + maxSlot}`, values: tagValues  },
    );
  }

  if (updateData.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption:'USER_ENTERED', data: updateData },
  });
}

// ── Clear team names from specific lobby tab(s), or all tabs ─────────────────
// lobbyLetters: array like ['A'] or null = clear all
async function clearTeamsFromSheet(spreadsheetId, slotsPerLobby = 24, lobbyLetters = null) {
  if (!spreadsheetId) return;

  const auth   = getAuth();
  const sheets = google.sheets({ version:'v4', auth });

  const meta        = await sheets.spreadsheets.get({ spreadsheetId });
  const lobbySheets = meta.data.sheets.filter(s => {
    if (!s.properties.title.startsWith('Lobby ')) return false;
    if (!lobbyLetters) return true;
    const letter = s.properties.title.replace('Lobby ', '');
    return lobbyLetters.includes(letter);
  });

  const empty      = Array.from({ length: slotsPerLobby }, () => ['']);
  const updateData = [];

  for (const s of lobbySheets) {
    const t = s.properties.title;
    updateData.push(
      { range: `${t}!E3:E${2 + slotsPerLobby}`, values: empty },
      { range: `${t}!F3:F${2 + slotsPerLobby}`, values: empty },
    );
  }

  if (updateData.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption:'USER_ENTERED', data: updateData },
  });
}

// ── Read standings from lobby tab(s) ─────────────────────────────────────────
async function getSheetStandings(spreadsheetId, slotsPerLobby = 24, lobbyLetter = null) {
  const auth   = getAuth();
  const sheets = google.sheets({ version:'v4', auth });

  const meta        = await sheets.spreadsheets.get({ spreadsheetId });
  const lobbySheets = meta.data.sheets.filter(s => {
    if (!s.properties.title.startsWith('Lobby ')) return false;
    if (lobbyLetter) return s.properties.title === `Lobby ${lobbyLetter}`;
    return true;
  });

  const all = [];

  for (const sheetMeta of lobbySheets) {
    const title  = sheetMeta.properties.title;
    const letter = title.replace('Lobby ', '');

    const scoringRes   = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A3:B${2 + slotsPerLobby}` });
    const placementPts = (scoringRes.data.values || []).map(r => parseInt(r[1]) || 0);

    const fullRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!D3:ZZ${2 + slotsPerLobby}` });
    const rows    = fullRes.data.values || [];

    for (const row of rows) {
      const teamName = row[1] || '';
      if (!teamName || teamName === '-') continue;

      let tPlace = 0, tKill = 0;
      for (let m = 0; (3 + m * 2 + 1) < row.length; m++) {
        const place = parseInt(row[3 + m * 2]);
        const kills = parseInt(row[3 + m * 2 + 1]) || 0;
        if (!isNaN(place) && place >= 1 && place <= placementPts.length) tPlace += placementPts[place - 1];
        tKill += kills;
      }

      all.push({
        slot:          parseInt(row[0]),
        lobby:         letter,
        team_name:     teamName,
        team_tag:      row[2] || '',
        placement_pts: tPlace,
        kill_pts:      tKill,
        total:         tPlace + tKill,
      });
    }
  }

  return all;
}

module.exports = { createServerSheet, syncTeamsToSheet, clearTeamsFromSheet, getSheetStandings };
