// Repositório de Project.
//
// O `id` de um projeto É o segmento de diretório de runtime/projects/<id>/ —
// não existe um segundo identificador. Por isso a validação aqui é a mesma
// `validateSegment` que comfy/storage.js já usa para resolver caminhos: se um
// id passa aqui, ele é seguro como pasta e como trecho de URL, por construção.

import { validateSegment } from '../comfy/storage.js';
import {
  database, DomainError, linha, linhas, newId, textoOuNulo,
} from './db.js';

const ASPECTO_PADRAO = '16:9';

/** Campos que `updateProject` aceita. Qualquer outro é erro, não silêncio. */
const CAMPOS_EDITAVEIS = new Set(['name', 'description', 'aspect']);

/**
 * Cria um projeto.
 *
 * `id` é opcional: quando vem, é validado como segmento seguro (é ele que vai
 * virar diretório); quando não vem, geramos um no mesmo formato dos demais
 * identificadores do servidor.
 */
export function createProject(entrada = {}, db = database()) {
  const {
    id = newId('proj'),
    name,
    description = '',
    aspect = ASPECTO_PADRAO,
    createdAt = Date.now(),
  } = entrada;

  validateSegment(id, 'projectId');

  const nome = String(name ?? '').trim();
  if (!nome) throw new DomainError('O projeto precisa de um nome.', { id });

  if (getProject(id, db)) {
    throw new DomainError(`Já existe um projeto com o id "${id}".`, { id });
  }

  const agora = Number(createdAt) || Date.now();
  db.prepare(`
    INSERT INTO projects (id, name, description, aspect, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, nome, String(description ?? ''), String(aspect || ASPECTO_PADRAO), agora, agora);

  return getProject(id, db);
}

export function getProject(id, db = database()) {
  // Um id inválido não é exceção na leitura: é simplesmente "não existe".
  // Assim quem consulta não precisa envolver toda busca num try/catch.
  if (!ehSegmentoValido(id)) return null;
  return linha(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function listProjects(db = database()) {
  return linhas(db.prepare('SELECT * FROM projects ORDER BY updatedAt DESC, id ASC').all());
}

/**
 * Atualiza nome, descrição e proporção. `updatedAt` é sempre do servidor —
 * quem chama não decide o relógio.
 */
export function updateProject(id, patch = {}, db = database()) {
  const atual = getProject(id, db);
  if (!atual) throw new DomainError(`Projeto desconhecido: "${id}".`, { id });

  const desconhecidos = Object.keys(patch).filter((k) => !CAMPOS_EDITAVEIS.has(k));
  if (desconhecidos.length) {
    throw new DomainError(
      `Campos não editáveis em um projeto: ${desconhecidos.join(', ')}.`,
      { id, desconhecidos, editaveis: [...CAMPOS_EDITAVEIS] },
    );
  }

  if ('name' in patch && !String(patch.name ?? '').trim()) {
    throw new DomainError('O projeto precisa de um nome.', { id });
  }

  const proximo = {
    name: 'name' in patch ? String(patch.name).trim() : atual.name,
    description: 'description' in patch ? String(patch.description ?? '') : atual.description,
    aspect: 'aspect' in patch ? String(patch.aspect || ASPECTO_PADRAO) : atual.aspect,
  };

  db.prepare(`
    UPDATE projects SET name = ?, description = ?, aspect = ?, updatedAt = ?
    WHERE id = ?
  `).run(proximo.name, proximo.description, proximo.aspect, Date.now(), id);

  return getProject(id, db);
}

/**
 * INTERNO — helper de migração/backfill. Não use como caminho de criação.
 *
 * Garante que o projeto existe, criando-o com o mínimo se necessário. É o que
 * o backfill usa: as pastas em runtime/projects/ nasceram antes deste banco
 * existir, então o registro precisa alcançá-las sem que ninguém tenha
 * cadastrado nada. Nunca sobrescreve um projeto já cadastrado.
 *
 * Criação normal de projeto é `createProject`, que exige nome e falha se o id
 * já existe. Esta função é deliberadamente ausente de `index.js`: criar um
 * projeto como efeito colateral de resolver um identificador é justamente o
 * que uma tool `og.*` não deve poder fazer sem intenção explícita.
 */
export function ensureProject(id, padroes = {}, db = database()) {
  const existente = getProject(id, db);
  if (existente) return { project: existente, criado: false };

  const project = createProject({
    id,
    // O nome do diretório é o melhor rótulo disponível; o usuário renomeia depois.
    name: textoOuNulo(padroes.name) || id,
    description: padroes.description ?? '',
    aspect: padroes.aspect ?? ASPECTO_PADRAO,
  }, db);

  return { project, criado: true };
}

/**
 * Registra um projeto que já existe para o usuário, se o servidor ainda não o
 * conhecer.
 *
 * ── Por que não `createProject` nem `ensureProject` ───────────────────────
 *
 * `createProject` falha quando o id já existe: serve para criar algo novo, e
 * abrir a mesma tela duas vezes não é criar duas vezes.
 *
 * `ensureProject` aceita um id solto e inventa o resto. É o que o backfill
 * precisa — as pastas em runtime/projects/ precedem este banco e não há
 * descritor nenhum a consultar — e é exatamente o que NÃO se quer em qualquer
 * outro lugar: um identificador vindo de fora não deveria bastar para
 * materializar um projeto.
 *
 * Esta operação fica no meio, e a diferença está no ARGUMENTO: ela exige o
 * descritor do projeto, com nome. Quem a chama precisa saber o que está
 * registrando, e não apenas repetir um id que recebeu. É essa exigência — e não
 * a boa vontade do chamador — que impede que ela vire uma porta de criação
 * genérica.
 *
 * Nunca sobrescreve um projeto já cadastrado: o que está no servidor é a
 * verdade, e o descritor de quem chega é apenas o que ele acha que sabe.
 */
export function registerProject(descritor = {}, db = database()) {
  if (!descritor || typeof descritor !== 'object') {
    throw new DomainError('O registro de projeto exige um descritor.', {});
  }

  const id = typeof descritor.id === 'string' ? descritor.id.trim() : '';
  if (!id) throw new DomainError('O registro de projeto exige um id.', {});

  const nome = typeof descritor.name === 'string' ? descritor.name.trim() : '';
  if (!nome) {
    // Sem nome não há descritor de verdade — só um id com outra roupa.
    throw new DomainError('O registro de projeto exige um nome.', { projectId: id });
  }

  const existente = getProject(id, db);
  if (existente) return { project: existente, criado: false };

  const project = createProject({
    id,
    name: nome,
    description: typeof descritor.description === 'string' ? descritor.description : '',
    ...(typeof descritor.aspect === 'string' && descritor.aspect
      ? { aspect: descritor.aspect }
      : {}),
  }, db);

  return { project, criado: true };
}

/**
 * Remove o projeto e, por ON DELETE CASCADE, suas cenas e assets.
 *
 * Só o registro: nenhum arquivo em runtime/projects/ é tocado. Apagar bytes é
 * decisão de outra camada, e desta etapa não faz parte.
 */
export function deleteProject(id, db = database()) {
  if (!getProject(id, db)) return false;
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return true;
}

function ehSegmentoValido(valor) {
  try {
    validateSegment(valor, 'projectId');
    return true;
  } catch {
    return false;
  }
}

export { ehSegmentoValido as isValidProjectId };
