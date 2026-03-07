// ── Results Image Generator ───────────────────────────────────────────────────
// All measurements are expressed as FRACTIONS of the template dimensions,
// so the code works correctly at any resolution the template is stored at.

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

// ── Register fonts by absolute TTF path — no fontconfig needed ───────────────
const FONT_DEFS = [
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',      family: 'BotFont', weight: 'normal' },
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', family: 'BotFont', weight: 'bold'   },
];
for (const f of FONT_DEFS) {
  if (fs.existsSync(f.path)) {
    try { registerFont(f.path, { family: f.family, weight: f.weight, style: 'normal' }); }
    catch(e) { console.warn('registerFont failed:', f.path, e.message); }
  }
}
// Optional user-supplied override fonts
const ASSET      = path.join(__dirname, '../assets/font.ttf');
const ASSET_BOLD = path.join(__dirname, '../assets/font-bold.ttf');
if (fs.existsSync(ASSET))      try { registerFont(ASSET,      { family: 'BotFont', weight: 'normal' }); } catch {}
if (fs.existsSync(ASSET_BOLD)) try { registerFont(ASSET_BOLD, { family: 'BotFont', weight: 'bold'   }); } catch {}

// ── Layout definitions — ALL VALUES ARE 0..1 FRACTIONS of image W/H ──────────
//
// DUAL PANEL (aspect ratio ~1.37):  two columns, 12 rows each
//   Measured on 857×625 reference image then divided by 857 (x) or 625 (y).
//
const DUAL_FX = {
  // Left panel column x-positions (fraction of width)
  L: { rank: 28/857, name: 68/857, place: 320/857, kills: 390/857, total: 415/857 },
  // Right panel column x-positions
  R: { rank: 440/857, name: 480/857, place: 735/857, kills: 800/857, total: 830/857 },
  // Row vertical midpoints (fraction of height)
  ROW_MIDS_FY: [125,174,210,247,282,318,354,390,426,461,496,532].map(y => y/625),
  // Row height fraction (used to set font size)
  ROW_H_FY: 35/625,
  // Logo zone x-positions (fraction of width)
  LOGO_ZONE_L_FX: 270/857,
  LOGO_ZONE_R_FX: 688/857,
  LOGO_H_FY:       24/625,
};

// SINGLE PANEL (aspect ratio ~2.11): one column, 4 rows
const SINGLE_FX = {
  C: { rank: 60/1041, name: 130/1041, place: 615/1041, kills: 725/1041, total: 1005/1041 },
  ROW_MIDS_FY: [150,238,327,417].map(y => y/493),
  ROW_H_FY: 88/493,
  LOGO_START_FX: 490/1041,
  LOGO_GAP_FX:   4/1041,
  LOGO_H_FY:     50/493,
};

// Font size = this fraction of the row pixel height
const FONT_FILL = 0.52;

// ─────────────────────────────────────────────────────────────────────────────

function detectLayout(w, h) {
  return (w / h) > 1.7 ? 'single' : 'dual';
}

function drawText(ctx, text, x, y, font, color, align = 'left') {
  ctx.save();
  ctx.font         = font;
  ctx.textAlign    = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(0,0,0,0.9)';
  ctx.fillText(String(text), x + 1, y + 1);
  ctx.fillStyle    = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

async function generateResultsImage(templatePath, teams, fontColor = '#FFFFFF', accentColor = '#FFD700', logoPath = null) {
  const template = await loadImage(templatePath);
  const TW = template.width;
  const TH = template.height;

  console.log(`[imageGen] Template: ${TW}x${TH}, layout: ${detectLayout(TW,TH)}, teams: ${teams.length}`);

  const canvas = createCanvas(TW, TH);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0);

  if (detectLayout(TW, TH) === 'dual') {
    await renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath);
  } else {
    await renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath);
  }
  return canvas.toBuffer('image/png');
}

// ── DUAL renderer ─────────────────────────────────────────────────────────────
async function renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const D = DUAL_FX;

  // Convert all fractions → actual pixels
  const rowMids = D.ROW_MIDS_FY.map(fy => Math.round(fy * TH));
  const rowH    = Math.round(D.ROW_H_FY * TH);
  const L       = scaleX(D.L, TW);
  const R       = scaleX(D.R, TW);

  const fontSize = Math.max(10, Math.round(rowH * FONT_FILL));
  const BOLD   = `bold ${fontSize}px BotFont`;
  const NORMAL = `${fontSize}px BotFont`;

  console.log(`[imageGen] dual rowH=${rowH}px fontSize=${fontSize}px`);

  // Left column first (ranks 1–12), right column second (13–24)
  const numRows   = rowMids.length;
  const leftTeams  = teams.slice(0, numRows);
  const rightTeams = teams.slice(numRows);

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
  const logoH  = Math.round(D.LOGO_H_FY * TH);
  const logoW  = logo ? Math.round(logo.width * logoH / logo.height) : 0;
  const logoZL = Math.round(D.LOGO_ZONE_L_FX * TW);
  const logoZR = Math.round(D.LOGO_ZONE_R_FX * TW);

  for (let i = 0; i < numRows; i++) {
    const y = rowMids[i];
    if (i < leftTeams.length) {
      const t = leftTeams[i];
      drawText(ctx, t.rank,          L.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     L.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, L.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      L.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         L.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, logoW, logoH, logoZL, y, t.wins, 3);
    }
    if (i < rightTeams.length) {
      const t = rightTeams[i];
      drawText(ctx, t.rank,          R.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     R.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, R.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      R.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         R.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, logoW, logoH, logoZR, y, t.wins, 3);
    }
  }
}

// ── SINGLE renderer ───────────────────────────────────────────────────────────
async function renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const S = SINGLE_FX;

  const rowMids = S.ROW_MIDS_FY.map(fy => Math.round(fy * TH));
  const rowH    = Math.round(S.ROW_H_FY * TH);
  const C       = scaleX(S.C, TW);

  const fontSize = Math.max(12, Math.round(rowH * FONT_FILL));
  const BOLD   = `bold ${fontSize}px BotFont`;
  const NORMAL = `${fontSize}px BotFont`;

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
  const logoH      = Math.round(S.LOGO_H_FY * TH);
  const logoW      = logo ? Math.round(logo.width * logoH / logo.height) : 0;
  const logoStartX = Math.round(S.LOGO_START_FX * TW);
  const logoGap    = Math.round(S.LOGO_GAP_FX * TW);

  for (let i = 0; i < rowMids.length && i < teams.length; i++) {
    const t = teams[i];
    const y = rowMids[i];
    drawText(ctx, t.rank,          C.rank,  y, BOLD,   accentColor, 'left');
    drawText(ctx, t.team_name,     C.name,  y, NORMAL, fontColor,   'left');
    drawText(ctx, t.placement_pts, C.place, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.kill_pts,      C.kills, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.total,         C.total, y, BOLD,   accentColor, 'right');
    if (logo && t.wins > 0) drawLogos(ctx, logo, logoW, logoH, logoStartX, y, t.wins, logoGap);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function drawLogos(ctx, logo, lw, lh, startX, midY, count, gap) {
  const topY = midY - Math.floor(lh / 2);
  for (let n = 0; n < count; n++) ctx.drawImage(logo, startX + n * (lw + gap), topY, lw, lh);
}

function scaleX(obj, TW) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * TW)]));
}

module.exports = { generateResultsImage };
