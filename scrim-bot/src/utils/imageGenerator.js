// ── Results Image Generator ───────────────────────────────────────────────────
const { createCanvas, loadImage } = require('canvas');

// Detected row midpoints for 1262x920 template (12 rows per side)
const ROW_MIDS = [208, 260, 314, 366, 419, 473, 525, 578, 629, 683, 734, 786];

// LEFT side x positions
const L = {
  slot:      57,
  name:      100,
  placement: 400,
  kills:     493,
  total:     568,
};

// RIGHT side x positions
const R = {
  slot:      672,
  name:      717,
  placement: 1015,
  kills:     1108,
  total:     1183,
};

/**
 * Generate results image
 * @param {string} templatePath
 * @param {Array} teams - sorted { rank, team_name, team_tag, placement_pts, kill_pts, total }
 * @returns {Buffer} PNG buffer
 */
async function generateResultsImage(templatePath, teams) {
  const template = await loadImage(templatePath);
  const canvas   = createCanvas(template.width, template.height);
  const ctx      = canvas.getContext('2d');

  ctx.drawImage(template, 0, 0);

  const count        = teams.length;
  const leftCount    = Math.ceil(count / 2);
  const leftTeams    = teams.slice(0, leftCount);
  const rightTeams   = teams.slice(leftCount);

  const FONT_RANK   = 'bold 18px Sans';
  const FONT_NAME   = '14px Sans';
  const FONT_NUM    = '16px Sans';
  const GOLD        = '#FFD700';
  const WHITE       = '#FFFFFF';
  const SHADOW      = 'rgba(0,0,0,0.9)';

  function drawText(text, x, y, font, color, align = 'center') {
    ctx.font        = font;
    ctx.textAlign   = align;
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur  = 4;
    ctx.fillStyle   = color;
    ctx.fillText(String(text), x, y + 6);
    ctx.shadowBlur  = 0;
  }

  // Scale row positions if fewer than 24 teams
  // If < 24 teams, rows still map 1:1 — just leave empty rows blank
  function drawTeam(t, side, rowIndex) {
    const mid = ROW_MIDS[rowIndex];
    if (!mid) return;
    const s = side === 'L' ? L : R;
    drawText(t.rank,                    s.slot,      mid, FONT_RANK, GOLD,  'center');
    drawText(t.team_name || '-',        s.name,      mid, FONT_NAME, WHITE, 'left');
    drawText(t.placement_pts ?? 0,      s.placement, mid, FONT_NUM,  WHITE, 'center');
    drawText(t.kill_pts ?? 0,           s.kills,     mid, FONT_NUM,  WHITE, 'center');
    drawText(t.total ?? 0,              s.total,     mid, FONT_RANK, GOLD,  'center');
  }

  for (let i = 0; i < leftTeams.length;  i++) drawTeam(leftTeams[i],  'L', i);
  for (let i = 0; i < rightTeams.length; i++) drawTeam(rightTeams[i], 'R', i);

  return canvas.toBuffer('image/png');
}

module.exports = { generateResultsImage };
