// ── Results Image Generator ───────────────────────────────────────────────────
// Fonts are bundled in src/ — no system font or fontconfig dependency.
// Layout is auto-detected per template by reading header pixel positions.

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

// ── Silence fontconfig error on Railway ───────────────────────────────────────
if (!process.env.FONTCONFIG_FILE) {
  const tmpConf = '/tmp/fc-empty.conf';
  if (!fs.existsSync(tmpConf)) {
    fs.writeFileSync(tmpConf,
      '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig></fontconfig>'
    );
  }
  process.env.FONTCONFIG_FILE = tmpConf;
}

// ── Font registration ─────────────────────────────────────────────────────────
const FONT_CANDIDATES = [
  { reg: path.join(__dirname, '../font.ttf'),      bold: path.join(__dirname, '../font-bold.ttf') },
  { reg: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
  { reg: '/usr/share/fonts/truetype/freefont/FreeSans.ttf',  bold: '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf' },
];

let fontsRegistered = false;
for (const candidate of FONT_CANDIDATES) {
  if (fs.existsSync(candidate.reg) && fs.existsSync(candidate.bold)) {
    try {
      registerFont(candidate.reg,  { family: 'ScrimFont', weight: 'normal', style: 'normal' });
      registerFont(candidate.bold, { family: 'ScrimFont', weight: 'bold',   style: 'normal' });
      console.log(`[imageGen] Fonts loaded from: ${candidate.reg}`);
      fontsRegistered = true;
      break;
    } catch(e) { console.warn('[imageGen] registerFont failed:', e.message); }
  }
}
if (!fontsRegistered) console.error('[imageGen] ⚠️  No fonts found!');

function makeFont(size, bold) {
  return `${bold ? 'bold ' : ''}${size}px "ScrimFont"`;
}

// ── Layout definitions (fractions of 857×625 reference) ──────────────────────
//
// Two measured dual-panel layouts. Auto-detected by where the header '#' sits.
//
// LAYOUT A — "Pro Scrim" (gold rows, header # at x≈40)
const LAYOUT_A = {
  L: { rank:40/857, name:80/857, place:292/857, kills:345/857, total:386/857 },
  R: { rank:460/857, name:515/857, place:712/857, kills:766/857, total:806/857 },
  ROW_MIDS_FY: [141,176,209,248,285,321,356,392,430,464,499,534].map(y => y/625),
  ROW_H_FY: 35/625,
  // Logo sits between team name and placement column
  LOGO_ZL_FX: 196/857, LOGO_ZR_FX: 616/857, LOGO_H_FY: 24/625,
};

// LAYOUT B — "Mauritius Scrim" (dark rows, header # at x≈63)
const LAYOUT_B = {
  L: { rank:40/857, name:80/857, place:292/857, kills:345/857, total:386/857 },
  R: { rank:460/857, name:515/857, place:712/857, kills:766/857, total:806/857 },
  ROW_MIDS_FY: [139,175,211,246,282,318,353,389,425,460,496,532].map(y => y/625),
  ROW_H_FY: 35/625,
  LOGO_ZL_FX: 196/857, LOGO_ZR_FX: 616/857, LOGO_H_FY: 24/625,
};

// Single-panel layout
const SINGLE_FX = {
  C: { rank:60/1041, name:130/1041, place:615/1041, kills:725/1041, total:1005/1041 },
  ROW_MIDS_FY: [150,238,327,417].map(y => y/493),
  ROW_H_FY: 88/493,
  LOGO_START_FX: 490/1041, LOGO_GAP_FX: 4/1041, LOGO_H_FY: 50/493,
};

const FONT_FILL = 0.40;

// ── Layout detection ──────────────────────────────────────────────────────────
function detectLayout(w, h) { return w / h > 1.7 ? 'single' : 'dual'; }

// For dual panels, detect which template variant by checking header brightness
// at x=40 (Layout A has its '#' here) vs x=63 (Layout B).
// We sample a small strip of the header band and see where the bright pixels cluster.
function detectDualVariant(ctx, TW, TH) {
  // Sample header row at ~y=14% of height (header band)
  const headerY = Math.round(0.14 * TH);
  const refW = TW; // actual pixel width

  // Check brightness at scaled x positions
  const checkA = Math.round(40/857 * refW);  // Layout A '#' position
  const checkB = Math.round(63/857 * refW);  // Layout B '#' position

  const pxA = ctx.getImageData(checkA, headerY, 1, 1).data;
  const pxB = ctx.getImageData(checkB, headerY, 1, 1).data;

  const brightA = pxA[0] + pxA[1] + pxA[2];
  const brightB = pxB[0] + pxB[1] + pxB[2];

  // Scan a band to find where the first bright cluster is
  let firstBrightX = null;
  for (let x = Math.round(20/857*refW); x < Math.round(120/857*refW); x++) {
    const px = ctx.getImageData(x, headerY, 1, 1).data;
    if (px[0] > 150 && px[1] > 120) { firstBrightX = x; break; }
  }

  const firstBrightFrac = firstBrightX ? firstBrightX / refW : 0.05;
  const useB = firstBrightFrac > 60/857;  // Layout B header starts further right

  console.log(`[imageGen] Header detection: firstBrightX=${firstBrightX}(${firstBrightFrac.toFixed(3)}) → Layout ${useB ? 'B' : 'A'}`);
  return useB ? LAYOUT_B : LAYOUT_A;
}

// ── Text drawing ──────────────────────────────────────────────────────────────
function drawText(ctx, text, x, y, font, color, align = 'left') {
  ctx.save();
  ctx.font         = font;
  ctx.textAlign    = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(0,0,0,0.85)';
  ctx.fillText(String(text), x + 1, y + 1);
  ctx.fillStyle    = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function generateResultsImage(templatePath, teams, fontColor = '#FFFFFF', accentColor = '#FFD700', logoPath = null) {
  const template = await loadImage(templatePath);
  const TW = template.width;
  const TH = template.height;
  console.log(`[imageGen] Template: ${TW}x${TH}, layout: ${detectLayout(TW,TH)}, teams: ${teams.length}`);

  const canvas = createCanvas(TW, TH);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0);

  if (detectLayout(TW, TH) === 'dual') {
    const layout = detectDualVariant(ctx, TW, TH);
    await renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath, layout);
  } else {
    await renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath);
  }
  return canvas.toBuffer('image/png');
}

// ── Dual renderer ─────────────────────────────────────────────────────────────
async function renderDual(ctx, TW, TH, teams, fontColor, accentColor, logoPath, layout) {
  const rowH     = Math.round(layout.ROW_H_FY * TH);
  const rowMids  = layout.ROW_MIDS_FY.map(fy => Math.round(fy * TH));
  const L        = scaleX(layout.L, TW);
  const R        = scaleX(layout.R, TW);
  const fontSize = Math.max(10, Math.round(rowH * FONT_FILL));
  const BOLD     = makeFont(fontSize, true);
  const NORMAL   = makeFont(fontSize, false);
  console.log(`[imageGen] dual rowH=${rowH}px fontSize=${fontSize}px`);

  const leftTeams  = teams.slice(0, rowMids.length);
  const rightTeams = teams.slice(rowMids.length);

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
  const logoH  = Math.round(layout.LOGO_H_FY * TH);
  const logoW  = logo ? Math.round(logo.width * logoH / logo.height) : 0;
  const logoZL = Math.round(layout.LOGO_ZL_FX * TW);
  const logoZR = Math.round(layout.LOGO_ZR_FX * TW);

  // Total available space between name col and placement col
  const totalColW_L = L.place - L.name - 4;
  const totalColW_R = R.place - R.name - 4;

  // Max wins across all teams (to pre-calculate logo space needed)
  const maxWins = Math.max(0, ...teams.map(t => t.wins || 0));
  const logoSlots = maxWins > 0 ? Math.min(maxWins > 3 ? 1 : maxWins, 3) : 0;
  const logoTotalW = logo ? (logoSlots * (logoW + 2)) : 0;

  const nameMaxW_L = totalColW_L - logoTotalW - (logoTotalW > 0 ? 4 : 0);
  const nameMaxW_R = totalColW_R - logoTotalW - (logoTotalW > 0 ? 4 : 0);

  for (let i = 0; i < rowMids.length; i++) {
    const y = rowMids[i];
    if (i < leftTeams.length) {
      const t = leftTeams[i];
      const wins = t.wins || 0;
      // Logo space for this team
      const thisLogoSlots = wins > 3 ? 1 : Math.min(wins, 3);
      const thisLogoW = logo && wins > 0 ? thisLogoSlots * (logoW + 2) : 0;
      const thisNameMaxW = totalColW_L - thisLogoW - (thisLogoW > 0 ? 4 : 0);
      drawText(ctx, t.rank,          L.rank,  y, NORMAL, accentColor, 'center');
      drawFitText(ctx, cleanTeamName(t.team_name), L.name, y, fontSize, fontColor, thisNameMaxW);
      drawText(ctx, t.placement_pts, L.place, y, NORMAL, fontColor,   'center');
      drawText(ctx, t.kill_pts,      L.kills, y, NORMAL, fontColor,   'center');
      drawText(ctx, t.total,         L.total, y, NORMAL, accentColor, 'center');
      if (logo && wins > 0) {
        const nameW = measureFitText(ctx, cleanTeamName(t.team_name), fontSize, thisNameMaxW);
        const logoStartX = L.name + nameW + 3;
        // Clip so logos never exceed placement column
        ctx.save();
        ctx.beginPath();
        ctx.rect(logoStartX, y - logoH, L.place - logoStartX - 2, logoH * 2);
        ctx.clip();
        drawLogos(ctx, logo, logoW, logoH, logoStartX, y, wins, accentColor);
        ctx.restore();
      }
    }
    if (i < rightTeams.length) {
      const t = rightTeams[i];
      const wins = t.wins || 0;
      const thisLogoSlots = wins > 3 ? 1 : Math.min(wins, 3);
      const thisLogoW = logo && wins > 0 ? thisLogoSlots * (logoW + 2) : 0;
      const thisNameMaxW = totalColW_R - thisLogoW - (thisLogoW > 0 ? 4 : 0);
      drawText(ctx, t.rank,          R.rank,  y, NORMAL, accentColor, 'center');
      drawFitText(ctx, cleanTeamName(t.team_name), R.name, y, fontSize, fontColor, thisNameMaxW);
      drawText(ctx, t.placement_pts, R.place, y, NORMAL, fontColor,   'center');
      drawText(ctx, t.kill_pts,      R.kills, y, NORMAL, fontColor,   'center');
      drawText(ctx, t.total,         R.total, y, NORMAL, accentColor, 'center');
      if (logo && wins > 0) {
        const nameW = measureFitText(ctx, cleanTeamName(t.team_name), fontSize, thisNameMaxW);
        const logoStartX = R.name + nameW + 3;
        ctx.save();
        ctx.beginPath();
        ctx.rect(logoStartX, y - logoH, R.place - logoStartX - 2, logoH * 2);
        ctx.clip();
        drawLogos(ctx, logo, logoW, logoH, logoStartX, y, wins, accentColor);
        ctx.restore();
      }
    }
  }
}

// ── Single renderer ───────────────────────────────────────────────────────────
async function renderSingle(ctx, TW, TH, teams, fontColor, accentColor, logoPath) {
  const rowH     = Math.round(SINGLE_FX.ROW_H_FY * TH);
  const rowMids  = SINGLE_FX.ROW_MIDS_FY.map(fy => Math.round(fy * TH));
  const C        = scaleX(SINGLE_FX.C, TW);
  const fontSize = Math.max(12, Math.round(rowH * FONT_FILL));
  const BOLD     = makeFont(fontSize, true);
  const NORMAL   = makeFont(fontSize, false);

  let logo = null;
  if (logoPath && fs.existsSync(logoPath)) try { logo = await loadImage(logoPath); } catch {}
  const logoH      = Math.round(SINGLE_FX.LOGO_H_FY * TH);
  const logoW      = logo ? Math.round(logo.width * logoH / logo.height) : 0;
  const logoStartX = Math.round(SINGLE_FX.LOGO_START_FX * TW);
  const logoGap    = Math.round(SINGLE_FX.LOGO_GAP_FX * TW);

  for (let i = 0; i < rowMids.length && i < teams.length; i++) {
    const t = teams[i];
    const y = rowMids[i];
    drawText(ctx, t.rank,          C.rank,  y, NORMAL, accentColor, 'center');
    drawText(ctx, cleanTeamName(t.team_name),     C.name,  y, NORMAL, fontColor,   'left');
    drawText(ctx, t.placement_pts, C.place, y, NORMAL, fontColor,   'center');
    drawText(ctx, t.kill_pts,      C.kills, y, NORMAL, fontColor,   'center');
    drawText(ctx, t.total,         C.total, y, NORMAL, accentColor, 'center');
    if (logo && t.wins > 0) drawLogos(ctx, logo, logoW, logoH, logoStartX, y, t.wins, accentColor);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Draw text shrinking font size until it fits within maxW
function cleanTeamName(name) {
  return String(name)
    .replace(/<@!?\d+>/g, '')   // remove user mentions
    .replace(/<@&\d+>/g, '')    // remove role mentions
    .replace(/<#\d+>/g, '')     // remove channel mentions
    .replace(/\s+/g, ' ')       // collapse extra spaces
    .trim();
}

function drawFitText(ctx, text, x, y, baseFontSize, color, maxW) {
  let size = baseFontSize;
  const minSize = Math.max(7, Math.round(baseFontSize * 0.6));
  ctx.font = makeFont(size, false);
  while (ctx.measureText(String(text)).width > maxW && size > minSize) {
    size--;
    ctx.font = makeFont(size, false);
  }
  ctx.save();
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(0,0,0,0.85)';
  ctx.fillText(String(text), x + 1, y + 1);
  ctx.fillStyle    = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

// Measure the actual width used by drawFitText (same shrink logic)
function measureFitText(ctx, text, baseFontSize, maxW) {
  let size = baseFontSize;
  const minSize = Math.max(7, Math.round(baseFontSize * 0.6));
  ctx.font = makeFont(size, false);
  while (ctx.measureText(String(text)).width > maxW && size > minSize) {
    size--;
    ctx.font = makeFont(size, false);
  }
  return Math.min(ctx.measureText(String(text)).width, maxW);
}

function drawLogos(ctx, logo, lw, lh, startX, midY, count, fontColor) {
  const topY  = midY - Math.floor(lh / 2);
  const tight = 2; // px gap between logos

  if (count > 3) {
    // Show single logo + "x{count}" label right next to it
    ctx.drawImage(logo, startX, topY, lw, lh);
    const labelFont = `${Math.round(lh * 0.7)}px "ScrimFont"`;
    ctx.save();
    ctx.font         = labelFont;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(0,0,0,0.7)';
    ctx.fillText(`x${count}`, startX + lw + 3, midY + 1);
    ctx.fillStyle    = fontColor || '#FFD700';
    ctx.fillText(`x${count}`, startX + lw + 2, midY);
    ctx.restore();
  } else {
    // Show up to 3 logos tightly packed
    for (let n = 0; n < count; n++) {
      ctx.drawImage(logo, startX + n * (lw + tight), topY, lw, lh);
    }
  }
}

function scaleX(obj, TW) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * TW)]));
}

module.exports = { generateResultsImage };
