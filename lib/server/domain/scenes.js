// Repositório de Scene.
//
// A forma da cena não é inventada aqui: ela vem de `createScene()` em
// lib/storyboard.js, que já é a definição da aplicação e é coberta por
// tests/storyboard.test.mjs. Este módulo acrescenta o que faltava para o
// registro viver no servidor — `projectId` e persistência — e reaproveita
// `renumber()` para a renumeração, em vez de reescrever a regra.

import {
  createScene as novaCena, renumber, SCENE_STATUS,
} from '../../storyboard.js';
import {
  database, DomainError, linha, linhas, newId, numeroOuNulo, SCENE_STATUS_VALUES, textoOuNulo,
} from './db.js';
import { getProject } from './projects.js';

/** Campos que `updateScene` aceita. `id` e `projectId` não se editam. */
const CAMPOS_EDITAVEIS = new Set([
  'number', 'title', 'description', 'duration', 'modelId',
  'status', 'revisionNote', 'image', 'videoId',
]);

/**
 * Cria uma cena dentro de um projeto.
 *
 * Sem `number`, a cena entra no fim da fila do projeto. Sem `status`, herda o
 * padrão de `createScene()` — que hoje é rascunho.
 */
export function createSceneRecord(entrada = {}, db = database()) {
  const { projectId } = entrada;

  if (!getProject(projectId, db)) {
    throw new DomainError(`Projeto desconhecido: "${projectId}".`, { projectId });
  }

  // A base vem da função que a aplicação já usa; só substituímos o que é do
  // servidor (o id) e o que depende do projeto (a numeração).
  const base = novaCena(entrada);
  const id = entrada.id || newId('scene');
  const number = Number.isFinite(Number(entrada.number)) && Number(entrada.number) > 0
    ? Math.trunc(Number(entrada.number))
    : proximoNumero(projectId, db);

  validarStatus(base.status);

  const agora = Number(entrada.createdAt) || Date.now();

  db.prepare(`
    INSERT INTO scenes (
      id, projectId, number, title, description, duration, modelId,
      status, revisionNote, image, videoId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    number,
    String(base.title ?? 'Nova cena'),
    String(base.description ?? ''),
    numeroOuNulo(base.duration) ?? 6,
    textoOuNulo(base.modelId),
    base.status,
    String(base.revisionNote ?? ''),
    textoOuNulo(base.image),
    textoOuNulo(base.videoId),
    agora,
    agora,
  );

  return getScene(id, db);
}

export function getScene(id, db = database()) {
  if (typeof id !== 'string' || !id) return null;
  return linha(db.prepare('SELECT * FROM scenes WHERE id = ?').get(id));
}

/**
 * Cenas do projeto na ordem da produção.
 *
 * O desempate por `createdAt` e `id` mantém a ordem estável quando duas cenas
 * dividem o mesmo número — o que acontece enquanto uma reordenação está pela
 * metade.
 */
export function listScenes(projectId, db = database()) {
  return linhas(db.prepare(`
    SELECT * FROM scenes WHERE projectId = ?
    ORDER BY number ASC, createdAt ASC, id ASC
  `).all(projectId));
}

export function updateSceneRecord(id, patch = {}, db = database()) {
  const atual = getScene(id, db);
  if (!atual) throw new DomainError(`Cena desconhecida: "${id}".`, { id });

  const desconhecidos = Object.keys(patch).filter((k) => !CAMPOS_EDITAVEIS.has(k));
  if (desconhecidos.length) {
    throw new DomainError(
      `Campos não editáveis em uma cena: ${desconhecidos.join(', ')}.`,
      { id, desconhecidos, editaveis: [...CAMPOS_EDITAVEIS] },
    );
  }

  if ('status' in patch) validarStatus(patch.status);

  const proximo = { ...atual, ...patch };

  db.prepare(`
    UPDATE scenes SET
      number = ?, title = ?, description = ?, duration = ?, modelId = ?,
      status = ?, revisionNote = ?, image = ?, videoId = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    Math.trunc(Number(proximo.number)) || atual.number,
    String(proximo.title ?? ''),
    String(proximo.description ?? ''),
    numeroOuNulo(proximo.duration) ?? 0,
    textoOuNulo(proximo.modelId),
    proximo.status,
    String(proximo.revisionNote ?? ''),
    textoOuNulo(proximo.image),
    textoOuNulo(proximo.videoId),
    Date.now(),
    id,
  );

  return getScene(id, db);
}

export function removeSceneRecord(id, db = database()) {
  if (!getScene(id, db)) return false;
  db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
  return true;
}

/**
 * Renumera as cenas do projeto em 1..n, na ordem atual.
 *
 * A regra vem de `renumber()` de lib/storyboard.js — a mesma que a tela usa.
 * Só a leitura e a escrita são daqui.
 */
export function renumberScenes(projectId, db = database()) {
  const atuais = listScenes(projectId, db);
  const renumeradas = renumber(atuais);

  const stmt = db.prepare('UPDATE scenes SET number = ?, updatedAt = ? WHERE id = ?');
  const agora = Date.now();

  db.exec('BEGIN');
  try {
    for (const cena of renumeradas) {
      const anterior = atuais.find((c) => c.id === cena.id);
      if (anterior && anterior.number === cena.number) continue;
      stmt.run(cena.number, agora, cena.id);
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listScenes(projectId, db);
}

function proximoNumero(projectId, db) {
  const { maior } = db
    .prepare('SELECT COALESCE(MAX(number), 0) AS maior FROM scenes WHERE projectId = ?')
    .get(projectId);
  return Number(maior) + 1;
}

function validarStatus(status) {
  if (!SCENE_STATUS_VALUES.includes(status)) {
    throw new DomainError(
      `Status de cena desconhecido: "${status}".`,
      { status, aceitos: SCENE_STATUS_VALUES },
    );
  }
  return status;
}

export { SCENE_STATUS };
