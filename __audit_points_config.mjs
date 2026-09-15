import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const response = await fetch(`${url}/rest/v1/samurai_admin_settings?id=eq.default&select=*`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  },
});
const db = await response.json();
const { getEffectivePointsConfiguration } = await import('./api/_lib/samuraiPoints.mjs');
console.log(JSON.stringify({
  dbSettings: db,
  env: {
    SAMURAI_MINIMUM_QUALIFYING_SWAP_USD: process.env.SAMURAI_MINIMUM_QUALIFYING_SWAP_USD,
    SAMURAI_MINIMUM_QUALIFYING_SWAP: process.env.SAMURAI_MINIMUM_QUALIFYING_SWAP,
    SAMURAI_POINTS_ENABLED: process.env.SAMURAI_POINTS_ENABLED,
    SAMURAI_POINTS_PER_DOLLAR: process.env.SAMURAI_POINTS_PER_DOLLAR,
  },
  runtime: getEffectivePointsConfiguration(Array.isArray(db) ? db[0] : null),
}, null, 2));
