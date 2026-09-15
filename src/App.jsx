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
    const route = window.location.hash.replace(/^#\/?/, '').split('/')[0]
    return pageMap[route] ? route : 'home'
  }
  const [route, setRoute] = useState(() => getRoute())

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(getRoute())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    if (!window.location.hash) window.history.replaceState(null, '', '#home')
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
