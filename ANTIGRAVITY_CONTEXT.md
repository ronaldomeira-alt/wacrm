# ANTIGRAVITY_CONTEXT.md — Mapa de Contexto Técnico e Protocolo Operacional

> **Aviso:** Este é um mapa de referência técnica estático e protocolo permanente de operação. Ele **NÃO** autoriza alterações sem prévia análise pontual dos arquivos afetados no código real.

---

## 1. Visão Geral do Sistema
- **Nome do Projeto:** WACRM (Fork de `ArnasDon/wacrm` mantido em `ronaldomeira-alt/wacrm`).
- **Propósito:** CRM de leads imobiliários via WhatsApp (focado na região de João Pessoa/PB).
- **Escopo Funcional:** Gestão exclusiva de leads — captura, qualificação, funis de vendas, automações sem código, construtor de fluxos visuais, follow-ups de IA, campanhas/broadcasts e agendamento de compromissos. **NÃO inclui catálogo de imóveis nem gestão predial/condominial.**
- **Instalação:** Multi-tenant por conta (`account_id`), com controle de permissões por papéis (`owner`, `admin`, `agent`, `viewer`).

---

## 2. Stack Tecnológica
- **Frontend / Meta-framework:** Next.js 16.2.12 (App Router, React 19.2.4, TypeScript 6, Tailwind CSS v4).
- **UI & Componentes:** Base UI (`@base-ui/react`), Lucide React (`lucide-react`), Recharts (`recharts`), Sonner (`sonner`), Drag-and-Drop (`@dnd-kit`), Diagramas (`@xyflow/react`, `@dagrejs/dagre`).
- **i18n:** `next-intl` (`pt-BR` como locale padrão via `NEXT_PUBLIC_APP_LOCALE=pt-BR`).
- **Backend / Database:** Supabase Postgres, Auth (Email/Senha), Storage (Mídias de chat, avatares), Realtime, RLS em todas as tabelas.
- **Canais do WhatsApp (Arquitetura Dupla):**
  1. **Meta Cloud API Oficial (Número WABA "8810"):** Atendimento compartilhado de leads novos/inbound, disparos formais via templates aprovados da Meta.
  2. **Baileys (WebSockets via WhatsApp Web - Número pessoal):** Conexão via biblioteca `baileys` para campanhas de relacionamento e disparos em lote com clientes convertidos.
- **Hospedagem & Deploy:** Hostinger Node.js Web App (Deploy automático via Git na branch `main` com `output: "standalone"`).
- **Notificações:** Web Push API (VAPID) com Service Worker em `public/sw.js`.

---

## 3. Estrutura de Diretórios Relevante
```
wacrm/
├── src/
│   ├── app/
│   │   ├── (auth)/             # Telas de login, signup, esqueci a senha
│   │   ├── (dashboard)/        # Área autenticada (inbox, contacts, pipelines, campaigns, automations, flows, agents, notifications, settings, calculadora)
│   │   ├── api/                # Handlers REST/Webhooks/Crons
│   │   │   ├── ai/             # Endpoints de IA (draft, autoreply, lead-analysis, followups/cron, ctwa-rescue/cron, learning/cron)
│   │   │   ├── automations/    # Engine e cron de automações sem código
│   │   │   ├── calendar/       # Webhook e crons de integração Google Calendar
│   │   │   ├── envios/         # Filas, controle de lotes Baileys e cron de envios
│   │   │   ├── flows/          # Construtor visual de fluxos e cron
│   │   │   ├── followup-plans/ # Cancelamento/gestão de planos de follow-up
│   │   │   ├── push/           # Notificações Web Push
│   │   │   ├── v1/             # REST API pública autenticada por API key (v1)
│   │   │   └── whatsapp/       # Webhook da Meta, config, mídias, templates
│   ├── components/             # Componentes modulares por domínio (inbox, contacts, settings, ui, etc.)
│   ├── hooks/                  # Hooks customizados (use-app-height.ts, use-auth.tsx, use-realtime.ts, use-presence.ts)
│   ├── lib/                    # Camada de serviços e regras de negócio
│   │   ├── ai/                 # Auto-reply, busca híbrida no banco, lead analysis, follow-up planner
│   │   ├── automations/        # Engine de execução de automações
│   │   ├── baileys/            # Gestão da conexão WebSocket Baileys, auth state, socket singleton
│   │   ├── contacts/           # Deduplicação de contatos, importação CSV, tags
│   │   ├── flows/              # Engine de execução de fluxos visuais
│   │   ├── inbox/              # Tratamento de mensagens, mídias e reações
│   │   ├── pipelines/          # Auto-criação e movimentação de cards Kanban (deals)
│   │   ├── push/               # Envio de notificações push VAPID
│   │   ├── webhooks/           # Despachante de webhooks externos de saída (HMAC-SHA256)
│   │   └── whatsapp/           # Cliente Meta Cloud API, decodificação AES-256-GCM, validação HMAC
│   └── types/                  # Tipos TypeScript do domínio
├── supabase/
│   └── migrations/             # 87+ arquivos SQL de migração sequencial (001 a 084 + migrações com data)
├── docs/                       # Documentação técnica original (ARQUITETURA.md, DECISOES_TECNICAS.md, STATUS_PROJETO.md)
└── public/
    └── sw.js                   # Service Worker para Push Notifications
```

---

## 4. Módulos e Funcionalidades Centrais

1. **Inbox Compartilhado:**
   - Atendimento multi-agente centralizado na Meta Cloud API.
   - Suporte a mensagens de texto, imagens, áudios (Opus/OGG/MP3), vídeos, documentos (com geração de preview de PDF), localização e reações.
   - Atribuição de conversas, fixação (pin), tags rápidas, notas internas, encerramento de atendimento.
   - Suporte a mensagens interativas (botões de resposta e listas).

2. **Gestão de Contatos & Leads:**
   - Cadastro, importação CSV com deduplicação por telefone (`normalizePhone`).
   - Categorização por tags livres (`tags.category`, ex: "Finalidade", "Bairro", "Faixa de valor").
   - Segmentos dinâmicos (`segments` / `segment_tags`).
   - Bloqueio de leads (`contact.blocked_at` — interrompe ingestão e automações).
   - Arquivamento de contatos e inteligência de leads (score de lead, tags automáticas de IA).

3. **Pipelines / Funis de Vendas (Kanban):**
   - Criação automática de card (Deal) no primeiro estágio assim que entra mensagem de lead novo (`ensureDealForNewLead`).
   - Organização visual de cards, atualização de valores, drag-and-drop, movimentação de etapas.

4. **Disparos & Campanhas:**
   - **Meta Templates (Cloud API):** Disparos para novas listas usando templates aprovados pela Meta.
   - **Campanhas Baileys (Número pessoal):** Disparos em lote (`envios` / `envios_lotes`) via número Baileys pareado com atrasos parametrizáveis anti-bloqueio e variações de mensagem.

5. **Motor de Automações No-Code:**
   - Gatilhos: `inbound_message`, `keyword`, `new_contact_created`, `first_inbound_message`, `schedule`.
   - Ações: Enviar mensagem, adicionar/remover tag, aguardar (wait delay), chamar webhook externo, condicional de horário/tag.

6. **Engine de Fluxos Visuais (Flows):**
   - Construtor interativo base em `@xyflow/react`.
   - Execução de jornadas passo a passo acionadas por respostas do cliente (botões/menus interativos).

7. **Inteligência Artificial (IA):**
   - Assistente no inbox para rascunhar respostas em 1 clique (OpenAI / Anthropic com chaves do cliente).
   - Bot de auto-resposta com busca híbrida de conhecimento (Full-Text Search no Postgres + Embeddings pgvector).
   - Planos de Follow-up Inteligente (cancelados automaticamente assim que o cliente responde).
   - Resgate de leads de anúncios CTWA (Click-to-WhatsApp Ads).

8. **Agenda & Compromissos:**
   - Módulo de agendamento (`appointments`) vinculado a contatos e imóveis de referência (`properties`).
   - Preparação de sync via Google Calendar (webhook e cron de renovação de canais `watch-cron`).

9. **REST API Pública (`/api/v1`) & Webhooks Externos:**
   - Autenticação por chaves revogáveis (`api_keys` com scopes como `webhooks:manage`).
   - Envio de eventos (`message.received`, `conversation.created`, `message.status_updated`) com assinatura HMAC em `webhook_endpoints`.

---

## 5. Fluxos Críticos do Sistema

### A. Recebimento de Mensagem Inbound (Meta Cloud API)
1. **Ponto de entrada:** `POST /api/whatsapp/webhook`.
2. **Validação:** Valida assinatura HMAC-SHA256 (`x-hub-signature-256`) com `META_APP_SECRET`.
3. **Assincronismo:** Responde HTTP 200 OK imediatamente e executa o processamento dentro de `after()` do Next.js.
4. **Mapeamento de Conta:** Identifica a conta pelo `phone_number_id` em `whatsapp_config`.
5. **Deduplicação / Bloqueio:**
   - Busca/Cria Contato (`findOrCreateContact`). Se `blocked_at` estiver preenchido, encerra imediatamente.
   - Busca/Cria Conversa (`findOrCreateConversation`).
   - Se for novo lead, cria Card no Kanban (`ensureDealForNewLead`).
   - Cancela planos ativos de follow-up (`cancelActiveFollowupPlan`).
6. **Persistência:** Salva em `messages` com `sender_type = 'customer'` e status `delivered`.
7. **Disparos em Cadeia (Fan-out):**
   - Emite evento para webhooks externos (`dispatchWebhookEvent`).
   - Dispara Web Push aos agentes (`sendPushToAccount`).
   - Executa engine de automações (`runAutomationsForTrigger`).
   - Avalia fluxos visuais (`dispatchInboundToFlows`).
   - Avalia auto-resposta de IA (`dispatchInboundToAiReply`).
   - Avalia análise de lead / inteligência (`dispatchInboundToLeadAnalysis`).

### B. Envio de Mensagem Outbound (Inbox → Meta)
1. **Ponto de entrada:** `POST /api/whatsapp/send`.
2. **Verificação de Acesso:** Checa autenticação da sessão Supabase e permissão na conta (`account_id`).
3. **Chamada Externa:** Envia via HTTP para a Meta Graph API usando `access_token` descriptografado (AES-256-GCM).
4. **Persistência:** Grava em `messages` com `sender_type = 'agent'` ou `'system'`, `status = 'sent'`.

### C. Conexão e Manutenção Baileys (WhatsApp Pessoal)
1. **Ponto de entrada:** `POST /api/envios/baileys/parear` ou tick do cron `/api/envios/cron`.
2. **Lifecycle:** Conexão mantida em memória global (`connections` Singleton Map em `src/lib/baileys/connection.ts`).
3. **Autenticação:** Credenciais salvas em tabelas Supabase (`baileys_sessao`, `baileys_sessao_keys`).
4. **Reconexão:** Lida com desconexões 515 (`restartRequired`) reconectando imediatamente.

### D. Disparo de Cron Jobs
- **Endpoints:** `/api/automations/cron`, `/api/flows/cron`, `/api/envios/cron`, `/api/ai/followups/cron`, `/api/ai/ctwa-rescue/cron`, `/api/ai/learning/cron`, `/api/calendar/google/watch-cron`.
- **Segurança:** Todos exigem cabeçalho `x-cron-secret` correspondente a `AUTOMATION_CRON_SECRET`.
- **Mecanismo:** Pings periódicos externos (ex.: cron-job.org) a cada ~30s.

---

## 6. Arquitetura de Banco de Dados (Supabase Postgres)

- **Princípio da Multi-tenancy:** Quase todas as tabelas contêm `account_id`. Dados são isolados por conta via Row-Level Security (RLS).
- **Hardening de Segurança:**
  - `anon` tem acesso bloqueado em quase todas as funções RPC.
  - Exceção intencional: `peek_invitation` para fluxo público de aceite de convite `/join/<token>`.
- **Principais Tabelas:**
  - `accounts`, `profiles`, `account_memberships`, `account_invitations` (Tenancy e usuários).
  - `contacts`, `tags`, `contact_tags`, `custom_fields`, `contact_custom_values`, `segments`, `segment_tags` (CRM).
  - `conversations`, `messages`, `message_reactions` (Chat).
  - `deals`, `pipelines`, `pipeline_stages` (Vendas/Kanban).
  - `whatsapp_config`, `message_templates` (Meta WABA).
  - `baileys_sessao`, `baileys_sessao_keys`, `envios`, `envios_lotes`, `envio_leads` (Baileys).
  - `automations`, `automation_steps`, `automation_runs` (Automações).
  - `flows`, `flow_nodes`, `flow_edges`, `flow_runs` (Fluxos visuais).
  - `broadcasts`, `broadcast_recipients` (Campanhas Meta).
  - `ai_config`, `ai_knowledge`, `followup_plans`, `scheduled_sends` (IA).
  - `appointments`, `properties` (Agenda).
  - `api_keys`, `webhook_endpoints`, `webhook_logs` (API Pública & Webhooks).

---

## 7. Áreas Críticas e Riscos de Alteração

### 🛑 ALTO RISCO / CRÍTICO (Modificar apenas com extremo cuidado e validação prévia)
1. **Sem separação Dev/Prod:**
   - O ambiente local aponta diretamente para o banco de dados Supabase de PRODUÇÃO. Qualquer teste de escrita local afeta dados reais de clientes!
2. **`src/app/api/whatsapp/webhook/route.ts`:**
   - Ponto de entrada de todas as mensagens dos clientes via Meta. Qualquer erro quebre a ingestão de mensagens ou cause loops/retentativas da Meta.
3. **Criptografia e Chaves (`src/lib/whatsapp/encryption.ts`):**
   - Decodificação AES-256-GCM dos tokens de acesso e tokens de verificação do WhatsApp. Erros invalidam toda a comunicação com a API da Meta.
4. **Gerenciador de Conexão Baileys (`src/lib/baileys/connection.ts`):**
   - Gerencia a conexão WebSocket do WhatsApp Pessoal. Tratamentos incorretos de reconexão ou perda de credenciais em `baileys_sessao_keys` desconectam a conta física.
5. **Funções RPC e RLS no Supabase (`supabase/migrations/`):**
   - Acesso a dados e multitenancy. Alterar políticas RLS pode expor dados entre imobiliárias/contas ou bloquear acessos válidos.
6. **Mapeamento de Teclado Mobile iOS (`src/hooks/use-app-height.ts`):**
   - Trata o comportamento delicado do PWA no iOS Safari / standalone ao abrir e fechar o teclado virtual.

---

## 8. Incertezas Identificadas & Pontos para Investigação Futura

1. **Integração Meta Cloud API Ativa no Número de Testes:**
   - `docs/ARQUITETURA.md` menciona que a Meta Cloud API estava com restrições / pendente no WABA no passado. É preciso confirmar o estado atual da conta Meta antes de testar disparos oficiais.
2. **Conexão Google Calendar Stub:**
   - Estruturas de tabelas e código cliente para Google Calendar existem em `src/lib/calendar/`, mas a chamada real OAuth / API ainda é um stub.
3. **Comportamento PWA iOS WebKit Snapshot Compositor:**
   - Conforme documentado em `HANDOFF.md`, há uma limitação conhecida do motor WebKit no iOS ao focar o composer do chat (um desvio visual momentâneo provocado pelo compositor de tela do sistema durante a animação do teclado).

---

## 9. PROTOCOLO PERMANENTE DE OPERAÇÃO E MANUTENÇÃO

Este protocolo é **estritamente obrigatório** para qualquer atuação, modificação ou manutenção no repositório WACRM em tarefas futuras.

### 9.1. Princípio Fundamental
O WACRM é um sistema maduro em produção com comportamento consolidado.
- **A prioridade máxima é a ESTABILIDADE E PRESERVAÇÃO DO COMPORTAMENTO EXISTENTE.**
- Estabilidade e compatibilidade têm precedência sobre modernização, refatoração, elegância ou redução de código.
- Uma implementação existente **NÃO** deve ser alterada por iniciativa própria apenas por haver uma sintaxe mais moderna, uma biblioteca mais nova ou uma arquitetura considerada "mais limpa".

### 9.2. Protocolo de 7 Passos Obrigatórios Antes de Qualquer Alteração
Antes de editar qualquer linha de código em tarefas futuras, o assistente deverá seguir rigorosamente estes passos:

1. **Ler o contexto existente:**
   - Consultar `ANTIGRAVITY_CONTEXT.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` e arquivos de documentação diretamente relacionados.
   - **O código real continua sendo a fonte suprema da verdade.** A documentação serve de mapa inicial e não substitui a leitura direta do código-fonte.
2. **Entender a implementação atual:**
   - Mapear ponto de entrada, componentes, serviços, funções, modelos de dados, integrações e efeitos colaterais.
   - Compreender exatamente como a funcionalidade opera hoje antes de planejar qualquer alteração.
3. **Procurar consumidores e dependências:**
   - Inspecionar sistematicamente quais partes do sistema utilizam a função, componente, hook, endpoint, migration ou tabela a ser alterada.
4. **Definir o menor escopo possível:**
   - Modificar estritamente o necessário para cumprir a solicitação pontual.
   - **Proibido ampliar o escopo:** Não fazer refatorações incidentais, renomeações, limpezas de código, modernizações ou otimizações não solicitadas ("Já que estou mexendo aqui...").
5. **Classificar o risco da alteração:**
   - **BAIXO RISCO:** Ajustes visuais, textos isolados, espaçamentos, ícones.
   - **MÉDIO RISCO:** Componentes compartilhados, hooks, services, filtros, lógica de negócio e consultas reusadas.
   - **ALTO RISCO / CRÍTICO:** Supabase, schema, migrations, RLS, autenticação, webhooks, APIs, crons, automações, Baileys, Meta Cloud API, secrets, env vars, deploy.
6. **Apresentar o plano para médio ou alto risco:**
   - Em alterações de Médio ou Alto Risco, explicitar o plano (o que mudará, por que mudará, arquivos afetados, dependências, riscos de regressão e forma de validação) e aguardar aprovação antes de executar.
7. **Fazer a menor alteração possível:**
   - Fazer edições cirúrgicas e localizadas. Não substituir grandes blocos ou reescrever arquivos inteiros por conveniência.

### 9.3. Regra Absoluta de Preservação do Comportamento
- O comportamento atual do sistema é um contrato implícito.
- Ao implementar novas funcionalidades ou correções, **preserve intactos todos os fluxos, regras de negócio, contratos de API e comportamentos existentes** que não façam parte direta da tarefa.
- Se uma tarefa puder ser cumprida sem alterar uma área existente, essa área **NÃO** deve ser tocada.

### 9.4. Proibição de Alterações por Conveniência
Não é permitido alterar código existente por:
- Preferência pessoal ou estilo de codificação diferente;
- Presença de código duplicado existente;
- Existência de bibliotecas mais recentes;
- Oportunidade aparente de refatoração ou redução de código.

*Diferença mandatória:* Distinguir sempre entre **"precisa mudar para cumprir a tarefa"** (permitido) e **"poderia ser melhor"** (proibido).

### 9.5. Tratamento de Problemas Fora do Escopo
- Se um bug ou fragilidade preexistente for identificado durante a execução de uma tarefa, **ele NÃO deve ser corrigido automaticamente.**
- O problema deve ser registrado e reportado ao usuário, e o trabalho deve prosseguir focado exclusivamente no escopo solicitado.

### 9.6. Proteção Máxima de Infraestrutura e Banco de Dados (Supabase em Produção)
- **Atenção Permanente:** O ambiente local de desenvolvimento conecta-se diretamente ao banco de dados Supabase de **PRODUÇÃO**.
- Nenhuma operação destrutiva, teste de escrita não autorizado ou migration experimental deve ser executada.
- Alterações em Webhooks, Meta API, Baileys, Autenticação e Cron Jobs exigem checagem minuciosa de contratos de entrada e saída.

### 9.7. Testes e Validação de Regressão
- A validação de uma tarefa exige verificar não apenas se a novidade funciona, mas obrigatoriamente se **o comportamento preexistente continua operando perfeitamente sem regressões.**

### 9.8. Tratamento de Incerteza
- Na presença de dúvida razoável sobre dependências ou impactos colaterais em áreas críticas, **interrompa a execução antes de modificar o código** e apresente o ponto de incerteza para alinhamento.

### 9.9. Níveis de Autonomia Progressiva
- **Nível 1 (Leitura):** Livre exploração e análise do código.
- **Nível 2 (Alterações Locais):** Ajustes de baixo risco em UI/textos isolados.
- **Nível 3 (Lógica):** Alterações em regras de negócio e hooks compartilhados após mapeamento de dependências.
- **Nível 4 (Banco):** Alterações em Supabase/RLS/migrations com máxima cautela.
- **Nível 5 (Infraestrutura):** Webhooks, Crons, Baileys, Meta, Auth, Secrets e Deploy exigem análise explícita prévia.
- **Nível 6 (Autonomia Operacional):** Consolidada conforme a aderência contínua a este protocolo for demonstrada.

### 9.10. Regra de Ouro
A sequência obrigatória para toda e qualquer futura tarefa é:
$$\text{ENTENDER} \longrightarrow \text{MAPEAR DEPENDÊNCIAS} \longrightarrow \text{CLASSIFICAR RISCO} \longrightarrow \text{DEFINIR ESCOPO} \longrightarrow \text{PLANEJAR} \longrightarrow \text{ALTERAR O MÍNIMO NECESSÁRIO} \longrightarrow \text{TESTAR} \longrightarrow \text{VERIFICAR REGRESSÕES}$$

### 9.11. Registro no Histórico do Arquivo
Sempre que uma decisão arquitetural relevante, comportamento especial ou proteção contra regressão for descoberta em tarefas futuras, ela deve ser registrada de forma concisa neste documento `ANTIGRAVITY_CONTEXT.md`.
