/**
 * Drives the real Hud against a minimal DOM shim to see whether the timing
 * tower actually re-renders as the standings change.
 */
class El {
  className = '';
  textContent = '';
  readonly style: Record<string, string> = {};
  readonly children: El[] = [];
  appendChild(c: El): El { this.children.push(c); return c; }
  remove(): void {}
  setAttribute(): void {}
  getAttribute(): string | null { return null; }
  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() { return { width: 200, height: 200, left: 0, top: 0 }; }
  set innerHTML(_v: string) { this.children.length = 0; }
  get innerHTML(): string { return ''; }
  readonly classList = { add(): void {}, remove(): void {}, toggle(): void {} };
}

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  createElement: () => new El(),
  createElementNS: () => new El(),
  getElementById: () => new El(),
  body: new El(),
};
g.window = {
  innerWidth: 1600, innerHeight: 1000, devicePixelRatio: 1,
  setTimeout: () => 0, clearTimeout: () => {},
  addEventListener: () => {}, requestAnimationFrame: () => 0,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};

const { Hud } = await import('../src/ui/Hud');
const { RaceEngine } = await import('../src/race/RaceEngine');
const { getCircuit } = await import('../src/data/tracks/circuits');
const { PHYSICS_DT } = await import('../src/core/SimClock');

const def = getCircuit('monza');
const engine = new RaceEngine(def, {
  kind: 'race', name: 'GP', durationS: 0, laps: 60,
  playerIndex: 0, standingStart: true, pitLaneStart: false, seed: 4242,
} as never);

const root = new El();
const hud = new Hud(root as never);
const player = engine.cars[0];
const input = {
  ersMode: 'balanced', touchActive: false, steerAxis: 0, throttleAxis: 0,
  brakeAxis: 0, drsHeld: false, joystickVector: { x: 0, y: 0 },
} as never;

// Reach into the private rows to read what the tower is actually displaying.
const rowsOf = (): string[] =>
  ((hud as unknown as { rows: { code: El }[] }).rows)
    .filter((r) => (r as unknown as { root: El }).root.style.display !== 'none')
    .map((r) => r.code.textContent);

let lastTower = '';
let lastStandings = '';
let towerChanges = 0;
let standingsChanges = 0;
let mismatches = 0;

for (let t = 0; t < 2400; t++) {
  for (let i = 0; i < Math.round(1 / PHYSICS_DT); i++) engine.step();
  if (engine.over) break;
  hud.update(engine, player, input, 60, 100);

  const tower = rowsOf().join(',');
  const shown = rowsOf().length;
  const standings = engine.standings.slice(0, shown).map((c) => c.driver.code).join(',');

  if (tower !== lastTower) { towerChanges++; lastTower = tower; }
  if (standings !== lastStandings) { standingsChanges++; lastStandings = standings; }
  if (tower !== standings) {
    if (mismatches < 5) {
      console.log(`MISMATCH t=${t}\n  tower     = ${tower}\n  standings = ${standings}`);
    }
    mismatches++;
  }
}

const rowObjs = (hud as unknown as { rows: { code: El; gap: El; pos: El; root: El }[] }).rows;
console.log('\nfinal tower as displayed:');
for (const r of rowObjs) {
  if (r.root.style.display === 'none') continue;
  console.log(`  ${r.pos.textContent.padStart(2)} ${r.code.textContent.padEnd(5)} ${r.gap.textContent}`);
}
console.log('\nleader lap', engine.standings[0].lap, '  laps of others:',
  engine.standings.map((c) => c.lap).join(','));
console.log('lapsDown:', engine.standings.map((c) => `${c.driver.code}:${c.lapsDown}`).join(' '));

console.log('');
console.log('standings order changed on', standingsChanges, 'sampled frames');
console.log('tower text changed on     ', towerChanges, 'sampled frames');
console.log('frames where the tower disagreed with the standings:', mismatches);
