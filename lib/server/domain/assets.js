// Repositório de Asset — a entidade que hoje não existe no servidor.
//
// Um Asset é o registro de um arquivo que a aplicação produziu: os bytes
// continuam onde sempre estiveram, em runtime/projects/<projectId>/, e este
// módulo guarda só a metadata que hoje vive espalhada no localStorage do
// navegador (prompt, seed, modelo, aprovação) mais a linhagem entre eles.
//
// `derivedFromAssetId` é o campo que faz "anime essa imagem" ser possível:
// o vídeo aponta explicitamente para a imagem que o originou.
//
// Não confundir com lib/server/export/assets.js, que resolve identificador →
// caminho em disco. Aquele é a allowlist de segurança e continua valendo como
// defesa em profundidade; este é o modelo de domínio.

import { APPROVAL } from '../../approval.js';
import {
  ASSET_KINDS, ASSET_STATUS, database, DomainError, inteiroOuNulo, linha, linhas,
  newId, numeroOuNulo, textoOuNulo,
} from './db.js';
import { getProject } from './projects.js';

/** Profundidade máxima ao subir a linhagem — trava contra dado circular. */
const LIMITE_LINHAGEM = 32;

/**
 * Registra um asset.
 *
 * Nada é escrito, movido ou lido em disco aqui: `bytes`, `width` e afins são
 * informados por quem já conhece o arquivo. Este módulo não toca em mídia.
 */
export function createAsset(entrada = {}, db = database()) {
  const {
    id = newId('asset'),
    projectId,
    kind,
    jobId = null,
    filename = null,
    url = null,
    mimeType = null,
    bytes = null,
    width = null,
    height = null,
    durationSeconds = null,
    prompt = null,
    seed = null,
    modelId = null,
    derivedFromAssetId = null,
    status = APPROVAL.PENDING,
    createdAt = Date.now(),
  } = entrada;

  if (!getProject(projectId, db)) {
    throw new DomainError(`Projeto desconhecido: "${projectId}".`, { projectId });
  }
  if (!ASSET_KINDS.includes(kind)) {
    throw new DomainError(
      `Tipo de asset desconhecido: "${kind}".`,
      { kind, aceitos: ASSET_KINDS },
    );
  }
  if (!ASSET_STATUS.includes(status)) {
    throw new DomainError(
      `Status de asset desconhecido: "${status}".`,
      { status, aceitos: ASSET_STATUS },
    );
  }

  // A origem é conferida antes do INSERT para que a mensagem diga o que houve.
  // A chave estrangeira continua no esquema como rede de segurança.
  if (derivedFromAssetId !== null && derivedFromAssetId !== undefined) {
    if (derivedFromAssetId === id) {
      throw new DomainError('Um asset não pode derivar de si mesmo.', { id });
    }
    if (!getAsset(derivedFromAssetId, db)) {
      throw new DomainError(
        `Asset de origem desconhecido: "${derivedFromAssetId}".`,
        { derivedFromAssetId },
      );
    }
  }

  const nomeArquivo = textoOuNulo(filename);
  if (nomeArquivo && findAssetByFile(projectId, nomeArquivo, db)) {
    throw new DomainError(
      `O arquivo "${nomeArquivo}" já está registrado no projeto "${projectId}".`,
      { projectId, filename: nomeArquivo },
    );
  }

  db.prepare(`
    INSERT INTO assets (
      id, projectId, kind, jobId, filename, url, mimeType, bytes,
      width, height, durationSeconds, prompt, seed, modelId,
      derivedFromAssetId, status, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    kind,
    textoOuNulo(jobId),
    nomeArquivo,
    textoOuNulo(url),
    textoOuNulo(mimeType),
    inteiroOuNulo(bytes),
    inteiroOuNulo(width),
    inteiroOuNulo(height),
    numeroOuNulo(durationSeconds),
    textoOuNulo(prompt),
    inteiroOuNulo(seed),
    textoOuNulo(modelId),
    textoOuNulo(derivedFromAssetId),
    status,
    Number(createdAt) || Date.now(),
  );

  return getAsset(id, db);
}

export function getAsset(id, db = database()) {
  if (typeof id !== 'string' || !id) return null;
  return linha(db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
}

/** O asset gravado para um arquivo do projeto — a chave que o backfill usa. */
export function findAssetByFile(projectId, filename, db = database()) {
  if (!projectId || !filename) return null;
  return linha(db
    .prepare('SELECT * FROM assets WHERE projectId = ? AND filename = ?')
    .get(projectId, filename));
}

export function findAssetsByJob(jobId, db = database()) {
  if (!jobId) return [];
  return linhas(db
    .prepare('SELECT * FROM assets WHERE jobId = ? ORDER BY createdAt ASC, id ASC')
    .all(jobId));
}

/** Assets do projeto, mais recentes primeiro. `kind` filtra imagem ou vídeo. */
export function listAssets({ projectId = null, kind = null } = {}, db = database()) {
  const condicoes = [];
  const valores = [];
  if (projectId) { condicoes.push('projectId = ?'); valores.push(projectId); }
  if (kind) { condicoes.push('kind = ?'); valores.push(kind); }
  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  return linhas(db
    .prepare(`SELECT * FROM assets ${onde} ORDER BY createdAt DESC, id ASC`)
    .all(...valores));
}

/**
 * Só o estado de aprovação muda depois da criação.
 *
 * A linhagem e a identidade do arquivo são deliberadamente imutáveis: permitir
 * reapontar `derivedFromAssetId` abriria caminho para um ciclo, que a checagem
 * de criação — que só aceita origem já existente — hoje torna impossível.
 */
export function setAssetStatus(id, status, db = database()) {
  const atual = getAsset(id, db);
  if (!atual) throw new DomainError(`Asset desconhecido: "${id}".`, { id });
  if (!ASSET_STATUS.includes(status)) {
    throw new DomainError(
      `Status de asset desconhecido: "${status}".`,
      { status, aceitos: ASSET_STATUS },
    );
  }
  db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, id);
  return getAsset(id, db);
}

/**
 * A cadeia de origem, do asset até a raiz.
 *
 * `[vídeo, imagem]` para o caso que motivou o campo. O limite de profundidade
 * é uma trava: se um dia um ciclo entrar no banco por fora desta camada, isto
 * para em vez de girar para sempre.
 */
export function assetLineage(id, db = database()) {
  const cadeia = [];
  const vistos = new Set();
  let atual = getAsset(id, db);

  while (atual && cadeia.length < LIMITE_LINHAGEM) {
    if (vistos.has(atual.id)) break;
    vistos.add(atual.id);
    cadeia.push(atual);
    atual = atual.derivedFromAssetId ? getAsset(atual.derivedFromAssetId, db) : null;
  }

  return cadeia;
}

/** Assets gerados diretamente a partir deste. */
export function assetDerivatives(id, db = database()) {
  if (!id) return [];
  return linhas(db
    .prepare('SELECT * FROM assets WHERE derivedFromAssetId = ? ORDER BY createdAt ASC, id ASC')
    .all(id));
}

/** Remove só o registro. O arquivo em runtime/ não é tocado. */
export function removeAssetRecord(id, db = database()) {
  if (!getAsset(id, db)) return false;
  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  return true;
}

export { APPROVAL, ASSET_KINDS, ASSET_STATUS };
