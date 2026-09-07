import Icon from './Icon'
import { COMING_SOON_TEXT, COMING_SOON_TITLE } from '../config/features'

// Shared COMING SOON state. Uses the existing RONIN typography, borders and
// glow language (mono kicker, display heading, red seal) so paused features
// look like part of the same interface rather than a bolted-on placeholder.
export default function ComingSoon({ text = COMING_SOON_TEXT, compact = false, className = '' }) {
  return (
    <div className={`coming-soon-block ${compact ? 'coming-soon-block-compact' : ''} ${className}`} role="status" aria-live="polite">
      <span className="coming-soon-seal" aria-hidden="true">浪</span>
      <div className="coming-soon-kicker"><span className="status-dot" /> RONIN / PAUSED</div>
      <strong className="coming-soon-title">{COMING_SOON_TITLE}</strong>
      <p className="coming-soon-text">{text}</p>
      <div className="coming-soon-note"><Icon name="shield" size={13} /><span>No wallet signature or blockchain transaction is requested while this feature is paused.</span></div>
    </div>
  )
}
