# Handoff: composer do Inbox (WACRM)

Sessão anterior (Windows/terminal) não fez nenhuma mudança de comportamento no
composer — este arquivo é só o estado atual, para a sessão no Mac começar sem
precisar reconstruir o contexto. `git status` estava limpo e sincronizado com
`origin/main` (HEAD `4bfa844`) no momento em que isso foi escrito.

## Onde mexer

- `src/components/inbox/message-composer.tsx` (~2000 linhas) — componente do
  composer em si: texto, autocomplete de `/shortcut`, anexos (imagem/vídeo/
  documento), gravação de áudio.
- `src/components/inbox/message-thread.tsx` — dono da lista de mensagens que
  fica ao lado do composer; parte da lógica de scroll/acompanhamento do
  composer (ResizeObserver, compensação de scroll durante a transição de
  altura) vive lá, não no composer.

## Arquitetura atual (o que já existe, para não reinventar)

**Altura dinâmica do textarea** (`adjustHeight`, linha ~579): mede
`scrollHeight`, decide `data-multiline` (quebra de linha real ou wrap em
1 linha), cap de 4 linhas visíveis (linhas 5+ scrollam por dentro). A
transição CSS de altura depende de forçar um reflow (`el.offsetHeight`)
entre resetar pra `startHeight` e assinar `targetHeight` — sem isso o
browser vê "mesmo valor" e não anima nada. Já foi corrigido um bug de
`adjustHeight()` sendo chamado 2x (uma no `handleChange`, outra no efeito
de `[text]`) que cancelava a própria transição (commit `b7e972d`).

**Troca single-line ↔ multi-line**: no CSS mobile ("ChatGPT style" em
`globals.css`, `[data-composer-capsule]`), o layout usa `flex-wrap`/`order`/
`width:100%`, que não são animáveis — o reflow sempre "salta" instantaneamente
independente de qualquer transição de altura. `fadeCapsuleOnModeSwitch`
disfarça isso com um dip de opacidade (0.55 → 1) exatamente no frame em que
o modo muda.

**Scroll da conversa acompanhando o composer** (`message-thread.tsx` linha
~1229+): a lista de mensagens é irmã flex (`flex-1`) do composer, então
quando o composer cresce/encolhe (nova linha, anexo, etc.) a lista
redimensiona junto. Isso é feito via `ResizeObserver` porque `requestAnimationFrame`
sozinho lê o layout ANTES do browser aplicar o novo tamanho durante uma
transição CSS — ResizeObserver é a ferramenta certa aqui (documentado
inline, não é gambiarra).

**Gravação de áudio** (`micPhase` state machine, linha ~289): idle →
recording → paused → sending/failed. Ponto crítico já resolvido: o upload
de fato NUNCA acontece dentro do composer (rodava dentro dele antes e
travava pra sempre no Safari iOS/WKWebView se o PWA fosse pro background
durante o fetch — ver comentário em `finalizeRecording`, linha ~999). O
áudio é persistido local (IndexedDB, `pending-audio-db.ts`) e o upload real
é feito por `message-thread.tsx` (`handleQueuedAudio` / `pending-audio-sync.ts`),
fora do ciclo de vida deste componente.

**Anexos**: imagem/vídeo vão direto (sem estágio de rascunho, modelo
WhatsApp — `handlePicked`, linha ~949); documento único fica em rascunho
com legenda (`stageUpload`); múltiplos documentos vão sequenciais
(`uploadAndSend`).

## Não existe change pendente

Nenhum diff local, nenhum commit à frente/atrás de `origin/main`. Qualquer
"mudança de comportamento no composer" que o usuário pedir agora é trabalho
novo, não uma continuação de algo já em progresso nesta branch.

## Observação sobre memória automática

O worker `claude-mem` (observer automático de memória) está com a cota de
inferência esgotada desde 2026-09-19 — não está gravando nada
automaticamente em nenhuma sessão até a cota resetar ou trocarem de
provider em `~/.claude-mem/settings.json`. Isso não afeta a memória própria
do Claude Code (arquivos em `~/.claude/projects/.../memory/`), que é local
por máquina e por isso não chega no Mac por conta própria — só o que for
commitado no repo (como este arquivo) atravessa as máquinas.
