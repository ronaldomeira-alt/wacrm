/**
 * One-off reconciliation for the first Fase 6 APPLY attempt: it deleted
 * 50 objects from Supabase Storage (chat-media) successfully, but
 * crashed on a broken verification step (querying the `storage` schema
 * via PostgREST, which isn't exposed in this project) before it could
 * stamp `storage_deleted_at` for those 50 rows. The exact set of 50 was
 * identified by a read-only SQL query (storage.objects vs. the
 * candidate paths) run directly against the project. This script only
 * stamps that exact, pre-confirmed set — it does no deleting and no
 * further verification of its own.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

const CONFIRMED_DELETED_LOG_IDS = [
  '00459216-0fb3-48ba-9195-68ca5d1992a0', '005aba52-aa6b-4e63-ab75-a2e59acd2198',
  '0081ba57-dd20-46d7-b1e7-a31015759ba1', '00859023-daaa-484a-8951-ff4443595608',
  '011a75e5-8982-467c-a273-993fa813f60a', '0164e59f-8724-4bf8-87d9-7a11c6392276',
  '01e0750a-5f5a-47e8-a4e5-2cf87744d8b2', '02261d12-933f-448d-84f3-3d8a905ab1a1',
  '023d1b56-77ed-423f-b660-079a89efe13f', '0258b4d6-770a-4cd8-8028-667d5a191002',
  '02a3ce95-2af4-461b-8236-f1c534a13184', '0369fe2b-df6d-4256-9076-4f1b133293a3',
  '03a47e89-4a84-483b-addd-7edb6dfb378e', '03ad3b1f-ed87-436a-a667-282ae191825f',
  '03b92449-0e25-421f-8056-ae7df9a7b6c2', '03c3949e-1b42-4a67-b4dd-827e462170ba',
  '04f40de7-10eb-4c91-b554-6fffcccb5c0f', '05b78c4f-af2c-4ab6-986a-944c35c9628e',
  '06fe8096-8d4b-4e82-a049-648c04bc0616', '071a5bb7-b387-4242-87bf-61888e9aa832',
  '07428300-7df1-4a04-8a52-ad2cc932eff1', '07be9bef-19e2-4ad3-94a9-77a1abb0fa30',
  '084bef5e-9bf4-4b5d-82b5-d32fe52f4d77', '08f2e6b8-dd5d-4bec-916b-ffdc8d2203a9',
  '09d6faa2-6d35-423f-81d4-016ae91ff396', '09e70de4-0376-4abe-a589-8d1619e8048b',
  '0a660253-1abe-49a0-bfc6-e8f2104f677d', '0a67bc24-e3c5-4884-8997-435a15ed59ab',
  '0aaee885-479a-4c5b-b2f0-e785a70eebce', '0b0ecfa8-9ecb-43fb-9d17-13fccf35a68f',
  '0b6cba72-627d-4fa6-86d2-4473a7ac0899', '0b892da3-b5cd-461f-9a45-1bb5919162cb',
  '0bbc5211-fbd8-47c0-b3de-ebe6c813abd5', '0c7ace38-e82a-4c92-8280-697d4f023c62',
  '0cf89843-1c57-4676-9564-4936a853d935', '0d2d0668-79e6-4ffc-9733-f4910fcd17b6',
  '0d6e8bee-6a94-4453-a7ed-6c9bcd75a18c', '0d8dd631-47f1-469b-92c5-18020a26b1e3',
  '0dd4e5d6-6e58-4cfb-b647-db1bcb9c7f32', '0e338a43-d180-4516-b4d3-af02abb1ca13',
  '0e7d4d12-18e7-444e-912c-d559e821b89b', '0fc27921-7c8b-48a0-8d66-ee4a6973f74e',
  '109daf0d-fc8c-4cca-bd85-9fb2c34400ce', '10c67c8a-48f6-4bcf-9916-b8e161ad581c',
  '11a219e3-fa95-438f-894a-7c7a6ea8887f', '1212b9c8-81c3-488f-908d-b1247ad17451',
  '122b4782-2295-4c57-9310-59d74f918f32', '12af2b7d-80b4-48d9-a888-92470c97de4a',
  '12d15dac-6a5c-4aae-805a-0e983e7ed626', '12e25429-5a64-4007-a44e-58b10798d560',
];

async function main() {
  if (CONFIRMED_DELETED_LOG_IDS.length !== 50) throw new Error('expected exactly 50 ids');
  const db = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data, error } = await db
    .from('media_migration_log')
    .update({ storage_deleted_at: new Date().toISOString() })
    .in('id', CONFIRMED_DELETED_LOG_IDS)
    .is('storage_deleted_at', null)
    .select('id');
  if (error) throw error;
  console.log(`Stamped storage_deleted_at on ${data?.length ?? 0} rows (expect 50).`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
