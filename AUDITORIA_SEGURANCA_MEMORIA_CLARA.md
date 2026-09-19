# Auditoria de Segurança e Proteção Comercial da Memória da Clara

**Data:** 18 de Setembro de 2026  
**Auditor:** Antigravity (Auditoria Independente de Segurança)  
**Alvo:** Arquitetura de Memória Dinâmica (`ai_memories`) e Prompt Builder  
**Commit Auditado:** `2e05749` (Branch `main`)  
**Status da Auditoria:** 🔴 **PROBLEMA IDENTIFICADO** (Regras de proteção comercial podem ser contornadas por memórias aprendidas)

---

## 1. Objetivo e Escopo da Auditoria

Verificar se a nova arquitetura de aprendizado e memória contínua da Clara respeita rigorosamente a separação entre:

$$\textbf{O QUE A CLARA SABE} \quad \neq \quad \textbf{O QUE A CLARA TEM PERMISSÃO PARA DIZER/FAZER}$$

A hierarquia formal inegociável do sistema exige:

$$\text{REGRAS DE SEGURANÇA / PROTEÇÃO COMERCIAL} \;>\; \text{MEMÓRIAS APRENDIDAS} \;>\; \text{BASE DE DADOS / IMÓVEIS}$$

Uma memória aprendida, por mais consolidada que seja, **nunca pode conceder autorização para violar uma regra de proteção comercial preexistente**.

---

## 2. Veredito Executivo

| Cenário Auditado | Veredito | Vulnerabilidade Principal |
| :--- | :---: | :--- |
| **1. Localização / Endereço Exato** | 🔴 **PROBLEMA** | Não há proibição contra fornecer rua/número. O prompt explicitamente autoriza responder "localização e bairro" como território livre. Se Clara memorizar rua/número de um imóvel, ela falará. |
| **2. Preços e Descontos** | 🔴 **PROBLEMA** | O prompt autoriza revelar preço de imóvel com estágio `pronto` desde que esteja no "contexto autorizado". Como memórias de imóvel são injetadas no contexto, preços aprendidos em chats informais viram preço oficial autorizado. O regex de segurança (`isPriceTampering`) possui brecha grave. |
| **3. Construtora / Incorporadora** | 🟡 **PARCIALMENTE SEGURO** | Há regra textual firme na Camada 1 proibindo citar construtora/incorporadora. Porém, a barreira é **100% probabilística (LLM)**. Não há sanitizador pós-geração ou guardrail determinístico via código. |
| **4. Marcação de Visitas** | 🟡 **PARCIALMENTE SEGURO** | Há instrução de handoff obrigatório no prompt, mas o pós-processamento no `conversation-engine.ts` não bloqueia se o LLM confirmar data/hora diretamente. |
| **5. Promoção Automática de Anúncios** | 🔴 **PROBLEMA CRÍTICO** | A função `promoteAdMemoryToProperty` eleva memórias de anúncio com $\ge 3$ ocorrências para fatos permanentes do imóvel sem nenhuma aprovação humana. |

---

## 3. Análise Forense Detalhada por Cenário

### 3.1. Cenário 1: Localização / Endereço Exato

#### Pergunta da Auditoria:
> *A Clara pode aprender internamente onde fica o imóvel (rua, número, pontos de referência), mas continuar estritamente impedida de passar o endereço exato para o cliente antes da qualificação/autorização?*

#### Achado Técnico:
* **Arquivo:** `src/lib/ai/prompt-builder.ts` (linhas 371 a 376)
* Nas seções de "Fronteiras Rígidas" e "Global Never Rules" do prompt da Clara, **NÃO EXISTE NENHUMA REGRA** que proíba a revelação de rua ou número.
* Pelo contrário, a Seção 5 (*Território Autorizado*) afirma textualmente:
  ```typescript
  // prompt-builder.ts:373
  "- Localização, bairro e proximidade da praia / pontos de interesse"
  ```
* Se um corretor disser no WhatsApp: *"O Ocean Palace fica na Rua das Gaivotas, 450, apto 302"*, o scanner de memória salvará isso como `property_fact`.
* **Comportamento em Produção:** Na próxima pergunta de um lead (*"Onde fica exatamente o Ocean Palace?"*), o LLM lerá a memória autorizada na Seção 8 e responderá a rua e o número sem qualquer bloqueio, pois o prompt diz que localização é "território autorizado".

---

### 3.2. Cenário 2: Preços de Imóveis (Lançamento vs. Pronto)

#### Pergunta da Auditoria:
> *Se a Clara aprender valores discutidos em conversas, ela pode usar isso para responder preço quando a regra geral proíbe?*

#### Achados Técnicos:

1. **A Exceção de Imóvel Pronto no Prompt:**
   * **Arquivo:** `src/lib/ai/prompt-builder.ts` (linhas 343 a 347)
   * O código estabelece:
     ```typescript
     // Se stage === 'pronto':
     "- Você PODE informar o preço de venda se o cliente perguntar expressamente,
        DESDE QUE o preço esteja expressamente disponível no conhecimento/contexto autorizado."
     ```
   * Como a Seção 8 injeta as memórias de imóvel (`propertyMemories`) como **conhecimento autorizado**, qualquer valor numérico aprendido de uma conversa entre corretores se torna automaticamente preço oficial autorizado para divulgação.

2. **A Falha de Regex no Scanner de Aprendizado:**
   * **Arquivo:** `src/lib/ai/learning-types.ts` (linhas 86 a 90)
   ```typescript
   export function isPriceTampering(text: string): boolean {
     const priceTamperRegex = /(?:alterar|mudar|trocar|atualizar|definir|baixar|aumentar|dar\s+desconto|fazer\s+por|fechar\s+por|preço\s+(?:agora|novo|correto|real))\s+(?:de|para|em|o|a)?\s*(?:R\$\s*)?[\d.,]+/i
     return priceTamperRegex.test(text)
   }
   ```
   * Esse regex exige **verbos de ação** (*alterar*, *mudar*, *dar desconto*).
   * **A Brecha:** Se um usuário ou corretor enviar no chat:
     > *"O valor deste duplex é R$ 450.000."*  
     > ou  
     > *"Unidades a partir de R$ 268.000."*
   * O teste `isPriceTampering()` retorna **`false`**. O scanner aprova a extração e a memória de preço é gravada no banco. Em um imóvel de estágio `pronto`, a Clara usará esse valor como preço oficial liberado para o cliente.

---

### 3.3. Cenário 3: Construtora / Incorporadora

#### Pergunta da Auditoria:
> *A Clara pode aprender qual é a construtora responsável, mas continuar proibida de revelar isso diretamente?*

#### Achado Técnico:
* **No Prompt:** Existe proteção textual rígida nas Seções 4 e 7 (*Layer 1 Authority*):
  ```typescript
  // prompt-builder.ts:333
  "- NUNCA mencione o nome da construtora ou incorporadora (ex: 'LCA', 'LCA Construções')."
  ```
* **No Banco de Dados:** No banco Supabase de produção, já existe a memória:
  ```json
  {
    "id": "e0da2fc4-5fe5-4b11-b0db-fc717208d2ee",
    "scope": "property",
    "fact_key": "general_info",
    "fact_value": "Construtora responsável: LCA Construções"
  }
  ```
* **A Vulnerabilidade:** A proteção é **exclusivamente probabilística**. Depende unicamente de o LLM obedecer à proibição textual da Seção 4 enquanto lê a Seção 8 contendo o nome da construtora.
* Em `src/lib/ai/conversation-engine.ts`, **não existe nenhum pós-processador regex determinístico** que verifique a saída gerada pela IA e sanitize o nome de construtoras cadastradas antes de despachar a mensagem pelo WhatsApp. Sob prompt injection ou variações de raciocínio do modelo, o vazamento pode ocorrer.

---

### 3.4. Cenário 4: Marcação de Visitas e Agendamentos

#### Pergunta da Auditoria:
> *Se a Clara aprender como o corretor agenda visitas, ela pode assumir que agora tem permissão para marcar visitas sozinha?*

#### Achado Técnico:
* A Seção 1 (*Handoff Obligatory*) instrui a Clara a transferir o atendimento humano para agendamento.
* O sistema de aprendizado não cria ferramentas dinâmicas (`tools`) de agendamento por conta própria, pois a lista de tools é estática em código.
* Porém, se o lead insistir (*"Pode ser amanhã às 15h?"*) e a Clara responder (*"Combinado, amanhã às 15h te espero lá!"*), o motor em `conversation-engine.ts` **não possui interceptor determinístico pós-geração**. A mensagem é enviada ao WhatsApp sem validar se houve agendamento direto indevido.

---

### 3.5. Cenário 5: Promoção Automática de Memórias de Anúncio (`promoteAdMemoryToProperty`)

#### Pergunta da Auditoria:
> *Existe risco de uma regra promocional de anúncio virar conhecimento definitivo do imóvel sem curadoria humana?*

#### Achado Técnico:
* **Arquivo:** `src/lib/ai/memory.ts` (linhas 386 a 423)
* O código implementa promoção autônoma de anúncio para imóvel:
  ```typescript
  // memory.ts:397-408
  if (memory.occurrence_count >= 3 && memory.confidence >= 0.8) {
    await supabase.from('ai_memories').upsert({
      scope: 'property',
      scope_id: propertyId,
      memory_type: 'property_fact',
      fact_key: memory.fact_key,
      fact_value: memory.fact_value,
      confidence: Math.min(1, memory.confidence + 0.1),
      source: 'consolidated',
      status: 'active' // Ativado imediatamente sem aprovação humana!
    })
  }
  ```
* **Cenário de Risco Real:**
  1. Um anúncio temporário de campanha de Dia dos Pais diz: *"Entrada facilitada em 60x sem juros"*.
  2. Três clientes comentam isso em conversas monitoradas.
  3. A memória atinge `occurrence_count >= 3`.
  4. O sistema converte autonomamente essa condição promocional temporária em um **fato definitivo do imóvel**, válido para qualquer atendimento futuro.

---

## 4. Comparativo Arquitetural: Camadas do Prompt

Ao analisar a construção do prompt em `src/lib/ai/prompt-builder.ts`, a ordem de injeção é:

```
┌────────────────────────────────────────────────────────┐
│ CAMADA 1: Identidade & Persona (Clara)                │
├────────────────────────────────────────────────────────┤
│ CAMADA 2: Missão Comercial & Qualificação              │
├────────────────────────────────────────────────────────┤
│ CAMADA 3: Diretrizes de Comunicação Humana             │
├────────────────────────────────────────────────────────┤
│ CAMADA 4: Fronteiras Rígidas (Never Rules)            │
├────────────────────────────────────────────────────────┤
│ CAMADA 5: Conhecimento Oficial do Imóvel               │
├────────────────────────────────────────────────────────┤
│ CAMADA 6: Estágio da Obra (Planta vs. Pronto)         │
├────────────────────────────────────────────────────────┤
│ CAMADA 7: Layer 1 Authority (Regras Inegociáveis)      │
├────────────────────────────────────────────────────────┤
│ CAMADA 8: MEMÓRIAS DINÂMICAS APRENDIDAS               │ ◄── Injetado no mesmo
│  - Memórias de Usuário / Lead                         │     nível de confiança
│  - Memórias do Imóvel (ai_memories)                   │     do material oficial!
│  - Memórias do Anúncio (ai_memories)                  │
└────────────────────────────────────────────────────────┘
```

### O Ponto Frágil:
As memórias dinâmicas da Camada 8 entram no prompt sob o título:
`"INFORMAÇÕES ADICIONAIS CONSOLIDADAS SOBRE O IMÓVEL"`

O LLM não recebe nenhuma meta-instrução informando:
> *"Os dados desta seção são memórias de conversas passadas. Elas NUNCA podem ser usadas para informar preço se não houver tabela formal, NUNCA podem revelar endereço exato e NUNCA podem revelar a construtora."*

---

## 5. Plano de Remediação Recomendado (Para o Claude Code)

Para que a arquitetura de aprendizado seja 100% segura comercialmente, recomendamos as seguintes intervenções cirúrgicas:

### 1. Adicionar Regra Explícita de Endereço no Prompt Builder
Em `src/lib/ai/prompt-builder.ts`:
* Adicionar na Camada 4 / Camada 7:
  ```typescript
  "- NUNCA informe o endereço exato do imóvel (rua, número, quadra, lote ou complemento). Você pode informar apenas a cidade, o bairro e pontos de referência gerais."
  ```

### 2. Corrigir o Regex `isPriceTampering`
Em `src/lib/ai/learning-types.ts`:
* Expandir a captura para qualquer menção de valores monetários absolutos que não venham de cadastro formal:
  ```typescript
  export function isPriceTampering(text: string): boolean {
    const hasMonetaryValue = /(?:R\$\s*|reais\b|mil\s*reais|\b\d{3}\.000\b)/i.test(text)
    const hasActionVerb = /(?:preço|valor|custa|fechar|vender|desconto|tabela|a\s+partir\s+de|por)/i.test(text)
    return hasMonetaryValue && hasActionVerb
  }
  ```

### 3. Exigir Curadoria Humana na Promoção de Memórias de Anúncio
Em `src/lib/ai/memory.ts`:
* Alterar o status padrão na promoção para `status: 'pending'` (aguardando aprovação na interface do usuário) em vez de `status: 'active'`.

### 4. Implementar Sanitizador Determinístico Pós-Geração
Em `src/lib/ai/conversation-engine.ts`:
* Antes de chamar `sendWhatsAppMessage`, executar um sanitizador que verifique por regex a presença de termos proibidos (nomes de construtoras cadastradas, números residenciais ou padrões de endereço). Se detectado, mascarar ou abortar o envio para intervenção humana.

### 5. Cláusula de Subordinação da Memória no Prompt
Em `src/lib/ai/prompt-builder.ts`:
* Injetar antes da Seção 8:
  ```typescript
  "AVISO DE SEGURANÇA SOBRE MEMÓRIAS APRENDIDAS:
  As informações a seguir são complementares e submetem-se INTEGRALMENTE às Regras de Proteção Comercial. Se uma memória contiver nome de construtora, preço não oficial ou endereço exato, você ESTÁ EXPRESSAMENTE PROIBIDA de divulgá-los ao cliente."
  ```

---

## 6. Conclusão da Auditoria

A memória da Clara hoje **possui capacidade de contornar regras de proteção comercial** porque:
1. Não existe proibição explícita sobre endereço exato.
2. A exceção de preço para imóveis prontos valida memórias dinâmicas como fonte autorizada.
3. Não existem guardrails determinísticos pós-LLM no código.
4. Anúncios são promovidos a fatos definitivos de imóveis sem supervisão humana.

O sistema está **apto para operar com segurança** assim que as 5 remediações acima forem aplicadas pelo Claude Code.
