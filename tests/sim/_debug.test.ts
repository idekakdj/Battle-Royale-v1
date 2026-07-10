import { describe, it } from 'vitest';
import { liveWorld, neutral, DT } from './helpers';

describe('debug eagle gale', () => {
  it('trace', () => {
    const { world } = liveWorld(['eagle', 'hippo'], 7);
    const c = world.fighters[0];
    const t = world.fighters[1];
    c.state.pos = { x: 0, y: 0, z: 0 };
    c.state.yaw = 0;
    t.state.pos = { x: 0, y: 0, z: 3 };
    c.state.specialCd = 0;
    const press = neutral();
    press.special = true;
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 35; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
      if (i % 5 === 0 || i === 34) {
        // eslint-disable-next-line no-console
        console.log(
          `i=${i} phase=${c.ability ? c.ability.phase : 'none'} yaw=${c.state.yaw.toFixed(3)} cpos=(${c.state.pos.x.toFixed(2)},${c.state.pos.z.toFixed(2)},${c.state.pos.y.toFixed(2)}) tpos=(${t.state.pos.x.toFixed(2)},${t.state.pos.z.toFixed(2)}) thp=${t.state.hp} action=${c.state.action}`,
        );
      }
    }
  });
});
