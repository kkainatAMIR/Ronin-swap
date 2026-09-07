import { useState } from 'react'
import { contracts } from '../data'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, SectionHeading, Tag } from '../components/Layout'

export default function Transparency() {
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')

  const copyAddress = async (contract) => {
    try {
      await navigator.clipboard.writeText(contract.value)
      setCopied(contract.label)
      setCopyError('')
      window.setTimeout(() => setCopied(''), 2200)
    } catch {
      setCopyError('Copy is unavailable in this browser. Select the value manually.')
    }
  }

  return (
    <>
      <PageHero eyebrow="Transparency / 08" title="Don't trust." titleAccent="Verify." text="Everything on-chain. Everything verifiable. If an address is not published, this interface says so." image="/images/hero-ronin.jpg" className="transparency-hero" petals={false}>
        <div className="page-hero-ref-actions"><Button href="#contracts" icon="arrowDown">Open contracts</Button><Tag tone="light">No hidden control</Tag></div>
      </PageHero>

      <section className="section contracts-section enhanced-section" id="contracts">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink">検証</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="Contract registry" title="The address is the answer." text="Official addresses will be added to this registry before launch. Placeholder states cannot be copied as live contracts by accident." /><div className="registry-badge"><span className="status-dot" /> registry<br /><strong>PUBLIC / PENDING</strong></div></div>
          <div className="contract-list surface-card enhanced-card">{contracts.map((contract, index) => <div className="contract-row" key={contract.label}><div className="contract-number">0{index + 1}</div><div className="contract-name"><strong>{contract.label.toLowerCase().includes('burn wallet') ? 'RONIN TREASURY WALLET' : contract.label}</strong><span>{contract.configured ? 'Verified deployment' : 'Address not configured'}</span></div><div className={`contract-value ${contract.configured ? '' : 'placeholder'}`}><span>{contract.value}</span>{contract.configured && <Tag tone="green">VERIFIED</Tag>}</div><button className="copy-button" onClick={() => copyAddress(contract)} aria-label={`Copy ${contract.label}`}><Icon name={copied === contract.label ? 'check' : 'copy'} size={14} />{copied === contract.label ? 'Copied' : 'Copy'}</button>{contract.explorer ? <a className="explorer-button" href={contract.configured ? contract.explorer : '#transparency'} target={contract.configured ? '_blank' : undefined} rel="noreferrer" onClick={(event) => { if (!contract.configured) event.preventDefault() }}><Icon name="external" size={14} /><span>Explorer</span></a> : <span className="explorer-button disabled"><Icon name="external" size={14} /><span>Pending</span></span>}</div>)}</div>
          {copyError && <div className="copy-error"><Icon name="info" size={14} /> {copyError}</div>}
          <div className="registry-foot"><span><i style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--red)', display: 'inline-block', marginRight: '6px' }} /> Values marked pending are not presented as live data.</span><a href="https://solscan.io" target="_blank" rel="noreferrer">Open Solana explorer <Icon name="arrowUpRight" size={12} /></a></div>
        </div>
      </section>

      <section className="section verify-section enhanced-section"><div className="enhanced-bg" style={{ backgroundImage: "url('/images/forge.jpg')" }} /><div className="verify-watermark">検証</div><div className="container verify-layout" style={{ position: 'relative', zIndex: 1 }}><div className="verify-copy"><Eyebrow>Our promise</Eyebrow><h2>Just code.<br /><em>Just truth.</em></h2><p>No master keys. No hidden control. Just code. Just truth. Just RONIN.</p><div className="verify-points"><div><Icon name="shield" size={18} /><span>Ownership stays with the holder.</span></div><div><Icon name="eye" size={18} /><span>Important changes are made in public.</span></div><div><Icon name="external" size={18} /><span>Every address can be checked independently.</span></div></div></div><div className="verify-seal"><div className="seal-ring"><span>検</span></div><small>VERIFY<br />EVERYTHING</small></div></div></section>

      <section className="section audit-section enhanced-section">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <SectionHeading eyebrow="Verification guide" title="Trust is a process." text="When the programs are live, use the public addresses above and an independent explorer to verify balances, routing, and burn events." />
          <div className="audit-grid"><article className="surface-card enhanced-card audit-card"><span className="audit-index">01</span><Icon name="search" size={18} /><h3>Find the address.</h3><p>Copy only from the official registry. Never from a private message or an unverified graphic.</p></article><article className="surface-card enhanced-card audit-card"><span className="audit-index">02</span><Icon name="eye" size={18} /><h3>Read the transaction.</h3><p>Open the explorer and inspect the program, amount, destination, and final status yourself.</p></article><article className="surface-card enhanced-card audit-card"><span className="audit-index">03</span><Icon name="check" size={18} /><h3>Keep your agency.</h3><p>No Ronin flow will claim success until a real provider and deployed contract return it.</p></article></div>
        </div>
      </section>
    </>
  )
}
