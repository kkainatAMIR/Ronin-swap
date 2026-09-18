// =====================================================================
// Extract the ronin_rewards program keypair from Solana Playground
// =====================================================================
//
// Solana Playground stores program keypairs in browser localStorage or
// IndexedDB. This snippet searches both locations for a keypair whose
// public key matches the deployed program ID:
//
//   FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU
//
// USAGE:
//
//   1. Open https://beta.solpg.io in your browser
//   2. Open your ronin_rewards workspace
//   3. Press F12 to open DevTools
//   4. Go to Console tab
//   5. Paste this ENTIRE file and press Enter
//   6. The console will print either:
//        - "✅ FOUND PROGRAM KEYPAIR" followed by the JSON array
//        - "❌ Program keypair not found"
//   7. If found, copy the JSON array (starts with [ and ends with ])
//   8. Save it to a local file called:
//        ronin-rewards-program/programs/ronin_rewards/ronin_rewards-keypair.json
//
// SECURITY:
//
//   - The keypair file is a SECRET. Anyone with it can deploy upgrades
//     to your program.
//   - NEVER commit this file to git (the .gitignore already excludes it).
//   - NEVER paste the keypair array in chat, email, or anywhere online.
//   - Save it ONLY on a machine you control.
//
// =====================================================================

(async () => {
  const TARGET = 'FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU'
  const { Keypair } = await import('@solana/web3.js')

  console.log('Searching for program keypair with pubkey:', TARGET)
  console.log('')

  // --------------------------------------------------------------
  // Helper: check if an array is a valid 64-byte Solana keypair
  // --------------------------------------------------------------
  function tryKeypair(arr, label) {
    if (!Array.isArray(arr) || arr.length !== 64) return null
    if (!arr.every(n => Number.isInteger(n) && n >= 0 && n < 256)) return null
    try {
      const kp = Keypair.fromSecretKey(new Uint8Array(arr))
      if (kp.publicKey.toBase58() === TARGET) {
        return { kp, label, arr }
      }
    } catch {}
    return null
  }

  // --------------------------------------------------------------
  // Helper: deeply search an object for a 64-byte array
  // --------------------------------------------------------------
  function walk(obj, path, found) {
    if (found) return found
    if (Array.isArray(obj)) {
      const r = tryKeypair(obj, path)
      if (r) return r
    } else if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const r = walk(obj[k], path ? `${path}.${k}` : k, found)
        if (r) return r
      }
    }
    return null
  }

  // --------------------------------------------------------------
  // Search 1: localStorage
  // --------------------------------------------------------------
  console.log('[1/2] Searching localStorage...')
  let found = null
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const v = localStorage.getItem(k)
    try {
      const parsed = JSON.parse(v)
      found = walk(parsed, `localStorage["${k}"]`, null)
      if (found) break
    } catch {}
  }

  // --------------------------------------------------------------
  // Search 2: IndexedDB
  // --------------------------------------------------------------
  if (!found) {
    console.log('[2/2] Searching IndexedDB...')
    try {
      const dbs = await indexedDB.databases()
      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbInfo.name)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
          for (const storeName of db.objectStoreNames) {
            try {
              const allRecords = await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly')
                const store = tx.objectStore(storeName)
                const req = store.getAll()
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error)
              })
              for (const rec of allRecords) {
                found = walk(rec, `IndexedDB[${dbInfo.name}/${storeName}]`, null)
                if (found) break
              }
              if (found) break
            } catch {}
          }
          db.close()
          if (found) break
        } catch {}
      }
    } catch (e) {
      console.log('IndexedDB search skipped:', e.message)
    }
  }

  // --------------------------------------------------------------
  // Result
  // --------------------------------------------------------------
  if (found) {
    console.log('')
    console.log('✅ FOUND PROGRAM KEYPAIR')
    console.log('Location:', found.label)
    console.log('Public key:', found.kp.publicKey.toBase58())
    console.log('')
    console.log('👉 COPY THE LINE BELOW — it is your program keypair:')
    console.log('=====================================================')
    console.log(JSON.stringify(found.arr))
    console.log('=====================================================')
    console.log('')
    console.log('Save it to a local file called:')
    console.log('  ronin-rewards-program/programs/ronin_rewards/ronin_rewards-keypair.json')
    console.log('')
    console.log('⚠️  This is a SECRET. Never paste it in chat, never commit to git.')
  } else {
    console.log('')
    console.log('❌ Program keypair not found in localStorage or IndexedDB.')
    console.log('')
    console.log('Possible reasons:')
    console.log('  - You opened a different Solana Playground workspace')
    console.log('  - The program was deployed from a different browser/profile')
    console.log('  - localStorage was cleared')
    console.log('')
    console.log('If you cannot recover the keypair, the deployed program ID')
    console.log('FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU cannot be reused.')
    console.log('You would need to deploy a NEW program with a NEW keypair,')
    console.log('which gets a NEW program ID.')
  }
})()
