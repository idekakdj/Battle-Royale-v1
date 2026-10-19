/**
 * Ocean Dome layout QA (v1.10, docs/OCEAN-HEIGHTS-PLAN.md): run with `npx vite-node scripts/ocean-layout.ts`.
 *
 * Prints, for `OCEAN_ARENA`:
 *   - an ASCII height map, 1 m cells, x to the right and z DOWN (like the top-view of the game), one character per height band
 *       .  seabed 0 m        :  terrace 1.5 m        =  plateau 3 m        #  sea-stack top 6.5 m
 *       0-6 ramp cell, the digit is the whole metres of its height (ramp wedge between the levels)
 *       ,  seabed cell a body (r 1.2) cannot stand on (cliff within 1.2 m)   -  the same on the terrace/plateau/ramps
 *     overlaid with  S spawn seat   P pickup pad   C coral   R rock   a arch   x crate
 *   - the stack / ramp tables (grades, widths, lengths) and the upper routes (tuck, rim clearance)
 *   - the serpent lane bin counts (low / high of 360)
 *   - the rule violations of tests/config/oceanRules.ts (empty = fine) and the reachability result (every seat -> every pad, stack top, ...)
 *
 * Options:  `--no-rules` skips the rule + reachability pass.   `--quick` skips only the (slower) reachability (about 15 s).   `--blocked` marks cells a body
 * of radius 1.2 cannot stand on (cliff within 1.2 m): `,` on the seabed, `-` elsewhere.
 */

import { OCEAN_ARENA as O, OCEAN_STACKS, OCEAN_UPPER_HEIGHT, arenaCliffDistance, arenaGroundHeight, arenaSlopeAt } from '../src/config/arenas';
import { serpentLaneBins } from '../src/config/serpentLanes';
import { OCEAN_RULES, FIGHTER_R, describeRamp, rampRole, rampsOf, reachability, upperRoutes } from '../tests/config/oceanRules';

const args = new Set(process.argv.slice(2));
const W = O.wallRadius;

function levelChar(h: number): string {
  if (Math.abs(h - 0) < 1e-9) return '.';
  if (Math.abs(h - 1.5) < 1e-9) return ':';
  if (Math.abs(h - 3) < 1e-9) return '=';
  if (Math.abs(h - OCEAN_UPPER_HEIGHT) < 1e-9) return '#';
  return '?';
}

function buildMap(): string[] {
  const cells: string[][] = [];
  for (let z = -W; z <= W; z++) {
    const row: string[] = [];
    for (let x = -W; x <= W; x++) {
      if (Math.hypot(x, z) > W) {
        row.push(' ');
        continue;
      }
      const h = arenaGroundHeight(O, x, z);
      let ch = levelChar(h);
      if (ch === '?' || arenaSlopeAt(O, x, z) > 0) ch = String(Math.min(9, Math.floor(h + 1e-9)));
      if (args.has('--blocked') && arenaCliffDistance(O, x, z) < FIGHTER_R) ch = h === 0 ? ',' : '-';
      row.push(ch);
    }
    cells.push(row);
  }
  const put = (x: number, z: number, ch: string): void => {
    const i = Math.round(z) + W;
    const j = Math.round(x) + W;
    if (cells[i] !== undefined && cells[i][j] !== undefined) cells[i][j] = ch;
  };
  for (const c of O.circles) {
    for (let z = Math.floor(c.z - c.radius); z <= Math.ceil(c.z + c.radius); z++) {
      for (let x = Math.floor(c.x - c.radius); x <= Math.ceil(c.x + c.radius); x++) {
        if (Math.hypot(x - c.x, z - c.z) <= c.radius) put(x, z, c.kind === 'coral' ? 'C' : 'R');
      }
    }
  }
  for (const s of O.segments) {
    for (let k = 0; k <= 20; k++) put(s.ax + ((s.bx - s.ax) * k) / 20, s.az + ((s.bz - s.az) * k) / 20, 'a');
  }
  for (const c of O.crates) put(c.x, c.z, 'x');
  for (const p of O.pickupPads) put(p.x, p.z, 'P');
  for (const s of O.spawns) put(s.x, s.z, 'S');
  return cells.map((r) => r.join(''));
}

const map = buildMap();
console.log(`Ocean Dome layout (wall ${W} m; x to the right, z down; 1 m cells)\n`);
console.log('      ' + Array.from({ length: 2 * W + 1 }, (_, i) => (i - W) % 10 === 0 ? String(Math.abs(i - W) / 10 % 10) : ' ').join(''));
map.forEach((line, i) => console.log(`${String(i - W).padStart(4)}  ${line}`));

console.log('\nStacks (upper platforms, top ' + OCEAN_UPPER_HEIGHT + ' m):');
for (const s of OCEAN_STACKS) {
  const pad = O.pickupPads.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) < s.radius);
  console.log(`  deg ${s.deg}  centre (${s.x.toFixed(2)}, ${s.z.toFixed(2)})  radius ${s.radius}  pads on top: ${pad.map((p) => p.id).join(',') || 'NONE'}`);
}

console.log('\nRamps:');
const ramps = rampsOf(O);
ramps.forEach((r, i) => console.log(`  ${String(i).padStart(2)} ${describeRamp(O, r)}`));
const roles: Record<string, number> = {};
for (const r of ramps) roles[rampRole(r)] = (roles[rampRole(r)] ?? 0) + 1;
console.log('  counts:', JSON.stringify(roles));

console.log('\nUpper routes (a long lower piece + a short gentle top piece each; the tower rim must stay >= 1.2 m from the biggest body while the ground is more than a step below the top):');
for (const rt of upperRoutes(O)) {
  const si = OCEAN_STACKS.findIndex((s) => s.x === rt.stack.x && s.z === rt.stack.z);
  const footR = Math.hypot(rt.foot.x, rt.foot.z);
  const footA = ((Math.atan2(rt.foot.z, rt.foot.x) * 180) / Math.PI + 360) % 360;
  const g = (p: { h0: number; h1: number; length: number }): string => (Math.abs(p.h1 - p.h0) / p.length).toFixed(3);
  console.log(
    `  tower ${si} (deg ${OCEAN_STACKS[si].deg}) <- from the ${rt.baseHeight === 3 ? 'plateau ' : 'terrace '} foot at r ${footR.toFixed(1)} deg ${footA.toFixed(0)}: lower grade ${g(rt.lower)} (${rt.lower.length} m), top grade ${g(rt.top)} (${rt.top.length} m), tuck ${(rt.stack.radius - rt.endDist).toFixed(2)} m, rim clear at the landing ${(rt.top.length + rt.endDist - rt.stack.radius).toFixed(2)} m`,
  );
}

const bins = serpentLaneBins(O);
console.log(`\nSerpent lanes: low ${bins.low.length} bins (need >= 150), high ${bins.high.length} bins (need >= 80), of 360`);

if (!args.has('--no-rules')) {
  console.log('\nRule violations (empty = ok):');
  let total = 0;
  for (const [name, rule] of Object.entries(OCEAN_RULES)) {
    const bad = rule(O);
    total += bad.length;
    console.log(`  ${name}: ${bad.length === 0 ? 'ok' : bad.length + ' violation(s)'}`);
    for (const b of bad.slice(0, 12)) console.log('      ' + b);
    if (bad.length > 12) console.log(`      ... ${bad.length - 12} more`);
  }
  if (args.has('--quick')) {
    console.log(total === 0 ? '\nRULES OK (reachability skipped)' : '\nFIX THE ABOVE');
    process.exit(0);
  }
  const rep = reachability(O);
  console.log(`\nReachability (grid 0.5 m, body r ${FIGHTER_R}, ramps only): ${rep.missing.length === 0 ? 'every seat reaches every seat, pad, stack top and crate pile' : rep.missing.length + ' MISSING'}`);
  for (const m of rep.missing.slice(0, 20)) console.log('      ' + m);
  const fin = rep.toCentre.filter((d) => Number.isFinite(d));
  if (fin.length > 0) console.log(`  walk to the centre pad: ${Math.min(...fin).toFixed(1)} - ${Math.max(...fin).toFixed(1)} m; ${(rep.reachedFraction * 100).toFixed(1)}% of walkable cells reachable from seat 0`);
  const padMax = rep.toPads.map((row) => row.map((d) => (Number.isFinite(d) ? d : -1)));
  console.log('  pad id:                 ' + O.pickupPads.map((p) => String(p.id).padStart(5)).join(''));
  console.log('  pad height:             ' + O.pickupPads.map((p) => arenaGroundHeight(O, p.x, p.z).toFixed(1).padStart(5)).join(''));
  console.log('  nearest seat (m):       ' + O.pickupPads.map((_, k) => Math.min(...padMax.map((row) => row[k])).toFixed(0).padStart(5)).join(''));
  console.log('  farthest seat (m):      ' + O.pickupPads.map((_, k) => Math.max(...padMax.map((row) => row[k])).toFixed(0).padStart(5)).join(''));
  console.log(total === 0 && rep.missing.length === 0 ? '\nALL GOOD' : '\nFIX THE ABOVE');
}
