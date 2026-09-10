// O contrato da narração — o TEXTO narrado de uma cena, e a impressão dele.
//
// PASSO 14-A. Nada aqui gera áudio, escolhe voz, fala com provider ou cria
// take. Este arquivo escreve, em código, uma frase que até agora só existia
// implícita no esquema:
//
//     ProductionScene.narration É o texto narrativo autoritativo da cena.
//
// ── Por que isto não é uma tabela nova ──────────────────────────────────────
//
// Porque a narração já é estado durável do Project desde o PASSO 12:
// `production_scenes.narration`, gravada por `replaceProductionScenes`,
// alterada por `updateProductionScene`, lida por `project.get_scene`. Uma
// segunda entidade "narração" guardaria o MESMO parágrafo num segundo lugar —
// e dois lugares para o mesmo texto é uma pergunta ("qual dos dois vale?") que
// nenhuma das duas tabelas sabe responder. O texto continua onde está; o que
// faltava era o contrato em volta dele, e é isto aqui.
//
// ── Narração NÃO é áudio ────────────────────────────────────────────────────
//
//     Scene.narration      texto — planejamento, escrito por quem dirige
//     Audio Take (futuro)  mídia — DERIVADA desse texto, num instante dado
//
// A distinção importa porque as duas coisas envelhecem em ritmos diferentes.
// Editar o texto muda o planejamento na hora; o WAV que alguém gerou ontem
// continua sendo o WAV de ontem. Nenhuma edição de texto pode reescrever um
// arquivo que já existe, e fingir que pode — deixando o áudio "atualizado"
// porque o texto mudou — seria mentir sobre o que o usuário vai ouvir.
//
// ── A pergunta que o 14-B vai precisar fazer ────────────────────────────────
//
//     "este áudio foi gerado da versão ATUAL da narração?"
//
// A resposta é uma comparação de impressões digitais. Um Audio Take futuro
// guarda a impressão do texto de que ele saiu — `sourceNarrationFingerprint` —
// e a pergunta acima vira:
//
//     sceneNarration(projectId, ordinal).fingerprint === take.sourceNarrationFingerprint
//
// Não há take nenhum ainda, e por isso não há coluna nenhuma aqui. O que este
// passo entrega é o lado da CENA dessa igualdade, pronto para o outro lado
// existir.
//
// ── Por que a impressão não é persistida ────────────────────────────────────
//
// Porque ela é função do texto, e o texto está no banco. Uma coluna
// `narrationFingerprint` seria um valor derivado guardado ao lado da origem
// dele — e todo caminho de escrita passaria a ter duas obrigações em vez de
// uma, sendo que esquecer a segunda produz um estado que MENTE (a impressão de
// um texto que não é mais aquele). Calcular na leitura custa um SHA-256 sobre
// no máximo quatro mil caracteres e não pode divergir de nada.
//
// ── Por que a impressão é do SERVIDOR ───────────────────────────────────────
//
// Mesmo motivo do `takeNumber` do PASSO 13-A: quem chama não sabe o que está
// gravado — e, quando quem chama é um modelo, ele ACHA que sabe. Uma impressão
// vinda de fora seria o hash do texto que o modelo lembra da conversa, e ele
// erra exatamente no caso que importa: depois de uma edição que ele não viu
// acontecer. Nenhuma função aqui aceita hash como argumento, e nenhuma
// ferramenta expõe hash ao modelo.

import { createHash } from 'node:crypto';

import { database } from './db.js';
import { getProductionScene } from './production.js';

/**
 * A impressão digital de um texto de narração.
 *
 * SHA-256, em hexadecimal, do texto EXATAMENTE como ele está persistido. Não
 * há normalização aqui de propósito: a forma canônica de uma narração é a que
 * `production.js` grava, e uma segunda canonicalização neste arquivo seria uma
 * segunda opinião sobre o que o texto é — a que discorda da primeira no dia em
 * que alguém mudar uma das duas.
 *
 * Por isso o caminho normal NÃO é chamar esta função com um texto na mão, e
 * sim `sceneNarration`, que lê do banco. Esta fica exportada porque a
 * propriedade que interessa — mesmo texto, mesma impressão — é dela.
 *
 * Provider-neutral: nada de modelo, voz, idioma ou velocidade entra no hash.
 * Se entrasse, "o texto mudou?" e "a voz mudou?" passariam a ser a mesma
 * pergunta, e o 14-B precisa que sejam duas.
 *
 * Narração vazia não tem impressão — devolve `null`. O hash da string vazia é
 * um valor perfeitamente estável e perfeitamente inútil: ele deixaria um take
 * futuro alegar proveniência de um texto que nunca existiu. "Não há o que
 * narrar" é a ausência de uma impressão, não uma impressão de nada.
 *
 * @param {string|null|undefined} texto
 * @returns {string|null} 64 hexadecimais, ou `null` se não há narração.
 */
export function narrationFingerprint(texto) {
  if (typeof texto !== 'string' || texto === '') return null;
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/**
 * A narração de uma cena, do jeito que ela está GRAVADA.
 *
 * Endereçada como tudo mais no planejamento: `projectId` (do ToolContext, no
 * agente) + `ordinal`. Nunca por `id` de cena. Não existe um número que
 * signifique "a cena de outro projeto" — ver o cabeçalho de `production.js`.
 *
 * Devolve `null` quando não há cena nessa posição, pelo mesmo critério de
 * `getProductionScene`: "não existe" e "é de outro projeto" são a mesma
 * resposta, porque distingui-las contaria ao chamador algo sobre um projeto
 * que não é o dele.
 *
 * `hasNarration` existe para o take de narração do 14-B ter o que recusar — e,
 * depois dele, o TTS do 14-C: uma cena pode legitimamente ser só imagem, só
 * música ou só silêncio, e isso não é defeito de planejamento. O domínio
 * continua aceitando narração vazia; o que não vai poder existir é uma voz
 * gerada a partir de nada.
 *
 * @returns {{ordinal: number, text: string, hasNarration: boolean,
 *            fingerprint: string|null}|null}
 */
export function sceneNarration(projectId, ordinal, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  const text = typeof cena.narration === 'string' ? cena.narration : '';

  return Object.freeze({
    ordinal: cena.ordinal,
    text,
    hasNarration: text !== '',
    fingerprint: narrationFingerprint(text),
  });
}
