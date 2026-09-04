import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Privacidade",
  robots: { index: true, follow: true },
};

// Public, unauthenticated page — required by Google's OAuth consent
// screen (Branding > "Link da Política de Privacidade") before the
// wacrm-505205 project can move out of Testing publishing status.
// Google Calendar is the only Google user data this app ever touches;
// this page's Calendar-specific section exists to satisfy the Google
// API Services User Data Policy disclosure requirement.
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-sm leading-relaxed text-foreground">
      <h1 className="mb-2 text-2xl font-semibold">Política de Privacidade</h1>
      <p className="mb-8 text-muted-foreground">Última atualização: 4 de setembro de 2026</p>

      <p className="mb-6">
        O WACRM é um CRM de uso interno para gestão de leads imobiliários via
        WhatsApp. Esta página descreve como os dados de contas conectadas via
        Google são tratados.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">Acesso ao Google Calendar</h2>
      <p className="mb-4">
        Quando um usuário conecta sua conta do Google Calendar ao WACRM, o
        aplicativo acessa exclusivamente a agenda principal (
        <em>primary calendar</em>) dessa mesma conta, com o único objetivo de:
      </p>
      <ul className="mb-4 list-disc space-y-1 pl-6">
        <li>Criar, atualizar e remover eventos correspondentes a visitas e compromissos cadastrados no CRM;</li>
        <li>Importar para o CRM eventos criados diretamente no Google Calendar (por exemplo, pelo celular), para manter as duas agendas sincronizadas.</li>
      </ul>
      <p className="mb-4">
        Nenhum dado de calendário é compartilhado com terceiros, vendido ou
        usado para publicidade. O acesso é usado somente para prestar essa
        funcionalidade de sincronização ao próprio usuário que a autorizou, em
        conformidade com a{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Google API Services User Data Policy
        </a>
        , incluindo os requisitos de Uso Limitado (Limited Use).
      </p>
      <p className="mb-4">
        O usuário pode revogar esse acesso a qualquer momento diretamente nas
        configurações do WACRM ou em{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          myaccount.google.com/permissions
        </a>
        .
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">Outros dados</h2>
      <p className="mb-4">
        Dados de leads e conversas (nome, telefone, mensagens de WhatsApp) são
        inseridos pelo próprio usuário do CRM ou recebidos via integração
        oficial com a API do WhatsApp Business, e usados exclusivamente para
        a operação do CRM contratado. Esses dados não são vendidos nem
        compartilhados com terceiros fora do necessário para a operação do
        serviço (por exemplo, o provedor de banco de dados e a própria Meta,
        como operadora do WhatsApp).
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">Contato</h2>
      <p>
        Dúvidas sobre esta política podem ser enviadas para{" "}
        <a href="mailto:ronaldomeira@gmail.com" className="underline">
          ronaldomeira@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
