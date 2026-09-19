// Diagnostic: calls the exact same production sendPushToAccount() used by
// the WhatsApp webhook, so whatever happens here is exactly what happens on
// a real inbound message — no separate test-only code path to drift from
// the real one. Prints the real result + any error detail, which is useful
// because the deployed server's log buffer resets on every deploy/restart
// (Hostinger Node.js runtime logs don't persist across them), so a failure
// from days ago is otherwise unrecoverable.
//
// Usage: npx tsx --env-file=.env.local scripts/diagnose-push.ts [accountId]
import { sendPushToAccount } from '../src/lib/push/send'

const ACCOUNT_ID = process.argv[2] || 'f8d2ae51-e393-4a74-a432-ddab0610837e'

async function main() {
  const result = await sendPushToAccount(ACCOUNT_ID, {
    title: 'WACRM — teste de diagnóstico',
    body: 'Se você recebeu isso no iPhone, o push está funcionando.',
    url: '/inbox',
    tag: 'wacrm-diagnostic-test',
  })
  console.log('RESULT:', JSON.stringify(result))
}

main().catch((err) => {
  console.error('SCRIPT ERROR:', err)
  process.exit(1)
})
