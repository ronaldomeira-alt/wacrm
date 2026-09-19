-- Meta Conversions API dataset per WhatsApp config, used to send the
-- QualifiedLead event back to Meta (see src/lib/whatsapp/meta-capi.ts).
-- Nullable: accounts without a configured dataset simply skip the event.
alter table whatsapp_config add column if not exists meta_capi_dataset_id text;
