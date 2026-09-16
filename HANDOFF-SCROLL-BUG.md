# Handoff: bug de scroll na lista de mensagens (iPhone PWA)

Documento de continuidade para retomar no Claude Code do terminal (Mac), com
Safari Web Inspector disponível. Cole o caminho deste arquivo pro Claude ler
primeiro ("leia o HANDOFF-SCROLL-BUG.md e continue") ou copie o conteúdo dele
direto na mensagem inicial.

## Sintoma (palavras do usuário, várias vezes confirmado igual)

No inbox (`/inbox`), lista de mensagens de uma conversa, **especificamente no
PWA instalado na tela de início do iPhone** (não reproduz — ou não foi
reportado — no Safari normal, desktop ou Android):

> Quando eu puxo pra rolar, a primeira rolagem, quando ela termina a inércia
> (o scroll continua sozinho depois que eu solto o dedo, até parar), ela
> volta de novo pro último balão. Como se estivesse fixando a conversa
> sempre na última mensagem. Só acontece na primeira rolagem da conversa —
> se eu volto pro fundo e repito o mesmo gesto, não quebra mais.
> Predominantemente em conversas longas com bastante anexo/mídia; não
> observado em conversas curtas.

Resumo do mecanismo, na visão do usuário: solta o dedo → inércia nativa do
iOS continua rolando → **quando a inércia para (não quando solta o dedo)** →
a tela "pisca" e volta pro último balão.

Isso é **diferente** do bug original de "scroll travando/soluçando durante o
arrasto", que foi resolvido antes (ver seção "Já resolvido" abaixo). Este é
um bug novo, sobre "voltar pro fundo sozinho depois que o scroll natural já
tinha ido embora".

## Status: NÃO RESOLVIDO após 6 tentativas

Todas as tentativas abaixo foram commitadas, pushadas para `main`, e o
usuário **confirmou o deploy** (pull + build + restart no hPanel da
Hostinger, fechou e reabriu o PWA por completo) antes de cada reteste. O
sintoma permaneceu **idêntico, palavra por palavra**, em todas as vezes —
isso é estranho o suficiente para desconfiar de duas coisas:

1. O deploy pode não estar realmente entregando o bundle novo (cache de
   build no hPanel? cache do WKWebView do PWA?) — ver a seção "Ferramenta de
   diagnóstico" abaixo, ela existe exatamente pra descartar essa hipótese
   primeiro.
2. O mecanismo real pode não estar em nenhuma das teorias já tentadas.

## Arquivo principal

`src/components/inbox/message-thread.tsx` — componente que renderiza a
lista de mensagens (`scrollRef` é o container `overflow-y-auto`). Não há
virtualização/windowing: todas as mensagens da conversa são renderizadas de
uma vez (`visibleMessages = messages`), decisão deliberada documentada no
próprio arquivo.

A lógica de "grudar no fundo" (pin/unpin) é um sistema de refs (não state,
pra evitar re-render a cada scroll):

- `isPinnedToBottomRef` — se true, vários mecanismos forçam `scrollTop =
  scrollHeight` sempre que algo muda (nova mensagem, redimensionamento de
  conteúdo, redimensionamento do composer).
- `isUserTouchingRef` — dedo na tela agora.
- `isScrollInMotionRef` — dedo na tela OU inércia ainda rolando (ver
  commit `e4e194d`).
- `isProgrammaticScrollRef` — um scroll disparado por nós mesmos (não pelo
  usuário), pra não confundir com gesto manual.
- Dois mecanismos forçam `scrollTop` de volta ao fundo quando
  `isPinnedToBottomRef` é true: um `ResizeObserver` no conteúdo (avatares/
  mídia carregando) e um loop `requestAnimationFrame` iOS-only que
  compensa mudanças de altura do composer.

## Tentativas já feitas (todas em `main`, todas sem efeito observado)

| Commit | Teoria | O que mudou |
|---|---|---|
| `8d6f3a1` | Scroll travando durante arrasto (bug **diferente**, esse foi resolvido) | `-webkit-overflow-scrolling: touch` no container |
| `e41e1da` | Esse `touch` scrolling ligou o bounce elástico nativo do WebKit na borda | `overscroll-behavior-y: contain` |
| `952f02d` | Toque no início da conversa competindo com o assentamento inicial (2s fixos) | unpin incondicional no touchstart, janela de 2s |
| `36d408c` | Mídia pesada leva mais que 2s pra carregar, janela fixa não cobre | trocou o timer fixo por "enquanto o `ResizeObserver` de conteúdo ainda está disparando" |
| `ec7f114` | Decidir pin no evento `scroll` é tarde demais / fora de ordem | leitura decisiva da posição real do DOM **no touchend** |
| `e4e194d` | **Usuário corrigiu o diagnóstico**: touchend não é o fim do gesto no iOS, a inércia continua depois. Ler a posição no touchend pode capturar um estado ainda "perto do fundo" antes da inércia fazer o percurso real | substituiu a decisão pontual no touchend por um estado contínuo `isScrollInMotionRef` (true a cada evento `scroll`, só vira false após ~180ms de silêncio); os dois mecanismos de força passaram a respeitar esse estado durante toda a inércia, não só durante o toque |
| `ae82514` | — (não é uma correção, é instrumentação) | painel de debug on-screen (`?scrolldebug=1`) + tag de versão visível, pra parar de adivinhar e conseguir dado real |

**Nenhuma teve efeito perceptível.** Isso é o dado mais importante pra quem
assumir a partir daqui: mesmo uma mudança estrutural como `e4e194d`
(substituir completamente o gatilho de "fim de gesto") não mudou nada — o que
é um forte indício de que **o mecanismo real ainda não foi identificado**,
ou o deploy não está realmente entregando essas mudanças pro dispositivo.

## Ferramenta de diagnóstico já em produção (commit `ae82514`)

Sem Mac disponível até agora, foi adicionado um painel de debug on-screen
pro próprio iPhone, ativado só com `?scrolldebug=1` na URL (zero custo pra
qualquer usuário normal, nada visível sem o parâmetro). Ele:

- Mostra uma **tag de build fixa** (`SCROLL_DEBUG_BUILD_TAG`, hoje
  `"e4e194d+scrolldebug"`) — serve pra confirmar visualmente, sem Web
  Inspector, se o deploy realmente entregou o código mais recente. **Se
  isso não aparecer depois de um deploy, o problema é de deploy, não de
  código.**
- Loga em tempo real (últimas ~60 linhas, num `<pre>` monoespaçado no
  rodapé da tela): `touchstart`, `touchend`, cada evento `scroll` (posição,
  distância do fundo, flags), fim real de movimento (`motion-end`),
  disparos do `ResizeObserver` de conteúdo, e principalmente qualquer
  escrita forçada de `scrollTop` — marcada com `!!! FORCED` pra saltar aos
  olhos.

Com o Mac agora disponível, **use o Safari Web Inspector de verdade** em vez
do painel on-screen — é estritamente melhor (console real, Timeline,
Network, breakpoints):

1. No iPhone: Ajustes → Safari → Avançado → ativar "Web Inspector".
2. Conectar o iPhone no Mac via cabo.
3. No Mac: Safari → menu Desenvolver → selecionar o iPhone → selecionar o
   PWA/página do wacrm.
4. Abrir a aba Console, reproduzir o gesto na conversa longa/com mídia, e
   ler os `console.log`/o comportamento em tempo real. Os `logScrollDebug(...)`
   já inseridos no código (busca por `logScrollDebug` em
   `message-thread.tsx`) escrevem num array em memória e atualizam o
   `<pre>` — **pode trocar rapidamente pra também espelhar em
   `console.log` se for mais conveniente no Web Inspector do que ler o
   painel na tela** (é uma linha a mais dentro de `logScrollDebug`).
5. Idealmente também gravar uma sessão do painel **Timeline/Performance**
   durante o gesto — isso mostra a ordem real de: eventos de toque, evento
   `scroll`, `ResizeObserver` callbacks, `requestAnimationFrame` callbacks,
   e exatamente quando cada `scrollTop` é escrito. É o jeito mais direto de
   provar ou descartar cada uma das teorias já tentadas.

## Hipóteses ainda não testadas (pra quem continuar)

Registradas aqui pra não perder o raciocínio, mas **nenhuma foi verificada
com dado real ainda**:

1. **Deploy não está realmente atualizando o bundle** — hPanel pode estar
   reaproveitando cache de `.next/` no build, ou o WKWebView do PWA está
   servindo um bundle antigo do cache HTTP. A tag de build / Web Inspector
   descarta isso rapidamente.
2. **`--app-height` / `use-app-height.ts`**: se há algum recálculo de
   altura do viewport (relacionado a safe-area, teclado, ou o próprio
   WKWebView "assentando" logo após abrir) que muda o `clientHeight` de
   `scrollRef` durante a inércia, isso alimentaria o loop de compensação
   iOS (`heightDelta`) mesmo sem o composer ter mudado de altura — vale
   conferir se esse hook dispara nesse momento.
3. **Conflito com o trabalho de outra sessão**: durante uma parte desta
   investigação, uma sessão paralela (mesmo usuário, terminal local) também
   estava mexendo em `message-thread.tsx` e `message-composer.tsx` ao mesmo
   tempo (commits `d1ace47`, `623e2cd`, `192d9e6`, etc. — ver
   `git log --oneline -- src/components/inbox/message-thread.tsx`). Vale
   conferir se sobrou alguma lógica concorrente/duplicada de scroll dessa
   sessão que não foi totalmente reconciliada.
4. Vale considerar remover temporariamente os dois mecanismos de força
   (comentar o `ResizeObserver` de conteúdo e o loop iOS) por completo e
   confirmar que o bug desaparece — isso pelo menos prova ou descarta que a
   causa está nesses dois mecanismos versus em algum lugar totalmente
   diferente (ex.: nativo do WebKit, ou outro trecho de código não mapeado
   ainda).

## Já resolvido (não mexer de novo sem necessidade)

- **Animação de expansão do composer** (1→4 linhas, suavidade): corrigido
  por uma sessão paralela (root cause: chamada duplicada de
  `adjustHeight()` cancelando a transição CSS) — commits `b7e972d`,
  `d4cf6e6`, `7037c58`. Nunca confirmado formalmente pelo usuário nesta
  conversa, mas não foi mais reportado como problema.
- **Scroll travando/soluçando durante o arrasto** (jank, não o bug de
  "voltar pro fundo"): resolvido com `-webkit-overflow-scrolling: touch`
  (`8d6f3a1`) + trabalho de histerese de uma sessão paralela (`d1ace47`,
  `623e2cd`).
- **Bounce elástico ao puxar levemente estando já no fundo**: resolvido com
  `overscroll-behavior-y: contain` (`e41e1da`).

## Deploy — lembrete

Não existe deploy automático neste repositório (`.github/workflows/ci.yml`
só faz lint/typecheck/test/build de verificação). Hostinger Git Auto Deploy
só puxa o código — **build e restart do processo Node.js são manuais no
hPanel**, sempre depois de cada push. Fechar o PWA por completo (não só
minimizar) no iPhone antes de retestar, pra limpar estado em memória.

## Branch / repo

Tudo commitado e pushado direto em `main` (autorizado explicitamente pelo
usuário nesta conversa). Repo: `ronaldomeira-alt/wacrm`.
