import { useEffect, useState } from 'react'
import { getTokenAnalytics, TOKEN_ANALYTICS_RANGES } from '../services/tokenAnalyticsService'

const ETH_WRAPPED_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ROBINHOOD_WRAPPED_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const NETWORK_NAMES = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  robinhood: 'Robinhood Chain',
}

function tokenAddress(network, token) {
  if (network === 'solana') return token?.mint || token?.address || null
  if (token?.type === 'native') {
    if (network === 'ethereum') return ETH_WRAPPED_ADDRESS
    if (network === 'robinhood') return ROBINHOOD_WRAPPED_ADDRESS
    return null
  }
  return token?.address || null
}

function formatAddress(address) {
  if (!address) return 'Market identity unavailable'
  const value = String(address)
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function formatUsd(value, maxFractionDigits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: maxFractionDigits,
  })
}

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  return formatUsd(value, Number(value) < 0.01 ? 10 : 6)
}

function formatCount(value) {
  return value == null || !Number.isFinite(Number(value))
    ? 'N/A'
    : Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatChange(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  const amount = Number(value)
  return `${amount > 0 ? '+' : ''}${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

function formatChartVolume(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function PriceChart({ points, symbol }) {
  if (!Array.isArray(points) || points.length < 2) return null
  const [selectedIndex, setSelectedIndex] = useState(points.length - 1)
  const prices = points.map((point) => point.close ?? point.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const padding = Math.max((max - min) * 0.12, Math.abs(max) * 0.001, Number.EPSILON)
  const axisMin = Math.max(0, min - padding)
  const axisMax = max + padding
  const span = axisMax - axisMin || Number.EPSILON
  const plot = { left: 78, right: 590, top: 22, bottom: 184 }
  const volumeTop = 211
  const volumeBottom = 256
  const xForIndex = (index) => plot.left + (index / (points.length - 1)) * (plot.right - plot.left)
  const yForPrice = (price) => plot.bottom - ((price - axisMin) / span) * (plot.bottom - plot.top)
  const polyline = prices.map((price, index) => `${xForIndex(index).toFixed(2)},${yForPrice(price).toFixed(2)}`).join(' ')
  const areaPath = `M ${plot.left},${plot.bottom} ${polyline.replaceAll(' ', ' L ')} L ${plot.right},${plot.bottom} Z`
  const maxVolume = Math.max(...points.map((point) => Number(point.volume) || 0), 0)
  const selectedPoint = points[Math.min(selectedIndex, points.length - 1)]
  const x = xForIndex(Math.min(selectedIndex, points.length - 1))
  const y = yForPrice(selectedPoint.close ?? selectedPoint.price)
  const positive = prices[prices.length - 1] >= prices[0]
  const priceTicks = [0, 1, 2, 3].map((index) => axisMax - (span * index) / 3)
  const firstTime = points[0].time
  const lastTime = points[points.length - 1].time
  const setIndexFromPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const viewX = ((event.clientX - rect.left) / rect.width) * 600
    const fraction = Math.max(0, Math.min(1, (viewX - plot.left) / (plot.right - plot.left)))
    setSelectedIndex(Math.round(fraction * (points.length - 1)))
  }
  const moveSelection = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -1 : 1
    setSelectedIndex((current) => Math.max(0, Math.min(points.length - 1, current + delta)))
  }

  return (
    <div className="token-analytics-chart-stage">
      <div className="token-analytics-chart-readout" aria-live="polite">
        <span>{new Date(selectedPoint.time).toLocaleString()}</span>
        <span>O <b>{formatPrice(selectedPoint.open)}</b></span>
        <span>H <b>{formatPrice(selectedPoint.high)}</b></span>
        <span>L <b>{formatPrice(selectedPoint.low)}</b></span>
        <span>C <b>{formatPrice(selectedPoint.close ?? selectedPoint.price)}</b></span>
        <span>VOL <b>{formatChartVolume(selectedPoint.volume)}</b></span>
      </div>
      <svg
        className={`token-analytics-chart${positive ? ' is-positive' : ' is-negative'}`}
        viewBox="0 0 600 280"
        role="img"
        aria-label={`${symbol} historical price and volume chart. Use left and right arrow keys to inspect data points.`}
        tabIndex={0}
        onPointerMove={setIndexFromPointer}
        onPointerDown={setIndexFromPointer}
        onKeyDown={moveSelection}
      >
        <defs>
          <linearGradient id="analytics-price-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity=".25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {priceTicks.map((tick, index) => {
          const tickY = plot.top + ((plot.bottom - plot.top) * index) / 3
          return (
            <g key={tick}>
              <line className="token-analytics-grid-line" x1={plot.left} y1={tickY} x2={plot.right} y2={tickY} />
              <text className="token-analytics-axis-label" x="0" y={tickY + 3}>{formatPrice(tick)}</text>
            </g>
          )
        })}
        {maxVolume > 0 && points.map((point, index) => {
          const volume = Number(point.volume) || 0
          const barWidth = Math.max(1, ((plot.right - plot.left) / points.length) * .66)
          const barHeight = (volume / maxVolume) * (volumeBottom - volumeTop)
          return (
            <rect
              key={`volume-${point.time}`}
              className="token-analytics-volume-bar"
              x={xForIndex(index) - barWidth / 2}
              y={volumeBottom - barHeight}
              width={barWidth}
              height={barHeight}
              rx="1"
            />
          )
        })}
        <path className="token-analytics-area" d={areaPath} />
        <polyline points={polyline} />
        <line className="token-analytics-crosshair" x1={x} y1={plot.top} x2={x} y2={volumeBottom} />
        <circle className="token-analytics-crosshair-point" cx={x} cy={y} r="4" />
        <text className="token-analytics-axis-label" x={plot.left} y="276">{new Date(firstTime).toLocaleDateString()}</text>
        <text className="token-analytics-axis-label is-end" x={plot.right} y="276">{new Date(lastTime).toLocaleDateString()}</text>
      </svg>
    </div>
  )
}

function AnalyticsWorkspace({ network, fromToken, toToken }) {
  const [activeSide, setActiveSide] = useState('from')
  const [range, setRange] = useState('1D')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const token = activeSide === 'from' ? fromToken || toToken : toToken || fromToken
  const address = tokenAddress(network, token)
  const title = token?.symbol || token?.name || 'Selected token'
  const marketSource = result?.metrics?.marketSource || null
  const change24h = result?.metrics?.change24h
  const hasDistinctTokens = Boolean(fromToken && toToken && (
    tokenAddress(network, fromToken)?.toLowerCase() !== tokenAddress(network, toToken)?.toLowerCase()
    || (!tokenAddress(network, fromToken) && !tokenAddress(network, toToken) && fromToken !== toToken)
  ))

  useEffect(() => {
    if (!address) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefreshVersion((current) => current + 1)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [address, network, range])

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setResult(null)
      setLoading(false)
      return () => { cancelled = true }
    }
    if (!address) {
      setResult({
        available: false,
        metrics: null,
        chart: [],
        chartAvailable: false,
        chartUnavailableReason: 'Market data unavailable for this token.',
      })
      setLoading(false)
      return () => { cancelled = true }
    }

    setLoading(true)
    setResult(null)
    getTokenAnalytics({ chain: network, address, range }).then((data) => {
      if (!cancelled) setResult(data)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [address, network, range, refreshVersion, token])

  return (
    <section className="token-analytics-workspace" aria-label="Token analytics">
      <header className="token-analytics-workspace-heading">
        <span>TOKEN ANALYTICS</span>
        <i aria-hidden="true" />
      </header>

      {fromToken && toToken && (
        <div className="token-analytics-tabs" role="tablist" aria-label="Select token analytics">
          <button type="button" role="tab" aria-selected={activeSide === 'from'} className={activeSide === 'from' ? 'active' : ''} onClick={() => setActiveSide('from')}>
            <span>PAY</span>{fromToken.symbol || fromToken.name || 'Token'}
          </button>
          {hasDistinctTokens && (
            <button type="button" role="tab" aria-selected={activeSide === 'to'} className={activeSide === 'to' ? 'active' : ''} onClick={() => setActiveSide('to')}>
              <span>RECEIVE</span>{toToken.symbol || toToken.name || 'Token'}
            </button>
          )}
        </div>
      )}

      {!token ? (
        <p className="token-analytics-empty">Select a token to view its market data.</p>
      ) : (
        <>
          <div className="token-analytics-price-header">
            <div className="token-analytics-token-identity">
              <h2>{title}</h2>
              <span>{NETWORK_NAMES[network]} · {formatAddress(address)}</span>
            </div>
            <div className="token-analytics-price">
              <strong>{loading ? 'Loading…' : formatPrice(result?.metrics?.priceUsd)}</strong>
              <span className={change24h == null ? 'is-unavailable' : Number(change24h) >= 0 ? 'is-positive' : 'is-negative'}>
                {loading ? '—' : `${formatChange(change24h)} 24H`}
              </span>
            </div>
          </div>

          <div className="token-analytics-chart-wrap">
            {loading ? (
              <div className="token-analytics-chart-message" role="status">Loading real market data…</div>
            ) : result?.chartAvailable ? (
              <PriceChart points={result.chart} symbol={title} />
            ) : (
              <div className="token-analytics-chart-message" role="status">
                {result?.chartUnavailableReason || 'Historical price data is unavailable for this token.'}
              </div>
            )}
          </div>

          <div className="token-analytics-range" aria-label={`${title} chart time range`}>
            {TOKEN_ANALYTICS_RANGES.map((item) => (
              <button key={item} type="button" className={range === item ? 'active' : ''} aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>
            ))}
          </div>

          <dl className="token-analytics-metrics">
            <div><dt>24H Volume</dt><dd>{loading ? 'Loading…' : formatUsd(result?.metrics?.volume24hUsd)}</dd></div>
            <div><dt>Liquidity</dt><dd>{loading ? 'Loading…' : formatUsd(result?.metrics?.liquidityUsd)}</dd></div>
            <div><dt>Market Cap</dt><dd>{loading ? 'Loading…' : formatUsd(result?.metrics?.marketCapUsd)}</dd></div>
            <div><dt>Holders</dt><dd>{loading ? 'Loading…' : formatCount(result?.metrics?.holders)}</dd></div>
          </dl>

          {!loading && !result?.available && <p className="token-analytics-unavailable" role="status">Market data unavailable for this exact token.</p>}
          {(marketSource || result?.metrics?.holdersSource || result?.chartSource) && (
            <small className="token-analytics-footnote">
              Market data via {marketSource || 'unavailable'}{result?.chartSource ? ` · chart via ${result.chartSource}` : ''}{result?.metrics?.holdersSource ? ` · holders via ${result.metrics.holdersSource}` : ''}
            </small>
          )}
        </>
      )}
    </section>
  )
}

export default function TokenAnalyticsPair({ network, fromToken, toToken }) {
  if (!fromToken && !toToken) return null
  return <AnalyticsWorkspace network={network} fromToken={fromToken} toToken={toToken} />
}
