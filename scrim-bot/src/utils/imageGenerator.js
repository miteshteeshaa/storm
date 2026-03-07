// ── Results Image Generator ───────────────────────────────────────────────────
const { createCanvas, loadImage } = require('canvas');

// Row midpoints — auto-detected from template pixel analysis
// These work for both 902x621 and 1920x1080 templates (scaled dynamically)
const BASE_ROW_MIDS = [146, 184, 222, 259, 297, 334, 371, 409, 446, 483, 520];
const BASE_W = 902;
const BASE_H = 621;

// Column positions (for 902x621 base)
const BASE_L = { rank:15,  name:52,  place:218, kills:264, total:308 };
const BASE_R = { rank:388, name:426, place:700, kills:780, total:840 };

async function generateResultsImage(templatePath, teams) {
  const template = await loadImage(templatePath);
  const TW = template.width;
  const TH = template.height;

  const canvas = createCanvas(TW, TH);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0);

  // Scale factors relative to base template size
  const sx = TW / BASE_W;
  const sy = TH / BASE_H;

  const rowMids = BASE_ROW_MIDS.map(y => Math.round(y * sy));
  const L = Object.fromEntries(Object.entries(BASE_L).map(([k,v]) => [k, Math.round(v * sx)]));
  const R = Object.fromEntries(Object.entries(BASE_R).map(([k,v]) => [k, Math.round(v * sx)]));

  const fontSize     = Math.round(13 * sx);
  const fontSizeSm   = Math.round(11 * sx);
  const FONT_BOLD    = `bold ${fontSize}px Sans`;
  const FONT_NORMAL  = `${fontSizeSm}px Sans`;
  const GOLD         = '#FFD700';
  const WHITE        = '#FFFFFF';

  function drawText(text, x, y, font, color) {
    ctx.font      = font;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(String(text), x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(String(text), x, y);
  }

  const slotsPerSide = Math.ceil(teams.length / 2);
  const leftTeams    = teams.slice(0, slotsPerSide);
  const rightTeams   = teams.slice(slotsPerSide);

  for (let i = 0; i < rowMids.length; i++) {
    const y = rowMids[i] - Math.round(7 * sy);

    if (i < leftTeams.length) {
      const t = leftTeams[i];
      ctx.textAlign = 'left';
      drawText(t.rank,          L.rank,  y, FONT_BOLD,   GOLD);
      drawText(t.team_name,     L.name,  y, FONT_NORMAL, WHITE);
      drawText(t.placement_pts, L.place, y, FONT_NORMAL, WHITE);
      drawText(t.kill_pts,      L.kills, y, FONT_NORMAL, WHITE);
      drawText(t.total,         L.total, y, FONT_BOLD,   GOLD);
    }

    if (i < rightTeams.length) {
      const t = rightTeams[i];
      ctx.textAlign = 'left';
      drawText(t.rank,          R.rank,  y, FONT_BOLD,   GOLD);
      drawText(t.team_name,     R.name,  y, FONT_NORMAL, WHITE);
      drawText(t.placement_pts, R.place, y, FONT_NORMAL, WHITE);
      drawText(t.kill_pts,      R.kills, y, FONT_NORMAL, WHITE);
      drawText(t.total,         R.total, y, FONT_BOLD,   GOLD);
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateResultsImage };
