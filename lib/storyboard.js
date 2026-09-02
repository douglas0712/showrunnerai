// Lógica pura do storyboard — testável sem renderizar a UI.

import { makeId } from './rng.js';

export const SCENE_STATUS = {
  DRAFT: 'rascunho',
  PENDING: 'pendente',
  APPROVED: 'aprovado',
  REVISION: 'revisão',
  RENDERED: 'vídeo gerado',
};

export const STATUS_TONE = {
  [SCENE_STATUS.DRAFT]: 'neutral',
  [SCENE_STATUS.PENDING]: 'warn',
  [SCENE_STATUS.APPROVED]: 'ok',
  [SCENE_STATUS.REVISION]: 'alert',
  [SCENE_STATUS.RENDERED]: 'accent',
};

export function createScene(partial = {}) {
  return {
    id: makeId('scene'),
    number: 0,
    title: 'Nova cena',
    description: '',
    duration: 6,
    modelId: 'minimax-h3',
    status: SCENE_STATUS.DRAFT,
    revisionNote: '',
    image: null,
    videoId: null,
    ...partial,
  };
}

/** Renumera as cenas em sequência a partir de 1. */
export function renumber(scenes = []) {
  return scenes.map((scene, index) => ({ ...scene, number: index + 1 }));
}

export function addScene(scenes = [], partial = {}) {
  return renumber([...scenes, createScene(partial)]);
}

export function removeScene(scenes = [], id) {
  return renumber(scenes.filter((scene) => scene.id !== id));
}

/** Move uma cena `delta` posições, sem sair dos limites da lista. */
export function moveScene(scenes = [], id, delta) {
  const index = scenes.findIndex((scene) => scene.id === id);
  if (index === -1) return scenes;
  const target = index + delta;
  if (target < 0 || target >= scenes.length) return scenes;
  const next = [...scenes];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return renumber(next);
}

export function updateScene(scenes = [], id, patch = {}) {
  return scenes.map((scene) => (scene.id === id ? { ...scene, ...patch } : scene));
}

export function approveScene(scenes = [], id) {
  return updateScene(scenes, id, { status: SCENE_STATUS.APPROVED, revisionNote: '' });
}

export function requestSceneRevision(scenes = [], id, note = '') {
  return updateScene(scenes, id, { status: SCENE_STATUS.REVISION, revisionNote: note });
}

export function totalDuration(scenes = []) {
  return scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
}

export function sceneStats(scenes = []) {
  return scenes.reduce(
    (acc, scene) => {
      acc.total += 1;
      if (scene.status === SCENE_STATUS.APPROVED) acc.approved += 1;
      if (scene.status === SCENE_STATUS.REVISION) acc.revision += 1;
      if (scene.status === SCENE_STATUS.RENDERED) acc.rendered += 1;
      return acc;
    },
    { total: 0, approved: 0, revision: 0, rendered: 0 },
  );
}
