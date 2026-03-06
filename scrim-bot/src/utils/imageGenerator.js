// ── Results Image Generator ───────────────────────────────────────────────────
// Uses percentage-based positioning so ANY template image works automatically.
//
// TEMPLATE DESIGN SPEC (share this with admins):
// ─────────────────────────────────────────────────────────────────────────────
// • Canvas is split into LEFT (0–50%) and RIGHT (50–100%) halves
// • Each half has 12 data rows, evenly spaced from 15.5% to 87.5% of height
// • Column positions (% of width) per half:
//     # (rank)   :  3.0%
//     Team Name  :  7.5%  (left-aligned)
//     Placement  : 38.5%
//     Kills      : 45.5%
//     Total      : 51.0%
// • Right half uses the same columns + 50% offset
// • Leave header above 15% and footer below 88% for branding / logos
// ─────────────────────────────────────────────────────────────────────────────

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');

// ── Layout constants (all as % of image dimensions) ──────────────────────────
const ROWS       = 12;
const ROW_START  = 0.155;   // first row Y (% of height)
const ROW_END    = 0.875;   // last row Y  (% of height)
const R_OFFSET   = 0.500;   // right-half X offset (% of width)

// Column X positions — LEFT half (% of width)
const COL = {
  slot:      0.030,
  name:      0.075,
  placement: 0.385,
  kills:     0.455,
  total:     0.510,
};

/**
 * Generate a results leaderboard image.
 *
 * @param {string} templatePath  - absolute path to the background PNG/JPG
 * @param {Array}  teams         - sorted array of team objects:
 *   { rank, team_name, team_tag, placement_pts, kill_pts, total }
 * @returns {Buffer} PNG image buffer
 */
async function generateResultsImage(templatePath, teams) {
  const template = await loadImage(templatePath);
  const W = template.width;
  const H = template.height;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Draw background template
  ctx.drawImage(template, 0, 0);

  // ── Compute pixel positions from percentages ─────────────────────────────
  const rowYs = [];
  for (let i = 0; i < ROWS; i++) {
    rowYs.push(Math.round((ROW_START + i * (ROW_END - ROW_START) / (ROWS - 1)) * H));
  }

  // Font sizes scale with image height
  const fzRank  = Math.max(10, Math.round(H * 0.026));  // bold rank/total
  const fzName  = Math.max(9,  Math.round(H * 0.021));  // team name
  const fzNum   = Math.max(9,  Math.round(H * 0.023));  // placement/kills

  // ── Text drawing helper ──────────────────────────────────────────────────
  function drawText(text, xPct, y, fontSize, color, bold = false, align = 'center') {
    const x = Math.round(xPct * W);
    ctx.font        = `${bold ? 'bold ' : ''}${fontSize}px Sans`;
    ctx.textAlign   = align;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur  = 5;
    ctx.fillStyle   = color;
    ctx.fillText(String(text ?? ''), x, y);
    ctx.shadowBlur  = 0;
  }

  // ── Draw one team row ────────────────────────────────────────────────────
  function drawTeam(team, rowIndex, side) {
    const y      = rowYs[rowIndex];
    if (y === undefined) return;
    const offset = side === 'R' ? R_OFFSET : 0;

    const GOLD  = '#FFD700';
    const WHITE = '#FFFFFF';

    drawText(team.rank,                   COL.slot      + offset, y, fzRank, GOLD,  true,  'center');
    drawText(team.team_name || '-',       COL.name      + offset, y, fzName, WHITE, false, 'left');
    drawText(team.placement_pts ?? 0,     COL.placement + offset, y, fzNum,  WHITE, false, 'center');
    drawText(team.kill_pts ?? 0,          COL.kills     + offset, y, fzNum,  WHITE, false, 'center');
    drawText(team.total ?? 0,             COL.total     + offset, y, fzRank, GOLD,  true,  'center');
  }

  // ── Split teams into left (rows 1-12) and right (rows 13-24) ────────────
  const leftTeams  = teams.slice(0, ROWS);
  const rightTeams = teams.slice(ROWS, ROWS * 2);

  for (let i = 0; i < leftTeams.length;  i++) drawTeam(leftTeams[i],  i, 'L');
  for (let i = 0; i < rightTeams.length; i++) drawTeam(rightTeams[i], i, 'R');

  return canvas.toBuffer('image/png');
}

module.exports = { generateResultsImage };
