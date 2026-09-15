import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const response = await fetch(`${url}/rest/v1/samurai_admin_settings?id=eq.default`, {
  method: 'PATCH',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify({
    minimum_qualifying_swap_usd: 10,
    points_per_usd: 10,
    updated_at: new Date().toISOString(),
    updated_by: 'admin',
  }),
});

const text = await response.text();
console.log(JSON.stringify({ status: response.status, body: text }, null, 2));
