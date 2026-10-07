import { useState } from 'react'
import { validateSamuraiPromo } from '../services/samuraiPromoService'

const invalidReasonLabels = {
  INVALID_PROMO_CODE: 'This promo code is not recognized.',
  CAMPAIGN_DISABLED: 'This campaign is disabled.',
  CAMPAIGN_NOT_STARTED: 'This campaign has not started yet.',
  CAMPAIGN_EXPIRED: 'This campaign has expired.',
  CAMPAIGN_TARGET_MISMATCH: 'This campaign does not apply to this network or token pair.',
}

export default function SamuraiPromoCode({ value, onChange, chainId, inputMint, outputMint }) {
  const [validation, setValidation] = useState(null)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState('')

  const validate = async () => {
    if (!value.trim()) {
      setValidation(null)
      setError('Enter a promo code to validate it.')
      return
    }
    setValidating(true)
    setError('')
    try {
      setValidation(await validateSamuraiPromo({ promoCode: value.trim(), chainId, inputMint, outputMint }))
    } catch (validationError) {
      setValidation(null)
      setError(validationError?.message || 'Promo validation is unavailable.')
    } finally {
      setValidating(false)
    }
  }

  return (
    <div className="samurai-promo-control" style={{ display: 'grid', gap: 6, margin: '12px 0' }}>
      <label htmlFor="samurai-promo-code">Promo Code</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="samurai-promo-code"
          value={value}
          maxLength={64}
          onChange={(event) => {
            onChange(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))
            setValidation(null)
            setError('')
          }}
          placeholder="Enter promo code"
          autoComplete="off"
        />
        <button type="button" onClick={validate} disabled={validating || !inputMint || !outputMint}>
          {validating ? 'Checking…' : 'Validate'}
        </button>
      </div>
      {validation?.valid && (
        <small role="status">
          Valid{validation.campaign?.name ? `: ${validation.campaign.name}` : ''} — campaign multiplier {validation.campaign?.multiplier}×. Final eligibility is rechecked against the verified transaction.
        </small>
      )}
      {validation && !validation.valid && <small role="status">{invalidReasonLabels[validation.reason] || 'This promo does not apply.'}</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  )
}
