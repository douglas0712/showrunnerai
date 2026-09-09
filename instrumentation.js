// O gancho de arranque do Next.
//
// Existe para uma coisa só: disparar a reconciliação dos trabalhos de geração
// que terminaram enquanto o processo esteve fora. A lógica inteira mora em
// `lib/server/generation/reconcile.js`, que é testável sem o Next — aqui fica o
// mínimo que só este arquivo pode fazer.
//
// ── Por que ele não espera ──────────────────────────────────────────────────
//
// `register()` roda antes de a aplicação começar a servir. Esperar a
// reconciliação aqui faria o primeiro pedido do usuário depender de o executor
// estar de pé e responder — e o executor é outro processo, que pode subir
// depois, ou nunca. A reconciliação vai para segundo plano e a aplicação sobe.
//
// ── Por que os guardas ──────────────────────────────────────────────────────
//
// `register()` também é chamado durante o `next build`. Um build não deve
// tocar em serviço externo nem abrir o banco: ele roda em máquina de CI, em
// contêiner sem ComfyUI, em qualquer lugar. E o runtime `edge` não tem
// `node:sqlite` nem sistema de arquivos — reconciliar de lá seria impossível
// e o erro apareceria longe da causa.
//
// São dois guardas porque são duas perguntas diferentes: "isto é um build?" e
// "isto é o runtime que consegue?".
//
// ── Por que o import foge do empacotador ────────────────────────────────────
//
// Os guardas acima valem em TEMPO DE EXECUÇÃO. O empacotador não os lê: ele
// segue o import de qualquer jeito e monta o pacote deste gancho para todos os
// runtimes — inclusive um em que `node:child_process` não existe. A cadeia
// `reconcile → facade → provider → ffmpeg` chega lá, a compilação falha, e a
// aplicação passa a responder 500 em TODA rota.
//
// Medido subindo o servidor de desenvolvimento:
//
//   Module build failed: UnhandledSchemeError: Reading from
//   "node:child_process" is not handled by plugins
//   node:child_process ← ffmpeg.js ← provider.js ← facade.js ← reconcile.js
//
// Tornar o import tardio dentro de `reconcile.js` não bastou: o empacotador
// rastreia import dinâmico também. Então o caminho é montado em tempo de
// execução e marcado para ser ignorado — aí não há o que rastrear, e quem
// resolve é o Node, no runtime em que a cadeia existe.
//
// O caminho parte de `process.cwd()`, que é a raiz do projeto tanto em
// desenvolvimento quanto em produção — a mesma premissa que `runtime/` já faz.

/** A fase que o Next declara enquanto compila para produção. */
const FASE_DE_BUILD = 'phase-production-build';

export async function register() {
  if (process.env.NEXT_PHASE === FASE_DE_BUILD) return;
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Nem `node:url` para montar a URL: NENHUM builtin do Node sobrevive à
  // compilação deste gancho — `node:url` falha exatamente como
  // `node:child_process` falhava. A URL é montada com o que existe em qualquer
  // runtime.
  const alvo = `file://${encodeURI(process.cwd())}/lib/server/generation/reconcile.js`;

  const { reconcileOnce } = await import(/* webpackIgnore: true */ alvo);

  // Sem `await`: o arranque não espera. `reconcileOnce` já absorve a própria
  // falha, então não há promessa rejeitada solta.
  reconcileOnce();
}
