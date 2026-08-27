# HANDOFF — Composer + Teclado no iPhone/PWA

**Status:** pausado, sem solução final. Retomar no Mac usando Safari Web Inspector.
**Branch:** `wip/inbox-keyboard-composer-ios` (não é `main` — de propósito, para não disparar o auto-deploy do Hostinger com código de debug ainda no meio).

## Objetivo original

No Inbox do WACRM, quando o composer (`src/components/inbox/message-composer.tsx`) é focado no iPhone rodando como PWA instalado (standalone), dois problemas:

1. **Movimento do composer ao abrir/fechar o teclado.** O ideal é o composer subir/descer junto com o teclado como se fossem um único elemento — sem um "degrau" (composer parado enquanto o teclado já está subindo, depois um salto brusco do composer pra posição final).
2. **Faixa escura entre o composer e o teclado.** Deveria ter continuidade visual com o fundo cinza do composer, sem parecer um buraco/camada separada.

Regras que valem para qualquer continuação:
- Só mobile/PWA/iPhone. Não alterar desktop (tudo aqui é gated por `display-mode: standalone`, então desktop nunca executa esse código).
- Não reestruturar o composer.
- Não criar nova arquitetura nem dependência.
- Reutilizar a lógica de viewport/teclado já existente (`use-app-height.ts`).
- Validar com `typecheck` / `lint` / `build` antes de qualquer teste; nunca fazer deploy sem aprovação manual do usuário testando no iPhone.

## Por que o Mac agora

Sem Mac, não havia como usar o Safari Remote Web Inspector (exclusivo de macOS) para depurar a PWA rodando no iPhone. Toda a investigação até aqui foi feita às cegas, com um **overlay de debug temporário renderizado na própria tela do PWA** (ver seção abaixo) — funcional, mas ruidoso e ele mesmo pode interferir na performance que está sendo medida (fazia `getBoundingClientRect()` a cada frame numa versão anterior; já reduzido, mas ainda é uma gambiarra, não uma ferramenta de profiling real).

**Com o Mac conectado ao iPhone via cabo:** Safari → menu Develop → selecionar o dispositivo → a aba do PWA standalone aparece lá (mesmo sem barra de endereço visível no PWA, o Web Inspector consegue anexar). Isso dá acesso a:
- Timeline/Performance real (ver os frames pintados de verdade, não inferir via `requestAnimationFrame` + log).
- Console/debugger ao vivo, breakpoints.
- Medir a curva e duração reais da animação nativa do teclado do iOS (isso nunca foi medido diretamente — só inferido pelos eventos de `visualViewport` que conseguimos capturar via JS).

## O que já foi descoberto (dados reais, capturados via overlay em 2026-08-26)

Com um overlay temporário logando `visualViewport.height/.offsetTop`, `--app-height`, a posição real do composer (`getBoundingClientRect()`) e `document.scrollingElement.scrollTop` a cada evento relevante, em teste real no iPhone (PWA standalone):

```
t=0ms   resting     vvH=873.0 vvOff=0.0 innerH=873 outerH=932 appH=932px composerBottom=undefined scrollY=0
t=0ms   focusin     vvH=932.0 vvOff=0.0 innerH=932 outerH=932 appH=932px composerBottom=932.0      scrollY=0
t=1ms   focusin-set vvH=932.0 ...                                appH=932px composerBottom=932.0   scrollY=0
t=29ms  raf         (nada muda — appH ainda 932, composer ainda no fundo da tela cheia)
t=85ms  raf         (nada muda ainda)
t=106ms resize      vvH=519.0 vvOff=295.0 appH=519px composerBottom=165.0  scrollY=354   ← GLITCH
t=107ms vv-scroll   vvH=519.0 vvOff=0.0   appH=519px composerBottom=519.0  scrollY=0     ← auto-corrigido
... (estável em 519 dali em diante, sem mais eventos até fechar o teclado)
```

Achados confirmados:

1. **~106ms de "silêncio" após o focus** antes do primeiro (e único) evento `visualViewport.resize` chegar. Durante esse período, o app não reage a nada — o composer continua na altura de tela cheia (932px) enquanto o teclado real já está visivelmente subindo por baixo dele. É provavelmente a origem do "degrau"/parte do movimento que o usuário descreveu como "composer sobe atrás do teclado, por trás dele".
2. **iOS dispara APENAS UM evento `resize` do `visualViewport`**, não uma sequência contínua acompanhando a animação — e esse único evento já chega com o valor FINAL (519px), não valores intermediários. Ou seja: **não há como, só com JS, acompanhar a posição do teclado frame a frame** — só temos "início" (932) e "fim" (519), sem os quadros do meio. Isso limita bastante o que dá pra fazer com CSS transition (ver histórico de tentativas abaixo).
3. **Glitch real de scroll do documento**: no exato instante do evento `resize`, `document.scrollingElement.scrollTop` estava em 354px (comportamento nativo do iOS de "rolar o campo focado pra vista", disparado independente do nosso código) — isso jogava a posição renderizada do composer para `y=165` (bem mais acima na tela) por pelo menos um instante, antes do nosso próprio código (já existente, em `dashboard-shell.tsx`) resetar `scrollTop` de volta a 0 um instante depois, e o composer "saltar" para `y=519` (posição final correta). Fizemos uma correção pra isso (resetar o scroll de forma síncrona dentro do mesmo handler que já reage ao evento de resize, em vez de um listener separado reagindo depois) — o usuário relatou que **o movimento ficou mais suave, mas o problema não foi resolvido**. Ainda não sabemos se sobrou resíduo desse mesmo mecanismo ou se há uma causa adicional que só dá pra ver com profiling real.
4. **Matematicamente, a caixa do composer não tem folga interna**: no estado assentado (teclado aberto), `composerBottom` (posição real via `getBoundingClientRect()`) bate exatamente com `appH` (519.0 == 519px). Ou seja, o `--app-height` calculado e a posição renderizada do composer estão perfeitamente alinhados — **não existe gap dentro da cadeia flexbox** (shell → header+main → main → página do inbox → message-thread → composer). Se ainda existe uma faixa escura visível entre o composer e o teclado, ela está **fora** dessa caixa — ou seja, `visualViewport.height` (519px, usado para dimensionar `--app-height`) pode não estar batendo com o topo real e visível do teclado nesse dispositivo/versão do iOS, OU há alguma outra camada/elemento que não foi identificado ainda. Isso não foi confirmado visualmente ainda porque os prints de debug tinham o overlay grande demais cobrindo essa região — a versão mais recente do overlay é pequena e fica no canto superior direito, mas ainda não recebemos um print limpo da parte de baixo da tela com ele.

## Histórico de tentativas (o que já foi testado e teve que ser revertido)

Para não repetir os mesmos erros:

- **`visualViewport.offsetTop` somado ao `--app-height`**: tentado para fechar o gap (teoria: o viewport visual desloca-se independente do scroll do documento). Causou uma regressão pior (composer "descia" antes de subir, ficando temporariamente atrás do teclado) — **revertido**. Pode ter sido só um efeito colateral do timing errático dessa leitura logo no instante do focus; não descartar totalmente, mas só reintroduzir com dados reais do Web Inspector, não achismo.
- **`transition-[height]` no shell** (`dashboard-shell.tsx`), tentando suavizar a troca de `--app-height`: piorou o movimento (criava uma segunda animação "correndo atrás" do valor real, já que só recebemos UM evento de resize com o valor final — ver achado #2 acima). **Revertido duas vezes** (uma vez junto com o bug do `offsetTop`, que confundiu os resultados; puro, sem esse bug junto, ainda não foi validado com sucesso). **Não reintroduzir sem entender, via Web Inspector, a duração/curva real da animação nativa do teclado** — só assim dá pra tentar casar uma transition com o "tempo restante" depois que o evento de resize chega.
- **`env(safe-area-inset-bottom)` atribuído via JS a uma custom property** (`--composer-safe-bottom`), depois consumido via `var()` em outro lugar: quebrou catastroficamente (composer sumia por completo, mesmo em repouso) — WebKit não resolve `env()` de forma confiável quando ele "passa por dentro" de uma custom property atribuída via JS. **Corrigido**: agora `--composer-safe-bottom` só recebe valores fixos (`0px`) ou é removido — o `env(safe-area-inset-bottom)` real fica sempre como fallback do `var()`, escrito direto no CSS (nunca atribuído via JS). Esse padrão está funcionando.
- **`--app-bg-override` pintando `html`/`body` com `var(--card)`** enquanto o campo está focado, pra dar continuidade visual em vez de perseguir o pixel exato: implementado, não resolveu o gap sozinho (usuário ainda reporta a faixa escura). Não sabemos ainda se é porque a causa raiz do gap está em outra camada, ou se a correção em si tem um bug — precisa inspecionar ao vivo.
- **`ResizeObserver` no container de mensagens pra manter a última mensagem visível** (não relacionado aos 2 problemas acima, era a "task 2" original antes desses ficarem o foco): isso **funcionou** e o usuário confirmou ("deu super certo"). Não mexer nisso sem necessidade.

## Estado atual dos arquivos modificados (não commitados até este checkpoint)

- **`src/hooks/use-app-height.ts`** — arquivo central. Contém:
  - A lógica de produção (`--app-height` resting/live, `--composer-safe-bottom`, `--app-bg-override`, o reset síncrono de scroll em `setLive`/`onFocusIn`).
  - **Um overlay de debug temporário** (bloco claramente marcado com `// ================= TEMPORARY DEBUG OVERLAY ... =================`), que cria um `<pre>` fixo no canto superior direito da tela mostrando `visualViewport.height`, `--app-height`, a posição real do composer e o scroll do documento a cada evento. **Isso precisa ser removido antes de qualquer deploy real** — está aqui de propósito para dar suporte à investigação no Mac; pode ser expandido/ajustado livremente durante a sessão de debug, mas não deve ir para produção.
- **`src/components/inbox/message-composer.tsx`** — duas mudanças:
  - `pb-[calc(9px+var(--composer-safe-bottom,env(safe-area-inset-bottom)))]` no lugar do `env()` cru (ver histórico acima).
  - Atributo `data-composer-root` no container do composer — **também temporário**, usado só pelo overlay de debug pra achar o elemento e medir sua posição real. Remover junto com o overlay.
- **`src/components/inbox/message-thread.tsx`** — a correção que **funcionou** (não mexer): `ResizeObserver` no container de mensagens (`scrollRef`) que reaplica `scrollTop = scrollHeight` (coalescido via `requestAnimationFrame`) sempre que o container muda de tamanho, só se o usuário já estava perto do fim da conversa (`isNearBottomRef`). Mantém a última mensagem visível acompanhando a abertura/fechamento do teclado, sem forçar scroll pra quem está lendo mensagens antigas.
- **`src/app/globals.css`** — `body`/`html` agora usam `background-color: var(--app-bg-override, var(--background))` em vez do `bg-background` puro do Tailwind, pra permitir o override de cor descrito acima.
- **`src/app/(dashboard)/dashboard-shell.tsx`** — só o comentário documentando por que a `transition-[height]` foi tentada e revertida (nenhuma mudança funcional além do comentário — o `resetDocumentScroll` original desse arquivo continua intocado e é o mecanismo que a correção em `use-app-height.ts` agora reforça).

## O que falta

1. **Conectar o iPhone ao Mac, abrir Safari → Develop → [dispositivo] → aba do PWA**, e medir com precisão:
   - Duração e curva reais da animação do teclado (show e hide).
   - Se `visualViewport.resize` realmente dispara só uma vez (como observado até aqui) ou se há mais eventos que o overlay não capturou por algum motivo.
   - Se ainda existe algum salto de scroll residual mesmo depois da correção síncrona aplicada.
2. **Com esses dados reais**, decidir se uma `transition` CSS bem calibrada (ou outra técnica) resolve o problema #1 (movimento), ou se é preciso outra abordagem.
3. **Investigar o problema #2 (faixa escura)** inspecionando ao vivo, no momento do teclado aberto: qual elemento realmente ocupa aquela região (computed styles, box model no inspector) — os números já provam que não é falta de altura na cadeia flexbox do composer; ou `visualViewport.height` não reflete o topo real do teclado nesse contexto, ou há uma camada não identificada.
4. **Remover o overlay de debug e o atributo `data-composer-root`** (ambos claramente marcados como temporários) assim que a causa raiz de ambos os problemas estiver confirmada e corrigida.
5. Só depois disso: `typecheck` + `lint` + `build`, testar no iPhone, esperar aprovação manual do usuário, e então (só a pedido explícito) fazer merge pra `main` e deploy.

## Ambiente local (não versionado, específico desta máquina)

- `.env.local` tem `ALLOWED_DEV_ORIGINS=192.168.0.11` adicionado (Windows, não commitado — está no `.gitignore`) pra permitir acesso via IP da rede local sem o Next.js bloquear os recursos de dev cross-origin. No Mac, se for repetir o teste via rede local em vez de só cabo, será preciso adicionar o IP do Mac na mesma variável do `.env.local` de lá.
- O servidor dev estava rodando em `npm run dev -- -H 0.0.0.0 -p 3000`, acessível em `http://192.168.0.11:3000` nesta máquina Windows.
