import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: true })
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
const wallet = '0xCD5662B74439909961Da81794a7cfa8dB801b3f4'
for (const table of ['swap_transactions', 'samurai_points']) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?wallet_address=eq.${wallet}&select=*&order=created_at.desc&limit=10`
  const response = await fetch(url, { headers })
  console.log(table, response.status, JSON.stringify(await response.json()))
}
