// ── Results Image Generator ───────────────────────────────────────────────────
// Uses canvas (node-canvas) to draw results onto the uploaded template image

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

// Row midpoints on the 1262x920 template (detected from pixel analysis)
const ROW_MIDS = [210, 261, 316, 369, 420, 476, 527, 579, 634, 686, 736, 788];
const DIVIDER_X = 596;

// LEFT side x positions
const L = {
  slot:      58,
  name:      102,
  placement: 400,
  kills:     492,
  total:     548,
};

// RIGHT side x positions  
const R = {
  slot:      650,
  name:      700,
  placement: 1005,
  kills:     1093,
  total:     1158,
};

/**
 * Generate results image
 * @param {string} templatePath - path to the template image file
 * @param {Array} teams - sorted array of { rank, team_name, team_tag, placement_pts, kill_pts, total }
 * @returns {Buffer} PNG image buffer
 */
async function generateResultsImage(templatePath, teams) {
  const template = await loadImage(templatePath);
  const canvas   = createCanvas(template.width, template.height);
  const ctx      = canvas.getContext('2d');

  // Draw template background
  ctx.drawImage(template, 0, 0);

  const slotsPerSide = Math.min(12, Math.ceil(teams.length / 2));
  const leftTeams    = teams.slice(0, slotsPerSide);
  const rightTeams   = teams.slice(slotsPerSide);

  // Font settings
  const FONT_BOLD   = 'bold 19px Sans';
  const FONT_NAME   = '15px Sans';
  const FONT_NORMAL = '16px Sans';
  const GOLD        = '#FFD700';
  const WHITE       = '#FFFFFF';
  const SHADOW      = 'rgba(0,0,0,0.8)';

  function drawText(text, x, y, font, color, align = 'left') {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 4;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 6);
    ctx.shadowBlur = 0;
  }

  // Draw left teams
  for (let i = 0; i < leftTeams.length; i++) {
    const t   = leftTeams[i];
    const mid = ROW_MIDS[i];
    if (!mid) continue;

    drawText(String(t.rank),          L.slot,      mid, FONT_BOLD,   GOLD,  'center');
    drawText(t.team_name || '-',      L.name,      mid, FONT_NAME,   WHITE, 'left');
    drawText(String(t.placement_pts || 0), L.placement, mid, FONT_NORMAL, WHITE, 'center');
    drawText(String(t.kill_pts || 0), L.kills,     mid, FONT_NORMAL, WHITE, 'center');
    drawText(String(t.total || 0),    L.total,     mid, FONT_BOLD,   GOLD,  'center');
  }

  // Draw right teams
  for (let i = 0; i < rightTeams.length; i++) {
    const t   = rightTeams[i];
    const mid = ROW_MIDS[i];
    if (!mid) continue;

    drawText(String(t.rank),          R.slot,      mid, FONT_BOLD,   GOLD,  'center');
    drawText(t.team_name || '-',      R.name,      mid, FONT_NAME,   WHITE, 'left');
    drawText(String(t.placement_pts || 0), R.placement, mid, FONT_NORMAL, WHITE, 'center');
    drawText(String(t.kill_pts || 0), R.kills,     mid, FONT_NORMAL, WHITE, 'center');
    drawText(String(t.total || 0),    R.total,     mid, FONT_BOLD,   GOLD,  'center');
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateResultsImage };
