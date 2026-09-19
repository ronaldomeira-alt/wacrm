/**
 * Controlled, end-to-end test of the QualifiedLead → Meta Conversions API
 * signal, using a REAL Click-to-WhatsApp click (real ctwa_clid) — never a
 * fabricated one, since Meta only accepts CAPI events for conversations
 * that genuinely originated from a Click-to-WhatsApp ad.
 *
 * This does NOT fake the trigger by writing `ai_score = 7` directly and
 * hoping something reacts to it. It calls the exact same production
 * function the real analysis pipeline calls — `applyLeadAnalysisResult`
 * in src/lib/ai/lead-analysis.ts, completely unmodified — with a
 * hand-crafted result standing in for what the LLM would have returned.
 *
 * Business rule (as of the "independent of pipeline" revision):
 * applyQualifiedLeadSignal fires purely on the contact's ai_score
 * crossing from < 7 to >= 7 in this batch — it does NOT require a
 * pipeline stage move, does NOT read stage_suggestion at all. This
 * script still also sends a stage_suggestion targeting "Interesse"
 * alongside the score, so it exercises PIPELINE_AUTO_MOVE_RULES /
 * STAGE_SUGGESTION_MIN_SCORE too (realistic combined scenario, and a
 * convenient way to eyeball the deal really moving) — but that part is
 * incidental to the CAPI call now, not a precondition for it.
 *
 * WARNING — this is not a dry run by default only as a safety rail, not
 * a simulation: with APPLY=1 it WRITES contacts.ai_score and moves the
 * deal's stage_id for the contact you point it at, for real. Only ever
 * point this at a lead you created yourself by clicking your own ad —
 * never a real customer's contact.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/test-qualified-lead-capi.ts --contact-id=<uuid>
 *     (dry run — prints what it found and what it WOULD do, writes nothing)
 *
 *   APPLY=1 npx tsx --env-file=.env.local scripts/test-qualified-lead-capi.ts --contact-id=<uuid>
 *     (writes ai_score=7, moves the deal to "Interesse" as a side effect, fires the real QualifiedLead event)
 *
 *   Add --test-event-code=TEST12345 (or TEST_EVENT_CODE=TEST12345 env var) to make the
 *   event show up live in Meta Events Manager → dataset → Test Events tab, instead of
 *   only counting as a normal production event. Get the code from that same tab.
 *   Omit it to send a normal (non-test) event — this is the only way to confirm the
 *   integration end to end with real production traffic if you'd rather not use Test
 *   Events. Never hardcode a test_event_code here — always pass it explicitly per run.
 */
const APPLY = process.env.APPLY === '1'

import { createClient } from '@supabase/supabase-js'
import { applyLeadAnalysisResult } from '../src/lib/ai/lead-analysis'
import { emptyLeadSummary } from '../src/lib/ai/lead-analysis-types'

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}

const CONTACT_ID = arg('contact-id') ?? process.env.CONTACT_ID
const TEST_EVENT_CODE = arg('test-event-code') ?? process.env.TEST_EVENT_CODE

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

async function main() {
  if (!CONTACT_ID) {
    console.error('Missing --contact-id=<uuid> (or CONTACT_ID env var). Aborting.')
    process.exit(1)
  }

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, account_id, name, phone, ai_score')
    .eq('id', CONTACT_ID)
    .maybeSingle()
  if (contactErr) throw contactErr
  if (!contact) {
    console.error(`No contact found with id ${CONTACT_ID}. Aborting.`)
    process.exit(1)
  }
  const accountId = contact.account_id as string

  const { data: dealRow, error: dealErr } = await db
    .from('deals')
    .select('id, stage_id, pipeline_id, conversation_id')
    .eq('account_id', accountId)
    .eq('contact_id', CONTACT_ID)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (dealErr) throw dealErr
  if (!dealRow) {
    console.error(
      `Contact ${CONTACT_ID} has no open deal. This lead needs to go through the normal WACRM ` +
        `intake flow (send it a real WhatsApp message via the CTWA ad) before this script can run ` +
        'the real stage-transition logic against it. Aborting.',
    )
    process.exit(1)
  }

  const { data: stageRows, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', dealRow.pipeline_id)
    .order('position', { ascending: true })
  if (stagesErr) throw stagesErr
  const stages = stageRows ?? []
  const interesseStage = stages.find((s) => s.name.trim().toLowerCase() === 'interesse')
  if (!interesseStage) {
    console.error(`No "Interesse" stage found in pipeline ${dealRow.pipeline_id}. Aborting.`)
    process.exit(1)
  }
  const currentStageName = stages.find((s) => s.id === dealRow.stage_id)?.name ?? '?'

  // Find the most recent conversation for this contact carrying a real
  // ctwa_clid — this is the load-bearing precondition for the whole test:
  // no real click, no valid event to send.
  const { data: conversations, error: convErr } = await db
    .from('conversations')
    .select('id, ctwa_referral, created_at')
    .eq('account_id', accountId)
    .eq('contact_id', CONTACT_ID)
    .not('ctwa_referral', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (convErr) throw convErr
  const conversation = conversations?.[0]
  const ctwaClid = (conversation?.ctwa_referral as { ctwa_clid?: string } | null)?.ctwa_clid
  if (!conversation || !ctwaClid) {
    console.error(
      `Contact ${CONTACT_ID} has no conversation with a real ctwa_clid. This script refuses to ` +
        'proceed without one — a fabricated clid would be rejected by Meta anyway, and this check ' +
        'also guards against accidentally pointing the script at a lead that never actually came ' +
        'from a Click-to-WhatsApp ad. Click your test ad for real, send a WhatsApp message, then re-run. Aborting.',
    )
    process.exit(1)
  }

  console.log('=== Controlled QualifiedLead CAPI test ===')
  console.log(`Contact:            ${contact.name ?? '(sem nome)'} (${contact.phone ?? '?'}) — id ${CONTACT_ID}`)
  console.log(`Account:            ${accountId}`)
  console.log(`Conversation:       ${conversation.id}`)
  console.log(`ctwa_clid (trunc):  ${truncate(ctwaClid, 24)}`)
  console.log(`Current stage:      ${currentStageName}  →  target: Interesse`)
  console.log(`Current ai_score:   ${contact.ai_score ?? 0}  →  will be set to: 7`)
  console.log(`test_event_code:    ${TEST_EVENT_CODE ?? '(none — will send as a normal production event)'}`)
  console.log(`Mode:               ${APPLY ? 'APPLY (writes for real)' : 'DRY RUN (nothing will be written)'}`)
  console.log('')

  if (!APPLY) {
    console.log('Dry run only. Re-run with APPLY=1 to actually execute the real stage-transition + CAPI call.')
    return
  }

  await applyLeadAnalysisResult({
    db,
    accountId,
    contactId: CONTACT_ID,
    conversationId: conversation.id,
    deal: { id: dealRow.id, stage_id: dealRow.stage_id },
    stages,
    currentAiScore: contact.ai_score ?? 0,
    metaCapiTestEventCode: TEST_EVENT_CODE,
    result: {
      summary: emptyLeadSummary(),
      tag_changes: [],
      lead_score: {
        value: 7,
        reason: 'Teste controlado (scripts/test-qualified-lead-capi.ts) — não é uma análise real da IA.',
      },
      stage_suggestion: {
        should_suggest: true,
        target_stage_name: 'Interesse',
        justification: 'Teste controlado — verificação da integração Meta Conversions API.',
        score: 95,
      },
    },
  })

  const { data: after } = await db
    .from('contacts')
    .select('ai_score')
    .eq('id', CONTACT_ID)
    .maybeSingle()
  const { data: dealAfter } = await db.from('deals').select('stage_id').eq('id', dealRow.id).maybeSingle()

  console.log('Done.')
  console.log(`  contacts.ai_score is now: ${after?.ai_score}`)
  console.log(`  deal stage is now:        ${stages.find((s) => s.id === dealAfter?.stage_id)?.name ?? dealAfter?.stage_id}`)
  console.log('')
  console.log(
    TEST_EVENT_CODE
      ? '  Check Meta Events Manager → your dataset → Test Events tab for the event.'
      : '  Check the dataset quality/events report in Meta Events Manager (crm/business_messaging channel).',
  )
  console.log('  If it failed silently, check this process\'s stderr above and the app runtime logs for "[lead-analysis] QualifiedLead CAPI event failed".')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
