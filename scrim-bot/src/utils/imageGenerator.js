// ── Results Image Generator ───────────────────────────────────────────────────
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

// ── Register fonts by absolute TTF path — no fontconfig needed ───────────────
// These paths exist on Railway (Debian-based). registerFont is idempotent.
const FONT_PATHS = [
  // DejaVu Sans (reliable fallback always present on Debian/Ubuntu)
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',      family: 'BotFont', weight: 'normal', style: 'normal' },
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', family: 'BotFont', weight: 'bold',   style: 'normal' },
];

for (const f of FONT_PATHS) {
  if (fs.existsSync(f.path)) {
    try {
      registerFont(f.path, { family: f.family, weight: f.weight, style: f.style });
    } catch(e) {
      console.warn('⚠️  registerFont failed for', f.path, e.message);
    }
  } else {
    console.warn('⚠️  Font not found:', f.path);
  }
}

// Also try a user-supplied font at src/assets/font.ttf (optional override)
const ASSET_FONT      = path.join(__dirname, '../assets/font.ttf');
const ASSET_FONT_BOLD = path.join(__dirname, '../assets/font-bold.ttf');
if (fs.existsSync(ASSET_FONT))      try { registerFont(ASSET_FONT,      { family: 'BotFont', weight: 'normal' }); } catch {}
if (fs.existsSync(ASSET_FONT_BOLD)) try { registerFont(ASSET_FONT_BOLD, { family: 'BotFont', weight: 'bold'   }); } catch {}

// ── DUAL PANEL template (857x625 base) ───────────────────────────────────────
// Pixel positions measured directly from the Asgardians Pro Scrim template.
const DUAL = {
  BASE_W: 857, BASE_H: 625,
  ROW_MIDS: [125, 174, 210, 247, 282, 318, 354, 390, 426, 461, 496, 532],
  L: { rank: 28,  name: 68,  place: 320, kills: 390, total: 415 },
  R: { rank: 440, name: 480, place: 735, kills: 800, total: 830 },
  FONT_SIZE_BOLD:   19,
  FONT_SIZE_NORMAL: 18,
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

async function renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const sx = TW / DUAL.BASE_W;
  const sy = TH / DUAL.BASE_H;
  const sc = Math.min(sx, sy);

  const rowMids = DUAL.ROW_MIDS.map(y => Math.round(y * sy));
  const L = scaleObj(DUAL.L, sx);
  const R = scaleObj(DUAL.R, sx);

  const boldSize   = Math.max(10, Math.round(DUAL.FONT_SIZE_BOLD   * sc));
  const normalSize = Math.max(9,  Math.round(DUAL.FONT_SIZE_NORMAL * sc));
  const BOLD   = `bold ${boldSize}px BotFont`;
  const NORMAL = `${normalSize}px BotFont`;

  // Left column first (ranks 1–12), right column second (ranks 13–24)
  const numRows    = rowMids.length;
  const leftTeams  = teams.slice(0, numRows);
  const rightTeams = teams.slice(numRows);

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
  const LOGO_H    = Math.round(24 * sy);
  const LOGO_W    = logo ? Math.round(logo.width * LOGO_H / logo.height) : 0;
  const LOGO_ZL   = Math.round(270 * sx);
  const LOGO_ZR   = Math.round(688 * sx);

  for (let i = 0; i < numRows; i++) {
    const y = rowMids[i];
    if (i < leftTeams.length) {
      const t = leftTeams[i];
      drawText(ctx, t.rank,          L.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     L.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, L.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      L.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         L.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZL, y, t.wins, 3);
    }
    if (i < rightTeams.length) {
      const t = rightTeams[i];
      drawText(ctx, t.rank,          R.rank,  y, BOLD,   accentColor, 'left');
      drawText(ctx, t.team_name,     R.name,  y, NORMAL, fontColor,   'left');
      drawText(ctx, t.placement_pts, R.place, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.kill_pts,      R.kills, y, NORMAL, fontColor,   'right');
      drawText(ctx, t.total,         R.total, y, BOLD,   accentColor, 'right');
      if (logo && t.wins > 0) drawLogos(ctx, logo, LOGO_W, LOGO_H, LOGO_ZR, y, t.wins, 3);
    }
  }
}

async function renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const sx = TW / SINGLE.BASE_W;
  const sy = TH / SINGLE.BASE_H;
  const sc = Math.min(sx, sy);

  const rowMids = SINGLE.ROW_MIDS.map(y => Math.round(y * sy));
  const C = scaleObj(SINGLE.C, sx);

  const boldSize   = Math.max(14, Math.round(SINGLE.FONT_SIZE_BOLD   * sc));
  const normalSize = Math.max(12, Math.round(SINGLE.FONT_SIZE_NORMAL * sc));
  const BOLD   = `bold ${boldSize}px BotFont`;
  const NORMAL = `${normalSize}px BotFont`;

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
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
