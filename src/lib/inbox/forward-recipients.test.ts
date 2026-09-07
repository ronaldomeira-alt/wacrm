import { describe, it, expect } from "vitest";
import {
  sortForwardRecipients,
  type ForwardContactRecipient,
} from "./forward-recipients";

describe("sortForwardRecipients", () => {
  const contactRonaldo: ForwardContactRecipient = {
    id: "contact-ronaldo",
    name: "Ronaldo Meira",
    phone: "558396507373",
    conversation: {
      id: "conv-ronaldo",
      last_message_at: "2026-09-07T14:00:00.000Z", // 2 hours ago
    },
  };

  const contactMaria: ForwardContactRecipient = {
    id: "contact-maria",
    name: "Maria Silva",
    phone: "558399999001",
    conversation: {
      id: "conv-maria",
      last_message_at: "2026-09-07T15:59:30.000Z", // 30 seconds ago
    },
  };

  const contactJoao: ForwardContactRecipient = {
    id: "contact-joao",
    name: "João Santos",
    phone: "558399999002",
    conversation: {
      id: "conv-joao",
      last_message_at: "2026-09-07T15:00:00.000Z", // 1 hour ago
    },
  };

  const contactAnaNoConv: ForwardContactRecipient = {
    id: "contact-ana",
    name: "Ana Oliveira",
    phone: "558399999003",
    conversation: null,
  };

  const contactBrunoNoConv: ForwardContactRecipient = {
    id: "contact-bruno",
    name: "Bruno Costa",
    phone: "558399999004",
    conversation: null,
  };

  const contactCarlosTie1: ForwardContactRecipient = {
    id: "contact-carlos",
    name: "Carlos Eduardo",
    phone: "558399999005",
    conversation: {
      id: "conv-carlos",
      last_message_at: "2026-09-07T12:00:00.000Z",
    },
  };

  const contactBernardoTie2: ForwardContactRecipient = {
    id: "contact-bernardo",
    name: "Bernardo Lima",
    phone: "558399999006",
    conversation: {
      id: "conv-bernardo",
      last_message_at: "2026-09-07T12:00:00.000Z",
    },
  };

  it("1. Current conversation has absolute priority even with older timestamp than other conversations", () => {
    // Ronaldo (current) has older timestamp (14:00) than Maria (15:59:30)
    const list = [contactMaria, contactRonaldo, contactJoao];
    const sorted = sortForwardRecipients(list, "contact-ronaldo");

    expect(sorted.map((c) => c.id)).toEqual([
      "contact-ronaldo", // Priority 1: Current conversation
      "contact-maria", // Priority 2: Most recent (15:59:30)
      "contact-joao", // Priority 2: Next recent (15:00)
    ]);
  });

  it("2. Three conversations with different timestamps are sorted descending by last_message_at", () => {
    const list = [contactRonaldo, contactJoao, contactMaria];
    // No current contact specified
    const sorted = sortForwardRecipients(list, null);

    expect(sorted.map((c) => c.id)).toEqual([
      "contact-maria", // 15:59:30
      "contact-joao", // 15:00:00
      "contact-ronaldo", // 14:00:00
    ]);
  });

  it("3. Contacts without conversation appear after active conversations and in alphabetical order", () => {
    const list = [
      contactBrunoNoConv,
      contactMaria,
      contactAnaNoConv,
      contactJoao,
    ];
    const sorted = sortForwardRecipients(list, null);

    expect(sorted.map((c) => c.id)).toEqual([
      "contact-maria", // with conv (15:59:30)
      "contact-joao", // with conv (15:00:00)
      "contact-ana", // no conv, letter 'A'
      "contact-bruno", // no conv, letter 'B'
    ]);
  });

  it("4. Two contacts with identical last_message_at are sorted alphabetically as tie-breaker", () => {
    const list = [contactCarlosTie1, contactBernardoTie2];
    const sorted = sortForwardRecipients(list, null);

    expect(sorted.map((c) => c.id)).toEqual([
      "contact-bernardo", // "Bernardo Lima" before "Carlos Eduardo"
      "contact-carlos",
    ]);
  });

  it("5. Search filtering preserves the priority hierarchy", () => {
    const ronaldoOther: ForwardContactRecipient = {
      id: "contact-ronaldo-other",
      name: "Ronaldo Alves",
      phone: "558399999007",
      conversation: {
        id: "conv-ronaldo-other",
        last_message_at: "2026-09-07T15:30:00.000Z",
      },
    };

    const ronaldoNoConv: ForwardContactRecipient = {
      id: "contact-ronaldo-noconv",
      name: "Ronaldo Zaccaro",
      phone: "558399999008",
      conversation: null,
    };

    const list = [
      contactMaria,
      ronaldoNoConv,
      contactRonaldo,
      ronaldoOther,
      contactJoao,
    ];

    const sorted = sortForwardRecipients(list, "contact-ronaldo");

    // Filter by "Ronaldo"
    const query = "ronaldo";
    const filtered = sorted.filter(
      (c) =>
        c.name?.toLowerCase().includes(query) ||
        c.phone?.toLowerCase().includes(query),
    );

    expect(filtered.map((c) => c.id)).toEqual([
      "contact-ronaldo", // 1. Current conversation Ronaldo Meira
      "contact-ronaldo-other", // 2. Recent conversation Ronaldo Alves
      "contact-ronaldo-noconv", // 3. No conversation match Ronaldo Zaccaro
    ]);
  });

  it("6. Absence of currentContactId sorts consistently using only recency + alphabetical", () => {
    const list = [
      contactBrunoNoConv,
      contactRonaldo,
      contactAnaNoConv,
      contactMaria,
    ];
    const sorted = sortForwardRecipients(list, undefined);

    expect(sorted.map((c) => c.id)).toEqual([
      "contact-maria", // 15:59:30
      "contact-ronaldo", // 14:00:00
      "contact-ana", // no conv 'A'
      "contact-bruno", // no conv 'B'
    ]);
  });
});
