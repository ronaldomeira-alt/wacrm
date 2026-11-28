// TEMP (DEM-004): exercita src/lib/match/sync-state.ts contra PostgREST descartável.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  probeMatchSync,
  claimMatchSync,
  commitMatchSync,
  releaseMatchSync,
} from './sync-state';

const token = readFileSync('/tmp/opencode/dem004/jwt.txt', 'utf8').trim();
const db = createClient('http://127.0.0.1:55434', token, { auth: { persistSession: false } });
const OPS = 'f8d2ae51-e393-4a74-a432-ddab0610837e';

describe('sync-state contra PostgREST descartável', () => {
  it('ciclo completo', async () => {
    let t0 = performance.now();
    const probe = await probeMatchSync(db, OPS);
    console.log('probe ms =', (performance.now() - t0).toFixed(1));
    console.log('probe =', JSON.stringify(probe));
    expect(probe).not.toBeNull();

    t0 = performance.now();
    const claim1 = await claimMatchSync(db, OPS);
    console.log('claim ms =', (performance.now() - t0).toFixed(1));
    console.log('claim1 =', JSON.stringify(claim1));
    expect(claim1?.acquired).toBe(true);

    const claim2 = await claimMatchSync(db, OPS);
    console.log('claim2 (concorrente) =', JSON.stringify(claim2));
    expect(claim2?.acquired).toBe(false);

    const commitErrado = await commitMatchSync(db, OPS, '00000000-0000-0000-0000-00000000dead', probe!, 'full');
    console.log('commit token errado =', commitErrado);

    const commitOk = await commitMatchSync(db, OPS, claim1!.lockToken!, probe!, 'full');
    console.log('commit token dono =', commitOk);
    expect(commitOk).toBe(true);

    const probe2 = await probeMatchSync(db, OPS);
    console.log('fingerprint estavel =', probe2?.fingerprint === probe?.fingerprint);

    const claim3 = await claimMatchSync(db, OPS);
    console.log(
      'claim3 =',
      JSON.stringify({
        acquired: claim3?.acquired,
        lastFingerprintIgual: claim3?.lastFingerprint === probe?.fingerprint,
        lastFullSyncAt: claim3?.lastFullSyncAt,
      })
    );

    const modeInvalido = await commitMatchSync(db, OPS, claim3!.lockToken!, probe!, 'bogus' as never);
    console.log('commit p_mode invalido =', modeInvalido);

    const release = await releaseMatchSync(db, OPS, claim3!.lockToken!);
    console.log('release =', release);
    expect(release).toBe(true);

    const claim4 = await claimMatchSync(db, OPS);
    console.log('claim apos release =', claim4?.acquired);
    await releaseMatchSync(db, OPS, claim4!.lockToken!);

    const ttl = await claimMatchSync(db, OPS, 30);
    console.log('claim lockSeconds=30 =', JSON.stringify(ttl));

    const probeSize = JSON.stringify(probe).length;
    console.log('bytes aprox. do probe =', probeSize);
  }, 60000);
});
