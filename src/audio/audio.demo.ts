/**
 * WP-G audio demo (`?demo=audio`, BLUEPRINT §14): a DOM button board that
 * triggers every synthesised sound — combat SFX, pickups, all 10 roars, ult
 * stingers, swings/specials per animal, crowd bed + excitement slider + cheers,
 * lobby music, and both results fanfares — plus volume sliders wired straight
 * to the {@link AudioEngine} setters, and a synthetic-EventBus section proving
 * the `attachBus` mapping.
 */

import { registerDemo } from '../core/demos';
import { EventBus } from '../core/EventBus';
import type { AnimalId, GameEvent, Vec3 } from '../core/types';
import { ANIMAL_IDS, ANIMALS } from '../config/animals';
import { AudioEngine } from './AudioEngine';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  parent.appendChild(el);
  return el;
}

registerDemo('audio', (root) => {
  const engine = new AudioEngine();
  const bus = new EventBus();
  engine.attachBus(bus);

  const board = h(
    'div',
    {
      fontFamily: 'system-ui, sans-serif',
      color: '#e8e0d0',
      background: '#1a1410',
      minHeight: '100vh',
      padding: '24px',
      boxSizing: 'border-box',
      overflowY: 'auto',
    },
    root,
  );

  const title = h('h1', { margin: '0 0 4px', fontSize: '22px', color: '#d9a441' }, board);
  title.textContent = 'WP-G Audio Demo — every sound, all synthesised';
  const hint = h('p', { margin: '0 0 16px', fontSize: '13px', opacity: '0.7' }, board);
  hint.textContent =
    'Click anything to unlock audio (first gesture resumes the AudioContext). No files, no clicks/pops.';

  function section(name: string): HTMLElement {
    const wrap = h('fieldset', {
      border: '1px solid #4a3a28',
      borderRadius: '8px',
      margin: '0 0 14px',
      padding: '10px 12px',
    }, board);
    const legend = document.createElement('legend');
    legend.textContent = name;
    Object.assign(legend.style, { color: '#d9a441', fontSize: '13px', padding: '0 6px' });
    wrap.appendChild(legend);
    return wrap;
  }

  /** Button that resumes the context first so the very first click is audible. */
  function button(parent: HTMLElement, label: string, fn: () => void): void {
    const b = h('button', {
      margin: '3px',
      padding: '6px 10px',
      background: '#2c2318',
      color: '#e8e0d0',
      border: '1px solid #6b5a3e',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '12px',
    }, parent);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      void engine.resume().then(fn);
    });
  }

  function slider(
    parent: HTMLElement,
    label: string,
    initial: number,
    onInput: (v: number) => void,
  ): HTMLInputElement {
    const wrap = h('label', {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      margin: '3px 14px 3px 3px',
      fontSize: '12px',
    }, parent);
    const span = document.createElement('span');
    span.textContent = label;
    span.style.minWidth = '52px';
    wrap.appendChild(span);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(initial);
    input.addEventListener('input', () => onInput(Number(input.value)));
    wrap.appendChild(input);
    return input;
  }

  // ── Volumes ────────────────────────────────────────────────────────────────
  const vol = section('Volumes (AudioEngine setters — UI persists gk-settings)');
  const s0 = engine.getSettings();
  slider(vol, 'Master', s0.master, (v) => engine.setVolumes({ master: v }));
  slider(vol, 'Music', s0.music, (v) => engine.setVolumes({ music: v }));
  slider(vol, 'SFX', s0.sfx, (v) => engine.setVolumes({ sfx: v }));
  const muteWrap = h('label', { fontSize: '12px', marginLeft: '8px', cursor: 'pointer' }, vol);
  const mute = document.createElement('input');
  mute.type = 'checkbox';
  mute.checked = s0.muted;
  mute.addEventListener('change', () => engine.setMuted(mute.checked));
  muteWrap.appendChild(mute);
  muteWrap.appendChild(document.createTextNode(' Muted'));

  // ── Combat SFX ────────────────────────────────────────────────────────────
  const combat = section('Combat SFX');
  button(combat, 'Hit (thud)', () => engine.hit(false));
  button(combat, 'Heavy hit / finisher', () => engine.finisher());
  button(combat, 'Blocked (ping)', () => engine.blocked());
  button(combat, 'Guard break (crack+boom)', () => engine.guardBreak());
  button(combat, 'Telegraph tick', () => engine.telegraphTick());
  button(combat, 'Crate break', () => engine.crateBreak());
  button(combat, 'Death (thud + gasp→cheer)', () => engine.deathSfx());
  button(combat, 'Match end (eruption)', () => engine.matchEndSfx());
  button(combat, 'UI click', () => engine.uiClick());
  button(combat, 'UI hover', () => engine.uiHover());

  // ── Pickups ───────────────────────────────────────────────────────────────
  const pickups = section('Pickup chimes');
  button(pickups, 'Heal (warm triad)', () => engine.pickupChime('heal'));
  button(pickups, 'Speed (arpeggio up)', () => engine.pickupChime('speed'));
  button(pickups, 'Rage (war drum)', () => engine.pickupChime('rage'));

  // ── v1.2 arena traps + eagle landing ─────────────────────────────────────
  const trapsSec = section('Arena traps + eagle landing (v1.2)');
  button(trapsSec, 'Fire trap trigger (whoosh+crackle)', () => engine.trapTrigger('fire'));
  button(trapsSec, 'Spike trap trigger (clank+thud)', () => engine.trapTrigger('spikes'));
  button(trapsSec, 'Fire damage tick (sizzle)', () => engine.trapTick('fire'));
  button(trapsSec, 'Spike damage tick (stab)', () => engine.trapTick('spikes'));
  button(trapsSec, 'Fire expire (dying hiss)', () => engine.trapExpire('fire'));
  button(trapsSec, 'Spikes retract', () => engine.trapExpire('spikes'));
  button(trapsSec, 'Landing slam (light)', () => engine.landingImpact(1, 30));
  button(trapsSec, 'Landing slam (heavy)', () => engine.landingImpact(1, 55));
  button(trapsSec, 'Far fire trigger (distance 20 m)', () => engine.trapTrigger('fire', 1 / (1 + (20 / 14) ** 2)));
  let bedOn = false;
  button(trapsSec, 'Fire crackle bed on/off', () => {
    bedOn = !bedOn;
    engine.setFireBed(bedOn ? 0.9 : 0);
  });
  const bedTimer = window.setInterval(() => {
    // The bed smooths + idles itself; keep feeding the current level.
    if (bedOn) engine.setFireBed(0.9);
    else engine.setFireBed(0);
  }, 250);

  // ── Per-animal ────────────────────────────────────────────────────────────
  const animalsSec = section('Per-animal: roar · swing (size-pitched) · special · ult stinger+roar');
  const table = h('div', { display: 'grid', gridTemplateColumns: 'auto auto auto auto auto', gap: '2px', alignItems: 'center' }, animalsSec);
  for (const id of ANIMAL_IDS) {
    const def = ANIMALS[id];
    const name = h('span', { fontSize: '12px', color: def.accent, paddingRight: '8px', fontWeight: '600' }, table);
    name.textContent = `${def.displayName} (${def.radius} m)`;
    button(table, 'Roar', () => engine.roar(id));
    button(table, 'Swing', () => engine.swing(id));
    button(table, 'Special', () => engine.special(id));
    button(table, 'Ultimate', () => engine.ultimate(id));
  }

  // ── Crowd ─────────────────────────────────────────────────────────────────
  const crowd = section('Crowd bed');
  button(crowd, 'Start bed', () => engine.startCrowd());
  button(crowd, 'Stop bed', () => engine.stopCrowd());
  slider(crowd, 'Excitement', 0.2, (v) => engine.setExcitement(v));
  button(crowd, 'Spike +0.5', () => engine.spikeExcitement(0.5));
  button(crowd, 'Cheer', () => engine.crowdCheer(false));
  button(crowd, 'Big cheer (bloodlust/victory)', () => engine.crowdCheer(true));

  // ── Music ─────────────────────────────────────────────────────────────────
  const music = section('Music (never mid-match)');
  button(music, 'Play lobby loop (92 BPM Am–F–C–G)', () => engine.playLobbyMusic());
  button(music, 'Stop music', () => engine.stopMusic());
  button(music, 'Victory fanfare', () => engine.playResultsFanfare(true));
  button(music, 'Defeat fanfare', () => engine.playResultsFanfare(false));

  // ── EventBus mapping proof ────────────────────────────────────────────────
  const busSec = section('Synthetic GameEvents through attachBus(bus)');
  const emit = (ev: GameEvent): void => bus.emit(ev);
  button(busSec, "emit hit (heavy)", () =>
    emit({ type: 'hit', attackerId: 0, targetId: 1, damage: 95, pos: ORIGIN, heavy: true }));
  button(busSec, 'emit blocked', () =>
    emit({ type: 'blocked', attackerId: 0, targetId: 1, damage: 30, pos: ORIGIN }));
  button(busSec, 'emit guardBreak', () => emit({ type: 'guardBreak', targetId: 1, pos: ORIGIN }));
  button(busSec, 'emit death', () => emit({ type: 'death', targetId: 1, killerId: 0, placement: 10 }));
  button(busSec, 'emit ultimate (lion)', () => emit({ type: 'ultimate', fighterId: 0, animal: 'lion' }));
  button(busSec, 'emit special (eagle)', () => emit({ type: 'special', fighterId: 0, animal: 'eagle' }));
  button(busSec, 'emit pickup (heal)', () =>
    emit({ type: 'pickup', fighterId: 0, kind: 'heal', pos: ORIGIN }));
  button(busSec, 'emit telegraph', () =>
    emit({ type: 'telegraph', fighterId: 0, kind: 'special', pos: ORIGIN, radius: 2, yaw: 0, arcDeg: 90, windup: 0.35 }));
  button(busSec, 'emit comboFinisher', () => emit({ type: 'comboFinisher', fighterId: 0 }));
  button(busSec, 'emit crateBreak', () => emit({ type: 'crateBreak', crateId: 0, pos: ORIGIN }));
  button(busSec, 'emit matchEnd', () => emit({ type: 'matchEnd', winnerId: 0 }));
  button(busSec, 'emit trapTriggered (fire)', () =>
    emit({ type: 'trapTriggered', trapId: 0, kind: 'fire', pos: ORIGIN, fighterId: 0 }));
  button(busSec, 'emit trapTriggered (spikes)', () =>
    emit({ type: 'trapTriggered', trapId: 1, kind: 'spikes', pos: ORIGIN, fighterId: 0 }));
  button(busSec, 'emit trapDamage ×6 (rate-limited)', () => {
    for (let i = 0; i < 6; i++) {
      emit({ type: 'trapDamage', trapId: 0, kind: i % 2 === 0 ? 'fire' : 'spikes', targetId: i, damage: 6, pos: ORIGIN });
    }
  });
  button(busSec, 'emit trapExpired (fire)', () => emit({ type: 'trapExpired', trapId: 0, kind: 'fire', pos: ORIGIN }));
  button(busSec, 'emit landingImpact', () =>
    emit({ type: 'landingImpact', fighterId: 0, pos: ORIGIN, radius: 3.2, damage: 48, height: 6 }));

  // Quick roar tour: plays each animal's roar in sequence (0.9 s apart).
  const tour = section('Tour');
  let tourTimer: number | null = null;
  button(tour, 'Roar tour (all 10)', () => {
    if (tourTimer !== null) return;
    let i = 0;
    const step = (): void => {
      const id: AnimalId = ANIMAL_IDS[i];
      engine.roar(id);
      i += 1;
      if (i >= ANIMAL_IDS.length) {
        if (tourTimer !== null) clearInterval(tourTimer);
        tourTimer = null;
      }
    };
    step();
    tourTimer = window.setInterval(step, 900);
  });

  return () => {
    if (tourTimer !== null) clearInterval(tourTimer);
    clearInterval(bedTimer);
    engine.detachBus();
    engine.dispose();
    board.remove();
  };
});
