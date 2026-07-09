/**
 * `?demo=ui` — cycles every WP-F screen with mock data (BLUEPRINT §14).
 *
 * Keys: `[` previous station · `]` next station. Stations: lobby → character
 * select → difficulty → HUD (fake animated snapshot: countdown, hp drain, ult
 * fill, kill feed, bloodlust, spectate) → pause overlay → results (victory) →
 * results (defeat). Screen buttons also navigate (PLAY → select, etc.).
 */

import { registerDemo } from '../core/demos';
import type { AnimalId, FighterState, WorldSnapshot } from '../core/types';
import { ANIMAL_IDS, ANIMALS } from '../config/animals';
import { el } from './dom';
import {
  Lobby,
  CharacterSelect,
  DifficultySelect,
  HUD,
  PauseMenu,
  Results,
  loadAnimal,
  loadDifficulty,
} from './index';

/** A demo station mounts itself and returns a teardown. */
interface Station {
  name: string;
  mount(host: HTMLElement, nav: (name: string) => void): () => void;
}

// ── Mock snapshot machinery ───────────────────────────────────────────────────

function makeFighter(id: number, animal: AnimalId, isPlayer: boolean): FighterState {
  const def = ANIMALS[animal];
  const a = (id / 10) * Math.PI * 2;
  return {
    id,
    animal,
    isPlayer,
    alive: true,
    pos: { x: Math.sin(a) * 24, y: 0, z: Math.cos(a) * 24 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: a + Math.PI,
    hp: def.hp,
    maxHp: def.hp,
    guard: def.guardMax,
    maxGuard: def.guardMax,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 0,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
  };
}

function makeSnapshot(playerAnimal: AnimalId): WorldSnapshot {
  const roster: AnimalId[] = [playerAnimal, ...ANIMAL_IDS.filter((a) => a !== playerAnimal)];
  return {
    time: 0,
    fighters: roster.map((animal, i) => makeFighter(i, animal, i === 0)),
    pickups: [],
    crates: [],
    bloodlustMult: 1,
    matchOver: false,
    winnerId: -1,
  };
}

// ── HUD station: a fully fake animated match ─────────────────────────────────

function hudStation(withPause: boolean): Station {
  return {
    name: withPause ? 'pause' : 'hud',
    mount(host, nav) {
      const playerAnimal = loadAnimal();
      const snapshot = makeSnapshot(playerAnimal);
      const player = snapshot.fighters[0];
      const hud = new HUD();

      // The HUD floats over the (absent) 3D arena; give the demo a backdrop.
      const backdrop = el('div', { class: 'gk-screen' });
      host.appendChild(backdrop);
      hud.mount(host);

      const timers: number[] = [];
      const later = (fn: () => void, ms: number): void => {
        timers.push(window.setTimeout(fn, ms));
      };

      // 3-2-1-FIGHT.
      hud.countdown(3);
      later(() => hud.countdown(2), 1000);
      later(() => hud.countdown(1), 2000);
      later(() => hud.countdown('FIGHT'), 3000);

      // Kill feed entries on a timer.
      let feedI = 0;
      const feed = window.setInterval(() => {
        const k = ANIMAL_IDS[feedI % 10];
        const v = ANIMAL_IDS[(feedI + 3) % 10];
        hud.killFeed({
          killerAnimal: k,
          victimAnimal: v,
          killerIsPlayer: k === playerAnimal,
          victimIsPlayer: v === playerAnimal,
        });
        feedI++;
      }, 3000);

      // Bloodlust steps.
      later(() => hud.bloodlust(1.25), 12000);
      later(() => hud.bloodlust(1.5), 24000);

      // Spectate stretch near the end of the loop.
      later(() => hud.setSpectate({ name: 'LION (BOT)', animal: 'lion' }), 30000);
      later(() => hud.setSpectate(null), 38000);

      // Animated fake sim: hp drains, ult fills, guard dips, buffs pulse.
      const start = performance.now();
      let raf = 0;
      const tick = (now: number): void => {
        const t = (now - start) / 1000;
        snapshot.time = t;
        const cyc = t % 40;

        player.hp = player.maxHp * Math.max(0.06, 1 - (cyc / 40) * 1.1);
        player.guard = player.maxGuard * (0.5 + 0.5 * Math.sin(t * 0.9));
        player.ultCharge = Math.min(100, (cyc * 100) / 14);
        const cd = ANIMALS[playerAnimal].special.cooldown;
        player.specialCd = Math.max(0, cd - (t % (cd + 3)));
        player.buffs =
          cyc % 12 < 6
            ? [
                { kind: 'speed', t: cyc % 12, dur: 6, mag: 0.3 },
                { kind: 'bleed', t: cyc % 12, dur: 6, mag: 30 },
              ]
            : [];
        if (Math.floor(t * 0.5) % 4 === 0 && Math.random() < 0.03) hud.hitmarker();

        // A bot "dies" every 15 s until 2 remain, then everyone respawns.
        const deadCount = Math.min(8, Math.floor(t / 15));
        for (let i = 1; i < snapshot.fighters.length; i++) {
          snapshot.fighters[i].alive = i > deadCount;
        }

        hud.update(snapshot, 0);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      // Optional pause overlay on top of the animated HUD.
      let pause: PauseMenu | null = null;
      if (withPause) {
        pause = new PauseMenu({
          onResume: () => nav('hud'),
          onQuitToLobby: () => nav('lobby'),
        });
        pause.mount(host);
      }

      return () => {
        cancelAnimationFrame(raf);
        window.clearInterval(feed);
        for (const id of timers) window.clearTimeout(id);
        pause?.unmount();
        hud.unmount();
        backdrop.remove();
      };
    },
  };
}

// ── Results stations ─────────────────────────────────────────────────────────

function resultsStation(victory: boolean): Station {
  return {
    name: victory ? 'results-victory' : 'results-defeat',
    mount(host, nav) {
      const screen = new Results({
        results: {
          victory,
          placement: victory ? 1 : 6,
          animal: loadAnimal(),
          kills: victory ? 5 : 2,
          damageDealt: victory ? 4210 : 1873,
          damageBlocked: victory ? 1120 : 486,
          ultsUsed: victory ? 3 : 1,
          matchTimeS: victory ? 284 : 121,
          difficulty: loadDifficulty(),
        },
        onRematch: () => nav('hud'),
        onChangeGladiator: () => nav('select'),
        onLobby: () => nav('lobby'),
      });
      screen.mount(host);
      return () => screen.unmount();
    },
  };
}

// ── Demo driver ──────────────────────────────────────────────────────────────

registerDemo('ui', (root) => {
  const host = el('div', { attrs: { style: 'position:absolute;inset:0;' } });
  const barName = el('span', { class: 'gk-demobar__name' });
  const bar = el('div', { class: 'gk-demobar' }, [
    el('span', { text: 'UI DEMO' }),
    el('span', { text: '[ prev · ] next' }),
    barName,
  ]);
  root.append(host, bar);

  const stations: Station[] = [
    {
      name: 'lobby',
      mount(h, nav) {
        const s = new Lobby({
          onPlay: () => nav('select'),
          getSelectedAnimal: () => loadAnimal(),
        });
        s.mount(h);
        return () => s.unmount();
      },
    },
    {
      name: 'select',
      mount(h, nav) {
        const s = new CharacterSelect({
          onConfirm: () => nav('difficulty'),
          onBack: () => nav('lobby'),
        });
        s.mount(h);
        return () => s.unmount();
      },
    },
    {
      name: 'difficulty',
      mount(h, nav) {
        const s = new DifficultySelect({
          onStart: () => nav('hud'),
          onBack: () => nav('select'),
        });
        s.mount(h);
        return () => s.unmount();
      },
    },
    hudStation(false),
    hudStation(true),
    resultsStation(true),
    resultsStation(false),
  ];

  let index = 0;
  let teardown: (() => void) | null = null;

  const show = (i: number): void => {
    teardown?.();
    index = ((i % stations.length) + stations.length) % stations.length;
    const station = stations[index];
    barName.textContent = station.name;
    teardown = station.mount(host, (name) => {
      const target = stations.findIndex((s) => s.name === name);
      show(target >= 0 ? target : index + 1);
    });
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === ']') show(index + 1);
    else if (e.key === '[') show(index - 1);
  };
  window.addEventListener('keydown', onKey);

  show(0);

  return () => {
    window.removeEventListener('keydown', onKey);
    teardown?.();
    bar.remove();
    host.remove();
  };
});
