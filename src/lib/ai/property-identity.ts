import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Identity resolution + creation-evidence gate for automatic property
// learning. Two independent safety layers, in this order:
//
//   1. resolvePropertyIdentity — is this name just a different spelling
//      of a property we already have? (typos, missing letters, spacing,
//      punctuation, abbreviations...) A partial/`ilike` check is NOT
//      enough: "Liv Park" is not a substring of "Live Park", so the old
//      substring match would have silently spawned a duplicate.
//   2. The conversation-evidence ledger (property_learning_candidates) —
//      even when nothing existing plausibly matches, a single mention
//      (or many mentions within one conversation) is not proof a new
//      empreendimento actually exists. Only sustained, contextual
//      recurrence across MIN_PROPERTY_LEARNING_CONVERSATIONS distinct
//      conversations clears the bar to auto-create one.
//
// Both layers are account-scoped — a name is only ever compared against,
// or accrues evidence within, its own account.
// ============================================================

/** Minimum number of *distinct* conversations (never messages within
 *  one conversation) that must show real estate context around a name
 *  before it's treated as evidence of a genuinely new empreendimento. */
export const MIN_PROPERTY_LEARNING_CONVERSATIONS = 7

const SAFE_MATCH_THRESHOLD = 0.8
const AMBIGUOUS_MATCH_THRESHOLD = 0.6
/** A short/generic single-word name (see isGenericName) needs a much
 *  tighter bar — "Park" alone must not casually bind to "Live Park". */
const GENERIC_SAFE_THRESHOLD = 0.95
const GENERIC_AMBIGUOUS_THRESHOLD = 0.88
/** The top match must clear the runner-up by this much to count as
 *  "safe" instead of "ambiguous" — two close contenders are a reason to
 *  hold off, not to guess. */
const SAFE_MATCH_MARGIN = 0.08

const GENERIC_PROPERTY_WORDS = new Set([
  'park',
  'home',
  'residence',
  'residencial',
  'reserva',
  'vista',
  'living',
  'blue',
  'jardim',
  'garden',
  'ville',
  'plaza',
  'life',
  'place',
  'tower',
  'view',
  'side',
  'prime',
  'class',
  'green',
  'sol',
  'mar',
  'flex',
]);

/** Lowercase, accent-free, punctuation-free, single-spaced form used for
 *  every comparison — deliberately aggressive (hyphens/underscores/
 *  punctuation all collapse to spaces) so "Live-Park" and "Live_Park"
 *  and "Live, Park!" all normalize identically. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/,.]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same as normalizeForMatch with spaces removed too, so "Live Park"
 *  and "LivePark" collapse to the identical string. */
export function compactForMatch(value: string): string {
  return normalizeForMatch(value).replace(/ /g, '');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[n];
}

/** 1.0 = identical, 0.0 = completely different (relative to the longer
 *  of the two strings) — deliberately tolerant of small edits (typos,
 *  missing/extra letters, phonetic near-misses) without needing an
 *  external fuzzy-matching or phonetic library. */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** A bare single-word, short/common real-estate term ("Park", "Home",
 *  "Vista"...) must never, by itself, be considered a confident match —
 *  it's exactly the kind of name where a coincidental resemblance is
 *  most likely to be wrong. */
export function isGenericName(normalized: string): boolean {
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length !== 1) return false;
  const word = tokens[0];
  return GENERIC_PROPERTY_WORDS.has(word) || word.length <= 5;
}

export type PropertyIdentityResolution =
  | { kind: 'safe_match'; propertyId: string; score: number }
  | { kind: 'ambiguous'; candidates: { propertyId: string; score: number }[] }
  | { kind: 'no_match' };

/**
 * A name that is structurally a prefix of a longer one (or vice versa),
 * at a whole-word boundary — "Live" is a prefix of "Live Park", but
 * "Park" is not a prefix of "Live Park" (it's a suffix, and a bare
 * generic suffix must NOT count as a candidate — see isGenericName).
 * This is a real, construction-based signal that a short/abbreviated
 * name plausibly refers to a longer one, independent of edit-distance
 * score, which reads a length difference alone as low similarity.
 */
function isPrefixMatch(candidateNormalized: string, existingNormalized: string): boolean {
  if (!candidateNormalized || !existingNormalized) return false;
  if (candidateNormalized === existingNormalized) return true;
  return (
    existingNormalized.startsWith(candidateNormalized + ' ') ||
    candidateNormalized.startsWith(existingNormalized + ' ')
  );
}

/**
 * Resolves a name the AI extracted from conversation against the
 * account's existing properties — tolerant of typos, missing/extra
 * letters, spacing/hyphenation differences, abbreviations and
 * capitalization, but conservative about short/generic names and about
 * two existing properties that are both plausible (never guesses; see
 * property-identity.test.ts for the worked examples from the spec).
 *
 * Decision order: (1) an exact match, post-normalization, wins outright
 * — a literal identity is never overridden by a similar-looking sibling;
 * (2) otherwise, fuzzy/semantic scoring decides between safe_match,
 * ambiguous, and no_match, with structurally plausible candidates (see
 * isPrefixMatch) always surviving into the ambiguity check even when
 * their fuzzy score alone would read as "no candidate" — "not safe
 * enough to match" must never collapse into "no candidate exists".
 */
export async function resolvePropertyIdentity(
  db: SupabaseClient,
  accountId: string,
  propertyName: string,
): Promise<PropertyIdentityResolution> {
  const candidateNormalized = normalizeForMatch(propertyName);
  if (!candidateNormalized) return { kind: 'no_match' };
  const candidateCompact = candidateNormalized.replace(/ /g, '');
  const candidateGeneric = isGenericName(candidateNormalized);

  const { data: properties } = await db
    .from('properties')
    .select('id, name')
    .eq('account_id', accountId);

  const scored = (properties ?? []).map((p) => {
    const existingNormalized = normalizeForMatch(p.name as string);
    const existingCompact = existingNormalized.replace(/ /g, '');
    // A literal match (with or without spacing) is never subject to the
    // fuzzy score or the safe-match margin below.
    const exact = existingNormalized === candidateNormalized || existingCompact === candidateCompact;
    const score = exact
      ? 1
      : Math.max(
          similarityRatio(candidateNormalized, existingNormalized),
          similarityRatio(candidateCompact, existingCompact),
        );
    const generic = candidateGeneric || isGenericName(existingNormalized);
    return {
      propertyId: p.id as string,
      score,
      exact,
      structurallyPlausible: exact || isPrefixMatch(candidateNormalized, existingNormalized),
      safeThreshold: generic ? GENERIC_SAFE_THRESHOLD : SAFE_MATCH_THRESHOLD,
      ambiguousThreshold: generic ? GENERIC_AMBIGUOUS_THRESHOLD : AMBIGUOUS_MATCH_THRESHOLD,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { kind: 'no_match' };

  // Exact match has absolute priority — it can never be turned into
  // `ambiguous` by a nearby fuzzy sibling (e.g. "Prime Tower A" vs an
  // existing "Prime Tower B"). The safe-match margin below only ever
  // arbitrates between *fuzzy* candidates.
  if (best.exact) {
    return { kind: 'safe_match', propertyId: best.propertyId, score: best.score };
  }

  const plausible = scored.filter((s) => s.score >= s.ambiguousThreshold || s.structurallyPlausible);
  if (plausible.length === 0) return { kind: 'no_match' };

  if (best.score >= best.safeThreshold) {
    const second = scored[1];
    const marginOk = !second || best.score - second.score >= SAFE_MATCH_MARGIN;
    if (marginOk) return { kind: 'safe_match', propertyId: best.propertyId, score: best.score };
  }

  return {
    kind: 'ambiguous',
    candidates: plausible.map((s) => ({ propertyId: s.propertyId, score: s.score })),
  };
}

// ============================================================
// Conversation-evidence ledger — the second safety layer, gating
// creation itself once resolvePropertyIdentity comes back `no_match`.
// ============================================================

const CONTEXT_KEYWORDS = [
  'unidade',
  'unidades',
  'localizacao',
  'localizado',
  'bairro',
  'metragem',
  'm2',
  'metro quadrado',
  'metros quadrados',
  'lazer',
  'tipologia',
  'quarto',
  'quartos',
  'suite',
  'condicao',
  'condicoes',
  'entrada',
  'financiamento',
  'interesse',
  'visita',
  'planta',
  'entrega',
  'andar',
  'vaga',
  'garagem',
  'piscina',
  'area',
  'preco',
  'valor',
  'apartamento',
  'apto',
  'sala',
  'cobertura',
  'duplex',
  'terreno',
  'construtora',
  'obra',
  'varanda',
  'sacada',
  'lancamento',
  'pronto',
];

/** Whether a (already-normalized, accent-free) chunk of conversation
 *  text carries any signal that a real empreendimento is actually being
 *  discussed — as opposed to the name being a passing, contentless
 *  mention. Deliberately a low bar (any single keyword) since Part 5 of
 *  the spec only asks to rule out "the name appeared" with zero
 *  surrounding substance, not to grade conversation quality. */
export function hasContextSignal(normalizedText: string): boolean {
  return CONTEXT_KEYWORDS.some((k) => normalizedText.includes(k));
}

export interface EvidenceMessageRow {
  conversationId: string;
  text: string;
}

/**
 * Groups scanned messages by conversation and reports, for one
 * candidate property name, which distinct conversations mention it at
 * all vs. which of those also carry real-estate context — the two
 * numbers Part 4/5 of the spec require kept separate (a bare mention
 * count is not enough).
 */
export function findConversationEvidence(
  rows: EvidenceMessageRow[],
  propertyName: string,
): { mentioned: Set<string>; withContext: Set<string> } {
  const mentioned = new Set<string>();
  const withContext = new Set<string>();
  const nameNormalized = normalizeForMatch(propertyName);
  if (!nameNormalized) return { mentioned, withContext };
  const nameCompact = nameNormalized.replace(/ /g, '');

  const byConversation = new Map<string, string[]>();
  for (const row of rows) {
    const arr = byConversation.get(row.conversationId);
    if (arr) arr.push(row.text);
    else byConversation.set(row.conversationId, [row.text]);
  }

  for (const [conversationId, texts] of byConversation) {
    const joinedNormalized = normalizeForMatch(texts.join(' \n '));
    const mentionsName =
      joinedNormalized.includes(nameNormalized) ||
      joinedNormalized.replace(/ /g, '').includes(nameCompact);
    if (!mentionsName) continue;
    mentioned.add(conversationId);
    if (hasContextSignal(joinedNormalized)) withContext.add(conversationId);
  }

  return { mentioned, withContext };
}

/**
 * Merges newly-observed conversation evidence for a candidate name into
 * its durable ledger row — accumulates across cron runs, since each run
 * only re-scans messages since the previous cursor and a single run
 * will rarely see 7 distinct conversations on its own.
 */
export async function recordPropertyLearningEvidence(
  db: SupabaseClient,
  accountId: string,
  propertyName: string,
  newMentionedConversationIds: Iterable<string>,
  newContextConversationIds: Iterable<string>,
): Promise<void> {
  const normalized = normalizeForMatch(propertyName);
  const newMentioned = new Set(newMentionedConversationIds);
  if (!normalized || newMentioned.size === 0) return;
  const newContext = new Set(newContextConversationIds);

  const { data: existing } = await db
    .from('property_learning_candidates')
    .select('conversation_ids, context_conversation_ids')
    .eq('account_id', accountId)
    .eq('normalized_name', normalized)
    .maybeSingle();

  const mergedConversations = new Set<string>([
    ...((existing?.conversation_ids as string[] | undefined) ?? []),
    ...newMentioned,
  ]);
  const mergedContext = new Set<string>([
    ...((existing?.context_conversation_ids as string[] | undefined) ?? []),
    ...newContext,
  ]);

  await db.from('property_learning_candidates').upsert(
    {
      account_id: accountId,
      normalized_name: normalized,
      display_name: propertyName.trim(),
      conversation_ids: Array.from(mergedConversations),
      context_conversation_ids: Array.from(mergedContext),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id,normalized_name' },
  );
}

/** Distinct, context-bearing conversations accumulated so far for this
 *  candidate name — the number Part 4/7 of the spec gates creation on. */
export async function getPropertyLearningEvidenceCount(
  db: SupabaseClient,
  accountId: string,
  propertyName: string,
): Promise<number> {
  const normalized = normalizeForMatch(propertyName);
  if (!normalized) return 0;
  const { data } = await db
    .from('property_learning_candidates')
    .select('context_conversation_ids')
    .eq('account_id', accountId)
    .eq('normalized_name', normalized)
    .maybeSingle();
  return ((data?.context_conversation_ids as string[] | undefined) ?? []).length;
}

export function meetsPropertyCreationEvidence(count: number): boolean {
  return count >= MIN_PROPERTY_LEARNING_CONVERSATIONS;
}

/** Called once a property is actually created from this candidate's
 *  evidence (or, in principle, if it's later found to resolve onto an
 *  existing one) — nothing left to accumulate toward. */
export async function clearPropertyLearningEvidence(
  db: SupabaseClient,
  accountId: string,
  propertyName: string,
): Promise<void> {
  const normalized = normalizeForMatch(propertyName);
  if (!normalized) return;
  await db
    .from('property_learning_candidates')
    .delete()
    .eq('account_id', accountId)
    .eq('normalized_name', normalized);
}
