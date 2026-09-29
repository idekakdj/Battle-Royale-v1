/**
 * Quick-start match demo (`?demo=match&animal=lion&difficulty=4&seed=123`),
 * v1.2 WP-P: mounts a real {@link MatchController} straight away (no menus) so
 * traps, landing slams and the swing-sector / range-indicator work can be
 * verified in live play. `window.__gkMatch` exposes the controller for
 * inspection from the console. Results / quit simply restart the match.
 */

import { registerDemo } from '../core/demos';
import type { AnimalId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';
import { AudioEngine } from '../audio/AudioEngine';
import { MatchController } from './MatchController';

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

registerDemo('match', (root) => {
  const params = new URLSearchParams(window.location.search);
  const a = params.get('animal');
  const animal: AnimalId = a !== null && (ANIMAL_IDS as readonly string[]).includes(a) ? (a as AnimalId) : 'lion';
  const d = Number(params.get('difficulty') ?? 4);
  const difficulty = (d >= 1 && d <= 4 ? Math.round(d) : 4) as Difficulty;
  const s = Number(params.get('seed'));
  let seed = Number.isFinite(s) && s > 0 ? s : Date.now();
  const canvas = ensureCanvas();
  const audio = new AudioEngine();
  let mc: MatchController | null = null;

  const start = (): void => {
    mc?.unmount();
    mc = new MatchController({
      canvas,
      audio,
      animal,
      difficulty,
      seed,
      onMatchEnd: () => {
        seed += 1;
        start();
      },
      onQuitToLobby: () => start(),
    });
    mc.mount(root);
    (window as unknown as { __gkMatch?: MatchController }).__gkMatch = mc;
  };
  start();

  return () => {
    mc?.unmount();
    mc = null;
    delete (window as unknown as { __gkMatch?: MatchController }).__gkMatch;
    audio.dispose();
  };
});
