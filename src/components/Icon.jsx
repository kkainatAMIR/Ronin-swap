import React from 'react'

const paths = {
  arrowRight: <><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></>,
  arrowUpRight: <><path d="M5 19 19 5" /><path d="M8 5h11v11" /></>,
  arrowDown: <><path d="M12 4v16" /><path d="m6 14 6 6 6-6" /></>,
  wallet: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v15H6.5A2.5 2.5 0 0 1 4 16.5z" /><path d="M4 7h15" /><path d="M15 12h4" /><circle cx="15" cy="12" r=".7" fill="currentColor" stroke="none" /></>,
  menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  copy: <><rect x="9" y="9" width="10" height="10" rx="1.5" /><path d="M15 9V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H9" /></>,
  external: <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M19 13v4.5A1.5 1.5 0 0 1 17.5 19h-11A1.5 1.5 0 0 1 5 17.5v-11A1.5 1.5 0 0 1 6.5 5H11" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  minus: <path d="M5 12h14" />,
  flame: <path d="M12 21c4.3 0 7-2.8 7-6.6 0-3.4-2.1-5.2-4.4-7.8.1 2.1-.6 3.4-1.9 4.3.3-3.3-1.3-6.4-4-7.9.3 3.5-2.7 5.2-3.1 8.7C5.1 16 7.5 21 12 21Z" />,
  coins: <><circle cx="9" cy="9" r="4" /><path d="M13 7.5A4 4 0 1 1 8.5 13" /><path d="M9 7v4M7.5 8.5h3" /></>,
  users: <><path d="M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="10" cy="8" r="3" /><path d="M16 11a3 3 0 1 0-1.2-5.75" /><path d="M19.5 20v-1.5A3.5 3.5 0 0 0 17 15.2" /></>,
  chart: <><path d="M4 19V5" /><path d="M4 19h16" /><path d="m7 15 3-4 3 2 5-7" /><path d="M15 6h3v3" /></>,
  activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  orbit: <><circle cx="12" cy="12" r="2" /><path d="M19.4 8.2c1.2 2.4-.3 5.3-3.4 6.5-3.1 1.3-7.1.4-8.9-2-1.8-2.5-.7-5.6 2.4-6.8 3.1-1.3 7.5-.1 9.9 2.3Z" /><path d="M8.2 19.4c-2.4-1.2-3.3-4.4-2-7.5 1.3-3.1 4.2-4.6 6.6-3.4 2.5 1.3 3.6 5.1 2.3 8.2-1.2 3.1-4.2 4.4-6.9 2.7Z" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></>,
  trend: <><path d="M4 17 9 12l3 3 7-8" /><path d="M15 7h4v4" /></>,
  crown: <><path d="m4 8 3 3 5-6 5 6 3-3-2 11H6L4 8Z" /><path d="M6 16h12" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v2" /></>,
  unlock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-1.8" /><path d="M12 14v2" /></>,
  sword: <><path d="m14.5 5.5 4 4" /><path d="m4 20 6.2-6.2" /><path d="m7 17 4 4" /><path d="m5.5 4.5 14 14" /><path d="m14 4 6 6-2 2-6-6z" /></>,
  shield: <path d="M12 21s8-3.7 8-10V5l-8-3-8 3v6c0 6.3 8 10 8 10Z" />,
  trophy: <><path d="M8 21h8" /><path d="M12 17v4" /><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4v2a4 4 0 0 0 4 4" /><path d="M17 6h3v2a4 4 0 0 1-4 4" /></>,
  award: <><circle cx="12" cy="8" r="5" /><path d="m8.5 12.5-1 7 4.5-2.5 4.5 2.5-1-7" /><path d="m10 8 1.3 1.3L14 7" /></>,
  gamepad: <><path d="M7 8h10a5 5 0 0 1 4.8 6.4l-1 3.2a2.3 2.3 0 0 1-4.1.7L15 16H9l-1.7 2.3a2.3 2.3 0 0 1-4.1-.7l-1-3.2A5 5 0 0 1 7 8Z" /><path d="M7 11v4M5 13h4M17 12h.01M19 14h.01" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-4.5-4.5L7 20" /></>,
  scroll: <><path d="M8 4h10v16H8a3 3 0 0 1 0-6h10" /><path d="M8 4a3 3 0 0 0 0 6h10" /><path d="M12 7h3M12 17h3" /></>,
  mountain: <><path d="m3 19 6.5-10 3.5 5 2-3 6 8H3Z" /><path d="m9.5 9 2-3 4.5 7" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.8-3L3 10" /><path d="M3 5v5h5" /><path d="M4 13a8 8 0 0 0 14.8 3L21 14" /><path d="M21 19v-5h-5" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  swapVertical: <><path d="M8 4v16" /><path d="m4 8 4-4 4 4" /><path d="M16 20V4" /><path d="m20 16-4 4-4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  pencil: <><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14.5 6.5 3 3" /></>,
  telegram: <><path d="m21 4-3.1 16-5.2-4.2-3.1 2.9.6-4.8L21 4Z" /><path d="m10.2 13.9 7.2-6.4" /></>,
  discord: <><path d="M7.5 7.2A14.6 14.6 0 0 1 12 6.5a14.6 14.6 0 0 1 4.5.7c1.5 2.1 2.2 4.6 2 7.4a13.4 13.4 0 0 1-4.2 2.1l-1-1.3a8.2 8.2 0 0 0 2-.9M7.5 7.2a15.3 15.3 0 0 0-2 7.4 13.4 13.4 0 0 0 4.2 2.1l1-1.3a8.2 8.2 0 0 1-2-.9M9.3 12.7h.01M14.7 12.7h.01" /></>,
}

export default function Icon({ name, size = 18, strokeWidth = 1.6, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.info}
    </svg>
  )
}
