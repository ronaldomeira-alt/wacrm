import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types";
import type { PlatformProfile } from "@/lib/platform/platform-profile";
import {
  prependOrMoveToTop,
  applyMessageToConversationList,
  applyConversationUpdate,
  mergeHydratedConversation,
} from "./conversation-list-reducer";

const IPHONE_PROFILE: PlatformProfile = {
  platform: "iphone",
  isIPhone: true,
  isDesktop: false,
  maxInboxLeads: 50,
  maxInitialMessages: 30,
  maxCachedConversations: 3,
  maxCachedMessagesPerConv: 30,
  allowOlderHistoryLoad: false,
  aggressiveResourceCleanup: true,
};

const DESKTOP_PROFILE: PlatformProfile = {
  platform: "desktop",
  isIPhone: false,
  isDesktop: true,
  maxInboxLeads: null,
  maxInitialMessages: null,
  maxCachedConversations: 10,
  maxCachedMessagesPerConv: null,
  allowOlderHistoryLoad: true,
  aggressiveResourceCleanup: false,
};

function createMockConversation(id: string, index: number): Conversation {
  return {
    id,
    user_id: "user-1",
    contact_id: `contact-${id}`,
    status: "open",
    unread_count: 0,
    pinned: false,
    needs_review: false,
    last_message_text: `Message ${index}`,
    last_message_at: new Date(Date.now() - index * 60000).toISOString(),
    created_at: new Date(Date.now() - index * 60000).toISOString(),
    updated_at: new Date(Date.now() - index * 60000).toISOString(),
    contact: {
      id: `contact-${id}`,
      account_id: "acc-1",
      user_id: "user-1",
      name: `Lead ${id}`,
      phone: `55119999900${index}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

describe("conversation-list-reducer (Realtime Mobile & Desktop Platform Architecture)", () => {
  it("Cenário 1: Chegada do 51º lead novo no iPhone desloca o menos recente mantendo 50 no topo", () => {
    // 1. Inbox inicial já contendo exatamente 50 leads
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );
    expect(initial50).toHaveLength(50);
    expect(initial50[0].id).toBe("conv-1");
    expect(initial50[49].id).toBe("conv-50");

    // 2. Chegada do 51º lead novo via fluxo de entrada (INSERT)
    const lead51 = createMockConversation("conv-51-novo", 0);
    const resultMobile = prependOrMoveToTop(initial50, lead51, IPHONE_PROFILE);

    // Validações no iPhone:
    expect(resultMobile).toHaveLength(50); // Teto de 50 preservado
    expect(resultMobile[0].id).toBe("conv-51-novo"); // 51º lead no topo
    expect(resultMobile[1].id).toBe("conv-1"); // Antigo 1º agora é o 2º
    expect(resultMobile.some((c) => c.id === "conv-50")).toBe(false); // 50º (menos recente) foi deslocado da memória do cliente
  });

  it("Cenário 1 (Desktop): Chegada do 51º lead no Windows não corta leads e exibe 51", () => {
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );

    const lead51 = createMockConversation("conv-51-novo", 0);
    const resultDesktop = prependOrMoveToTop(initial50, lead51, DESKTOP_PROFILE);

    // Validações no Windows:
    expect(resultDesktop).toHaveLength(51); // Sem corte
    expect(resultDesktop[0].id).toBe("conv-51-novo"); // Novo lead no topo
    expect(resultDesktop.some((c) => c.id === "conv-50")).toBe(true); // Todos preservados
  });

  it("Cenário 2: Nova mensagem de um lead antigo fora dos 50 traz o lead de volta ao topo preservando limite de 50", () => {
    // 1. Inbox móvel contendo 50 leads (conv-1 a conv-50)
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );

    // 2. Lead antigo fora dos 50 (conv-72) envia uma nova mensagem
    const incomingMsg = {
      conversation_id: "conv-72",
      content_text: "Olá Ronaldo, ainda está disponível?",
      created_at: new Date().toISOString(),
    };

    // 3. O reducer detecta que a conversa não está nos 50 carregados e sinaliza necessidade de hidratação
    const step1 = applyMessageToConversationList(
      initial50,
      incomingMsg,
      null,
      IPHONE_PROFILE
    );
    expect(step1.needsHydrate).toBe(true);

    // 4. Ao hidratar do Supabase, o lead é inserido no topo e a lista é limitada a 50
    const hydratedLead72 = createMockConversation("conv-72", 0);
    hydratedLead72.last_message_text = incomingMsg.content_text;
    hydratedLead72.last_message_at = incomingMsg.created_at;

    const resultMobile = mergeHydratedConversation(
      step1.conversations,
      hydratedLead72,
      IPHONE_PROFILE
    );

    // Validações no iPhone:
    expect(resultMobile).toHaveLength(50); // Limite de 50 respeitado
    expect(resultMobile[0].id).toBe("conv-72"); // Lead antigo trazido de volta ao topo
    expect(resultMobile[0].last_message_text).toBe("Olá Ronaldo, ainda está disponível?");
    expect(resultMobile.some((c) => c.id === "conv-50")).toBe(false); // Menos recente deslocado
  });

  it("Cenário 2 (Desktop): Nova mensagem de um lead antigo no Windows preserva todo o histórico", () => {
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );

    const hydratedLead72 = createMockConversation("conv-72", 0);
    const resultDesktop = mergeHydratedConversation(
      initial50,
      hydratedLead72,
      DESKTOP_PROFILE
    );

    expect(resultDesktop).toHaveLength(51);
    expect(resultDesktop[0].id).toBe("conv-72");
    expect(resultDesktop.some((c) => c.id === "conv-50")).toBe(true);
  });

  it("Nova mensagem de um lead que já está nos 50 (ex: posição 35) move para o topo sem alterar contagem total", () => {
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );

    const msg = {
      conversation_id: "conv-35",
      content_text: "Nova mensagem do lead 35",
      created_at: new Date().toISOString(),
    };

    const res = applyMessageToConversationList(
      initial50,
      msg,
      null,
      IPHONE_PROFILE
    );

    expect(res.needsHydrate).toBe(false);
    expect(res.conversations).toHaveLength(50);
    expect(res.conversations[0].id).toBe("conv-35");
    expect(res.conversations[0].last_message_text).toBe("Nova mensagem do lead 35");
    expect(res.conversations[0].unread_count).toBe(1);
  });

  it("Evento UPDATE de conversa com nova data move para o topo no iPhone mantendo teto de 50", () => {
    const initial50: Conversation[] = Array.from({ length: 50 }, (_, i) =>
      createMockConversation(`conv-${i + 1}`, i + 1)
    );

    const updated = {
      ...initial50[20],
      last_message_at: new Date().toISOString(),
      last_message_text: "Mensagem atualizada",
    };

    const res = applyConversationUpdate(
      initial50,
      updated,
      null,
      IPHONE_PROFILE
    );

    expect(res.needsHydrate).toBe(false);
    expect(res.conversations).toHaveLength(50);
    expect(res.conversations[0].id).toBe("conv-21"); // Antigo índice 20 agora no topo
  });
});
