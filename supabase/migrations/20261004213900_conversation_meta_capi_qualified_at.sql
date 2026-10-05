-- Add meta_capi_qualified_at to conversations to track manual and automated
-- QualifiedLead Conversions API submissions to Meta.
alter table conversations add column if not exists meta_capi_qualified_at timestamptz;

comment on column conversations.meta_capi_qualified_at is
  'Data/hora em que o evento QualifiedLead foi enviado à Meta Conversions API para esta conversa.';
