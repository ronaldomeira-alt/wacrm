@AGENTS.md

# WACRM

CRM de leads imobiliários via WhatsApp (João Pessoa/PB). Fork de ArnasDon/wacrm.
Repo: github.com/ronaldomeira-alt/wacrm

## Escopo

Gerencia **apenas leads** — captura, qualificação, automação, follow-up.
NÃO inclui catálogo de imóveis nem gestão de propriedades (isso é outro sistema).

## Stack

* Node.js (hospedado na Hostinger, sem Docker/VPS)
* Supabase (banco de dados)
* WhatsApp: dois canais distintos, não confundir

  * API oficial da Meta (número "8810") — primeiro contato com leads novos
  * Baileys (número pessoal do usuário) — campanhas e relacionamento com clientes já convertidos

## ⚠️ Avisos críticos antes de qualquer mudança

* **Não existe separação dev/produção.** O ambiente local aponta para o mesmo banco Supabase de produção. Qualquer teste de envio/escrita feito localmente é uma ação real no sistema.
* Antes de alterar qualquer função `SECURITY DEFINER` ou permissão no Supabase, checar se é uma das que já foram propositalmente restritas (hardening feito anteriormente) — não reabrir acesso `anon` sem necessidade clara.
* `peek\_invitation` é a única função com acesso anônimo intencional (fluxo público de convite `/join/<token>`) — não é bug.

## Como trabalhar comigo

* Instruções diretas, sem relatório longo a cada passo.
* Só me avisar em pontos de decisão real (ex: rota destrutiva, custo extra, ambiguidade de requisito) ou falhas inesperadas — não narrar cada etapa concluída com sucesso.
* Economizar tokens: evitar reler arquivos grandes sem necessidade, preferir edições pontuais a reescritas completas.

