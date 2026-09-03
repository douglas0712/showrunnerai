// Conhecimento do nó ComfyUI `ResolutionSelector`.
//
// Este nó aparece no MiniMax H3 e no Ideogram 4, e a tabela de proporções é
// propriedade DELE, não dos modelos — a lista abaixo foi lida de
// /object_info/ResolutionSelector no servidor, não suposta.
//
// A tradução existe porque o nó espera rótulos como "16:9 (Widescreen)". Um
// descriptor nunca deixa esse valor vir do caller: o caller informa "16:9" e a
// allowlist decide o resto. Proporção fora da tabela é erro, não improviso.

import { deepFreeze, WorkflowError } from './descriptor.js';

/** Proporção do Showrunner → opção exata do ResolutionSelector. */
export const ASPECT_TO_SELECTOR = deepFreeze({
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
});

export const ASPECTS_SUPORTADOS = Object.freeze(Object.keys(ASPECT_TO_SELECTOR));

export function selectorForAspect(aspect) {
  const opcao = ASPECT_TO_SELECTOR[aspect];
  if (!opcao) {
    throw new WorkflowError(`Proporção não suportada: "${aspect}".`, {
      suportadas: ASPECTS_SUPORTADOS,
    });
  }
  return opcao;
}

/** Opção do ResolutionSelector → proporção do Showrunner. */
export function aspectFromSelector(opcao) {
  const par = Object.entries(ASPECT_TO_SELECTOR).find(([, v]) => v === opcao);
  return par ? par[0] : null;
}

/**
 * Megapixels → rótulo de qualidade, pelo mais próximo.
 *
 * Cada descriptor traz a própria tabela: o que é "1K" para um modelo de imagem
 * não é o que é "480p" para um de vídeo.
 */
export function qualityFromMegapixels(mp, tabela) {
  const alvo = Number(mp);
  if (!Number.isFinite(alvo)) return null;
  let melhor = null;
  let menorDiferenca = Infinity;
  for (const [rotulo, valor] of Object.entries(tabela)) {
    const diferenca = Math.abs(valor - alvo);
    if (diferenca < menorDiferenca) {
      menorDiferenca = diferenca;
      melhor = rotulo;
    }
  }
  return menorDiferenca <= 0.05 ? melhor : `${alvo} MP`;
}

/** Qualidade → megapixels, contra a tabela do descriptor. */
export function megapixelsForQuality(quality, tabela) {
  const mp = tabela[quality];
  if (!mp) {
    throw new WorkflowError(`Qualidade não suportada: "${quality}".`, {
      suportadas: Object.keys(tabela),
    });
  }
  return mp;
}
