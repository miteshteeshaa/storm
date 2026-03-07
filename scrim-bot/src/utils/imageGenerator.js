// ── Results Image Generator ───────────────────────────────────────────────────
// Dual-panel layout: 857x625 base (12 rows × 2 columns = 24 teams)
// Single-panel layout: 1041x493 base (4 rows × 1 column)
// Pixel positions measured directly from the Asgardians Pro Scrim template.

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

// Register a bundled font if the system has no fonts (Railway minimal image).
// Drop a .ttf into src/assets/font.ttf to use a custom font.
const ASSET_FONT = path.join(__dirname, '../assets/font.ttf');
if (fs.existsSync(ASSET_FONT)) {
  try { registerFont(ASSET_FONT, { family: 'BotFont' }); } catch {}
}

// ── DUAL PANEL template (857x625 base) ───────────────────────────────────────
// Row midpoints measured from actual template pixels:
const DUAL = {
  BASE_W: 857, BASE_H: 625,
  // Vertical midpoint of each of the 12 data rows
  ROW_MIDS: [125, 174, 210, 247, 282, 318, 354, 390, 426, 461, 496, 532],
  // Left panel (x: 0-412): left-align rank & name, right-align stats
  L: { rank: 28,  name: 68,  place: 320, kills: 390, total: 415 },
  // Right panel (x: 412-857): mirrors left
  R: { rank: 440, name: 480, place: 735, kills: 800, total: 830 },
  FONT_SIZE_BOLD:   14,
  FONT_SIZE_NORMAL: 13,
};

// ── SINGLE PANEL template (1041x493 base) ────────────────────────────────────
const SINGLE = {
  BASE_W: 1041, BASE_H: 493,
  ROW_MIDS: [150, 238, 327, 417],
  LOGO_START_X: 490,
  LOGO_GAP: 4,
  LOGO_H: 50,
  C: { rank: 60, name: 130, place: 615, kills: 725, total: 1005 },
  FONT_SIZE_BOLD:   22,
  FONT_SIZE_NORMAL: 20,
};

/**
 * Detect layout from image dimensions.
 * dual  ~1.37 (857x625) — two columns of 12 rows
 * single ~2.11 (1041x493) — one column of 4 rows
 */
function detectLayout(w, h) {
  return (w / h) > 1.7 ? 'single' : 'dual';
}

/**
 * Draw text with drop shadow. Uses canvas textBaseline='middle'.
 */
function drawText(ctx, text, x, y, font, color, align = 'left') {
  ctx.save();
  ctx.font         = font;
  ctx.textAlign    = align;
  ctx.textBaseline = 'middle';
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(String(text), x + 1, y + 1);
  // Main text
  ctx.fillStyle = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

/**
 * Generate a results image.
 * @param {string}      templatePath
 * @param {Array}       teams  — sorted array of
 *   { rank, team_name, placement_pts, kill_pts, total, wins }
 * @param {string}      fontColor    — CSS hex, default '#FFFFFF'
 * @param {string}      accentColor  — CSS hex for rank & total, default '#FFD700'
 * @param {string|null} logoPath     — optional chicken dinner logo PNG path
 * @returns {Promise<Buffer>}
 */
async function generateResultsImage(
  templatePath,
  teams,
  fontColor   = '#FFFFFF',
  accentColor = '#FFD700',
  logoPath    = null
) {
  const template = await loadImage(templatePath);
  const TW = template.width;
  const TH = template.height;

  const canvas = createCanvas(TW, TH);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0);

  const layout = detectLayout(TW, TH);

  if (layout === 'dual') {
    await renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath);
  } else {
    await renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath);
  }

  return canvas.toBuffer('image/png');
}

// ── DUAL PANEL renderer ───────────────────────────────────────────────────────
async function renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const sx = TW / DUAL.BASE_W;
  const sy = TH / DUAL.BASE_H;

  const rowMids = DUAL.ROW_MIDS.map(y => Math.round(y * sy));
  const L = scaleObj(DUAL.L, sx);
  const R = scaleObj(DUAL.R, sx);

  const fontSize      = Math.round(DUAL.FONT_SIZE_BOLD   * Math.min(sx, sy));
  const fontSizeSmall = Math.round(DUAL.FONT_SIZE_NORMAL * Math.min(sx, sy));
  const BOLD   = `bold ${fontSize}px Arial`;
  const NORMAL = `${fontSizeSmall}px Arial`;

  // ── FILL COLUMN 1 FIRST, then column 2 ──────────────────────────────────
  // Teams are already sorted by rank. Left column = rows 1-12, right = rows 13-24.
  const numRows  = rowMids.length; // 12
  const leftTeams  = teams.slice(0, numRows);
  const rightTeams = teams.slice(numRows);

  // Load logo if provided
  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) {
    try { logo = await loadImage(logoPath); } catch {}
  }
  const LOGO_H = Math.round(24 * sy);
  const LOGO_W = logo ? Math.round(logo.width * LOGO_H / logo.height) : 0;
  const LOGO_ZONE_L = Math.round(270 * sx);
  const LOGO_ZONE_R = Math.round(688 * sx);

  for (let i = 0; i < numRows; i++) {
    const y = rowMids[i];

    if (i < leftTeams.length) {
      const t = leftTeams[i];
      drawText(ctx, t.rank,          L.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     L.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, L.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      L.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         L.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZONE_L, y, t.wins, 3);
    }

    if (i < rightTeams.length) {
      const t = rightTeams[i];
      drawText(ctx, t.rank,          R.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     R.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, R.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      R.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         R.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZONE_R, y, t.wins, 3);
    }
  }
}

// ── SINGLE PANEL renderer ─────────────────────────────────────────────────────
async function renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const sx = TW / SINGLE.BASE_W;
  const sy = TH / SINGLE.BASE_H;

  const rowMids = SINGLE.ROW_MIDS.map(y => Math.round(y * sy));
  const C = scaleObj(SINGLE.C, sx);

  const BOLD   = `bold ${Math.round(SINGLE.FONT_SIZE_BOLD   * Math.min(sx,sy))}px Arial`;
  const NORMAL = `${Math.round(SINGLE.FONT_SIZE_NORMAL * Math.min(sx,sy))}px Arial`;

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) {
    try { logo = await loadImage(logoPath); } catch {}
  }
  const LOGO_H       = Math.round(SINGLE.LOGO_H * sy);
  const LOGO_W       = logo ? Math.round(logo.width * LOGO_H / logo.height) : 0;
  const LOGO_START_X = Math.round(SINGLE.LOGO_START_X * sx);
  const LOGO_GAP     = Math.round(SINGLE.LOGO_GAP * sx);

  for (let i = 0; i < rowMids.length && i < teams.length; i++) {
    const t = teams[i];
    const y = rowMids[i];
    drawText(ctx, t.rank,          C.rank,  y, BOLD,   accentColor, 'left');
    drawText(ctx, t.team_name,     C.name,  y, NORMAL, fontColor,   'left');
    drawText(ctx, t.placement_pts, C.place, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.kill_pts,      C.kills, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.total,         C.total, y, BOLD,   accentColor, 'right');
    if (logo && t.wins > 0) drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_START_X, y, t.wins, LOGO_GAP);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function drawLogos(ctx, logo, lw, lh, startX, midY, count, gap) {
  const topY = midY - Math.floor(lh / 2);
  for (let n = 0; n < count; n++) {
    ctx.drawImage(logo, startX + n * (lw + gap), topY, lw, lh);
  }
}

function scaleObj(obj, sx) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * sx)]));
}

module.exports = { generateResultsImage };
