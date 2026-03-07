// ── Results Image Generator ───────────────────────────────────────────────────
// Supports two template layouts, auto-detected by aspect ratio:
//   • DUAL_PANEL  — 851x621  (two columns of 12 rows each, 24 teams total)
//   • SINGLE_PANEL — 1041x493 (one column of 4 rows, used for top-N summaries)
// Scales to any resolution variant of each layout.
// Supports chicken dinner logo overlay (1 or 2 logos per team win count).

const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs   = require('fs');

// ── DUAL PANEL template (851x621 base) ───────────────────────────────────────
const DUAL = {
  BASE_W: 851, BASE_H: 621,
  ROW_MIDS: [138, 174, 210, 246, 281, 317, 352, 388, 424, 460, 495, 530],
  // left-align: rank, name  |  right-align: place, kills, total
  L: { rank: 28,  name: 68,  place: 338, kills: 386, total: 422 },
  R: { rank: 427, name: 463, place: 754, kills: 800, total: 840 },
  FONT_SIZE_BOLD:   15,
  FONT_SIZE_NORMAL: 13,
};

// ── SINGLE PANEL template (1041x493 base) ────────────────────────────────────
const SINGLE = {
  BASE_W: 1041, BASE_H: 493,
  ROW_MIDS: [150, 238, 327, 417],
  // logo zone: between name end (~480) and placement col
  LOGO_START_X: 490,  // x position for first logo
  LOGO_GAP: 4,        // gap between logos
  LOGO_H: 50,         // logo height in pixels (width auto-scaled)
  C: { rank: 60, name: 130, place: 615, kills: 725, total: 1005 },
  FONT_SIZE_BOLD:   22,
  FONT_SIZE_NORMAL: 20,
};

/**
 * Detect layout from image dimensions.
 * @param {number} w
 * @param {number} h
 * @returns {'dual'|'single'}
 */
function detectLayout(w, h) {
  const ratio = w / h;
  // dual ~1.37, single ~2.11
  return ratio > 1.8 ? 'single' : 'dual';
}

/**
 * Draw text with drop shadow. Uses canvas textBaseline='middle'.
 */
function drawText(ctx, text, x, y, font, color, align = 'left') {
  ctx.font         = font;
  ctx.textAlign    = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(0,0,0,0.75)';
  ctx.fillText(String(text), x + 1, y + 1);
  ctx.fillStyle    = color;
  ctx.fillText(String(text), x, y);
}

/**
 * Generate a results image.
 *
 * @param {string}  templatePath   Path to the PNG template
 * @param {Array}   teams          Sorted team objects:
 *   { rank, team_name, placement_pts, kill_pts, total, wins }
 *   `wins` = number of #1 finishes this team achieved (for chicken dinner logos)
 * @param {string}  fontColor      CSS hex for normal text  (default '#FFFFFF')
 * @param {string}  accentColor    CSS hex for rank & total (default '#FFD700')
 * @param {string|null} logoPath   Path to chicken dinner logo PNG (optional)
 * @returns {Promise<Buffer>}      PNG image buffer
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

  const BOLD   = `bold ${Math.round(DUAL.FONT_SIZE_BOLD   * sx)}px Sans`;
  const NORMAL = `${Math.round(DUAL.FONT_SIZE_NORMAL * sx)}px Sans`;

  const slotsPerSide = Math.ceil(teams.length / 2);
  const leftTeams    = teams.slice(0, slotsPerSide);
  const rightTeams   = teams.slice(slotsPerSide);

  // Load logo if provided
  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) {
    logo = await loadImage(logoPath);
  }

  const LOGO_H = Math.round(28 * sy);
  const LOGO_W = logo ? Math.round(logo.width * LOGO_H / logo.height) : 0;
  // Logo zone in dual panel: between name end and placement col
  // name ends roughly at L.name + 160*sx, place starts at L.place - 50*sx
  const LOGO_ZONE_X = Math.round(270 * sx); // start of logo zone (left panel)
  const LOGO_ZONE_XR = Math.round(688 * sx); // start of logo zone (right panel)

  for (let i = 0; i < rowMids.length; i++) {
    const y = rowMids[i];

    if (i < leftTeams.length) {
      const t = leftTeams[i];
      drawText(ctx, t.rank,          L.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     L.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, L.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      L.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         L.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) {
        drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZONE_X, y, t.wins, 3);
      }
    }

    if (i < rightTeams.length) {
      const t = rightTeams[i];
      drawText(ctx, t.rank,          R.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     R.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, R.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      R.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         R.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) {
        drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZONE_XR, y, t.wins, 3);
      }
    }
  }
}

// ── SINGLE PANEL renderer ─────────────────────────────────────────────────────
async function renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const sx = TW / SINGLE.BASE_W;
  const sy = TH / SINGLE.BASE_H;

  const rowMids = SINGLE.ROW_MIDS.map(y => Math.round(y * sy));
  const C = scaleObj(SINGLE.C, sx);

  const BOLD   = `bold ${Math.round(SINGLE.FONT_SIZE_BOLD   * sx)}px Sans`;
  const NORMAL = `${Math.round(SINGLE.FONT_SIZE_NORMAL * sx)}px Sans`;

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) {
    logo = await loadImage(logoPath);
  }

  const LOGO_H = Math.round(SINGLE.LOGO_H * sy);
  const LOGO_W = logo ? Math.round(logo.width * LOGO_H / logo.height) : 0;
  const LOGO_START_X = Math.round(SINGLE.LOGO_START_X * sx);
  const LOGO_GAP     = Math.round(SINGLE.LOGO_GAP * sx);

  for (let i = 0; i < rowMids.length; i++) {
    if (i >= teams.length) break;
    const t = teams[i];
    const y = rowMids[i];

    drawText(ctx, t.rank,          C.rank,  y, BOLD,   accentColor, 'left');
    drawText(ctx, t.team_name,     C.name,  y, NORMAL, fontColor,   'left');
    drawText(ctx, t.placement_pts, C.place, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.kill_pts,      C.kills, y, NORMAL, fontColor,   'right');
    drawText(ctx, t.total,         C.total, y, BOLD,   accentColor, 'right');

    if (logo && t.wins > 0) {
      drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_START_X, y, t.wins, LOGO_GAP);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Draw N logo icons horizontally starting at (startX, midY) */
function drawLogos(ctx, logo, lw, lh, startX, midY, count, gap) {
  const topY = midY - Math.floor(lh / 2);
  for (let n = 0; n < count; n++) {
    const x = startX + n * (lw + gap);
    ctx.drawImage(logo, x, topY, lw, lh);
  }
}

/** Scale an object's values by sx */
function scaleObj(obj, sx) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * sx)]));
}

module.exports = { generateResultsImage };
