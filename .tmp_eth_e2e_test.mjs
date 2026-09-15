import fs from 'node:fs';
import dotenv from 'dotenv';
import { awardSamuraiPoints, getSeasonForTimestamp } from './api/_lib/supabaseBackend.mjs';
import { calculateSamuraiPoints, getEffectivePointsConfiguration } from './api/_lib/samuraiPoints.mjs';

dotenv.config({ path: '.env.local', override: true });

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const idx = line.indexOf('=');
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
  env[key] = value;
}

const supabaseUrl = env.SUPABASE_URL;
const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = {
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
  Accept: 'application/json',
};

async function supabaseGet(path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

async function pickEligibleSwap(chainId) {
  const rows = await supabaseGet(`swap_transactions?chain_id=eq.${chainId}&verification_status=eq.verified&status=eq.CONFIRMED&select=signature,chain_id,wallet_address,provider,volume_usd,input_mint,output_mint,input_amount_raw,input_decimals,timestamp,slot,transaction_hash&order=timestamp.desc&limit=50`);
  const sanitized = Array.isArray(rows) ? rows : [];
  const candidates = [];
  for (const row of sanitized) {
    if (!row || Number(row.volume_usd) < 0.5) continue;
    const existing = await supabaseGet(`samurai_points?signature=eq.${encodeURIComponent(row.signature)}&select=signature`);
    if (Array.isArray(existing) && existing.length) continue;
    candidates.push(row);
  }
  return candidates[0] || null;
}

async function runOne(chainId, label) {
  const swap = await pickEligibleSwap(chainId);
  if (!swap) {
    return {
      label,
      status: 'NO_ELIGIBLE_SWAP_FOUND',
      selectedSwap: null,
      reason: `No verified ${chainId === 1 ? 'ETH' : 'Solana'} swap with volume_usd >= 0.5 and no existing samurai_points row was found.`,
    };
  }

  const season = await getSeasonForTimestamp(swap.timestamp)
  const config = {
    ...getEffectivePointsConfiguration(),
    pointsEnabled: true,
    minimumQualifyingSwapUsd: 0,
    pointsPerUsd: 1,
    ruleVersion: 'v1',
    campaigns: [],
    transactionPointsCapEnabled: false,
    transactionPointsCap: null,
    startDate: null,
    endDate: null,
  };

  const calculation = await calculateSamuraiPoints({
    verification_status: 'verified',
    chain_id: Number(swap.chain_id),
    volume_usd: Number(swap.volume_usd),
    timestamp: swap.timestamp,
    input_mint: swap.input_mint,
    output_mint: swap.output_mint,
    input_amount_raw: swap.input_amount_raw,
    input_decimals: Number(swap.input_decimals),
  }, config);

  const payload = {
    p_signature: swap.signature,
    p_qualifying_volume_usd: calculation.qualified ? calculation.qualifyingVolumeUsd : 0,
    p_base_points: calculation.qualified ? calculation.basePoints : 0,
    p_multiplier: calculation.qualified ? calculation.multiplier : 1,
    p_final_points: calculation.qualified ? calculation.finalPoints : 0,
    p_points_rule_version: calculation.pointsRuleVersion,
    p_season_id: season?.id || env.SAMURAI_CURRENT_SEASON_ID || 'season-1',
    p_eligibility_status: calculation.qualified ? 'qualified' : 'not_qualified',
    p_exclusion_reason: calculation.exclusionReason || null,
  };

  let rpcResponse;
  try {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/award_samurai_points`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    const rpcText = await rpcRes.text();
    let parsed;
    try { parsed = JSON.parse(rpcText); } catch { parsed = { raw: rpcText }; }
    rpcResponse = { status: rpcRes.status, body: parsed };
  } catch (error) {
    rpcResponse = { status: 'EXCEPTION', body: { message: error?.message || String(error) } };
  }

  const rowQuery = `samurai_points?signature=eq.${encodeURIComponent(swap.signature)}&select=signature,chain_id,wallet_id,wallet_address,qualifying_volume_usd,base_points,multiplier,final_points,points_awarded,points_rule_version,season_id,eligibility_status`;
  let row = null;
  try {
    const rowRows = await supabaseGet(rowQuery);
    row = Array.isArray(rowRows) ? rowRows[0] || null : rowRows || null;
  } catch {
    row = null;
  }

  return {
    label,
    status: rpcResponse.status === 200 || rpcResponse.status === 201 ? 'OK' : 'ERROR',
    transactionSignature: swap.signature,
    swap,
    seasonId: season?.id || env.SAMURAI_CURRENT_SEASON_ID || 'season-1',
    calculated: {
      qualified: calculation.qualified,
      qualifyingVolumeUsd: calculation.qualifyingVolumeUsd,
      basePoints: calculation.basePoints,
      multiplier: calculation.multiplier,
      finalPoints: calculation.finalPoints,
      pointsRuleVersion: calculation.pointsRuleVersion,
      seasonId: season?.id || env.SAMURAI_CURRENT_SEASON_ID || 'season-1',
    },
    awardPayload: payload,
    rpcResponse,
    samuraiPointsRow: row,
  };
}

const eth = await runOne(1, 'ETH');
const sol = await runOne(101, 'SOLANA');
console.log(JSON.stringify({ eth, sol }, null, 2));
