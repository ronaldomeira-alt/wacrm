-- Fase 5 (troca de referências Supabase -> R2): coluna aditiva de
-- checkpoint. Reaproveita media_migration_log.source_url (gravado na
-- Fase 3, nunca alterado) como o mecanismo de rollback — não precisa de
-- tabela nova. reference_flipped_at marca quando este script de flip
-- efetivamente trocou messages.media_url pela key R2, permitindo
-- retomada segura (candidatos = status='completed' AND
-- reference_flipped_at IS NULL) e rollback (reverter para source_url
-- só onde reference_flipped_at IS NOT NULL).

alter table public.media_migration_log
  add column reference_flipped_at timestamptz;
