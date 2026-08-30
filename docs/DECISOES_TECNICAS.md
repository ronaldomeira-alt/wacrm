# Decisões técnicas — wacrm

> Registro do "porquê" por trás de escolhas não óbvias, para não perder tempo revisitando a mesma pergunta no futuro.

## Fork próprio em vez de contribuir no upstream

**Decisão:** clonar `ArnasDon/wacrm` para `ronaldomeira-alt/wacrm` e trabalhar direto no `main` do fork.
**Motivo:** as customizações (tradução pt-BR, segmentação imobiliária) são específicas do negócio do usuário (corretor de imóveis em João Pessoa) e não fazem sentido como contribuição genérica ao projeto open-source. Trabalhar direto no fork evita esperar review/aprovação de PR para algo que só serve a este uso.
**Como aplicar:** ao atualizar com melhorias do upstream, usar `git fetch upstream && git merge upstream/main` (ainda não foi feito nesta sessão — o fork está atualizado até o commit `8b7279a` do upstream).

## `tags.category` como texto livre, sem tabela `categories`

**Decisão:** adicionar uma coluna `category TEXT` nullable em `tags`, em vez de criar uma tabela `tag_categories` separada com FK.
**Motivo:** o requisito era simplicidade e velocidade de implementação para uma conta pequena (1-2 corretores, ~300 leads/mês), reaproveitando ao máximo o modelo existente. Uma tabela separada exigiria FK, UI de gerenciamento de categorias, e migração de dados — complexidade desproporcional ao problema (agrupar visualmente tags relacionadas e permitir digitar categorias novas). Texto livre com `datalist` no front-end (autocomplete de categorias existentes, mas aceita digitar qualquer coisa) resolve o caso de uso pedido explicitamente pelo usuário ("Outros — campo para digitação" para bairros fora da lista pré-definida).
**Trade-off aceito:** não há validação de categorias (ex.: "Bairro" vs "bairro" vs "Bairros" viram grupos diferentes se alguém digitar errado). Aceitável no volume atual; se crescer, migrar para enum ou tabela dedicada.
**Como aplicar:** ao adicionar novas categorias de segmentação no futuro, não é preciso migration — só inserir tags com o novo valor de `category`. Só migrar para tabela separada se surgir necessidade de metadados por categoria (ordem customizável pelo usuário, ícone, cor padrão, etc.).

## Função RPC separada (`filter_contacts_by_all_tags`) em vez de sobrecarregar `filter_contacts_by_tags`

**Decisão:** criar uma segunda função SQL para o filtro AND, em vez de adicionar um parâmetro `p_mode` na função existente ou fazer overload por assinatura.
**Motivo:** o PostgREST (camada que expõe funções Postgres como endpoints RPC do Supabase) não resolve bem overloads de função por nome — pode gerar ambiguidade ou exigir especificar `Content-Profile`/assinatura explícita no client, o que complica o código de app. Duas funções com nomes distintos e mesma assinatura de parâmetros mantêm os call sites (`supabase.rpc('filter_contacts_by_tags', ...)` vs `supabase.rpc('filter_contacts_by_all_tags', ...)`) inequívocos e fáceis de auditar.
**Como aplicar:** ao expandir o filtro de tags (ex.: um modo "todas exceto"), preferir uma terceira função nomeada a adicionar branching complexo dentro de uma função só.

## Deploy no Hostinger via Git, não via Docker

**Decisão:** o deploy de produção usa o fluxo nativo de "Web App Node.js" do Hostinger, que faz `git pull` + build direto do branch `main`. O suporte a Docker que existe no repo (`docker/Dockerfile`, `docker/docker-compose.yml`) é uma opção alternativa documentada, não o caminho usado em produção.
**Motivo:** o Hostinger detecta e builda projetos Next.js nativamente sem precisar de container; um `Dockerfile` na raiz do repo estava inclusive confundindo o detector de framework do painel (hipótese testada e mantida como boa prática, embora a causa raiz real do erro de deploy tenha sido outra — ver `CHANGELOG.md`).
**Ressalva importante (não é Docker, mas também não é `node_modules` completo):** "sem Docker" não significa que produção roda `next start` sobre a árvore de dependências inteira. O `next.config.ts` define `output: "standalone"`, e o ambiente de execução da Hostinger usa **a árvore produzida pelo Output File Tracing (`@vercel/nft`)**, não o `node_modules` completo. O tracer só copia o que consegue provar estaticamente que é alcançável — arquivos carregados dinamicamente (especificador computado, `path.join(...)` em runtime, `webpackIgnore`/`vite-ignore`) ficam de fora silenciosamente.
**Como aplicar:**

- Mudanças em variáveis `NEXT_PUBLIC_*` exigem reconfigurar/rebuildar no painel do Hostinger (elas são "queimadas" no build), não só editar `.env.local`.
- Ao adicionar uma dependência que carrega assets em runtime, listá-los em `outputFileTracingIncludes` no `next.config.ts`. Precedente: o pdfjs-dist aninhado do `pdf-to-img` faz `await import(this.workerSrc)` com `workerSrc` defaultado para `"./pdf.worker.mjs"` — o build ia pra produção com `pdf.mjs` mas **sem** `pdf.worker.mjs` ao lado, e a geração de thumbnail de PDF falhava com `Setting up fake worker failed: "Cannot find module .../pdf.worker.mjs"`. Mesma coisa para `standard_fonts/`, `cmaps/`, `wasm/` e `iccs/`, cujos caminhos o `pdf-to-img` monta em runtime com `path.join(...)`.
- Sintoma que identifica essa classe de bug: **funciona em `next dev` e `next start`, falha só em produção com "Cannot find module"**. Localmente ambos resolvem do `node_modules` real e completo; produção não. Diagnóstico direto: `npm run build` e comparar `find .next/standalone/node_modules/<pacote> -type f` com o `node_modules/<pacote>` real.

## Segredos nunca digitados pelo assistente em formulários web

**Decisão:** em toda a sessão (Supabase, GitHub, Hostinger), chaves de API, tokens e senhas nunca foram digitados diretamente pelo assistente em campos de formulário na interface. Ou (a) o usuário colou o valor no chat e o assistente escreveu em arquivo local (`.env.local`, etc.), ou (b) o assistente preparou um arquivo local e pediu para o próprio usuário fazer o upload/import pela UI (ex.: `.env.production.import` no Hostinger).
**Motivo:** política de segurança do assistente — evita exposição de segredos a superfícies de automação de navegador e mantém uma trilha auditável de quem efetivamente autorizou cada valor sensível a entrar em produção.
**Como aplicar:** manter esse padrão em qualquer integração futura (ex.: ao reconectar o WhatsApp Cloud API, o `META_APP_SECRET` deve seguir o mesmo fluxo).

## Testes pré-existentes com falha não foram "consertados" às pressas

**Decisão:** as 5 falhas em `currency.test.ts` e `date-utils.test.ts` (ambiente-dependentes: ICU/locale e timezone) foram documentadas como conhecidas em vez de alteradas.
**Motivo:** são arquivos do template upstream, não tocados por nenhuma mudança desta sessão, e o comportamento incorreto só se manifesta neste ambiente Windows local (fuso -3, build de ICU específico) — não necessariamente em produção/CI. Alterar lógica de data/moeda sem entender o contexto original do mantenedor é mais arriscado do que deixar documentado.
**Como aplicar:** se decidir corrigir, começar por `mondayIndex` em `src/lib/dashboard/date-utils.ts` (comparar em UTC em vez de hora local) e só então investigar a divergência de `Intl.NumberFormat` em `currency.ts`.
