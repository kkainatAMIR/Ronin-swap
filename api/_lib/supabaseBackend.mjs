import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', override: true })

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const SUPABASE_URL = String(runtimeEnv.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE_KEY = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY || ''

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

function supabaseHeaders(prefer = 'return=representation') {
  return {
    Accept: 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  }
}

async function supabaseRequest(path, options = {}) {
  if (!isSupabaseConfigured()) throw new Error('SUPABASE_NOT_CONFIGURED')
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...supabaseHeaders(options.prefer), ...(options.headers || {}) },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error_description || body?.error || `Supabase request failed (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export async function persistVerifiedSwap(verified) {
  const walletRows = await supabaseRequest('wallets?on_conflict=wallet_address&select=id,wallet_address,created_at,updated_at', {
    method: 'POST',
    body: JSON.stringify([{ wallet_address: verified.wallet, updated_at: new Date().toISOString() }]),
    prefer: 'resolution=merge-duplicates,return=representation',
  })
  const wallet = Array.isArray(walletRows) ? walletRows[0] : walletRows
  if (!wallet?.id) throw new Error('Supabase did not return the wallet record.')

  const swapRows = await supabaseRequest('swap_transactions?on_conflict=signature&select=id,signature,wallet_address,chain_id,provider,input_mint,output_mint,input_amount_raw,output_amount_raw,input_decimals,output_decimals,timestamp,slot,confirmation_status,verification_status,status,transaction_hash,sell_token_id,buy_token_id,created_at,updated_at', {
    method: 'POST',
    body: JSON.stringify([{
      signature: verified.signature,
      chain_id: 101,
      provider: 'jupiter',
      wallet_id: wallet.id,
      wallet_address: verified.wallet,
      input_mint: verified.input.mint,
      output_mint: verified.output.mint,
      input_amount_raw: verified.input.amountRaw,
      output_amount_raw: verified.output.amountRaw,
      input_decimals: verified.input.decimals,
      output_decimals: verified.output.decimals,
      transaction_hash: verified.signature,
      status: 'CONFIRMED',
      sell_token_id: `101:${verified.input.mint}`,
      buy_token_id: `101:${verified.output.mint}`,
      timestamp: verified.timestamp,
      slot: verified.slot,
      confirmation_status: verified.status,
      verification_status: 'verified',
      updated_at: new Date().toISOString(),
    }]),
    prefer: 'resolution=merge-duplicates,return=representation',
  })
  const swap = Array.isArray(swapRows) ? swapRows[0] : swapRows
  if (!swap?.signature) throw new Error('Supabase did not return the swap record.')
  return { wallet, swap }
}

export async function persistEthereumSwap({ wallet, transactionHash, sellToken, buyToken, sellAmount, buyAmount, sellDecimals, buyDecimals, volumeUsd, timestamp, blockNumber }) {
  const walletRows = await supabaseRequest('wallets?on_conflict=wallet_address&select=id,wallet_address,created_at,updated_at', { method: 'POST', body: JSON.stringify([{ wallet_address: wallet, wallet_chain_id: 1, updated_at: new Date().toISOString() }]), prefer: 'resolution=merge-duplicates,return=representation' })
  const walletRow = Array.isArray(walletRows) ? walletRows[0] : walletRows
  if (!walletRow?.id) throw new Error('WALLET_PERSISTENCE_FAILED')
  const native = 'native'
  const slotNumber = typeof blockNumber === 'number' ? blockNumber : (typeof blockNumber === 'string' && blockNumber.startsWith('0x') ? Number.parseInt(blockNumber, 16) : Number(blockNumber) || 0)
  const rows = await supabaseRequest('swap_transactions?on_conflict=chain_id,transaction_hash&select=*', { method: 'POST', body: JSON.stringify([{ signature: transactionHash, transaction_hash: transactionHash, chain_id: 1, provider: '0x', wallet_id: walletRow.id, wallet_address: wallet, input_mint: sellToken === native ? native : sellToken, output_mint: buyToken === native ? native : buyToken, sell_token_address: sellToken === native ? null : sellToken, buy_token_address: buyToken === native ? null : buyToken, sell_token_id: `1:${sellToken === native ? 'native' : sellToken.toLowerCase()}`, buy_token_id: `1:${buyToken === native ? 'native' : buyToken.toLowerCase()}`, input_amount_raw: String(sellAmount), output_amount_raw: String(buyAmount), sell_amount: String(sellAmount), buy_amount: String(buyAmount), input_decimals: sellDecimals, output_decimals: buyDecimals, volume_usd: volumeUsd == null ? null : Number(volumeUsd), timestamp, slot: slotNumber, confirmation_status: 'finalized', verification_status: 'verified', status: 'CONFIRMED', updated_at: new Date().toISOString() }]), prefer: 'resolution=merge-duplicates,return=representation' })
  return { wallet: walletRow, swap: Array.isArray(rows) ? rows[0] : rows }
}

export async function getEthereumSwapByHash(transactionHash) {
  const rows = await getAdminRows(`swap_transactions?chain_id=eq.1&transaction_hash=eq.${encodeURIComponent(transactionHash)}&select=*`)
  return rows?.[0] || null
}

export async function persistLifiSwap({ wallet, transactionHash, fromChain, toChain, fromToken, toToken, fromAmount, toAmount, volumeUsd, timestamp, blockNumber, quoteId }) {
  const walletRows = await supabaseRequest('wallets?on_conflict=wallet_address&select=id,wallet_address', { method: 'POST', body: JSON.stringify([{ wallet_address: wallet, wallet_chain_id: Number(fromChain), updated_at: new Date().toISOString() }]), prefer: 'resolution=merge-duplicates,return=representation' })
  const walletRow = Array.isArray(walletRows) ? walletRows[0] : walletRows
  if (!walletRow?.id) throw new Error('WALLET_PERSISTENCE_FAILED')
  const slotNumber = typeof blockNumber === 'number' ? blockNumber : (typeof blockNumber === 'string' && blockNumber.startsWith('0x') ? Number.parseInt(blockNumber, 16) : Number(blockNumber) || 0)
  const rows = await supabaseRequest('swap_transactions?on_conflict=chain_id,transaction_hash&select=*', { method: 'POST', body: JSON.stringify([{ signature: transactionHash, transaction_hash: transactionHash, chain_id: Number(fromChain), provider: 'lifi', wallet_id: walletRow.id, wallet_address: wallet, input_mint: fromToken, output_mint: toToken, sell_token_address: fromToken, buy_token_address: toToken, sell_token_id: `${fromChain}:${fromToken.toLowerCase()}`, buy_token_id: `${toChain}:${toToken.toLowerCase()}`, input_amount_raw: String(fromAmount), output_amount_raw: String(toAmount), sell_amount: String(fromAmount), buy_amount: String(toAmount), volume_usd: volumeUsd == null ? null : Number(volumeUsd), timestamp, slot: slotNumber, confirmation_status: 'finalized', verification_status: 'verified', status: 'CONFIRMED', quote_id: quoteId || null, updated_at: new Date().toISOString() }]), prefer: 'resolution=merge-duplicates,return=representation' })
  return { wallet: walletRow, swap: Array.isArray(rows) ? rows[0] : rows }
}

export async function getLifiSwapByHash(transactionHash) {
  const rows = await getAdminRows(`swap_transactions?provider=eq.lifi&transaction_hash=eq.${encodeURIComponent(transactionHash)}&select=*`)
  return rows?.[0] || null
}

export async function getPointsBySignature(signature) {
  const rows = await getAdminRows(`samurai_points?signature=eq.${encodeURIComponent(signature)}&select=signature,chain_id,points_awarded,final_points,eligibility_status,season_id`)
  return rows?.[0] || null
}

export async function getVerifiedSwapHistory(walletAddress, chain = 'all') {
  const encodedWallet = encodeURIComponent(`eq.${walletAddress}`)
  const chainFilter = chain === 'solana' ? '&chain_id=eq.101' : chain === 'ethereum' ? '&chain_id=eq.1' : chain === 'robinhood' ? '&chain_id=eq.4663' : ''
  const swaps = await supabaseRequest(`swap_transactions?wallet_address=${encodedWallet}&verification_status=eq.verified&status=eq.CONFIRMED${chainFilter}&select=signature,transaction_hash,wallet_address,chain_id,provider,input_mint,output_mint,sell_token_id,buy_token_id,input_amount_raw,output_amount_raw,sell_amount,buy_amount,input_decimals,output_decimals,volume_usd,timestamp,slot,confirmation_status,verification_status,status,created_at&order=timestamp.desc`, {
    method: 'GET',
    prefer: 'return=minimal',
  })
  if (!Array.isArray(swaps) || !swaps.length) return []
  const signatures = swaps.map((swap) => swap.signature).filter(Boolean)
  const points = await getAdminRows(`samurai_points?signature=in.(${signatures.join(',')})&select=signature,points_awarded,final_points,eligibility_status`)
  const pointsBySignature = new Map((points || []).map((point) => [point.signature, point]))
  return swaps.map((swap) => ({ ...swap, points_awarded: Number(pointsBySignature.get(swap.signature)?.points_awarded || 0), eligibility_status: pointsBySignature.get(swap.signature)?.eligibility_status || 'not_qualified' }))
}

export async function getVerifiedSwapBySignature(signature) {
  const encodedSignature = encodeURIComponent(`eq.${signature}`)
  const rows = await supabaseRequest(`swap_transactions?signature=${encodedSignature}&verification_status=eq.verified&select=signature,wallet_id,wallet_address,input_mint,output_mint,input_amount_raw,output_amount_raw,input_decimals,output_decimals,timestamp,slot,confirmation_status,verification_status`, {
    method: 'GET',
    prefer: 'return=minimal',
  })
  return Array.isArray(rows) ? rows[0] || null : null
}

export async function awardSamuraiPoints(points) {
  const rows = await supabaseRequest('rpc/award_samurai_points', {
    method: 'POST',
    body: JSON.stringify({
      p_signature: points.signature,
      p_qualifying_volume_usd: points.qualified ? points.qualifyingVolumeUsd : 0,
      p_base_points: points.qualified ? points.basePoints : 0,
      p_multiplier: points.qualified ? points.multiplier : 1,
      p_final_points: points.qualified ? points.finalPoints : 0,
      p_points_rule_version: points.pointsRuleVersion,
      p_season_id: points.seasonId || null,
      p_eligibility_status: points.qualified ? 'qualified' : 'not_qualified',
      p_exclusion_reason: points.exclusionReason || null,
    }),
    prefer: 'return=representation',
  })
  return Array.isArray(rows) ? rows[0] || null : rows
}

export async function getLeaderboard({ period, seasonId, page, limit }) {
  return supabaseRequest('rpc/get_samurai_leaderboard', {
    method: 'POST',
    body: JSON.stringify({ p_period: period, p_season_id: seasonId, p_page: page, p_limit: limit }),
    prefer: 'return=representation',
  })
}

export async function getLeaderboardWalletStats(wallet, seasonId) {
  const rows = await supabaseRequest('rpc/get_samurai_wallet_stats', {
    method: 'POST',
    body: JSON.stringify({ p_wallet: wallet, p_season_id: seasonId }),
    prefer: 'return=representation',
  })
  return Array.isArray(rows) ? rows[0] || null : rows
}

export async function getCurrentSeason() {
  const rows = await supabaseRequest('rpc/get_current_samurai_season', { method: 'POST', body: '{}', prefer: 'return=representation' })
  return Array.isArray(rows) ? rows[0] || null : rows
}

export async function getAdminSettings() {
  const rows = await getAdminRows('samurai_admin_settings?id=eq.default&select=*')
  return rows?.[0] || null
}

export async function updateAdminSettings(values, adminId) {
  const rows = await supabaseRequest('samurai_admin_settings?id=eq.default', { method: 'PATCH', body: JSON.stringify({ ...values, updated_at: new Date().toISOString(), updated_by: adminId }), prefer: 'return=representation' })
  await writeAdminAudit({ adminId, action: 'ADMIN_SETTINGS_UPDATED', reason: JSON.stringify(values) })
  return rows?.[0] || rows
}

export async function getAdminOverview() {
  const rows = await supabaseRequest('rpc/get_admin_overview', { method: 'POST', body: '{}', prefer: 'return=representation' })
  return Array.isArray(rows) ? rows[0] || null : rows
}

export async function getAdminNotes({ wallet, signature }) {
  const filter = wallet ? `wallet_address=eq.${encodeURIComponent(wallet)}` : `transaction_signature=eq.${encodeURIComponent(signature)}`
  return getAdminRows(`samurai_admin_notes?${filter}&select=*&order=created_at.desc`)
}

export async function createAdminNote({ wallet, signature, note, adminId }) {
  return supabaseRequest('samurai_admin_notes', { method: 'POST', body: JSON.stringify([{ wallet_address: wallet || null, transaction_signature: signature || null, note, admin_id: adminId }]), prefer: 'return=representation' })
}

export async function getSeasons() {
  return supabaseRequest('samurai_seasons?select=*&order=start_at.desc', { method: 'GET', prefer: 'return=minimal' })
}

export async function getPublicSeasons() {
  return supabaseRequest('samurai_seasons?select=id,name,description,start_at,end_at,status,leaderboard_enabled,final_wallet_count,final_transaction_count,final_volume,final_points,frozen_at&order=start_at.desc', { method: 'GET', prefer: 'return=minimal' })
}

export async function getSeason(id) {
  const rows = await supabaseRequest(`samurai_seasons?id=eq.${encodeURIComponent(id)}&select=*`, { method: 'GET', prefer: 'return=minimal' })
  return rows?.[0] || null
}

export async function getSeasonForTimestamp(timestamp) {
  const encoded = encodeURIComponent(timestamp)
  const rows = await supabaseRequest(`samurai_seasons?start_at=lte.${encoded}&end_at=gt.${encoded}&status=eq.ACTIVE&select=id,name,points_enabled,minimum_qualifying_volume,base_points_per_usd,multiplier_rules&order=start_at.desc&limit=1`, { method: 'GET', prefer: 'return=minimal' })
  return rows?.[0] || null
}

export async function createSeason(season) {
  const rows = await supabaseRequest('samurai_seasons', { method: 'POST', body: JSON.stringify([{ id: season.id, name: season.name, description: season.description, start_at: season.startAt, end_at: season.endAt, points_enabled: season.pointsEnabled, minimum_qualifying_volume: season.minimum, base_points_per_usd: season.rate, multiplier_rules: season.multiplierRules }]), prefer: 'return=representation' })
  return rows?.[0] || rows
}

export async function adminSeasonAction(id, action, adminId) {
  const season = await getSeason(id)
  if (!season) throw new Error('SEASON_NOT_FOUND')
  if (action === 'activate') {
    const active = await getSeasons()
    if (active.some((item) => item.status === 'ACTIVE' && item.id !== id)) throw new Error('ACTIVE_SEASON_EXISTS')
    if (season.status !== 'DRAFT') throw new Error('INVALID_SEASON_TRANSITION')
    if (Date.parse(season.end_at) <= Date.parse(season.start_at)) throw new Error('INVALID_SEASON')
    if (Number(season.minimum_qualifying_volume) < 0 || Number(season.base_points_per_usd) < 0) throw new Error('INVALID_POINTS_CONFIGURATION')
    await supabaseRequest(`samurai_seasons?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE', updated_at: new Date().toISOString() }), prefer: 'return=minimal' })
  } else if (action === 'end') {
    if (season.status !== 'ACTIVE') throw new Error('INVALID_SEASON_TRANSITION')
    await supabaseRequest(`samurai_seasons?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'ENDED', updated_at: new Date().toISOString() }), prefer: 'return=minimal' })
  } else if (action === 'freeze') {
    await supabaseRequest('rpc/freeze_samurai_season', { method: 'POST', body: JSON.stringify({ p_id: id }), prefer: 'return=representation' })
  } else if (action === 'archive') {
    if (season.status !== 'FROZEN') throw new Error('INVALID_SEASON_TRANSITION')
    await supabaseRequest(`samurai_seasons?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'ARCHIVED', updated_at: new Date().toISOString() }), prefer: 'return=minimal' })
  }
  await supabaseRequest('samurai_admin_audit_log', { method: 'POST', body: JSON.stringify([{ admin_id: adminId, action: `ADMIN_SEASON_${action.toUpperCase()}`, reason: id }]), prefer: 'return=minimal' })
  return getSeason(id)
}

async function getAdminRows(path) {
  return supabaseRequest(path, { method: 'GET', prefer: 'return=minimal' })
}

async function writeAdminAudit({ adminId, action, wallet, signature, previousStatus, newStatus, reason }) {
  return supabaseRequest('samurai_admin_audit_log', { method: 'POST', body: JSON.stringify([{ admin_id: adminId, action, target_wallet: wallet, transaction_signature: signature, previous_status: previousStatus, new_status: newStatus, reason }]), prefer: 'return=minimal' })
}

export async function getAdminFlags(page, limit) {
  const offset = (page - 1) * limit
  return getAdminRows(`samurai_abuse_flags?select=id,wallet_address,signature,reason,severity,status,details,created_at,resolved_at,resolved_by&order=created_at.desc&offset=${offset}&limit=${limit}`)
}

export async function getAdminTransactions({ signature, wallet, page, limit }) {
  const filters = [signature ? `signature=eq.${encodeURIComponent(signature)}` : '', wallet ? `wallet_address=eq.${encodeURIComponent(wallet)}` : ''].filter(Boolean).join('&')
  return getAdminRows(`swap_transactions?select=signature,wallet_address,input_mint,output_mint,timestamp,slot,verification_status,flag_status,flag_reason,flag_severity,excluded_at,excluded_by${filters ? `&${filters}` : ''}&order=timestamp.desc&offset=${(page - 1) * limit}&limit=${limit}`)
}

export async function getAdminPointDetails(signature) {
  const rows = await getAdminRows(`samurai_points?signature=eq.${encodeURIComponent(signature)}&select=signature,wallet_address,qualifying_volume_usd,base_points,multiplier,final_points,points_awarded,points_rule_version,season_id,eligibility_status,flag_status,exclusion_reason,created_at`)
  return rows?.[0] || null
}

export async function getAdminLeaderboard({ period, seasonId, page, limit }) {
  return getLeaderboard({ period, seasonId, page, limit })
}

export async function getAdminWallet(wallet) {
  const rows = await getAdminRows(`wallets?wallet_address=eq.${encodeURIComponent(wallet)}&select=wallet_address,season_points,lifetime_points,season_qualifying_volume_usd,lifetime_qualifying_volume_usd,qualifying_swap_count,flag_status,excluded_at,excluded_by`)
  const flags = await getAdminRows(`samurai_abuse_flags?wallet_address=eq.${encodeURIComponent(wallet)}&select=id,signature,reason,severity,status,created_at&order=created_at.desc`)
  const transactions = await getAdminRows(`samurai_points?wallet_address=eq.${encodeURIComponent(wallet)}&select=signature,qualifying_volume_usd,base_points,multiplier,final_points,season_id,eligibility_status,flag_status,created_at&order=created_at.desc&limit=100`)
  const notes = await getAdminNotes({ wallet })
  return { wallet: rows?.[0] || null, flags: flags || [], transactions: transactions || [], notes: notes || [] }
}

export async function adminAction({ action, signature, wallet, status, reason, severity, adminId }) {
  const target = signature ? `signature=eq.${encodeURIComponent(signature)}` : `wallet_address=eq.${encodeURIComponent(wallet)}`
  const table = signature ? 'swap_transactions' : 'wallets'
  const previousRows = await getAdminRows(`${table}?${target}&select=flag_status,wallet_address,signature`)
  const previous = previousRows?.[0]
  const values = { flag_status: status }
  if (signature) Object.assign(values, { flag_reason: reason, flag_severity: severity })
  if (status === 'EXCLUDED') Object.assign(values, { excluded_at: new Date().toISOString(), excluded_by: adminId })
  if (status === 'NORMAL') Object.assign(values, { excluded_at: null, excluded_by: null })
  await supabaseRequest(`${table}?${target}`, { method: 'PATCH', body: JSON.stringify(values), prefer: 'return=representation' })
  if (signature) await supabaseRequest(`samurai_points?signature=eq.${encodeURIComponent(signature)}`, { method: 'PATCH', body: JSON.stringify({ flag_status: status, excluded_at: values.excluded_at || null, excluded_by: values.excluded_by || null }), prefer: 'return=minimal' })
  if (status === 'FLAGGED' && signature) await supabaseRequest('samurai_abuse_flags', { method: 'POST', body: JSON.stringify([{ wallet_address: previous.wallet_address, signature, reason, severity }]), prefer: 'return=minimal' })
  await supabaseRequest('samurai_admin_audit_log', { method: 'POST', body: JSON.stringify([{ admin_id: adminId, action, target_wallet: wallet || previous?.wallet_address, transaction_signature: signature, previous_status: previous?.flag_status || 'NORMAL', new_status: status, reason }]), prefer: 'return=minimal' })
  const recalc = await supabaseRequest('rpc/recalculate_samurai_totals', { method: 'POST', body: JSON.stringify({ p_wallet: wallet || previous?.wallet_address || null }), prefer: 'return=representation' })
  return { updated: true, status, recalculate: recalc }
}

export async function recalculateSamurai(wallet) {
  return supabaseRequest('rpc/recalculate_samurai_totals', { method: 'POST', body: JSON.stringify({ p_wallet: wallet || null }), prefer: 'return=representation' })
}

export async function createAbuseFlag({ wallet, signature, reason, severity, details }) {
  await supabaseRequest(`swap_transactions?signature=eq.${encodeURIComponent(signature)}`, { method: 'PATCH', body: JSON.stringify({ flag_status: 'FLAGGED', flag_reason: reason, flag_severity: severity }), prefer: 'return=minimal' })
  await supabaseRequest(`samurai_points?signature=eq.${encodeURIComponent(signature)}`, { method: 'PATCH', body: JSON.stringify({ flag_status: 'FLAGGED' }), prefer: 'return=minimal' })
  return supabaseRequest('samurai_abuse_flags', { method: 'POST', body: JSON.stringify([{ wallet_address: wallet, signature, reason, severity, details: details || {} }]), prefer: 'return=minimal' })
}

export { SUPABASE_URL }