import { useEffect, useState, Component } from 'react'
import { WalletProvider } from './context/WalletContext'
import { AppChrome } from './components/Layout'
import Home from './pages/Home'
import Yield from './pages/Yield'
import Burn from './pages/Burn'
import Game from './pages/Game'
import NFT from './pages/NFT'
import Rank from './pages/Rank'
import Shield from './pages/Shield'
import Tokenomics from './pages/Tokenomics'
import Transparency from './pages/Transparency'
import Swap from './pages/Swap'
import Admin from './pages/Admin'
import Profile from './pages/Profile'

const pageMap = { home: Home, yield: Yield, burn: Burn, game: Game, nft: NFT, rank: Rank, shield: Shield, tokenomics: Tokenomics, transparency: Transparency, swap: Swap, profile: Profile, admin: Admin }

class ErrorBoundary extends Component {
  constructor(props){ super(props); this.state={hasError:false, error:null} }
  static getDerivedStateFromError(error){ return {hasError:true, error} }
  componentDidCatch(err, info){ console.error('RONIN UI ERROR', err, info) }
  render(){
    if(this.state.hasError){
      return <div style={{padding:'40px', fontFamily:'monospace', background:'#fffaf3', minHeight:'100vh'}}><h2 style={{color:'#b91c1c'}}>RONIN UI crashed</h2><pre style={{whiteSpace:'pre-wrap', background:'#fff', padding:'16px', border:'1px solid #f0e0c8', borderRadius:'8px'}}>{String(this.state.error?.message || this.state.error)}\n\n{String(this.state.error?.stack || '')}</pre><button onClick={()=>{ this.setState({hasError:false, error:null}); window.location.hash='#home'; window.location.reload() }} style={{marginTop:'16px', padding:'10px 16px', background:'#b91c1c', color:'#fff', border:0, borderRadius:'6px'}}>Reload Home</button></div>
    }
    return this.props.children
  }
}

function useHashRoute() {
  const getRoute = () => {
    if (window.location.pathname === '/admin') return 'admin'
    // EXISTING BEHAVIOR (first priority): check the hash route.
    // If a valid hash route exists (#profile, #swap, etc.), use it.
    const hashRoute = window.location.hash.replace(/^#\/?/, '').split('/')[0]
    if (pageMap[hashRoute]) return hashRoute

    // NEW FALLBACK (mobile wallet-link only): If no valid hash route
    // exists (e.g. MetaMask Mobile stripped the #hash during the
    // deep-link handoff), check for ?route=<page> in the query string.
    // This is ONLY a fallback — it does NOT replace hash routing.
    // Desktop always has a #hash, so this fallback is a no-op there.
    // Mobile wallet-link deep-links carry ?route=profile in the query
    // string specifically because #hash doesn't survive the handoff.
    const routeParam = new URLSearchParams(window.location.search).get('route')
    if (routeParam && pageMap[routeParam]) return routeParam

    return 'home'
  }
  const [route, setRoute] = useState(() => getRoute())

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(getRoute())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    if (!window.location.hash) {
      // Don't force #home if we have a ?route= param (mobile wallet-link).
      // The ?route= param will be used as the fallback. Once the
      // wallet-link flow completes, clearMobileWalletLinkParams()
      // removes ?route= and the normal #home default takes over.
      const hasRouteParam = new URLSearchParams(window.location.search).get('route')
      if (!hasRouteParam) window.history.replaceState(null, '', '#home')
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  const navigate = (nextRoute) => {
    if (window.location.hash === `#${nextRoute}`) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    window.location.hash = nextRoute
  }

  return { route, navigate }
}

function RoutedApp() {
  const { route, navigate } = useHashRoute()
  const Page = pageMap[route] || Home
  return <AppChrome route={route} onNavigate={navigate}><ErrorBoundary><Page /></ErrorBoundary></AppChrome>
}

export default function App() {
  return <WalletProvider><ErrorBoundary><RoutedApp /></ErrorBoundary></WalletProvider>
}
