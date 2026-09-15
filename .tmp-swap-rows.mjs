import fs from 'node:fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const idx = line.indexOf('=');
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
  env[key] = value;
}
const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log(JSON.stringify({ error: 'MISSING_SUPABASE_CONFIG' }, null, 2));
  process.exit(1);
}
const rowsQuery = `${url}/rest/v1/swap_transactions?chain_id=eq.1&verification_status=eq.verified&select=signature,chain_id,wallet_address,provider,volume_usd,input_mint,output_mint,input_amount_raw,input_decimals,timestamp,slot,transaction_hash&order=timestamp.desc&limit=50`;
const rowsRes = await fetch(rowsQuery, { headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' } });
const rowsBody = await rowsRes.text();
if (!rowsRes.ok) {
  console.log(JSON.stringify({ status: rowsRes.status, body: rowsBody }, null, 2));
  process.exit(1);
}
const rows = JSON.parse(rowsBody);
console.log(JSON.stringify(rows, null, 2));
