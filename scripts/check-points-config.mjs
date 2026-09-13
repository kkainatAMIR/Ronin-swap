import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: true })
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/samurai_admin_settings?id=eq.default&select=minimum_qualifying_swap_usd,points_enabled,points_per_usd`, { headers })
console.log(response.status, JSON.stringify(await response.json()))
