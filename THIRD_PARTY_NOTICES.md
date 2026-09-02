# Avisos de terceiros

O Showrunner Studio é distribuído sob a licença MIT (ver `LICENSE`). Este
documento registra o que foi derivado ou inspirado em trabalho de terceiros,
para preservar as atribuições aplicáveis.

---

## 1. Open Generative AI

- **Projeto:** Open Generative AI
- **Repositório:** https://github.com/Anil-matcha/Open-Generative-AI
- **Licença:** MIT
- **Copyright:** © 2026 Open Generative AI Contributors
- **Uso local de referência:** `/media/douglas/SSD2/dev/open/Open-Generative-AI`
  (commit `9bf5fe1`, consultado em 20/08/2026)

A licença MIT do projeto original permite uso, cópia, modificação e
redistribuição, exigindo a manutenção do aviso de copyright e da permissão. O
texto integral da licença MIT do Open Generative AI é reproduzido na seção 1.3.

### 1.1 O que foi derivado

**Nenhum arquivo do Open Generative AI foi copiado para este repositório.** Todo
o código aqui foi escrito para o Showrunner Studio. O que foi aproveitado são
padrões de arquitetura e disciplina de interface, listados abaixo com origem e
destino:

| Padrão aproveitado | Origem no Open Generative AI | Destino aqui |
| --- | --- | --- |
| Registro declarativo de abas que alimenta navegação e roteamento ao mesmo tempo | `components/StandaloneShell.js` (`TABS`) | `components/navigation.js` |
| Shell de estúdio com barra lateral agrupada, área única de conteúdo e troca de aba sem recarregar | `components/StandaloneShell.js` | `components/StudioShell.jsx` |
| Catálogo de modelos como registros declarativos (`id`, `name`, `inputs` com enums e padrões) usados para montar os controles dinamicamente | `packages/studio/src/models.js` | `lib/models.js` |
| Contrato do compositor de prompt: controles de parâmetro com 38 px de altura, um único botão primário de ação, superfícies de dropdown compartilhadas | `packages/studio/src/components/prompt/README.md` e `prompt/PromptComposer.jsx` | `components/ui/primitives.jsx` (`CONTROL_HEIGHT`, `Button`, `Select`, `Field`) |
| Estúdio de modo duplo: o conjunto de modelos e campos muda conforme haja ou não imagem de entrada | `packages/studio/src/components/ImageStudio.jsx`, `VideoStudio.jsx` | `components/screens/ImageScreen.jsx`, `VideoScreen.jsx` |
| Taxonomia de controles de direção cinematográfica (câmera, lente, distância focal, abertura) que se converte em modificadores de prompt | `packages/studio/src/components/CinemaStudio.jsx` | `lib/cinema.js` |
| Histórico de gerações persistido no navegador, com miniaturas e reaproveitamento entre telas | `packages/studio/src/components/ImageStudio.jsx` (`localStorage`) | `lib/storage.js`, `components/StudioContext.jsx` |
| Direção visual: tema escuro, painéis com desfoque, selos de estado, tipografia compacta | interface geral do projeto | `app/globals.css`, `components/ui/` |

### 1.2 O que foi deliberadamente **não** aproveitado

- **O cliente da MuAPI** (`packages/studio/src/muapi.js`) e todo o padrão de
  submeter → consultar acoplado a um fornecedor único. Aqui a execução passa por
  providers substituíveis (`lib/providers/`), e nenhuma tela conhece o
  fornecedor.
- **O portão de chave de API** (`components/StandaloneShell.js:643`, que
  bloqueia toda a interface sem uma credencial). O Showrunner Studio abre direto
  no estúdio, sem chave, login ou cadastro.
- **Os textos, identidade visual, imagens e marcas** do projeto original.
- **A extensão dos textos das opções cinematográficas.** As opções aqui foram
  escritas em português e ampliadas (movimento de câmera, iluminação,
  enquadramento, estilo e proporção não existem no original); apenas a
  organização em categorias é devedora dele.

### 1.3 Licença MIT do Open Generative AI

```
MIT License

Copyright (c) 2026 Open Generative AI Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Higgsfield — inspiração de experiência, sem uso de material

A organização da experiência de um estúdio profissional de mídia por IA
(vitrine de modelos na entrada, estúdios especializados por tipo de saída,
aprovação item a item) serviu de referência conceitual.

**Nada de propriedade da Higgsfield foi utilizado**: nenhum logotipo, marca,
nome comercial, paleta, fonte, ícone, captura de tela, texto de interface ou
trecho de código. A identidade aqui — nome, subtítulo, paleta âmbar/violeta,
ícones e todos os textos — é própria e original.

---

## 3. Dependências de execução

| Pacote | Licença | Papel |
| --- | --- | --- |
| [Next.js](https://github.com/vercel/next.js) | MIT | Framework de aplicação e servidor de desenvolvimento |
| [React](https://github.com/facebook/react) / React DOM | MIT | Biblioteca de interface |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) + `@tailwindcss/postcss` | MIT | Sistema de estilos |
| [PostCSS](https://github.com/postcss/postcss) | MIT | Processamento de CSS |

Os textos completos das licenças acompanham cada pacote em `node_modules/`.

### Recursos visuais

Não há dependência de recurso remoto. Não são usadas fontes externas (a pilha
tipográfica é a do sistema), nem bibliotecas de ícones, nem imagens de banco.
Todos os ícones são SVG desenhados neste repositório
(`components/ui/icons.jsx`) e todos os quadros de pré-visualização são SVG
gerados localmente em tempo de execução (`lib/placeholder.js`).
