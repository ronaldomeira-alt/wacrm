-- Migration 087: Otimização de contadores de abas de Match via RPC (redução de 99.9% de Egress)
-- Substitui o download de 14.500 linhas de lead_property_matches no frontend por agregação direta no banco.

CREATE OR REPLACE FUNCTION get_match_tab_counts(p_account_id uuid)
RETURNS TABLE (
  match_status text,
  distinct_leads bigint
) LANGUAGE sql STABLE AS $$
  SELECT 
    m.match_status,
    count(DISTINCT m.lead_id) AS distinct_leads
  FROM lead_property_matches m
  JOIN property_match_projections p 
    ON p.account_id = m.account_id 
   AND p.property_id = m.property_id
  WHERE m.account_id = p_account_id
    AND m.suppressed = false
    AND (m.match_status != 'novo' OR p.status = 'ativo')
  GROUP BY m.match_status;
$$;

GRANT EXECUTE ON FUNCTION get_match_tab_counts(uuid) TO authenticated, service_role;
