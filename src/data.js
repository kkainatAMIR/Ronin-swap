// The project's published $RONIN mint. Kept as the default so nothing breaks
// if no environment variable is configured. Set VITE_RONIN_MINT_ADDRESS to
// override it (e.g. for a different deployment) without touching source.
export const RONIN_MINT = import.meta.env.VITE_RONIN_MINT_ADDRESS || '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump'
export const RONIN_TOKEN_URL = `https://solscan.io/token/${RONIN_MINT}#holders`

export const navItems = [
  { id: 'home', label: 'Home' },
  { id: 'profile', label: 'Profile' },
  { id: 'yield', label: 'RONIN LOCK' },
  { id: 'swap', label: 'Swap' },
  { id: 'burn', label: 'Burn' },
  { id: 'game', label: 'Game' },
  { id: 'nft', label: 'NFT' },
  { id: 'shield', label: 'Shield' },
  { id: 'tokenomics', label: 'Tokenomics' },
  { id: 'transparency', label: 'Transparency' },
]

export const timeline = [
  { date: 'AUG 14', title: 'HITS $1 MILLION MARKET CAP', text: 'RONIN reaches a $1 million market cap within two days.' },
  { date: 'AUG 16–19', title: 'EXPLOSIVE GROWTH', text: 'Rapid growth, creativity, community expansion, and global onboarding accelerate the RONIN movement.' },
  { date: 'AUG 20', title: 'PEAKS NEAR $7 MILLION MC', text: 'RONIN reaches a peak of nearly $7 million in market capitalization.' },
  { date: 'AUG 25', title: 'THE ECOSYSTEM TAKES SHAPE', text: 'Development of the official RONIN website begins, bringing the broader ecosystem vision to life.' },
  { date: 'AUG 27', title: 'BUILT BEYOND THE TOKEN', text: 'Buy, Burn, NFT, Yield, and Game experiences are built into the evolving RONIN ecosystem.' },
]

export const yieldDurations = [
  { id: '30d', label: '30 DAYS', days: 30, multiplier: '1.0x' },
  { id: '90d', label: '90 DAYS', days: 90, multiplier: '1.25x' },
  { id: '180d', label: '180 DAYS', days: 180, multiplier: '1.5x' },
  { id: '1y', label: '365 DAYS', days: 365, multiplier: '2.0x' },
]

export const gameFeatures = [
  { id: 'earn', label: 'Earn Ronin', icon: 'coins', title: 'Every path leaves a mark.', text: 'Play, contribute, and collect XP across the ecosystem. Your actions become your reputation in the clan.' },
  { id: 'play', label: 'How to play', icon: 'sword', title: 'Choose your discipline.', text: 'Explore the map, take on seasonal quests, and build a record worthy of the name you carry.' },
  { id: 'leaderboard', label: 'Leaderboard', icon: 'trophy', title: 'The clan remembers.', text: 'Rise through the season rankings. The highest seats are earned in public, one challenge at a time.' },
  { id: 'achievements', label: 'Achievements', icon: 'award', title: 'Collect proof of the road.', text: 'Unlock badges for burns, holds, quests, and contributions that move the whole ecosystem forward.' },
  { id: 'gear', label: 'NFT gear', icon: 'shield', title: 'Carry your history.', text: 'Future gear drops will add visual identity and utility to the warriors who claim them.' },
  { id: 'updates', label: 'Updates', icon: 'scroll', title: 'The road is still being forged.', text: 'Season one planning is underway. Follow the clan channels for the next expedition.' },
]

export const nfts = [
  { id: '1487', name: 'The Crimson Vow', rarity: 'Legendary', category: 'Legendary', image: '/images/nft-legend.jpg', traits: ['Crimson armor', 'Moonlit oath', 'Vermilion cord'], description: 'A vow is stronger than steel. The first piece in the legendary forge.' },
  { id: '1857', name: 'Mountain Shogun', rarity: 'Epic', category: 'Samurai', image: '/images/nft-shogun.jpg', traits: ['Ivory kabuto', 'Highland mark', 'Silent command'], description: 'Made for the one who can see the whole battlefield from the ridge.' },
  { id: '2027', name: 'No-Face Ronin', rarity: 'Rare', category: 'Rare', image: '/images/nft-mask.jpg', traits: ['Oni menpo', 'Ashen silk', 'Night patrol'], description: 'A name left behind. A path that cannot be followed by anyone else.' },
  { id: '2604', name: 'Red Sash', rarity: 'Rare', category: 'Rare', image: '/images/nft-hatamoto.jpg', traits: ['Hatamoto helm', 'Red sash', 'Bamboo watch'], description: 'An understated mark of service, worn by those who guard the clan.' },
  { id: '3112', name: 'First Light', rarity: 'Epic', category: 'Samurai', image: '/images/nft-shogun.jpg', traits: ['Dawn plate', 'Temple bells', 'Gold stitch'], description: 'The sky changes first. The warrior changes with it.' },
  { id: '3381', name: 'Ash & Petal', rarity: 'Rare', category: 'Rare', image: '/images/nft-mask.jpg', traits: ['Charcoal plate', 'Sakura ash', 'Wanderer'], description: 'The softness of a petal. The resolve of a blade.' },
]

export const ranks = [
  {
    id: 'gashira', name: 'Gashira', kanji: '頭', subtitle: 'Clan head', role: 'One leader. One vision. One clan.', tone: 'vermilion', image: '/images/ranks/gashira.jpg', minBalance: null, minNfts: 5, minXp: 25000, minYield: 50000,
    holdingNote: 'Unique rank. Cannot be bought. Earned by honor. Chosen by the clan.',
    statement: 'Clan head — beyond measure. Not about how much you hold. It’s about what you build.',
    duties: [
      { title: 'Lead the clan', text: 'Set the vision, direction and standards for the entire clan.' },
      { title: 'Protect the clan', text: 'Defend the clan’s honor, treasury and all who fight under it.' },
      { title: 'Make the calls', text: 'Make the final decisions that shape the future of $RONIN.' },
      { title: 'Empower the clan', text: 'Trust your warriors, reward loyalty and build leaders for tomorrow.' },
      { title: 'Build the legacy', text: 'Create something that outlives you. A legacy for generations.' },
    ],
    unlockLabel: 'What it means',
    unlocks: [
      { title: 'One only', text: 'A unique rank reserved for the clan head.' },
      { title: 'Earned by honor', text: 'Cannot be bought; chosen by the clan.' },
      { title: 'Responsible for all', text: 'Bow to no one. Be responsible for all.' },
    ],
  },
  {
    id: 'ronin-legend', name: 'Ronin Legend', kanji: '浪', subtitle: 'The elite few', role: 'Legends are remembered forever.', tone: 'red', image: '/images/ranks/ronin-legend.jpg', minBalance: 50000000, minNfts: 3, minXp: 10000, minYield: 15000,
    holdingNote: 'The highest rank. Only the strongest earn the title.',
    statement: 'You are not just a holder. You are a LEGEND.',
    duties: [
      { title: 'Lead by example', text: 'Set the standard for the clan. Inspire through your actions, not just words.' },
      { title: 'Protect the clan', text: 'Guard the community, defend its reputation and stand against FUD, scammers and enemies.' },
      { title: 'Shape the future', text: 'Support the vision, vote with your bag, and help build the legacy of $RONIN.' },
      { title: 'Mentor & guide', text: 'Help new samurai rise through the ranks and strengthen the clan from within.' },
      { title: 'Bring honor', text: 'Represent the clan with pride. Your name carries the weight of every samurai.' },
      { title: 'Build a legacy', text: 'Create something that outlives you. Legends build, their names live forever.' },
    ],
    unlockLabel: 'What it means',
    unlocks: [
      { title: 'Backbone of $RONIN', text: 'You are the backbone of the $RONIN clan.' },
      { title: 'Shape destiny', text: 'You hold the power to shape the clan’s destiny.' },
      { title: 'Ultimate respect', text: 'You earn the ultimate respect of every samurai.' },
      { title: 'History', text: 'Your name will be remembered in $RONIN history.' },
      { title: 'Bigger legacy', text: 'Big bag. Big responsibility. Bigger legacy.' },
    ],
  },
  {
    id: 'shogun', name: 'Shogun', kanji: '将', subtitle: 'Supreme commander', role: 'Only the strongest lead armies.', tone: 'ink', image: '/images/ranks/shogun.jpg', minBalance: 25000000, minNfts: 2, minXp: 6500, minYield: 8000,
    holdingNote: 'Supreme rank. Cannot be bought. Earned by strength. Respected by all.',
    statement: 'Lead the clan. Rule the battlefield. A Shōgun doesn’t follow the path. He creates it.',
    duties: [
      { title: 'Command', text: 'Lead the clan with vision and absolute authority. Every decision shapes our future.' },
      { title: 'Protect', text: 'Defend the clan and its people. Ensure safety, security, and victory in battle.' },
      { title: 'Unite', text: 'Bring samurai together as one. Build loyalty, trust, and an unbreakable bond.' },
      { title: 'Expand', text: 'Conquer new lands. Grow $RONIN. Strengthen the clan’s influence across all realms.' },
      { title: 'Inspire', text: 'Lead by example. Your name becomes the legacy of the next generation.' },
      { title: 'Legacy', text: 'Build something that outlives you. Leave a legacy the world will never forget.' },
    ],
    unlockLabel: 'What you unlock',
    unlocks: [
      { title: 'Elite status', text: 'Respected by every samurai in the clan.' },
      { title: 'Top 1%', text: 'You are among the strongest.' },
      { title: 'Influence', text: 'Your voice shapes the clan’s path.' },
      { title: 'Rewards', text: 'More benefits. More power.' },
      { title: 'Eternal honor', text: 'Your name will live forever in $RONIN.' },
    ],
  },
  {
    id: 'daimyo', name: 'Daimyo', kanji: '大', subtitle: 'Regional lord', role: 'Respected leader. Wields real power.', tone: 'ink', image: '/images/ranks/daimyo.jpg', minBalance: 10000000, minNfts: 2, minXp: 3000, minYield: 4000,
    holdingNote: 'A Daimyō is a lord of the land. Respected by many. Loyal to the clan. Trusted to lead.',
    statement: 'Not the highest rank, but a pillar of strength. A Daimyō builds, leads and defends their domain for the clan.',
    duties: [
      { title: 'Govern', text: 'Oversee your domain and its people. Maintain order, justice and peace.' },
      { title: 'Protect', text: 'Train and lead warriors. Defend the clan and its allies in times of war.' },
      { title: 'Provide', text: 'Manage resources, collect and distribute wealth to strengthen the clan.' },
      { title: 'Alliances', text: 'Form strong alliances with other domains. Diplomacy is as powerful as the sword.' },
      { title: 'Expand', text: 'Grow your influence and territory. Bring honor and glory to the clan.' },
      { title: 'Lead by example', text: 'A true leader’s honor, wisdom and courage inspire all who serve under them.' },
    ],
    unlockLabel: 'What you unlock',
    unlocks: [
      { title: 'Respected status', text: 'Recognized as a key leader of the clan.' },
      { title: 'More influence', text: 'Your voice shapes the clan’s direction.' },
      { title: 'Exclusive access', text: 'Priority in future clan events, alpha and rewards.' },
      { title: 'Higher rewards', text: 'More benefits. More power. More $RONIN.' },
      { title: 'Path to Shōgun', text: 'Prove your loyalty and you may one day rise even higher.' },
    ],
  },
  {
    id: 'karo', name: 'Karo', kanji: '家', subtitle: 'Chief advisors', role: 'Wise. Trusted. Influential.', tone: 'ink', image: '/images/ranks/karo.jpg', minBalance: 5000000, minNfts: 1, minXp: 1500, minYield: 2000,
    holdingNote: 'A Karō guides the clan with wisdom and loyalty. Not just strength, but strategy.',
    statement: 'Karōs are the voice of reason. The thinkers. The planners. The bridge between leaders and warriors. They plan today, so the clan wins tomorrow.',
    duties: [
      { title: 'Strategize', text: 'Plan campaigns, tactics and moves that ensure the clan’s growth and protection.' },
      { title: 'Advise leaders', text: 'Counsel the Daimyō and Shōgun with honest insight and trusted advice.' },
      { title: 'Manage affairs', text: 'Oversee clan affairs, resources, and diplomacy with precision and care.' },
      { title: 'Train minds', text: 'Mentor warriors in strategy, discipline, and the way of the samurai.' },
      { title: 'Keep the clan united', text: 'Resolve conflicts, maintain harmony, and strengthen bonds within the clan.' },
      { title: 'Think long term', text: 'Make decisions that secure the legacy and future of $RONIN.' },
    ],
    unlockLabel: 'What you unlock',
    unlocks: [
      { title: 'High influence', text: 'Have a strong say in clan decisions and future direction.' },
      { title: 'Alpha access', text: 'Get early access to alpha info, announcements and opportunities.' },
      { title: 'Strategic role', text: 'Be part of the core team that shapes the clan’s moves and expansion.' },
      { title: 'Higher rewards', text: 'Greater access to rewards, perks and allocations.' },
      { title: 'Path to greater', text: 'Earn respect, build legacy and rise towards Daimyō and beyond.' },
    ],
  },
  {
    id: 'hatamoto', name: 'Hatamoto', kanji: '旗', subtitle: 'Shōgun’s direct retainers', role: 'Loyal. Skilled. Trusted.', tone: 'ink', image: '/images/ranks/hatamoto.jpg', minBalance: 2000000, minNfts: 1, minXp: 700, minYield: 1000,
    holdingNote: 'Chosen for their skill, loyalty and dedication to the clan’s cause. Earn your place. Prove yourself.',
    statement: 'Hatamoto are more than followers. They are the Shōgun’s right hand.',
    duties: [
      { title: 'Execute orders', text: 'Carry out the Shōgun’s commands with precision and efficiency.' },
      { title: 'Defend the clan', text: 'Protect the clan, our members and our vision from any threats.' },
      { title: 'Implement strategy', text: 'Turn plans into action. Coordinate raids, campaigns and community operations.' },
      { title: 'Lead by example', text: 'Show discipline, integrity and unwavering loyalty in all you do.' },
      { title: 'Support the clan', text: 'Mentor new samurai, share knowledge and strengthen the clan’s bonds.' },
      { title: 'Maintain honor', text: 'Uphold the code, protect our reputation and honor the clan.' },
    ],
    unlockLabel: 'What you unlock',
    unlocks: [
      { title: 'Influence', text: 'Have a voice in key decisions and future directions.' },
      { title: 'Early access', text: 'Get early access to alpha, updates, announcements and opportunities.' },
      { title: 'Special roles', text: 'Access to exclusive Hatamoto roles and channels.' },
      { title: 'More rewards', text: 'Higher rewards, airdrops, exclusive perks.' },
      { title: 'Respected status', text: 'Recognized as a key warrior within the Shōgunate.' },
      { title: 'Path to higher ranks', text: 'Prove loyalty and rise to Gashira, Daimyō and beyond.' },
    ],
  },
  {
    id: 'samurai', name: 'Samurai', kanji: '侍', subtitle: 'The heart of the clan', role: 'Strong alone. Unstoppable together.', tone: 'ink', image: '/images/ranks/samurai.jpg', minBalance: 500000, minNfts: 0, minXp: 250, minYield: 0,
    holdingNote: 'Earn your place. Join the ranks. Fight for the clan.',
    statement: 'Every great legacy is built by the many. As a Samurai, you are the strength of our clan.',
    duties: [
      { title: 'Defend', text: 'Protect the clan and its members. Stand against FUD, scammers and any threats.' },
      { title: 'Raid & spread', text: 'Help grow $RONIN by raiding, sharing and spreading the word far and wide.' },
      { title: 'Represent', text: 'Carry the name $RONIN with honor. Your actions reflect the clan.' },
      { title: 'Support', text: 'Support your fellow Samurai. Together we are stronger, no one fights alone.' },
      { title: 'Build the legacy', text: 'Contribute to the future. Your efforts today build the legend of tomorrow.' },
      { title: 'Stay sharp', text: 'Keep learning, stay active and always improve. A dull sword cannot protect.' },
    ],
    unlockLabel: 'What you unlock',
    unlocks: [
      { title: 'Official Samurai status', text: 'Recognized as a core member of the $RONIN clan.' },
      { title: 'Access to exclusive content', text: 'Updates, alpha, sneak peeks and announcements.' },
      { title: 'Community recognition', text: 'Earn respect and credits within the clan.' },
      { title: 'Future rewards & airdrops', text: 'Priority access to future perks and rewards.' },
      { title: 'Vote & influence', text: 'Have a say in clan decisions and the road ahead.' },
    ],
  },
  {
    id: 'ashigaru', name: 'Ashigaru', kanji: '足', subtitle: 'The foundation of the clan', role: 'Many in number. Unwavering in loyalty.', tone: 'ink', image: '/images/ranks/ashigaru.jpg', minBalance: 10000, minNfts: 0, minXp: 0, minYield: 0,
    holdingNote: 'Every step strengthens the clan. Every holder makes us stronger. Start your path. Earn your place.',
    statement: 'Ashigaru may fight in the shadow, but without them, there can be no victory.',
    duties: [
      { title: 'Follow orders', text: 'Obey your superiors without question. The clan’s strength comes from unity and discipline.' },
      { title: 'Protect the clan', text: 'Defend your clan and your brothers in every battle. Stand against all threats.' },
      { title: 'Strength in numbers', text: 'Work together. Support each other. Many small efforts create great victories.' },
      { title: 'Serve the mission', text: 'Carry out tasks, gather intelligence, and ensure the clan’s objectives are met.' },
      { title: 'Honor & loyalty', text: 'Show respect to all ranks. Loyalty to the clan and honor in every action.' },
      { title: 'Train & improve', text: 'Sharpen your skills daily. An Ashigaru who trains today becomes a leader tomorrow.' },
    ],
    unlockLabel: 'What you unlock as an Ashigaru',
    unlocks: [
      { title: 'Foundation access', text: 'Be part of the largest and most dedicated community.' },
      { title: 'Exclusive updates', text: 'Receive clan news, alpha drops and announcements.' },
      { title: 'Community rewards', text: 'Earn rewards for activity, raids and contributions.' },
      { title: 'Future benefits', text: 'Early access to future features, games and clan utilities.' },
      { title: 'Grow with the clan', text: 'As the clan grows, so does your rank, power and rewards.' },
      { title: 'Path to greatness', text: 'Prove yourself. Rise through the ranks. Become legendary.' },
    ],
  },
]

export const demoProfile = {
  balance: 2450000,
  nfts: 4,
  level: 28,
  xp: 20000,
  yieldLocked: 40000,
  yieldJoined: 'May 18, 2025',
  achievements: 12,
  seasonRank: 184,
  globalRank: 742,
  totalEarnings: 28460,
}

export const tokenomics = [
  { label: 'Liquidity', value: 50, color: '#b52b31', description: 'Used for liquidity and open ecosystem markets.' },
  { label: 'Buy & burn', value: 30, color: '#17161a', description: 'Funds dedicated buyback operations and permanent burning.' },
  { label: 'DEVELOPMENT', value: 20, color: '#c9bfb0', description: 'Supports ecosystem growth, partnerships, and sustainability.' },
]

export const contracts = [
  { label: '$RONIN contract', value: RONIN_MINT, configured: true, explorer: RONIN_TOKEN_URL },
  { label: 'RONIN burn wallet', value: '9jRsw55MwR5L8yTneLLjWNfjdThX4v687CuHo7moRUCi', configured: true, explorer: 'https://solscan.io/account/9jRsw55MwR5L8yTneLLjWNfjdThX4v687CuHo7moRUCi' },
  { label: 'Development wallet', value: 'Not published — awaiting official deployment', configured: false, explorer: 'https://solscan.io' },
  { label: 'Yield program', value: 'Coming in a future release', configured: false, explorer: '' },
  { label: 'NFT program', value: 'UI ready — contract not deployed', configured: false, explorer: '' },
  { label: 'Staking program', value: 'Coming in a future release', configured: false, explorer: '' },
]

export const formatNumber = (number) => new Intl.NumberFormat('en-US').format(number)
export const formatCompact = (number) => {
  if (number >= 1000000) return `${(number / 1000000).toFixed(number % 1000000 === 0 ? 0 : 2)}M`
  if (number >= 1000) return `${(number / 1000).toFixed(number % 1000 === 0 ? 0 : 1)}K`
  return formatNumber(number)
}

// Holding is the authoritative rank signal. NFT, XP, and yield fields remain
// visible as optional ecosystem requirements until those programs are indexed.
// A wallet below the Ashigaru threshold is shown as unranked. Gashira stays
// unavailable until its official holding threshold is supplied.
export function getCurrentRank(profile) {
  if (!profile || typeof profile.balance !== 'number') return null
  return ranks.find((rank) => typeof rank.minBalance === 'number' && profile.balance >= rank.minBalance) || null
}

export function getNextRank(profile) {
  const current = getCurrentRank(profile)
  if (!current) return ranks[ranks.length - 1]
  const index = ranks.findIndex((rank) => rank.id === current.id)
  return index > 0 ? ranks[index - 1] : null
}

export function getRankProgress(profile, nextRank) {
  if (!profile || typeof profile.balance !== 'number' || !nextRank || typeof nextRank.minBalance !== 'number') return 0
  return Math.min(100, Math.round((profile.balance / Math.max(1, nextRank.minBalance)) * 100))
}
