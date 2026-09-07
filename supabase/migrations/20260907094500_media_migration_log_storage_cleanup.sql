-- Fase 6 (limpeza do Supabase Storage pós-migração R2): coluna aditiva de
-- checkpoint, mesmo padrão de reference_flipped_at (Fase 5). Marca quando
-- o objeto original em storage.objects (bucket chat-media) foi
-- efetivamente removido pelo script scripts/cleanup-historical-storage.ts,
-- permitindo retomada segura e auditoria posterior. Nunca apaga nem
-- modifica nenhuma linha existente.

alter table public.media_migration_log
  add column storage_deleted_at timestamptz;
