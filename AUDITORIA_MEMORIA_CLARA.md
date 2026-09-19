# RELATÓRIO DE AUDITORIA TÉCNICA E FORENSE
## Arquitetura de Memória, Aprendizado, RAG e Prompt da Clara (WACRM)

> **Data da Auditoria:** 18 de Setembro de 2026  
> **Status:** Diagnóstico concluído (Leitura estrita / Somente-leitura)  
> **Destinatário:** Claude Code / Engenharia WACRM  
> **Ambiente Auditado:** Código-fonte (`c:\Projetos\WACRM`) e Banco de Produção Supabase (`qedptmrcvcbzhucoeznd`)

---

## 1. RESUMO EXECUTIVO & RESPOSTA À PERGUNTA CENTRAL

> **A Clara realmente aprende com as conversas de Ronaldo e Tatiana, distingue conhecimento global de conhecimento específico e usa esse aprendizado corretamente na resposta?**

**RESPOSTA DIRETA:** **NÃO.**

Hoje, a arquitetura de memória e aprendizado da Clara sofre de uma **desconexão estrutural completa**:
1. **Desconexão de `ai_memories`:** A tabela `ai_memories` existe no Supabase e possui 74 registros (gerados por backfill), mas **nenhuma linha de código em todo o projeto WACRM consulta essa tabela**. O `PromptBuilder` e o `conversation-engine.ts` não a utilizam.
2. **Separação incorreta de Tenant (`account_id`):** Os 74 registros existentes na tabela `ai_memories` foram gravados sob um `account_id` inativo (`7f434d39...`). Na conta de produção real onde ocorrem as 421 conversas ativas (`f8d2ae51...`), a tabela `ai_memories` possui **exatamente 0 registros**.
3. **Áudios de corretores 100% ignorados:** Existem 315 mensagens de áudio de corretores no banco e **nenhuma possui transcrição (`transcript_text = NULL`)**. O código possui travas contratuais deliberadas que rejeitam transcrever qualquer áudio cujo remetente seja `agent`.
4. **Perda total de autoria e contexto no Scanner:** O scanner agrupa todas as mensagens recentes de todas as conversas da conta em uma única linha do tempo achatada, sem identificação de conversa, sem diferenciar Ronaldo de Tatiana e **incluindo as mensagens da própria Clara (bot) rotuladas como `[atendente]`**.
5. **Memória de Anúncio Ausente no Prompt:** O criativo, headline e oferta do anúncio (Meta Ads/CTWA) não são passados ao `PromptBuilder`. O anúncio é usado apenas para resolver o ID do imóvel e descartado.
6. **O que REALMENTE funciona:** O RAG legado (`ai_knowledge_chunks`) e a `lead_intelligence` (preferências do contato) funcionam e mantêm isolamento estrito entre imóveis e entre clientes.

---

## 2. MAPEAMENTO DETALHADO DO FLUXO DE PONTA A PONTA

### Fluxo A: Mensagens de Texto / Chat

```
MENSAGEM (WhatsApp)
  │
  ▼
[messages] (content_text, content_type, sender_type, conversation_id)
  │
  ▼
learning-generate.ts :: generateLearningSuggestions()
  │  Lê mensagens recentes (gt: learning_last_scanned_at)
  │  Filtra via effectiveMessageText()
  │  ⚠️ Achatamento: converte todas em ChatMessage[] linear
  ▼
learning-prompt.ts :: buildLearningScanUserPrompt()
  │  Formata: "[cliente] ... \n [atendente] ..."
  │  ⚠️ Não passa conversation_id, nem agent_name, nem ad_id
  ▼
LLM Scan (OpenAI / Anthropic)
  │
  ▼
learning-types.ts :: parseLearningScanResult()
  │  Retorna LearningCandidate[]
  ▼
[ai_suggestions] (category='learning', status='pending')
  │
  ▼
Aprovação: PATCH /api/ai/suggestions/[id]
  │
  ├─► property_subjective  ──► [property_ai_contexts.subjective_knowledge] & embeddings
  ├─► never_rule / boundary ──► [ai_configs.global_never_rules]
  ├─► language_style       ──► [ai_configs.team_presentation]
  └─► global_knowledge     ──► [ai_knowledge_documents] & embeddings
  │
  ⚠️ TABELA ai_memories NUNCA É ALIMENTADA NESTE FLUXO
  │
  ▼
Retrieval: knowledge.ts :: retrievePropertyKnowledge()
  │  Executa RPCs match_property_ai_knowledge_semantic e _fts
  │  Busca em [ai_knowledge_chunks] (apenas chunks de documentos)
  ▼
PromptBuilder: prompt-builder.ts :: buildConversationalSystemPrompt()
  │  Monta 11 seções estruturadas
  ▼
Clara: conversation-engine.ts :: executeConversationalTurn()
```

### Fluxo B: Áudio do Corretor

```
ÁUDIO DO CORRETOR (WhatsApp / App)
  │
  ▼
[messages] (content_type='audio', sender_type='agent', transcript_text=NULL)
  │
  ▼
transcribe-audio.ts :: transcribeInboundAudioMessage()
  │  ⚠️ Bloqueio Contratual: "Only for sender_type='customer'"
  │  Rota /api/ai/transcribe retorna HTTP 400 se sender_type !== 'customer'
  ▼
transcript_text permanece NULL
  │
  ▼
message-text.ts :: effectiveMessageText()
  │  Retorna NULL para áudio sem transcrição
  ▼
learning-generate.ts (linhas 88-90)
  │  .filter((r) => r.text !== null) descarta a mensagem silenciosamente
  ▼
0 áudios analisados ──► 0 sugestões ──► 0 memórias
```

---

## 3. AUDITORIA DO BANCO DE DADOS EM PRODUÇÃO

### Tabela `ai_memories`

* **Total de Registros:** 74
* **Por Escopo (`scope`):**
  * `global`: 52
  * `property`: 22
  * `ad`: 0
  * `conversation`: 0
* **Por Tipo (`knowledge_type`):**
  * `communication_pattern`: 43
  * `property_subjective`: 22
  * `process_suggestion`: 9
* **Por Status:** `active`: 74 (100%)
* **Por Confiança:** `high`: 74 (100%)
* **Por Empreendimento (`property_id`):**
  * `NULL`: 53
  * `c5851f88-0dd0-46b9-9a1d-06487fbc69f5` (Live Park): 21
  * Demais imóveis: 0
* **Por `ad_id`:** `NULL`: 74 (100%)
* **Por `conversation_id`:** `NULL`: 74 (100%)
* **Por Origem (`source_type`):** `backfill_migration`: 74 (100% criados em lote em 18/09/2026 20:30 UTC a partir de sugestões antigas; nenhuma gerada organicamente).

### Anomalias Críticas do Banco

1. **Desconexão de Tenant:**
   * Conta Ativa com 421 conversas: `account_id = 'f8d2ae51-e393-4a74-a432-ddab0610837e'` -> **0 memórias**.
   * Conta Inativa onde o backfill inseriu: `account_id = '7f434d39-87d8-4d16-8262-e3006908d1c5'` -> **74 memórias**.
2. **Registro de Propriedade Órfão de `property_id`:**
   * ID: `7063cde3-fa27-426d-88d2-3639ee790ad5`
   * Scope: `property`
   * Property ID: `NULL`
   * Conteúdo: *"O Avant Home, em Intermares, é apresentado como um studio pronto..."*
3. **Memórias Aprovadas com Violação de Regras Críticas:**
   * ID `e0da2fc4...`: Revela que a construtora do Liv Park é a *"LCA Construções"* (viola sigilo absoluto de construtora).
   * ID `9f44d218...`: Divulga valores *"a partir de R$ 268.000 e parcelas menores que R$ 1.000"* para o Liv Park (imóvel em pré-lançamento).

### Tabela `ai_suggestions`

* **Total de Sugestões:** 647 (todas na conta ativa `f8d2ae51...`)
  * `followup`: 85 aprovadas, 378 pendentes
  * `learning`: 74 aprovadas, 73 pendentes
  * `pipeline_move`: 34 aprovadas, 3 pendentes
* **Sugestões Aprovadas com `applied_target = NULL`:** 119 registros (categorias `followup` e `pipeline_move`).

---

## 4. AUDITORIA DE ISOLAMENTO E CROSS-PROPERTY LEAKAGE

Auditoria realizada com 3 empreendimentos reais da conta:
1. **Live Park** (`c5851f88-0dd0-46b9-9a1d-06487fbc69f5`) — Pré-lançamento
2. **Avant Home** (`39325280-ac10-48e4-ae13-5318ecaa02ac`) — Pronto
3. **Puerto Ventura - Locação** (`4f27cb41-ecbb-4175-bc19-005245a5494c`) — Locação

### Teste de Retrieval via RPCs (`match_property_ai_knowledge_fts` / `semantic`)

| Origem | Recebe do Live Park? | Recebe do Avant Home? | Recebe do Puerto Ventura? |
|---|---|---|---|
| **Live Park** | **SIM** (apenas dele) | **NÃO** | **NÃO** |
| **Avant Home** | **NÃO** | **SIM** (apenas dele) | **NÃO** |
| **Puerto Ventura** | **NÃO** | **NÃO** | **SIM** (apenas dele) |

**Conclusão:** No mecanismo ativo de RAG (`ai_knowledge_chunks`), **o isolamento é 100% eficaz**. Não há vazamento entre empreendimentos porque a cláusula SQL filtra `(c.property_id = p_property_id OR c.property_id IS NULL)` e todos os chunks específicos possuem `property_id` preenchido.

---

## 5. AUDITORIA DE ANÚNCIOS (META ADS / CTWA)

* **Detecção:** O webhook captura `ctwa_referral` e salva em `conversations.ctwa_referral`. Das 421 conversas, **383 possuem dados de CTWA**.
* **Resolução:** O arquivo `property-resolution.ts` utiliza `ctwa_referral->>'source_id'` para buscar na tabela `property_ad_mappings` e associa o empreendimento correto.
* **Gargalo:** O `PromptBuilderArgs` em `prompt-builder.ts` **não possui campos para anúncio**. Nem o headline nem o texto do anúncio chegam ao modelo. A Clara não sabe qual oferta trouxe o lead.

---

## 6. AUDITORIA DO APRENDIZADO DE CORRETORES (RONALDO E TATIANA)

* **Diferenciação:** O arquivo `learning-generate.ts` não seleciona `sender_id` ou nome do usuário.
* **Mapeamento:**
  * Leads: `sender_type === 'customer'` -> `role: 'user'` -> `[cliente]`
  * Corretores humanos: `sender_type === 'agent'` -> `role: 'assistant'` -> `[atendente]`
  * Clara (bot): `sender_type === 'bot'` -> `role: 'assistant'` -> `[atendente]`
* **Risco Comprovado:** As próprias respostas automáticas da Clara são reanalisadas pelo scanner como se fossem mensagens de um corretor experiente.
* **Áudios:** 100% descartados por rejeição de código em `transcribe-audio.ts`.

---

## 7. AUDITORIA DO CRON DE APRENDIZADO

* **Status:** O cursor `learning_last_scanned_at` da conta ativa (`f8d2ae51...`) está **paralisado em 13/09/2026 15:00:41 UTC**.
* **Mensagens Acumuladas:** Existem **1.029 mensagens** enviadas após 13/09/2026 que nunca foram processadas pelo scanner.

---

## 8. RESULTADO DOS TESTES AUTOMATIZADOS

* **Comando:** `npm test` (Vitest)
* **Resultado:**
  * Arquivos de teste: **134 aprovados** (100%)
  * Total de testes: **1.321 aprovados** (100%)
  * Falhas: **0**
  * Duração: 13.68s
* **COBERTURA REAL DA ARQUITETURA DE MEMÓRIA: BAIXA**
  * Motivo: **Nenhum dos 1.321 testes valida a tabela `ai_memories`**. Os testes utilizam mocks que simulam o comportamento idealizado sem conectar o pipeline real de ponta a ponta.

---

## 9. CLASSIFICAÇÃO DOS COMPONENTES

| Componente | Classificação | Justificativa Técnica |
|---|---|---|
| Isolamento RAG por Empreendimento | 🟢 FUNCIONANDO | RPCs filtram rigidamente por `property_id`; 0 vazamentos |
| Resolução de Imóvel por Anúncio | 🟢 FUNCIONANDO | Casa `source_id` com `property_ad_mappings` com precisão |
| Isolamento de Memória por Lead | 🟢 FUNCIONANDO | `lead_intelligence` consulta exclusivamente por `contact_id` |
| PromptBuilder e Regras Proibitivas | 🟢 FUNCIONANDO | Sigilo de construtora e proteção de preços em camadas consistentes |
| Scanner Textual de Aprendizado | 🟡 PARCIAL | Funciona mas achata conversas e mistura bot com corretores |
| Cron de Aprendizado em Produção | 🟡 PARCIAL | Paralisado desde 13/09/2026 para a conta principal |
| Conexão da tabela `ai_memories` | 🔴 PROBLEMA | Tabela órfã: nenhum arquivo do projeto a consulta para o prompt |
| Tenant da tabela `ai_memories` | 🔴 PROBLEMA | 74 memórias gravadas na conta errada (`7f434d39`); conta real tem 0 |
| Transcrição de Áudios de Corretores | 🔴 PROBLEMA | Trava explícita no código rejeita `sender_type = 'agent'` (0/315 transcritos) |
| Identificação Ronaldo vs Tatiana | 🔴 PROBLEMA | Inexistente no código; ambos rotulados como `[atendente]` |
| Conteúdo do Anúncio no Prompt | 🔴 PROBLEMA | Headline e criativo do anúncio descartados após resolução do imóvel |
| Função `promoteMemoryScope` | 🔴 PROBLEMA | Função inexistente em código, migrações e histórico git |

---

## 10. RESPOSTAS ÀS 15 PERGUNTAS DO BRIEFING

1. **Clara aprende hoje com mensagens de Ronaldo?**  
   **PARCIAL / NÃO ATRIBUÍDO.** Lê textos, mas não sabe quem é Ronaldo (rotula como `[atendente]` misturado com Clara). Cron paralisado desde 13/09.
2. **Clara aprende hoje com mensagens de Tatiana?**  
   **PARCIAL / NÃO ATRIBUÍDO.** Idêntico a Ronaldo; autoria perdida.
3. **Clara aprende hoje com áudios de Ronaldo?**  
   **NÃO.** 0 de 315 áudios transcritos; código rejeita expressamente transcrever agentes.
4. **Clara aprende hoje com áudios de Tatiana?**  
   **NÃO.** Mesma trava técnica; nenhum áudio transcrito.
5. **O estilo de Ronaldo é efetivamente recuperado para gerar respostas?**  
   **NÃO.** Não há estilo de Ronaldo isolado no banco nem no prompt.
6. **O estilo de Tatiana é efetivamente recuperado para gerar respostas?**  
   **NÃO.** Inexistente no prompt.
7. **Conhecimentos GLOBAL estão chegando ao prompt?**  
   **SIM.** Chunks com `property_id IS NULL` chegam via Seção 9 do PromptBuilder.
8. **Conhecimentos PROPERTY estão chegando somente à propriedade correta?**  
   **SIM.** RAG técnico isola estritamente por `property_id`.
9. **Conhecimentos AD estão chegando somente ao anúncio correto?**  
   **NÃO.** O conteúdo do anúncio não chega a nenhum prompt; é descartado após resolver o imóvel.
10. **Conhecimentos CONVERSATION estão isolados?**  
    **SIM.** `lead_intelligence` isola estritamente pelo `contact_id`.
11. **Ainda existe vazamento através do RAG legado?**  
    **NÃO.** Documentos com `property_id = NULL` contêm apenas conceitos institucionais genéricos.
12. **Ainda existem approved com applied_target = null?**  
    **SIM.** 119 sugestões aprovadas possuem `applied_target = NULL` (follow-up e pipeline).
13. **Existem memórias classificadas no escopo errado?**  
    **SIM.** Registro `7063cde3...` ("O Avant Home...") é de propriedade mas tem `property_id = NULL`. Fatos do Bessa foram aprovados como estilo global.
14. **O PromptBuilder realmente usa ai_memories em produção?**  
    **NÃO.** O PromptBuilder não possui nenhuma linha de código consultando `ai_memories`.
15. **Qual é o maior problema restante da arquitetura?**  
    **A ILUSÃO DE APRENDIZADO POR DESCONEXÃO ESTRUTURAL:** A tabela `ai_memories` foi criada e populada via migração de backfill, mas o motor da Clara não a lê; os 315 áudios dos corretores onde reside a inteligência comercial real são rejeitados pelo transcrevedor; e o scanner achata todas as conversas sem distinguir corretores de robôs.
