import { json } from './_lib/roninBackend.mjs'
import { getAdminSettings, isSupabaseConfigured } from './_lib/supabaseBackend.mjs'

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  if (!isSupabaseConfigured()) return json(res, 200, {
    samuraiPoints: { minimumQualifyingSwapUsd: 0, enabled: true },
    season: { active: true },
    rewards: { enabled: true, claimsEnabled: true },
  })

  const settings = await getAdminSettings().catch(() => null)
  const pointsEnabled = settings?.points_enabled ?? true
  const minimumQualifyingSwapUsd = settings?.minimum_qualifying_swap_usd ?? 0

  return json(res, 200, {
    samuraiPoints: {
      minimumQualifyingSwapUsd: Number(minimumQualifyingSwapUsd) || 0,
      enabled: Boolean(pointsEnabled),
    },
    season: {
      active: true,
    },
    rewards: {
      enabled: true,
      claimsEnabled: true,
    },
  })
}
