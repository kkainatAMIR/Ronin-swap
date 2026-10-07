function normalizeWalletAddress(address) {
  const value = String(address || '').trim()
  return /^0x/i.test(value) ? value.toLowerCase() : value
}

export function getVisibleCampaigns(campaigns, now = Date.now()) {
  if (!Array.isArray(campaigns)) return []

  return campaigns.flatMap((campaign) => {
    const id = String(campaign?.id || '').trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || campaign.enabled === false) return []

    const startAt = campaign.startDate || campaign.start_at || null
    const endAt = campaign.endDate || campaign.end_at || null
    const startTime = startAt ? Date.parse(startAt) : Number.NEGATIVE_INFINITY
    const endTime = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY
    if ((startAt && !Number.isFinite(startTime)) || (endAt && !Number.isFinite(endTime)) || endTime <= now) return []
    const multiplier = Number(campaign.multiplier)
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('INVALID_CAMPAIGN_MULTIPLIER')

    return [{
      id,
      name: String(campaign.name || ''),
      description: String(campaign.description || ''),
      promoCode: campaign.promoCode ?? campaign.promo_code ?? null,
      startAt,
      endAt,
      multiplier,
      source: campaign.source || '',
      direction: campaign.direction || 'any',
      chainId: campaign.chainId ?? null,
      inputMint: campaign.inputMint || '',
      outputMint: campaign.outputMint || '',
      inputTokenMetadata: campaign.inputTokenMetadata || null,
      outputTokenMetadata: campaign.outputTokenMetadata || null,
      status: startTime > now ? 'UPCOMING' : 'ACTIVE',
      participantCount: 0,
    }]
  })
}

export function countCampaignParticipants(pointRows, walletLinks = []) {
  const canonicalWallets = new Map()
  for (const link of walletLinks) {
    if (link?.status && link.status !== 'ACTIVE') continue
    const solanaWallet = normalizeWalletAddress(link?.solana_wallet)
    const evmWallet = normalizeWalletAddress(link?.evm_wallet)
    if (solanaWallet && evmWallet) {
      canonicalWallets.set(solanaWallet, solanaWallet)
      canonicalWallets.set(evmWallet, solanaWallet)
    }
  }

  const participants = new Map()
  for (const row of pointRows) {
    const campaignId = String(row?.campaign_id || '')
    const walletAddress = normalizeWalletAddress(row?.wallet_address)
    if (!campaignId || !walletAddress
      || row.eligibility_status !== 'qualified'
      || row.flag_status === 'EXCLUDED'
      || Number(row.final_points) <= 0) continue

    if (!participants.has(campaignId)) participants.set(campaignId, new Set())
    participants.get(campaignId).add(canonicalWallets.get(walletAddress) || walletAddress)
  }

  return new Map([...participants].map(([campaignId, wallets]) => [campaignId, wallets.size]))
}
