import { apiError, json } from '../../api/_lib/roninBackend.mjs'
import { getPublicCampaignOverview, isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Campaign data is not configured.')

  try {
    return json(res, 200, await getPublicCampaignOverview())
  } catch (error) {
    console.error('public campaign overview failed:', error?.message || error)
    return apiError(res, 502, 'CAMPAIGN_OVERVIEW_ERROR', 'Unable to load campaigns.')
  }
}
