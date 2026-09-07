import { useMemo, useState } from 'react'
import { nfts } from '../data'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, SectionHeading, Tag, Sakura, ContractStatusWarning } from '../components/Layout'

const filters = ['All', 'Samurai', 'Legendary', 'KZENG JIANG', 'Rare']

export default function NFT() {
  const [filter, setFilter] = useState('All')
  const [selected, setSelected] = useState(null)
  const filteredNfts = useMemo(() => filter === 'All' ? nfts : filter === 'KZENG JIANG' ? [] : nfts.filter((nft) => nft.category === filter || nft.rarity === filter), [filter])

  return (
    <>
      <PageHero eyebrow="NFT / 05" title="Forge your" titleAccent="samurai." text="Own a piece of the legend. Carry your honor." image="/images/nft-legend.jpg" className="nft-hero">
        <div className="page-hero-ref-actions"><ContractStatusWarning className="contract-status-warning-hero" /><Button onClick={() => document.getElementById('collection')?.scrollIntoView({ behavior: 'smooth' })} icon="image">View collection</Button><Tag tone="light">UI experience / contracts next</Tag></div>
      </PageHero>

      <section className="section contract-status-section"><div className="container"><ContractStatusWarning /><p className="contract-status-caption">The NFT collection contract is under development and is not deployed on-chain. No mint or purchase transaction can be executed on this page.</p></div></section>

      
      
      <section className="section nft-section enhanced-section" id="collection">
        <Sakura count={12} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/nft-legend.jpg')" }} />
        <div className="enhanced-ink">影絵</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row nft-heading-row"><SectionHeading eyebrow="The collection" title="Wear the story." text="Kzeng Jiang's previous work is shown below. The exclusive RONIN NFT collection is coming soon." /><div className="collection-note"><span className="note-number">06</span><span>previous works<br />on display</span></div></div>
          <ContractStatusWarning className="contract-status-warning-inset" />
          <div className="nft-toolbar"><div className="filter-tabs" role="tablist" aria-label="NFT categories">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)} role="tab" aria-selected={filter === item}>{item}</button>)}</div><span className="filter-result"><Icon name="eye" size={14} /> {filteredNfts.length} pieces on display</span></div>
          
          
          {filter === 'KZENG JIANG' ? (
          <div className="nft-artist-insert surface-card">
            <div className="nft-artist-hero">
              <div className="nft-artist-intro">
                <Eyebrow>KZENG JIANG / PREVIOUS WORK</Eyebrow>
                <h3 className="display-heading" style={{ fontSize: 'clamp(40px, 6vw, 72px)', margin: '12px 0 20px', lineHeight: 0.9 }}>
                  KZENG JIANG<br /><span style={{ color: 'var(--red)' }}>× $RONIN</span>
                </h3>
                <p className="artist-tagline">The exclusive RONIN NFT collection is coming soon.</p>
              </div>
              <div className="nft-artist-bio">
                <p>$RONIN is proud to welcome Kzeng Jiang, a Shanghai-based contemporary artist and illustrator, for an exclusive collaboration. Known for a distinctive visual language that brings together Eastern cultural heritage and contemporary art, his career spans illustration, design, and collectible art—including an acclaimed collaboration with luxury porcelain house Lladró.</p>
                <a href="https://www.instagram.com/kzengjiang" target="_blank" rel="noreferrer" className="btn btn-outline" style={{ marginTop: '16px' }}>Follow @kzengjiang <Icon name="external" size={14} /></a>
              </div>
            </div>

            <div className="nft-artist-pillars">
              <div className="artist-pillar">
                <span className="pillar-num">01</span>
                <strong>100 EXCLUSIVE PIECES</strong>
                <p>Not intended to be mass-produced. 100 pieces connecting the philosophy of the masterless Samurai with a new generation of digital ownership.</p>
              </div>
              <div className="artist-pillar">
                <span className="pillar-num">02</span>
                <strong>CANVAS TO BLOCKCHAIN</strong>
                <p>Kzeng’s work explores the intersection between tradition and modernity, giving centuries-old philosophy a new identity within Web3.</p>
              </div>
              <div className="artist-pillar">
                <span className="pillar-num">03</span>
                <strong>MORE THAN A MEME</strong>
                <p>Token → Community → Art → NFTs → Ecosystem. The Samurai may be masterless, but he does not have to walk alone.</p>
              </div>
            </div>

            <div className="nft-artist-gallery-wrap">
              <div className="gallery-header">
                <Tag tone="red">COMING SOON</Tag>
                <strong>RONIN EXCLUSIVE NFT COLLECTION</strong>
              </div>
              
              <div className="nft-artist-gallery">
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 1.58.10 AM.jpeg" alt="Kzeng Jiang previous work 1" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 01</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 3.11.28 AM (1).jpeg" alt="Kzeng Jiang previous work 2" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 02</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 3.11.28 AM.jpeg" alt="Kzeng Jiang previous work 3" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 03</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 3.11.29 AM (1).jpeg" alt="Kzeng Jiang previous work 4" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 04</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 3.11.29 AM.jpeg" alt="Kzeng Jiang previous work 5" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 05</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
                <div className="artist-work">
                  <img src="/images/WhatsApp Image 2026-08-27 at 3.11.30 AM.jpeg" alt="Kzeng Jiang previous work 6" />
                  <div className="work-caption">
                    <strong>Kzeng Jiang / Previous work 06</strong>
                    <span>Selected artwork from Kzeng Jiang's previous work.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ) : (
            <>
              <div className="nft-grid">{filteredNfts.map((nft, index) => <article className="nft-card enhanced-card" key={nft.id} onClick={() => setSelected(nft)} tabIndex="0" onKeyDown={(event) => { if (event.key === 'Enter') setSelected(nft) }}><div className="nft-image-wrap"><img src={nft.image} alt={`${nft.name}, Ronin collectible ${nft.id}`} loading={index > 1 ? 'lazy' : 'eager'} /><div className="nft-image-shade" /><span className="nft-id">#{nft.id}</span><span className="nft-view"><Icon name="arrowUpRight" size={16} /></span></div><div className="nft-card-body"><div><Eyebrow>{nft.rarity}</Eyebrow><h3>{nft.name}</h3></div><span className={`rarity-dot ${nft.rarity.toLowerCase()}`} /></div><div className="nft-card-foot"><span>Ronin archive • {nft.category}</span><span>View details <Icon name="arrowRight" size={12} /></span></div></article>)}</div>
              <div className="collection-footer"><span><i /> Collection interface only</span><p>No mint, purchase, or marketplace action is represented here.</p><Button variant="outline" icon="arrowUpRight" onClick={() => setSelected(nfts[0])}>View featured piece</Button></div>
            </>
          )}
        </div>
      </section>

      <section className="section section-cream nft-manifesto enhanced-section cream-enhanced">
        <Sakura count={10} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="container" style={{ position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: '.9fr 1.1fr', gap: '32px', alignItems: 'center' }}>
          <div className="nft-manifesto-visual"><img src="/images/nft-legend.jpg" alt="Ronin NFT visual" /></div>
          <div><div className="nft-manifesto-mark" style={{ textAlign: 'left', marginBottom: '12px' }}>影</div><Eyebrow>Beyond the image</Eyebrow><h2 className="display-heading">A visual identity<br /><span>for the road ahead.</span></h2><p>Every piece is designed to feel like an artifact from the same world: weathered, deliberate, and unmistakably Ronin. Future utility will be defined before it is promised.</p><div style={{ marginTop: '18px' }}><Button href="#rank" variant="outline" icon="arrowRight">See what you can become</Button></div></div>
        </div>
      </section>

      {selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null) }}><div className="modal nft-modal" role="dialog" aria-modal="true" aria-labelledby="nft-dialog-title"><button className="modal-close" onClick={() => setSelected(null)} aria-label="Close NFT details"><Icon name="close" size={16} /></button><div className="nft-modal-image"><img src={selected.image} alt={selected.name} /></div><div className="nft-modal-copy"><div className="modal-kicker"><span className="status-dot" /> RONIN ARCHIVE / #{selected.id}</div><h2 id="nft-dialog-title">{selected.name}</h2><Tag tone="red">{selected.rarity}</Tag><p style={{ margin: '16px 0', color: 'var(--muted)', fontSize: '12px', lineHeight: '1.6' }}>{selected.description}</p><div className="traits-grid">{selected.traits.map((trait, index) => <div key={trait}><span>0{index + 1}</span><strong>{trait}</strong></div>)}</div><div className="modal-note"><Icon name="info" size={14} /> Collection viewing only. No mint or purchase transaction is available in this phase.</div></div></div></div>}
    </>
  )
}
