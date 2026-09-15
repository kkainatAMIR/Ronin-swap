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
const query = `${url}/rest/v1/swap_transactions?chain_id=eq.1&verification_status=eq.verified&select=signature,chain_id,wallet_address,provider,volume_usd,timestamp,transaction_hash&order=timestamp.desc&limit=20`;
const res = await fetch(query, { headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' } });
const text = await res.text();
console.log('STATUS', res.status);
console.log(text.slice(0, 8000));
