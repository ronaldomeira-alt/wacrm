import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Compatibility redirect from the Stage 2 experimental preview route to the
 * official unified `/agents` route, preserving query parameters (`tab`,
 * `contact`, `ui`).
 */
export default async function AgentsPreviewRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string') qs.set(k, v);
    else if (Array.isArray(v) && v[0]) qs.set(k, v[0]);
  }
  const suffix = qs.toString();
  redirect(`/agents${suffix ? `?${suffix}` : ''}`);
}
