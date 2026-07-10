/**
 * Standalone animal preview for the lobby / character select (BLUEPRINT §11.3,
 * WP-E). Self-contained mini renderer: pedestal, warm key + cool rim light,
 * slow turntable, idle animation. Cheap by design — no shadows, its own rAF
 * that skips work while the document is hidden or the canvas is disconnected.
 */

import * as THREE from 'three';
import type { AnimalId } from '../core/types';
import { AnimalFactory } from './animals/AnimalFactory';
import { makeMockState, type BaseRig } from './animals/Animator';

export interface AnimalPreview {
  setAnimal(a: AnimalId): void;
  dispose(): void;
}

export function createPreview(canvas: HTMLCanvasElement, animal: AnimalId): AnimalPreview {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // transparent — UI supplies the backdrop

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);

  // Warm arena-toned lighting (§11.1): hemisphere fill, warm key, cool rim.
  scene.add(new THREE.HemisphereLight(0xffe8c0, 0x6b5a3e, 0.85));
  const key = new THREE.DirectionalLight(0xffdcae, 2.1);
  key.position.set(2.5, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb7ff, 1.2);
  rim.position.set(-3, 3.5, -3.5);
  scene.add(rim);

  // Turntable: pedestal + rig rotate together.
  const table = new THREE.Group();
  scene.add(table);
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8d8272, roughness: 0.95, flatShading: true });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xc9a23a, roughness: 0.6, metalness: 0.3, flatShading: true });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.6, 0.42, 14), stoneMat);
  pedestal.position.y = -0.21;
  const trim = new THREE.Mesh(new THREE.CylinderGeometry(1.38, 1.38, 0.06, 14), trimMat);
  trim.position.y = 0.0;
  table.add(pedestal, trim);

  let rig: BaseRig | null = null;
  let state = makeMockState(animal);

  const fitCamera = (): void => {
    if (rig === null) return;
    const box = new THREE.Box3().setFromObject(rig.root);
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(size.y, 0.8);
    const w = Math.max(size.x, size.z, 0.8);
    const dist = h * 1.35 + w * 0.8 + 1.3;
    camera.position.set(0.0, h * 0.62 + 0.35, dist);
    camera.lookAt(0, h * 0.48, 0);
  };

  const setAnimal = (a: AnimalId): void => {
    if (rig !== null) {
      table.remove(rig.root);
      rig.dispose();
    }
    rig = AnimalFactory.createRig(a);
    state = makeMockState(a);
    table.add(rig.root);
    fitCamera();
  };
  setAnimal(animal);

  let raf = 0;
  let last = performance.now();
  let lastW = 0;
  let lastH = 0;
  let disposed = false;

  const frame = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    // Pause (skip all work) while hidden or unmounted.
    if (document.hidden || !canvas.isConnected) {
      last = now;
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    table.rotation.y += dt * 0.45; // slow turntable
    if (rig !== null) {
      state.actionT += dt;
      rig.update(state, dt);
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    setAnimal,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      if (rig !== null) {
        table.remove(rig.root);
        rig.dispose();
        rig = null;
      }
      pedestal.geometry.dispose();
      trim.geometry.dispose();
      stoneMat.dispose();
      trimMat.dispose();
      renderer.dispose();
    },
  };
}
