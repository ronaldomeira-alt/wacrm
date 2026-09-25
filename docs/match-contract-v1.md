# Contrato Match Compartilhado — Versão 1.0 (v1)
# Integração: WACRM (Leads) ↔ Meus Imóveis (Catálogo)

Este documento estabelece o contrato técnico oficial, determinístico e idempotente que governa o subsistema de **Match** e a fundação do túnel de integração entre o **WACRM** e o sistema **Meus Imóveis**.

---

## 1. Princípios Arquiteturais e Fontes da Verdade

1. **WACRM é a fonte da verdade dos LEADS e seus perfis:**
   - O WACRM detém com exclusividade a identidade do lead, maturidade do perfil, requisitos obrigatórios, preferências, tags com proveniência (CTWA vs Conversa), score/temperatura comercial e histórico de mensagens.
2. **Meus Imóveis é a fonte da verdade dos IMÓVEIS:**
   - O Meus Imóveis gerencia o catálogo imobiliário, empreendimentos, unidades, tabelas de preços, disponibilidades, imagens e páginas públicas.
3. **A relação Lead ↔ Imóvel é compartilhada:**
   - O Match entre um lead e um imóvel é calculado e persistido com estado (`novo`, `enviado`, `pausado`, `arquivado`, `suprimido`), score e histórico de envio.
4. **Sem duplicação desnecessária de bases:**
   - O WACRM mantém apenas uma projeção/cache enxuta dos imóveis necessária para a execução do motor determinístico de Match.
5. **Idempotência absoluta:**
   - Toda comunicação entre sistemas, ingestão de eventos e reprocessamento de regras deve ser estritamente idempotente.
6. **Deterministmo e separação de IA:**
   - *"IA entende pessoas. Regras fazem o Match."*
   - O motor de Match é puramente matemático/booleano baseado em atributos estruturados.
   - Temperatura (0–10), Maturidade (0–100%) e Compatibilidade Match (0–100%) são três métricas totalmente distintas que nunca se misturam.

---

## 2. Entidades Compartilhadas e Esquema de Dados

### 2.1. LeadProfile & LeadIntelligence (WACRM)

```typescript
export interface LeadSearchProfile {
  account_id: string;
  lead_id: string;
  maturity: number;              // 0 a 100%
  ai_score: number;              // 0 a 10 (Temperatura/Warmth)
  status: 'active' | 'paused' | 'archived';
  operation?: 'compra' | 'aluguel';
  purpose: string[];             // ["moradia", "investimento"]
  property_types: string[];      // ["apartamento", "flat"]
  locations: string[];           // ["Bessa", "Manaíra"]
  location_strict: boolean;      // true se o cliente disse "somente bairro X"
  price_min: number | null;
  price_max: number | null;      // Orçamento de referência
  price_absolute_ceiling: boolean; // true se cliente declarou teto rígido
  price_flex_max: number | null; // Teto para oportunidades especiais
  bedrooms: number[];            // [2, 3]
  bedrooms_required: boolean;    // true se número de quartos é requisito obrigatório
  delivery_status: ('pronto' | 'planta' | 'construcao')[];
  delivery_status_required: boolean;
  required_features: string[];   // ex: ["elevador", "acessibilidade"]
  preferred_features: string[];  // ex: ["varanda gourmet", "vista mar"]
  is_short_stay: boolean;        // Se busca temporada exclusivamente (não gera match comum)
}
```

### 2.2. PropertyMatchProjection (Projeção no WACRM)

Projeção de campos essenciais dos imóveis cadastrados no sistema Meus Imóveis:

```typescript
export interface PropertyMatchProjection {
  property_id: string;           // UUID originário de Meus Imóveis
  account_id: string;
  code?: string;                 // Código de referência comercial (ex: "AP-302")
  title: string;                 // Nome do empreendimento ou imóvel
  operation: 'venda' | 'locacao';
  property_type: string;         // 'apartamento' | 'casa' | 'flat' | 'terreno' | 'comercial'
  neighborhood: string;
  city: string;
  price_min: number;             // Faixa mínima de preço
  price_max: number;             // Faixa máxima de preço
  area_min?: number | null;      // Metragem útil mín (m²)
  area_max?: number | null;      // Metragem útil máx (m²)
  bedrooms_min?: number | null;  // Mínimo de quartos
  bedrooms_max?: number | null;  // Máximo de quartos
  delivery_status: 'pronto' | 'planta' | 'em_construcao';
  delivery_deadline?: string | null; // ISO Date de previsão de entrega
  features: string[];            // ["elevador", "piscina", "vaga_garagem", ...]
  cover_url?: string | null;     // Imagem principal para cards e envio
  public_url?: string | null;    // URL canônica de Meus Imóveis
  status: 'ativo' | 'inativo' | 'arquivado';
  updated_at: string;
}
```

### 2.3. LeadPropertyMatch (Par Lead ↔ Imóvel)

```typescript
export type MatchStatus = 'novo' | 'enviado' | 'pausado' | 'arquivado';
export type MatchOrigin = 'match_automatico' | 'envio_manual' | 'origem_ctwa';

export interface LeadPropertyMatch {
  id: string;                    // UUID
  account_id: string;
  lead_id: string;
  property_id: string;
  match_score: number;           // 0 a 100%
  score_breakdown: {
    price: number;               // 0 a 25
    location: number;            // 0 a 20
    property_type: number;       // 0 a 15
    bedrooms: number;            // 0 a 15
    purpose: number;             // 0 a 10
    delivery: number;            // 0 a 10
    area: number;                // 0 a 5
    penalties?: string[];
  };
  profile_maturity: number;      // Maturidade do perfil no momento da avaliação (0 a 100)
  commercial_priority: number;   // Prioridade para ordenação interna (Score Composto)
  match_status: MatchStatus;
  suppressed: boolean;           // true se o corretor descartou o match
  origin: MatchOrigin;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  paused_at: string | null;
  archived_at: string | null;
}
```

### 2.4. PropertyShare & TrackingToken (Envios Individuais)

Cada envio via WhatsApp gera um registro único de compartilhamento com um token criptográfico opaco:

```typescript
export interface PropertyShare {
  id: string;                    // UUID
  account_id: string;
  lead_id: string;
  property_id: string;
  match_id?: string | null;
  tracking_token: string;        // 32-bytes hex string (64 caracteres), sem dados pessoais (PII)
  channel: 'whatsapp_pessoal';
  message_template: string;
  sent_at: string;
  revoked_at: string | null;
  
  // Métricas agregadas de tracking
  first_opened_at: string | null;
  last_opened_at: string | null;
  open_count: number;
  is_interested: boolean;
  interested_at: string | null;
}
```

---

## 3. Matriz de Estados do Match e Transições

```
                ┌──────────────────────────────────────┐
                │                                      │
   [Cálculo] ──►│                NOVO                  │
                │  (Score >= 70% e Maturidade >= 70%)  │
                └──────────────────┬───────────────────┘
                                   │
                     Clique "Enviar" no CRM
                                   │
                                   ▼
                ┌──────────────────────────────────────┐
                │               ENVIADO                │
                │    (Gera Share + Tracking Token)     │
                └───────────┬──────────────┬───────────┘
                            │              │
           Pausar Match     │              │     Arquivar Match
                            ▼              ▼
     ┌────────────────────────┐          ┌────────────────────────┐
     │        PAUSADO         │          │       ARQUIVADO        │
     │  (Pausa no par ou lead)│          │ (Concluído/Desistência)│
     └────────────────────────┘          └────────────────────────┘
```

### 3.1. Estado Especial: SUPRIMIDO (`suppressed = true`)
- Ativado quando o corretor clica em **"Descartar Match"**.
- O registro **NUNCA** é deletado fisicamente do banco de dados.
- O par `(lead_id, property_id)` é marcado como `suppressed = true`.
- Futuras rodadas de cálculo determinístico **nunca** desmarcam a supressão e **nunca** reexibem o match nas listas ativas (`novo`, `enviado`, `pausado`, `arquivado`).

---

## 4. Eventos Padronizados do Sistema

Todos os eventos utilizam envelope padrão de mensageria:

```typescript
export interface TunnelEventEnvelope<T = Record<string, unknown>> {
  event_id: string;              // UUID determinístico ou v4
  event_name: string;            // Ex: "match.sent"
  timestamp: string;             // ISO 8601 UTC
  account_id: string;
  payload: T;
}
```

### 4.1. Catálogo de Eventos

| Evento | Origem | Descrição |
|---|---|---|
| `lead.profile_updated` | WACRM | Atualização estruturada nas preferências/restrições do lead. |
| `lead.status_changed` | WACRM | Lead transicionou entre ativo, pausado ou arquivado. |
| `lead.maturity_changed` | WACRM | Maturidade cruzou limites de cálculo (ex: atingiu >= 70%). |
| `match.created` | WACRM | Novo par Lead ↔ Imóvel identificado com compatibilidade. |
| `match.updated` | WACRM | Score de match recalculado devido a mudanças no perfil ou imóvel. |
| `match.suppressed` | WACRM | Corretor descartou o match; supressão permanente ativada. |
| `match.sent` | WACRM | Corretor disparou o envio do imóvel via WhatsApp pessoal. |
| `match.paused` | WACRM | Match colocado em pausa manual. |
| `match.archived` | WACRM | Match arquivado pelo corretor. |
| `property.created` | Meus Imóveis | Novo imóvel ou empreendimento cadastrado no catálogo. |
| `property.updated` | Meus Imóveis | Alteração de preço, status, tipologia ou atributos do imóvel. |
| `property.status_changed` | Meus Imóveis | Imóvel ativado, pausado ou vendido/esgotado. |
| `share.created` | WACRM | Token opaco individual de compartilhamento gerado. |
| `public_link.opened` | Meus Imóveis | Cliente abriu a página pública através do token de envio. |
| `public_related_property.opened` | Meus Imóveis | Cliente navegou para outro imóvel sugerido na mesma sessão. |
| `public_interest.clicked` | Meus Imóveis | Cliente clicou no botão "Tenho interesse" na página pública. |

---

## 5. Endpoints da API de Integração (Túnel WACRM)

Todas as rotas do túnel operam sob o prefixo `/api/tunnel/v1/`.

### 5.1. Autenticação
As requisições entre o WACRM e Meus Imóveis utilizam autenticação segura via Bearer Token:
- Header: `Authorization: Bearer <TUNNEL_API_KEY>`

---

### 5.2. `POST /api/tunnel/v1/properties/sync`
Permite ao sistema Meus Imóveis criar ou atualizar a projeção de um imóvel no WACRM.

**Payload:**
```json
{
  "property_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "title": "Residencial Live Park",
  "operation": "venda",
  "property_type": "apartamento",
  "neighborhood": "Bessa",
  "city": "João Pessoa",
  "price_min": 350000,
  "price_max": 520000,
  "area_min": 45,
  "area_max": 72,
  "bedrooms_min": 2,
  "bedrooms_max": 3,
  "delivery_status": "em_construcao",
  "delivery_deadline": "2027-12-31",
  "features": ["elevador", "piscina", "varanda_gourmet", "vaga_garagem"],
  "cover_url": "https://meusimoveis.com.br/assets/live-park-cover.jpg",
  "public_url": "https://ronaldomeira.com.br/imoveis/live-park",
  "status": "ativo"
}
```

**Resposta (200 OK):**
```json
{
  "success": true,
  "action": "upserted",
  "property_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "matches_recalculated": 12,
  "strong_matches_count": 2
}
```

---

### 5.3. `GET /api/tunnel/v1/leads/compatible`
Permite ao sistema Meus Imóveis consultar quais leads do WACRM possuem compatibilidade com um determinado imóvel.

**Query Parameters:**
- `property_id`: UUID do imóvel
- `min_score`: Pontuação mínima (padrão: 70)
- `only_active`: Filtrar leads ativos com maturidade >= 70% (padrão: true)

**Resposta (200 OK):**
```json
{
  "property_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "total_compatible": 4,
  "leads": [
    {
      "lead_id": "1a2b3c4d-...",
      "lead_name": "Mariana Silva",
      "lead_initials": "MS",
      "match_score": 92,
      "profile_maturity": 85,
      "ai_score": 8,
      "commercial_priority": 94.2,
      "status": "active",
      "match_status": "novo"
    }
  ]
}
```

---

### 5.4. `POST /api/tunnel/v1/events/tracking`
Recebe eventos disparados pela página pública de Meus Imóveis (abertura, navegação correlata, clique em "Tenho interesse").

**Payload 1: Primeira ou Subsequente Abertura**
```json
{
  "event_name": "public_link.opened",
  "tracking_token": "a4f89b2c83d97e1045f2...",
  "timestamp": "2026-09-25T14:30:00Z"
}
```

**Payload 2: Navegação para Imóvel Correlato**
```json
{
  "event_name": "public_related_property.opened",
  "tracking_token": "a4f89b2c83d97e1045f2...",
  "related_property_id": "7c8d9e0f-...",
  "timestamp": "2026-09-25T14:32:15Z"
}
```

**Payload 3: Clique em "Tenho interesse"**
```json
{
  "event_name": "public_interest.clicked",
  "tracking_token": "a4f89b2c83d97e1045f2...",
  "property_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "timestamp": "2026-09-25T14:33:00Z"
}
```

**Comportamento do WACRM:**
1. Valida o token e localiza o `lead_id`, `property_id` e `match_id` correspondentes.
2. Atualiza `first_opened_at`, `last_opened_at` e incrementa `open_count`.
3. Registra a navegação correlata no log da sessão de compartilhamento.
4. Para `public_interest.clicked`:
   - Marca `is_interested = true` e grava `interested_at`.
   - Dispara imediatamente notificação Push de alta prioridade ao corretor (Web Push / Push Notifications).

---

### 5.5. `GET /api/tunnel/v1/shares/resolve/:token`
Endpoint público utilizado pelo servidor ou cliente do Meus Imóveis ao renderizar a página do imóvel a partir do link compartilhado.

**Resposta (200 OK):**
```json
{
  "valid": true,
  "property_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "corretor_name": "Ronaldo Meira",
  "corretor_phone": "558399999999"
}
```
*Garantia estrita:* Nenhuma informação pessoal identificável do lead (PII) é devolvida nesta rota.

---

## 6. Governança e Regras de Negócio

1. **Tokens Opacos:**
   - O `tracking_token` é gerado via `crypto.randomBytes(32).toString('hex')`.
   - Não contém IDs sequenciais nem hashes reversíveis de telefone/email.
2. **Ciclo de Envio pelo WhatsApp Pessoal:**
   - O WACRM abre a interface de envio utilizando o deep link `https://wa.me/${digits}?text=${encodeURIComponent(text + '\n' + link)}`.
   - Ao clicar no botão de envio no CRM, o estado do Match transiciona de forma síncrona para `enviado`.
3. **Respeito à Decisão Humana:**
   - Matches suprimidos por `Descartar Match` são definitivos para o par `(lead_id, property_id)`.
   - Leads com `paused_at IS NOT NULL` ou `archived_at IS NOT NULL` não recebem novos Matches automáticos.
