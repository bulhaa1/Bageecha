import { useState, useEffect, useRef, useMemo } from "react"
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  limit,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  increment,
  arrayUnion,
  arrayRemove,
  runTransaction,
} from "firebase/firestore"
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  type User,
} from "firebase/auth"
import { db, auth, googleProvider, ADMIN_EMAIL } from "./firebase"

let audioCtx: AudioContext | null = null
const getAudioCtx = () => {
  if (!audioCtx)
    audioCtx = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )()
  if (audioCtx.state === "suspended") audioCtx.resume()
  return audioCtx
}

const playTone = (
  freq: number,
  dur = 0.12,
  type: OscillatorType = "sine",
  gain = 0.18,
) => {
  try {
    const ctx = getAudioCtx()
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    g.gain.setValueAtTime(gain, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + dur)
  } catch {
    /* audio unavailable */
  }
}

const playVoteSound = () => {
  playTone(523.25, 0.07, "triangle", 0.15)
  setTimeout(() => playTone(783.99, 0.09, "triangle", 0.12), 60)
}

const playUpvoteSound = () => {
  playTone(659.25, 0.07, "sine", 0.16)
  setTimeout(() => playTone(880, 0.09, "sine", 0.14), 55)
  setTimeout(() => playTone(1318.51, 0.14, "sine", 0.1), 110)
}

const playDownvoteSound = () => {
  playTone(329.63, 0.08, "sine", 0.16)
  setTimeout(() => playTone(246.94, 0.12, "sine", 0.15), 60)
}

const encodeShare = (poll: Poll) => {
  const data = {
    question: poll.question,
    description: poll.description,
    category: poll.category,
    author: poll.author,
    options: poll.options,
    votes: poll.votes,
    upvotes: poll.upvotes,
    downvotes: poll.downvotes,
    hot: poll.hot,
    createdAt: poll.createdAt,
    durationH: poll.durationH,
  }
  const json = JSON.stringify(data)
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

const decodeShare = (s: string): Partial<Poll> | null => {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
    const json = decodeURIComponent(escape(atob(b64)))
    const data = JSON.parse(json)
    if (!data || !data.question || !Array.isArray(data.options)) return null
    return data
  } catch {
    return null
  }
}

const buildShareUrl = (poll: Poll) =>
  `${window.location.origin}${window.location.pathname}?share=${encodeShare(poll)}`

type Category = "Food" | "Transport" | "Lifestyle" | "Hot Take" | "Community" | "Sports" | "Politics" | "Tech" | "Music" | "Dating" | "Environment" | "Fashion" | "General" | "Controversial"

interface Comment {
  id: string
  text: string
  timeAgo: string
  createdAt?: number
  likes: number
  liked: boolean
  replies: Comment[]
}

interface Poll {
  id: string
  question: string
  description?: string
  category: Category
  author: string
  creatorId?: string
  options: string[]
  votes: number[]
  voted: number | null
  upvotes: number
  downvotes: number
  userVote: "up" | "down" | null
  comments: Comment[]
  timeAgo: string
  hot: boolean
  createdAt: number
  durationH?: number
  archived?: boolean
  expired?: boolean
}

type RawReply = {
  id: string
  text: string
  timeAgo: string
  createdAt?: number
  likes: number
  likedBy?: string[]
}

type RawComment = RawReply & {
  replies?: Record<string, RawReply>
}

type RawPoll = Omit<Poll, "voted" | "userVote" | "comments"> & {
  comments?: Record<string, RawComment>
}

type ProfileMap = Record<string, {
  voted: number | null
  userVote: "up" | "down" | null
}>

const MAX_OPTIONS = 7
const MIN_OPTIONS = 2
const DURATION_CHOICES = [6, 12, 24, 48] as const

const pollLifetimeMs = (d: { durationH?: number }) =>
  (d.durationH ?? 48) * 60 * 60 * 1000

const fmtTimeAgo = (createdAt: number, now: number): string => {
  const diff = Math.max(0, now - createdAt)
  if (diff < 30_000) return "just now"
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const OPTION_COLORS = [
  "var(--primary)",
  "var(--accent)",
  "var(--purple)",
  "#5eead4",
  "#fb923c",
  "#f472b6",
  "#38bdf8",
]

const AUTHOR_NAMES = [
  "raalhu_rider",
  "ehkala_latheef",
  "wave_125",
  "bodu_mas",
  "kuda_mas",
  "kokko_beybe",
  "dhigu_meeha",
  "kulajehi_gamees",
  "sai_thashi",
  "disc_mashuni",
  "muranakuri_roshi",
  "kandu_rasgefaanu",
  "baraboa_riha",
  "fandithahadhaa_sheikh",
  "mushi_mas",
  "haamundi_meeha",
  "kihineh_bro",
  "varah_sakaraai",
  "boa_fen",
  "basahaa_kujja",
  "rashuge_katheebu",
  "vaguthee_manzil",
  "billoori_villa",
  "meeru_finifenmaa",
  "bondibaiy_boss",
  "supari_bro",
  "valhoamas_master",
  "rihaakuru_dhiya",
  "moya_golaa",
  "dhon_manje",
  "ammayaai_dhen",
  "majilis_member",
  "dhivehi_ninja",
  "kulhi_riha",
  "sigma_katheebu",
  "npc_meeha",
  "phase2_resident",
  "bajiya_lover",
  "ekamaku_dho",
  "bodu_cringe",
  "dhoani_rizz",
  "boakibaa_hedhika",
  "bohkuraa_dhoani",
  "kandu_mas",
  "bis_roshi",
  "abadhu_rony",
  "ammata_sidi",
  "kanmathi_dhatha",
  "santhi_mariyanbu",
  "foolhu_dhiguhandi",
]

function pickAuthorName(): string {
  return AUTHOR_NAMES[Math.floor(Math.random() * AUTHOR_NAMES.length)]
}

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

const normalizeVotes = (d: RawPoll): number[] => {
  if (Array.isArray(d.votes)) return d.votes.map((v) => Number(v) || 0)
  if (d.votes && typeof d.votes === "object")
    return Object.values(d.votes as Record<string, unknown>).map(
      (v) => Number(v) || 0,
    )
  return (d.options ?? []).map(() => 0)
}

const toRawPoll = (poll: Poll, anonId: string): RawPoll => ({
  id: poll.id,
  question: poll.question,
  description: poll.description ?? "",
  category: poll.category,
  author: poll.author,
  creatorId: poll.creatorId ?? "",
  options: poll.options,
  votes: poll.votes,
  upvotes: poll.upvotes,
  downvotes: poll.downvotes,
  hot: poll.hot,
  createdAt: poll.createdAt,
  durationH: poll.durationH ?? 48,
  archived: poll.archived ?? false,
  timeAgo: poll.timeAgo,
  comments: Object.fromEntries(
    poll.comments.map((c) => [
      c.id,
      {
        id: c.id,
        text: c.text,
        timeAgo: c.timeAgo,
        createdAt: c.createdAt,
        likes: c.likes,
        likedBy: c.liked ? [anonId] : [],
        replies: Object.fromEntries(
          c.replies.map((r) => [
            r.id,
            {
              id: r.id,
              text: r.text,
              timeAgo: r.timeAgo,
              createdAt: r.createdAt,
              likes: r.likes,
              likedBy: r.liked ? [anonId] : [],
            },
          ]),
        ),
      },
    ]),
  ),
})

const toViewPoll = (
  d: RawPoll,
  anonId: string,
  profile: ProfileMap,
  now: number,
): Poll => {
  const options = d.options ?? []
  const baseVotes = normalizeVotes(d)
  return {
    id: d.id,
    question: d.question ?? "",
    description: d.description,
    category: CATEGORY_META[d.category] ? d.category : "General",
    author: d.author,
    creatorId: d.creatorId,
    options,
    votes: options.map((_, i) => baseVotes[i] ?? 0),
    upvotes: d.upvotes,
    downvotes: d.downvotes,
    hot: d.hot,
    createdAt: d.createdAt,
    durationH: d.durationH ?? 48,
    timeAgo: d.timeAgo,
    archived: d.archived ?? false,
    expired: d.archived || Date.now() - d.createdAt > pollLifetimeMs(d),
    voted: profile[d.id]?.voted ?? null,
    userVote: profile[d.id]?.userVote ?? null,
    comments: Object.values(d.comments ?? {}).map((c) => ({
      id: c.id,
      text: c.text,
      timeAgo: c.createdAt
        ? fmtTimeAgo(c.createdAt, now)
        : fmtTimeAgo(d.createdAt, now),
      createdAt: c.createdAt,
      likes: c.likes,
      liked: (c.likedBy ?? []).includes(anonId),
      replies: Object.values(c.replies ?? {}).map((r) => ({
        id: r.id,
        text: r.text,
        timeAgo: r.createdAt
          ? fmtTimeAgo(r.createdAt, now)
          : fmtTimeAgo(d.createdAt, now),
        createdAt: r.createdAt,
        likes: r.likes,
        liked: (r.likedBy ?? []).includes(anonId),
        replies: [],
      })),
    })),
  }
}

const CTA_PHRASES = [
  "Ask the island something 🌿",
  "What are the islanders thinking? 🤔",
  "Drop a question into the lagoon 🌊",
  "Put the island to a vote 🗳️",
  "Start a fresh debate 🔥",
  "Your question, their take ✨",
  "Poll the whole atoll 🏝️",
  "Ask away, dhariyaa! 🐠",
  "Got a hot take? Spill it ☕",
  "Test the waters with a poll 🏄",
]

const CATEGORY_META: Record<Category, {
  bg: string
  text: string
  border: string
  emoji: string
}> = {
  Food: { bg: "#ff2d7820", text: "#ff6b9d", border: "#ff2d7835", emoji: "🍛" },
  Transport: {
    bg: "#00e5ff18",
    text: "#00e5ff",
    border: "#00e5ff30",
    emoji: "🚢",
  },
  Lifestyle: {
    bg: "#ffe03320",
    text: "#ffe033",
    border: "#ffe03335",
    emoji: "✨",
  },
  "Hot Take": {
    bg: "#ff2d7820",
    text: "#ff2d78",
    border: "#ff2d7840",
    emoji: "🔥",
  },
  Community: {
    bg: "#b57bff20",
    text: "#b57bff",
    border: "#b57bff35",
    emoji: "🏘️",
  },
  Sports: {
    bg: "#5eead420",
    text: "#5eead4",
    border: "#5eead435",
    emoji: "⚽",
  },
  Politics: {
    bg: "#fb923c20",
    text: "#fb923c",
    border: "#fb923c35",
    emoji: "🗳️",
  },
  Tech: { bg: "#60a5fa20", text: "#60a5fa", border: "#60a5fa35", emoji: "💻" },
  Music: { bg: "#e879f920", text: "#e879f9", border: "#e879f935", emoji: "🎵" },
  Dating: {
    bg: "#f4717120",
    text: "#f47171",
    border: "#f4717135",
    emoji: "💘",
  },
  Environment: {
    bg: "#4ade8020",
    text: "#4ade80",
    border: "#4ade8035",
    emoji: "🌿",
  },
  Fashion: {
    bg: "#f9a8d420",
    text: "#f9a8d4",
    border: "#f9a8d435",
    emoji: "👗",
  },
  General: {
    bg: "#8a7fb026",
    text: "#a89bd4",
    border: "#8a7fb045",
    emoji: "🌴",
  },
  Controversial: {
    bg: "#f43f5e20",
    text: "#f43f5e",
    border: "#f43f5e35",
    emoji: "⚠️",
  },
}

const INITIAL_POLLS: Omit<Poll, "createdAt" | "votes" | "upvotes" | "downvotes" | "userVote">[] =
  [
    {
      id: "1",
      question: "Best tea spot in Hulhumalé Phase 1?",
      category: "Food",
      author: "bajiya_lover",
      options: ["Café Huraa", "Coral Corner Teahouse"],
      voted: null,
      timeAgo: "2h ago",
      hot: true,
      comments: [
        {
          id: "c1",
          text: "Huraa has the best masala chai on the island, no contest 🔥",
          timeAgo: "1h ago",
          likes: 14,
          liked: false,
          replies: [],
        },
        {
          id: "c2",
          text: "Coral Corner is underrated tbh. The view alone is worth it",
          timeAgo: "45m ago",
          likes: 6,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "2",
      question: "Should public transport run 24/7 across Malé?",
      category: "Transport",
      author: "dhon_manje",
      options: ["Yes, obviously", "Too expensive, no"],
      voted: null,
      timeAgo: "4h ago",
      hot: true,
      comments: [
        {
          id: "c3",
          text: "The last ferry at 11pm is a real problem. I missed it twice last week",
          timeAgo: "3h ago",
          likes: 23,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "3",
      question: "Is Phase 2 actually liveable yet?",
      category: "Lifestyle",
      author: "phase2_resident",
      options: ["Yeah it's great now", "Needs 2 more years"],
      voted: null,
      timeAgo: "6h ago",
      hot: false,
      comments: [],
    },
    {
      id: "4",
      question: "Roshi or bread for breakfast in 2026?",
      category: "Hot Take",
      author: "bis_roshi",
      options: ["Roshi forever 🤌", "Bread is winning"],
      voted: null,
      timeAgo: "8h ago",
      hot: false,
      comments: [
        {
          id: "c4",
          text: "Roshi with mas riha or it doesn't count",
          timeAgo: "7h ago",
          likes: 31,
          liked: false,
          replies: [],
        },
        {
          id: "c5",
          text: "My kids refuse roshi now. It's over for us 😭",
          timeAgo: "6h ago",
          likes: 19,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "5",
      question:
        "Should Friday prayers be broadcast on loudspeakers near apartments?",
      category: "Community",
      author: "rashuge_katheebu",
      options: ["Keep the tradition", "Indoor sound only"],
      voted: null,
      timeAgo: "12h ago",
      hot: false,
      comments: [
        {
          id: "c7",
          text: "It's part of our culture. I grew up with it",
          timeAgo: "10h ago",
          likes: 27,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "6",
      question: "Best futsal court in Malé for a late-night game?",
      category: "Sports",
      author: "wave_125",
      options: ["Ekuveni Indoor", "Galolhu Ground"],
      voted: null,
      timeAgo: "1d ago",
      hot: false,
      comments: [],
    },
    {
      id: "7",
      question: "Should the Maldives lower the voting age to 16?",
      category: "Politics",
      author: "majilis_member",
      options: ["Yes, let them vote", "Keep it at 18"],
      voted: null,
      timeAgo: "5h ago",
      hot: true,
      comments: [
        {
          id: "c8",
          text: "At 16 you're paying taxes if you work. You should have a say.",
          timeAgo: "4h ago",
          likes: 44,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "8",
      question: "Is local Dhivehi music dying out?",
      category: "Music",
      author: "varah_sakaraai",
      options: ["Yes and it's sad", "No, it's evolving"],
      voted: null,
      timeAgo: "9h ago",
      hot: false,
      comments: [],
    },
    {
      id: "9",
      question: "Would you date someone from a different island?",
      category: "Dating",
      author: "dhoani_rizz",
      options: ["Love is love 💕", "Family would never"],
      voted: null,
      timeAgo: "3h ago",
      hot: true,
      comments: [
        {
          id: "c9",
          text: "My parents literally moved islands for each other. Classic Maldives story.",
          timeAgo: "2h ago",
          likes: 56,
          liked: false,
          replies: [],
        },
      ],
    },
    {
      id: "10",
      question: "Should plastic bags be fully banned across all islands?",
      category: "Environment",
      author: "meeru_finifenmaa",
      options: ["Ban them now", "Need better alternatives first"],
      voted: null,
      timeAgo: "7h ago",
      hot: false,
      comments: [],
    },
    {
      id: "11",
      question: "Is the local tech scene actually growing?",
      category: "Tech",
      author: "dhivehi_ninja",
      options: ["Yes, slowly but surely", "It's all hype"],
      voted: null,
      timeAgo: "11h ago",
      hot: false,
      comments: [],
    },
    {
      id: "12",
      question: "Is the modest fashion trend here to stay?",
      category: "Fashion",
      author: "basahaa_kujja",
      options: ["Absolutely, it looks great", "It's just a phase"],
      voted: null,
      timeAgo: "2d ago",
      hot: false,
      comments: [],
    },
    {
      id: "13",
      question: "Does the island need more late-night cafés?",
      category: "General",
      author: "ehkala_latheef",
      options: ["Yes, night owls need options", "We have enough already"],
      voted: null,
      timeAgo: "3d ago",
      hot: false,
      comments: [
        {
          id: "c13",
          text: "After 9pm there's nowhere to hang out. Please.",
          timeAgo: "2d ago",
          likes: 17,
          liked: false,
          replies: [],
        },
      ],
    },
  ]

interface FilterOption {
  label: string
  value: "all" | Category
}

const ALL_FILTERS: FilterOption[] = [
  { label: "All", value: "all" },
  ...(Object.keys(CATEGORY_META) as Category[]).map((c) => ({
    label: `${CATEGORY_META[c].emoji} ${c}`,
    value: c as "all" | Category,
  })),
]

interface ThemeOption {
  id: string
  name: string
  swatch: [string, string, string]
}

const THEMES: ThemeOption[] = [
  {
    id: "neon",
    name: "Neon",
    swatch: ["#ff2d78", "#b57bff", "#00e5ff"],
  },
  {
    id: "ocean",
    name: "Ocean",
    swatch: ["#38bdf8", "#818cf8", "#22d3ee"],
  },
  {
    id: "forest",
    name: "Forest",
    swatch: ["#4ade80", "#2dd4bf", "#a3e635"],
  },
  {
    id: "sunset",
    name: "Sunset",
    swatch: ["#fb7185", "#f472b6", "#fbbf24"],
  },
  {
    id: "graphite",
    name: "Graphite",
    swatch: ["#60a5fa", "#94a3b8", "#a5b4fc"],
  },
  {
    id: "dawn",
    name: "Dawn",
    swatch: ["#e11d74", "#7c3aed", "#0891b2"],
  },
]

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return narrow
}

function IslandLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block" }}
    >
      <circle cx="12" cy="7.6" r="3.2" fill="var(--primary)" />
      <path
        d="M3 14.8c3-2.4 6-2.4 9 0s6 2.4 9 0"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M3 19.6c3-2.4 6-2.4 9 0s6 2.4 9 0"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  )
}

function RulesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9.5 11h5" />
      <path d="M9.5 15h5" />
    </svg>
  )
}

function KeyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <circle cx="8" cy="16" r="3.5" />
      <path d="M10.7 13.3 20 4" />
      <path d="M17.5 6.5l2 2" />
      <path d="M14.5 9.5l2 2" />
    </svg>
  )
}

function PersonIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <circle cx="12" cy="7.5" r="3.4" />
      <path d="M4.5 20.5c1.4-3.8 3.9-5.5 7.5-5.5s6.1 1.7 7.5 5.5" />
    </svg>
  )
}

function ArchiveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M4 7.5h16v3.5H4z" />
      <path d="M4 11h16v9H4z" />
      <path d="M10 14.5h4" />
    </svg>
  )
}

function ThemePicker({
  theme,
  onChange,
  compact,
}: {
  theme: string
  onChange: (t: string) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [open])

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        title="Color theme"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 9,
          padding: compact ? "0 10px" : "0 14px",
          height: compact ? 34 : 36,
          color: "var(--text-dim)",
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 1,
          fontFamily: "Satoshi, sans-serif",
          cursor: "pointer",
          transition: "all 0.15s",
        }}
      >
        <span style={{ display: "inline-flex", gap: 2 }}>
          {(THEMES.find((t) => t.id === theme)?.swatch ?? THEMES[0].swatch).map(
            (c, i) => (
              <span
                key={i}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: c,
                  display: "inline-block",
                }}
              />
            ),
          )}
        </span>
        {!compact && <span>Theme</span>}
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            zIndex: 61,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: 8,
            width: 170,
            boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          }}
        >
          {THEMES.map((t) => {
            const active = theme === t.id
            return (
              <button
                key={t.id}
                onClick={() => {
                  onChange(t.id)
                  setOpen(false)
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  background: active ? "var(--primary-soft-bg)" : "transparent",
                  border: active
                    ? "1px solid var(--primary-soft)"
                    : "1px solid transparent",
                  borderRadius: 9,
                  padding: "7px 10px",
                  cursor: "pointer",
                  fontFamily: "Satoshi, sans-serif",
                  textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ display: "inline-flex", gap: 2 }}>
                  {t.swatch.map((c, i) => (
                    <span
                      key={i}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: c,
                        display: "inline-block",
                      }}
                    />
                  ))}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: "var(--text)",
                  }}
                >
                  {t.name}
                </span>
                {active && (
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "var(--primary)",
                      fontSize: 12,
                    }}
                  >
                    ✓
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PollCard({
  poll,
  now,
  onVote,
  onComment,
  onLikeComment,
  onRedditVote,
  onReplyComment,
  onShare,
  openComments,
  compact = false,
  isAdmin = false,
  onDelete,
}: {
  poll: Poll
  now: number
  onVote: (id: string, option: number) => void
  onComment: (id: string, text: string) => void
  onLikeComment: (pollId: string, commentId: string) => void
  onRedditVote: (id: string, vote: "up" | "down") => void
  onReplyComment: (pollId: string, commentId: string, text: string) => void
  onShare: (poll: Poll) => void
  openComments: boolean
  compact?: boolean
  isAdmin?: boolean
  onDelete?: (id: string) => void
}) {
  const [showComments, setShowComments] = useState(openComments)
  const [commentText, setCommentText] = useState("")
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState("")
  const [hovering, setHovering] = useState(false)
  const [nowT, setNowT] = useState(() => Date.now())
  const [animateComments, setAnimateComments] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const meta = CATEGORY_META[poll.category] ?? CATEGORY_META.General

  useEffect(() => {
    if (!hovering) return
    const iv = setInterval(() => setNowT(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [hovering])

  useEffect(() => {
    if (showComments) {
      setAnimateComments(true)
      const t = window.setTimeout(() => setAnimateComments(false), 400)
      return () => window.clearTimeout(t)
    }
  }, [showComments])

  const remainMs = Math.max(0, poll.createdAt + pollLifetimeMs(poll) - nowT)
  const remainH = Math.floor(remainMs / 3600000)
  const remainM = Math.floor((remainMs % 3600000) / 60000)
  const remainS = Math.floor((remainMs % 60000) / 1000)

  const score = poll.upvotes - poll.downvotes

  const total = poll.votes.reduce((s, v) => s + v, 0)
  const pctOf = (i: number) =>
    total > 0
      ? Math.round((poll.votes[i] / total) * 100)
      : Math.round(100 / poll.options.length)

  const handleComment = () => {
    if (commentText.trim()) {
      onComment(poll.id, commentText.trim())
      setCommentText("")
    }
  }

  const handleReply = () => {
    if (replyTo && replyText.trim()) {
      onReplyComment(poll.id, replyTo, replyText.trim())
      setReplyText("")
      setReplyTo(null)
    }
  }

  return (
    <div
      id={`poll-card-${poll.id}`}
      className="card-hover"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        borderRadius: 20,
        overflow: "hidden",
        background:
          "linear-gradient(160deg, var(--card-top) 0%, var(--card-bottom) 100%)",
        border: `1px solid var(--border)`,
      }}
    >
      {/* Coloured top accent bar */}
      <div
        style={{
          height: 3,
          background: `linear-gradient(90deg, ${meta.text}, transparent)`,
        }}
      />

      <div style={{ padding: compact ? "12px 14px 10px" : "16px 18px 14px" }}>
        {/* Tags row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 11,
            flexWrap: "wrap",
          }}
        >
          <span
            className="tag-pill"
            style={{
              background: meta.bg,
              color: meta.text,
              padding: "3px 10px",
              borderRadius: 99,
              border: `1px solid ${meta.border}`,
            }}
          >
            {meta.emoji} {poll.category}
          </span>
          {poll.hot && (
            <span
              className="tag-pill"
              style={{
                background: "var(--primary-soft-bg)",
                color: "var(--primary)",
                padding: "3px 10px",
                borderRadius: 99,
                border: "1px solid var(--primary-soft)",
              }}
            >
              🔥 Trending
            </span>
          )}
          {poll.expired && (
            <span
              className="tag-pill"
              style={{
                background: "var(--accent-soft-bg)",
                color: "var(--accent)",
                padding: "3px 10px",
                borderRadius: 99,
                border: "1px solid var(--accent-soft)",
              }}
            >
              🏁 Closed
            </span>
          )}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--text-muted)",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <span style={{ fontSize: 11, opacity: 0.85 }}>👤</span>
            {poll.author}
          </span>
          {hovering && !poll.expired && (
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--primary)",
                fontSize: 11,
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              ⏳ {remainH}h {remainM}m {remainS}s
            </span>
          )}
          <span
            style={{
              marginLeft: hovering && !poll.expired ? 0 : "auto",
              color: "var(--text-faint)",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {fmtTimeAgo(poll.createdAt, now)}
          </span>
        </div>

        {/* Question */}
        <p
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: compact ? 16 : 19,
            fontWeight: 700,
            color: "var(--text)",
            margin: "0 0 14px",
            lineHeight: 1.35,
          }}
        >
          {poll.question}
        </p>

        {poll.description && !compact && (
          <p
            style={{
              margin: "-6px 0 14px",
              color: "var(--text-dim)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {poll.description}
          </p>
        )}

        {/* Vote options */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {poll.expired && (
            <p
              style={{
                margin: "0 0 2px",
                color: "var(--accent)",
                fontSize: 12,
                fontWeight: 800,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              🏁 This poll closed after {poll.durationH ?? 48}h — voting is
              done.
            </p>
          )}
          {poll.options.map((label, i) => {
            const pct = pctOf(i)
            const isVoted = poll.voted === i
            const didVote = poll.voted !== null
            const barColor = OPTION_COLORS[i % OPTION_COLORS.length]
            const votedGlow =
              barColor === "var(--primary)"
                ? "var(--primary-glow)"
                : barColor === "var(--accent)"
                  ? "var(--accent-glow)"
                  : `${barColor}55`
            const barBg =
              barColor === "var(--primary)"
                ? "var(--vote-bar-a)"
                : barColor === "var(--accent)"
                  ? "var(--vote-bar-b)"
                  : `${barColor}22`

            return (
              <button
                key={i}
                onClick={() => !didVote && !poll.expired && onVote(poll.id, i)}
                style={{
                  position: "relative",
                  width: "100%",
                  padding: compact ? "8px 10px" : "11px 14px",
                  borderRadius: 11,
                  border: isVoted
                    ? `2px solid ${barColor}`
                    : `2px solid var(--border-strong)`,
                  background: "var(--bg)",
                  cursor: didVote || poll.expired ? "default" : "pointer",
                  overflow: "hidden",
                  textAlign: "left",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                  boxShadow: isVoted ? `0 0 14px ${votedGlow}` : "none",
                  opacity: poll.expired ? 0.65 : 1,
                }}
              >
                <div
                  className="vote-bar"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    height: "100%",
                    width: `${pct}%`,
                    background: barBg,
                  }}
                />
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "Satoshi, sans-serif",
                      fontSize: compact ? 12 : 14,
                      fontWeight: isVoted ? 800 : 600,
                      color: isVoted
                        ? barColor
                        : didVote
                          ? "var(--text-faint-3)"
                          : "var(--text-bright)",
                      transition: "color 0.2s",
                    }}
                  >
                    {label}
                  </span>
                  <span
                    style={{
                      fontFamily: "Satoshi, sans-serif",
                      fontSize: compact ? 13 : 15,
                      fontWeight: 900,
                      color: barColor,
                      opacity: isVoted ? 1 : 0.45,
                      transition: "opacity 0.2s",
                    }}
                  >
                    {pct}%
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {showResults && poll.expired && (
          <div
            className="results-pop"
            style={{
              padding: compact ? "2px 14px 12px" : "4px 18px 14px",
            }}
          >
            <PollResults poll={poll} compact={compact} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: compact ? "8px 14px" : "10px 18px",
          borderTop: "1px solid var(--surface-2)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 99,
            padding: "2px 8px",
          }}
        >
          <button
            onClick={() => onRedditVote(poll.id, "up")}
            title="Upvote"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px 4px",
              color:
                poll.userVote === "up" ? "var(--primary)" : "var(--text-faint)",
              fontSize: 14,
              lineHeight: 1,
              transition: "color 0.15s, transform 0.1s",
            }}
          >
            ▲
          </button>
          <span
            className="number-tick"
            style={{
              fontFamily: "Satoshi, sans-serif",
              fontSize: 13,
              fontWeight: 900,
              color:
                score > 0
                  ? "var(--primary)"
                  : score < 0
                    ? "var(--accent)"
                    : "var(--text-dim)",
              minWidth: 20,
              textAlign: "center",
            }}
          >
            {score}
          </span>
          <button
            onClick={() => onRedditVote(poll.id, "down")}
            title="Downvote"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px 4px",
              color:
                poll.userVote === "down"
                  ? "var(--accent)"
                  : "var(--text-faint)",
              fontSize: 14,
              lineHeight: 1,
              transition: "color 0.15s, transform 0.1s",
            }}
          >
            ▼
          </button>
        </div>
        <span
          style={{ color: "var(--text-faint)", fontSize: 12, fontWeight: 700 }}
        >
          {poll.expired
            ? "🏁 Closed · ended"
            : `${total.toLocaleString()} votes`}
        </span>
        <button
          onClick={() => setShowComments(!showComments)}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: showComments ? "var(--purple)" : "var(--text-muted)",
            fontSize: 12,
            fontWeight: 800,
            fontFamily: "Satoshi, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 0",
            transition: "color 0.15s",
          }}
        >
          💬{" "}
          {poll.comments.length > 0
            ? `${poll.comments.length} comment${
                poll.comments.length !== 1 ? "s" : ""
              }`
            : "comment"}
        </button>
        <button
          onClick={() => onShare(poll)}
          title="Share this poll"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-faint)",
            fontSize: 12,
            fontWeight: 800,
            fontFamily: "Satoshi, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 0",
            transition: "color 0.15s",
          }}
        >
          🔗 Share
        </button>
        <button
          onClick={() => poll.expired && setShowResults(!showResults)}
          disabled={!poll.expired}
          title={
            poll.expired
              ? showResults
                ? "Hide results"
                : "Show final results"
              : `Results unlock in ${remainH}h ${remainM}m`
          }
          style={{
            background: "none",
            border: "none",
            cursor: poll.expired ? "pointer" : "default",
            color: showResults
              ? "var(--primary)"
              : poll.expired
                ? "var(--text-muted)"
                : "var(--text-faint)",
            fontSize: 12,
            fontWeight: 800,
            fontFamily: "Satoshi, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 0",
            opacity: poll.expired ? 1 : 0.7,
            transition: "color 0.15s",
          }}
        >
          {poll.expired ? "📊 Results" : "🔒 Results"}
        </button>
        {isAdmin && onDelete && (
          <button
            onClick={() => onDelete(poll.id)}
            title="Delete this poll for everyone"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--accent)",
              fontSize: 12,
              fontWeight: 800,
              fontFamily: "Satoshi, sans-serif",
              padding: "2px 0",
              transition: "color 0.15s",
            }}
          >
            🗑️ Delete
          </button>
        )}
      </div>

      {/* Comments */}
      {showComments && (
        <div
          style={{
            borderTop: "1px solid var(--surface-2)",
            padding: compact ? "10px 14px" : "14px 18px",
            background: "var(--bg-deep)",
          }}
        >
          {poll.comments.map((c) => (
            <div
              key={c.id}
              className={animateComments ? "comment-enter" : ""}
              style={{
                marginBottom: 8,
                padding: "9px 12px",
                borderRadius: 10,
                background: "var(--card-bottom)",
                border: "1px solid var(--border)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "var(--text-comment)",
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              >
                {c.text}
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 5,
                }}
              >
                <span
                  style={{
                    color: "var(--text-faint)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {c.timeAgo}
                </span>
                <button
                  onClick={() => onLikeComment(poll.id, c.id)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: c.liked ? "var(--primary)" : "var(--text-faint)",
                    fontSize: 11,
                    fontFamily: "Satoshi, sans-serif",
                    fontWeight: 700,
                    padding: 0,
                    transition: "color 0.15s",
                  }}
                >
                  ♥ {c.likes}
                </button>
                <button
                  onClick={() => {
                    setReplyTo(replyTo === c.id ? null : c.id)
                    setReplyText("")
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color:
                      replyTo === c.id ? "var(--purple)" : "var(--text-faint)",
                    fontSize: 11,
                    fontFamily: "Satoshi, sans-serif",
                    fontWeight: 700,
                    padding: 0,
                    transition: "color 0.15s",
                  }}
                >
                  ↩ reply
                </button>
              </div>

              {replyTo === c.id && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 8,
                    paddingLeft: 10,
                    borderLeft: "2px solid var(--purple)",
                  }}
                >
                  <input
                    autoFocus
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleReply()}
                    placeholder="Reply..."
                    maxLength={140}
                    style={{
                      flex: 1,
                      background: "var(--card-bottom)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "7px 10px",
                      color: "var(--text)",
                      fontSize: 12,
                      fontFamily: "Satoshi, sans-serif",
                      outline: "none",
                    }}
                  />
                  <button
                    onClick={handleReply}
                    disabled={!replyText.trim()}
                    style={{
                      background: replyText.trim()
                        ? "var(--gradient)"
                        : "var(--surface-2)",
                      border: "none",
                      borderRadius: 8,
                      padding: "7px 12px",
                      color: replyText.trim() ? "#fff" : "var(--text-faint)",
                      fontWeight: 800,
                      fontFamily: "Satoshi, sans-serif",
                      fontSize: 11,
                      cursor: replyText.trim() ? "pointer" : "default",
                      transition: "all 0.2s",
                    }}
                  >
                    Reply
                  </button>
                </div>
              )}

              {c.replies.length > 0 && (
                <div
                  style={{
                    marginLeft: 10,
                    marginTop: 8,
                    paddingLeft: 10,
                    borderLeft: "2px solid var(--border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {c.replies.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 8,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <p
                        style={{
                          margin: 0,
                          color: "var(--text-muted)",
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        {r.text}
                      </p>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginTop: 4,
                        }}
                      >
                        <span
                          style={{
                            color: "var(--text-faint)",
                            fontSize: 10,
                            fontWeight: 600,
                          }}
                        >
                          {r.timeAgo}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div
            style={{
              display: "flex",
              gap: 7,
              marginTop: poll.comments.length ? 8 : 0,
            }}
          >
            <input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleComment()}
              placeholder="Drop an anonymous take..."
              maxLength={140}
              style={{
                flex: 1,
                background: "var(--card-bottom)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                padding: "8px 12px",
                color: "var(--text)",
                fontSize: 13,
                fontFamily: "Satoshi, sans-serif",
                outline: "none",
              }}
            />
            <button
              onClick={handleComment}
              disabled={!commentText.trim()}
              style={{
                background: commentText.trim()
                  ? "var(--gradient)"
                  : "var(--surface-2)",
                border: "none",
                borderRadius: 9,
                padding: "8px 14px",
                color: commentText.trim() ? "#fff" : "var(--text-faint)",
                fontWeight: 800,
                fontFamily: "Satoshi, sans-serif",
                fontSize: 12,
                cursor: commentText.trim() ? "pointer" : "default",
                transition: "all 0.2s",
              }}
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SharedPollView({
  poll,
  onHome,
  onVote,
  onComment,
}: {
  poll: Poll
  onHome: () => void
  onVote: (option: number) => void
  onComment: () => void
}) {
  const [voted, setVoted] = useState(poll.voted)
  const [votes, setVotes] = useState<number[]>(() =>
    poll.options.map((_, i) => poll.votes[i] ?? 0),
  )
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(iv)
  }, [])

  const meta = CATEGORY_META[poll.category] ?? CATEGORY_META.General
  const total = votes.reduce((s, v) => s + v, 0)
  const pctOf = (i: number) =>
    total > 0
      ? Math.round((votes[i] / total) * 100)
      : Math.round(100 / votes.length)

  const castVote = (i: number) => {
    if (voted !== null) return
    setVotes((prev) => {
      const next = [...prev]
      next[i] += 1
      return next
    })
    setVoted(i)
    onVote(i)
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Minimal header: clickable brand → homepage */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--bg-92)",
          backdropFilter: "blur(18px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            maxWidth: 620,
            margin: "0 auto",
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <button
            onClick={onHome}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            title="Back to homepage"
          >
            <span
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 24,
                fontWeight: 900,
                color: "var(--text)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Bageecha
            </span>
            <IslandLogo size={17} />
          </button>
          <button
            onClick={onHome}
            style={{
              marginLeft: "auto",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 99,
              padding: "6px 13px",
              color: "var(--text-dim)",
              fontFamily: "Satoshi, sans-serif",
              fontWeight: 800,
              fontSize: 12,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            ← Explore more
          </button>
        </div>
      </header>

      <main
        style={{
          maxWidth: 620,
          margin: "0 auto",
          width: "100%",
          padding: "24px 16px 60px",
        }}
      >
        <div
          style={{
            borderRadius: 20,
            overflow: "hidden",
            background:
              "linear-gradient(160deg, var(--card-top) 0%, var(--card-bottom) 100%)",
            border: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              height: 3,
              background: `linear-gradient(90deg, ${meta.text}, transparent)`,
            }}
          />
          <div style={{ padding: "16px 18px 14px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 11,
                flexWrap: "wrap",
              }}
            >
              <span
                className="tag-pill"
                style={{
                  background: meta.bg,
                  color: meta.text,
                  padding: "3px 10px",
                  borderRadius: 99,
                  border: `1px solid ${meta.border}`,
                }}
              >
                {meta.emoji} {poll.category}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                <span style={{ fontSize: 11, opacity: 0.85 }}>👤</span>
                {poll.author}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  color: "var(--text-faint)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {fmtTimeAgo(poll.createdAt, now)}
              </span>
            </div>

            <p
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 20,
                fontWeight: 700,
                color: "var(--text)",
                margin: "0 0 14px",
                lineHeight: 1.35,
              }}
            >
              {poll.question}
            </p>

            {poll.description && (
              <p
                style={{
                  margin: "-6px 0 14px",
                  color: "var(--text-dim)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {poll.description}
              </p>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {votes.map((_, i) => {
                const pct = pctOf(i)
                const isVoted = voted === i
                const didVote = voted !== null
                const barColor = OPTION_COLORS[i % OPTION_COLORS.length]
                const votedGlow =
                  barColor === "var(--primary)"
                    ? "var(--primary-glow)"
                    : barColor === "var(--accent)"
                      ? "var(--accent-glow)"
                      : `${barColor}55`
                const barBg =
                  barColor === "var(--primary)"
                    ? "var(--vote-bar-a)"
                    : barColor === "var(--accent)"
                      ? "var(--vote-bar-b)"
                      : `${barColor}22`

                return (
                  <button
                    key={i}
                    onClick={() => castVote(i)}
                    style={{
                      position: "relative",
                      width: "100%",
                      padding: "13px 16px",
                      borderRadius: 11,
                      border: isVoted
                        ? `2px solid ${barColor}`
                        : `2px solid var(--border-strong)`,
                      background: "var(--bg)",
                      cursor: didVote ? "default" : "pointer",
                      overflow: "hidden",
                      textAlign: "left",
                      transition: "border-color 0.2s, box-shadow 0.2s",
                      boxShadow: isVoted ? `0 0 14px ${votedGlow}` : "none",
                    }}
                  >
                    {didVote && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: `${pct}%`,
                          background: barBg,
                          transition: "width 0.6s ease",
                        }}
                      />
                    )}
                    <div
                      style={{
                        position: "relative",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "Satoshi, sans-serif",
                          fontSize: 14,
                          fontWeight: isVoted ? 800 : 600,
                          color: isVoted
                            ? barColor
                            : didVote
                              ? "var(--text-faint-3)"
                              : "var(--text-bright)",
                          transition: "color 0.2s",
                        }}
                      >
                        {poll.options[i]}
                      </span>
                      {didVote ? (
                        <span
                          className="number-tick"
                          style={{
                            fontFamily: "Satoshi, sans-serif",
                            fontSize: 18,
                            fontWeight: 900,
                            color: barColor,
                            opacity: isVoted ? 1 : 0.3,
                          }}
                        >
                          {pct}%
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-faint)",
                            fontWeight: 700,
                          }}
                        >
                          tap →
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid var(--surface-2)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  color: "var(--text-faint)",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {voted !== null
                  ? "Thanks for voting! 💛"
                  : `${total.toLocaleString()} votes`}
              </span>
              <button
                onClick={onComment}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--purple)",
                  fontSize: 12,
                  fontWeight: 800,
                  fontFamily: "Satoshi, sans-serif",
                  padding: "2px 0",
                }}
              >
                💬 comment on this
              </button>
            </div>
          </div>
        </div>

        <p
          style={{
            textAlign: "center",
            color: "var(--text-faint)",
            fontSize: 11,
            fontWeight: 600,
            marginTop: 18,
          }}
        >
          Shared via Bageecha · tap Bageecha to explore more polls
        </p>
      </main>
    </div>
  )
}

function useCountUp(target: number, duration = 900, start = true): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!start) return
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration)
      const eased = 1 - Math.pow(1 - k, 3)
      setValue(Math.round(target * eased))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [start, target, duration])
  return value
}

function ResultRow({
  color,
  label,
  votes,
  pct,
  crowned,
}: {
  color: string
  label: string
  votes: number
  pct: number
  crowned: boolean
}) {
  const n = useCountUp(votes)
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 10,
        background: crowned ? "var(--primary-soft-bg)" : "var(--surface)",
        border: crowned
          ? "1px solid var(--primary-soft)"
          : "1px solid var(--border)",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-muted)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--text)",
          fontSize: 12,
          fontWeight: 900,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {n.toLocaleString()}
      </span>
      <span
        style={{
          color: color,
          fontSize: 12,
          fontWeight: 900,
          minWidth: 44,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {pct}%
      </span>
      {crowned && <span title="Winner">👑</span>}
    </div>
  )
}

function PollResults({
  poll,
  compact = false,
}: {
  poll: Poll
  compact?: boolean
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const total = poll.votes.reduce((s, v) => s + v, 0)
  const max = total > 0 ? Math.max(...poll.votes) : 0
  const winners = poll.votes
    .map((v, i) => (v === max && v > 0 ? i : -1))
    .filter((i) => i >= 0)
  const centerTotal = useCountUp(total)

  const R = 40
  const C = 2 * Math.PI * R
  let acc = 0
  const segments = poll.votes.map((v, i) => {
    const frac = total > 0 ? v / total : 0
    const len = Math.max(0.001, frac * C - 1.5)
    const seg = {
      i,
      len,
      offset: acc * C,
      frac,
      color: OPTION_COLORS[i % OPTION_COLORS.length],
    }
    acc += frac
    return seg
  })

  const pctOf = (i: number) =>
    total > 0
      ? Math.round((poll.votes[i] / total) * 100)
      : Math.round(100 / poll.options.length)
  const winPct = winners.length === 1 ? pctOf(winners[0]) : 0

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-faint)",
          }}
        >
          🏁 Final results
        </span>
        {winners.length === 1 ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 900,
              color: OPTION_COLORS[winners[0] % OPTION_COLORS.length],
            }}
          >
            {poll.options[winners[0]]} won with {winPct}% 👑
          </span>
        ) : winners.length > 1 ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 900,
              color: "var(--text-dim)",
            }}
          >
            🤝 It's a tie!
          </span>
        ) : (
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: "var(--text-faint)",
            }}
          >
            No votes cast
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flexShrink: 0 }}>
          <svg
            viewBox="0 0 100 100"
            width={compact ? 150 : 170}
            height={compact ? 150 : 170}
            style={{ transform: "rotate(-90deg)", display: "block" }}
          >
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--surface-2)"
              strokeWidth={13}
            />
            {segments.map((s) => (
              <circle
                key={s.i}
                className={
                  s.len > 0.001 && winners.includes(s.i)
                    ? "donut-winner"
                    : "donut-seg"
                }
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth={13}
                strokeDasharray={`${mounted ? s.len : 0} ${C}`}
                strokeDashoffset={-s.offset}
                style={{ transitionDelay: `${s.i * 0.12}s` }}
              />
            ))}
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              gap: 1,
            }}
          >
            {total > 0 && (
              <span style={{ fontSize: 16, lineHeight: 1 }}>
                {winners.length > 1 ? "🤝" : "👑"}
              </span>
            )}
            <span
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: compact ? 22 : 26,
                fontWeight: 900,
                color: "var(--text)",
                lineHeight: 1.1,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {centerTotal.toLocaleString()}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                color: "var(--text-faint)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {total === 1 ? "vote" : "votes"}
            </span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 200,
            display: "grid",
            gridTemplateColumns: compact ? "1fr" : "1fr 1fr",
            gap: 7,
          }}
        >
          {poll.options.map((label, i) => (
            <ResultRow
              key={i}
              color={OPTION_COLORS[i % OPTION_COLORS.length]}
              label={label}
              votes={poll.votes[i] ?? 0}
              pct={pctOf(i)}
              crowned={winners.includes(i)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ArchiveTable({
  polls,
  onDelete,
}: {
  polls: Poll[]
  onDelete?: (p: Poll) => void
}) {
  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })

  if (polls.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 0",
          color: "var(--text-faint)",
        }}
      >
        <p style={{ fontSize: 36, margin: "0 0 8px" }}>🗃️</p>
        <p
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: 18,
            fontWeight: 700,
            margin: "0 0 4px",
            color: "var(--text-dim)",
          }}
        >
          No archived polls yet
        </p>
        <p style={{ fontSize: 13, margin: 0, fontWeight: 600 }}>
          Closed polls will show up here for the admin.
        </p>
      </div>
    )
  }

  const totalVotes = polls.reduce(
    (s, p) => s + p.votes.reduce((a, v) => a + v, 0),
    0,
  )
  const top = [...polls].sort(
    (a, b) =>
      b.votes.reduce((s, v) => s + v, 0) - a.votes.reduce((s, v) => s + v, 0),
  )[0]
  const topVotes = top.votes.reduce((s, v) => s + v, 0)

  const chip = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 99,
    padding: "6px 13px",
    fontSize: 12,
    fontWeight: 800,
    color: "var(--text-dim)",
  } as const

  const th = {
    padding: "9px 12px",
    textAlign: "left",
    whiteSpace: "nowrap",
    fontWeight: 800,
    letterSpacing: "0.07em",
    color: "var(--text-faint)",
    fontSize: 10,
    textTransform: "uppercase",
  } as const

  const td = {
    padding: "10px 12px",
    whiteSpace: "nowrap",
    color: "var(--text-dim)",
    fontWeight: 700,
    fontSize: 12.5,
  } as const

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <span style={chip}>🗃️ {polls.length} archived</span>
        <span style={chip}>🗳️ {totalVotes} votes cast</span>
        <span style={chip}>
          🏆{" "}
          <span
            style={{
              maxWidth: 240,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {top.question} — {topVotes} vote{topVotes !== 1 ? "s" : ""}
          </span>
        </span>
      </div>

      <div
        style={{
          overflowX: "auto",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--surface)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Closed</th>
              <th style={th}>Question</th>
              <th style={th}>Category</th>
              <th style={th}>Duration</th>
              <th style={th}>Votes</th>
              <th style={th}>▲/▼</th>
              <th style={th}>💬</th>
              <th style={th}>Author</th>
              {onDelete && <th style={th} />}
            </tr>
          </thead>
          <tbody>
            {polls.map((p) => {
              const votes = p.votes.reduce((s, v) => s + v, 0)
              const meta = CATEGORY_META[p.category]
              return (
                <tr
                  key={p.id}
                  style={{
                    borderTop: "1px solid var(--border)",
                    background: "transparent",
                  }}
                >
                  <td style={td}>{fmtDate(p.createdAt + pollLifetimeMs(p))}</td>
                  <td style={{ ...td, maxWidth: 300 }}>
                    <span
                      style={{
                        display: "block",
                        fontWeight: 800,
                        color: "var(--text)",
                        maxWidth: 300,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {p.question}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "var(--text-faint)",
                        fontWeight: 600,
                      }}
                    >
                      created {fmtDate(p.createdAt)}
                    </span>
                  </td>
                  <td style={td}>
                    {meta ? `${meta.emoji} ${p.category}` : p.category}
                  </td>
                  <td style={td}>{p.durationH ?? 48}h</td>
                  <td
                    style={{
                      ...td,
                      color: "var(--primary)",
                      fontWeight: 900,
                    }}
                  >
                    {votes}
                  </td>
                  <td style={td}>
                    <span style={{ color: "var(--primary)" }}>
                      ▲ {p.upvotes}
                    </span>{" "}
                    <span style={{ color: "var(--accent)" }}>
                      ▼ {p.downvotes}
                    </span>
                  </td>
                  <td style={td}>{p.comments.length}</td>
                  <td style={td}>{p.author}</td>
                  {onDelete && (
                    <td style={{ ...td, textAlign: "right" }}>
                      <button
                        onClick={() => onDelete(p)}
                        title="Delete this poll"
                        style={{
                          background: "none",
                          border: "none",
                          padding: "4px 6px",
                          cursor: "pointer",
                          fontSize: 13,
                          color: "var(--text-faint)",
                          transition: "all 0.15s",
                        }}
                      >
                        🗑️
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function WelcomeModal({ onClose }: { onClose: () => void }) {
  const sections = [
    {
      emoji: "🏝️",
      title: "What is Bageecha?",
      body: "Bageecha gives Maldivians a private space to share hot takes and vote on local topics anonymously.",
    },
    {
      emoji: "🔒",
      title: "Your privacy",
      body: "Everything is anonymous. Nobody can see who you are, how you voted, and your choices stay private to you. We don't collect any personal information.",
    },
    {
      emoji: "⏰",
      title: "What to expect",
      body: "Polls close automatically after 6–48 hours (the poll creator picks the limit) and are archived. Vote, comment, upvote, and share any poll.",
    },
    {
      emoji: "📜",
      title: "The rules",
      body: "Be kind. Keep it clean. No spam or repeated polls. Admin can remove anything that breaks these rules.",
    },
  ]
  return (
    <div
      className="modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,3,15,0.9)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 110,
        padding: 16,
      }}
    >
      <div
        className="modal-panel"
        style={{
          background:
            "linear-gradient(160deg, var(--surface-2), var(--card-bottom))",
          border: "1px solid var(--border)",
          borderRadius: 24,
          padding: 24,
          width: "100%",
          maxWidth: 420,
          maxHeight: "min(82vh, 640px)",
          overflowY: "auto",
          boxShadow: "0 -24px 60px var(--purple-glow)",
        }}
      >
        <h2
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: 22,
            fontWeight: 900,
            color: "var(--text)",
            margin: "0 0 4px",
          }}
        >
          Welcome to Bageecha 🏝️
        </h2>
        <p
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: "var(--text-faint)",
            margin: "0 0 16px",
          }}
        >
          A quick intro before you dive in —
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {sections.map((s) => (
            <div key={s.title}>
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 900,
                  color: "var(--text)",
                  margin: "0 0 3px",
                }}
              >
                {s.emoji} {s.title}
              </p>
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: 1.5,
                  color: "var(--text-dim)",
                  margin: 0,
                }}
              >
                {s.body}
              </p>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            width: "100%",
            background: "var(--gradient-cta)",
            border: "none",
            borderRadius: 12,
            padding: "12px 0",
            color: "#fff",
            fontFamily: "Satoshi, sans-serif",
            fontWeight: 900,
            fontSize: 14,
            cursor: "pointer",
            boxShadow: "0 4px 22px var(--primary-glow-strong)",
          }}
        >
          Got it, let me in 🌴
        </button>
      </div>
    </div>
  )
}

function RulesModal({ onClose }: { onClose: () => void }) {
  const rules = [
    "Be kind — no hate, harassment, or personal attacks.",
    "Keep it clean — family-friendly content only.",
    "No spam, ads, or repeated polls.",
    "No illegal or dangerous content.",
    "🔒 Privacy: votes are anonymous and your choices stay private to you — nobody can see how you voted.",
    "🗳️ One vote per poll, forever — vote carefully, you can't change it.",
    "Admin can remove polls that break these rules.",
    "⏰ Polls close 6–48 hours after being posted (you choose the limit) — closed polls are archived.",
  ]
  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,3,15,0.88)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        className="modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          background:
            "linear-gradient(160deg, var(--surface-2), var(--card-bottom))",
          border: "1px solid var(--border)",
          borderRadius: 24,
          padding: 24,
          width: "100%",
          maxWidth: 420,
          maxHeight: "min(82vh, 640px)",
          overflowY: "auto",
          boxShadow: "0 -24px 60px var(--purple-glow)",
        }}
      >
        <h2
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: 21,
            fontWeight: 900,
            color: "var(--text)",
            margin: "0 0 14px",
          }}
        >
          Rules of the Island 🌴
        </h2>
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {rules.map((rule, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-dim)",
                lineHeight: 1.5,
              }}
            >
              <span
                style={{
                  color: "var(--primary)",
                  fontWeight: 900,
                  flexShrink: 0,
                }}
              >
                {i + 1}.
              </span>
              <span>{rule}</span>
            </li>
          ))}
        </ul>
        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            width: "100%",
            background: "var(--gradient-cta)",
            border: "none",
            borderRadius: 12,
            padding: "11px 0",
            color: "#fff",
            fontFamily: "Satoshi, sans-serif",
            fontWeight: 900,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Got it 👍
        </button>
      </div>
    </div>
  )
}

function NewPollModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (
    p: Omit<Poll, "id" | "votes" | "voted" | "comments" | "timeAgo" | "hot" | "createdAt" | "upvotes" | "downvotes" | "userVote">,
  ) => void
}) {
  const [question, setQuestion] = useState("")
  const [description, setDescription] = useState("")
  const [author, setAuthor] = useState(
    () => localStorage.getItem("bageecha-author") || pickAuthorName(),
  )
  const [options, setOptions] = useState<string[]>(["", ""])
  const [category, setCategory] = useState<Category>("Community")
  const [durationH, setDurationH] = useState(24)

  const filledOptions = options.map((o) => o.trim()).filter((o) => o !== "")
  const valid =
    question.trim() !== "" &&
    author.trim() !== "" &&
    filledOptions.length >= MIN_OPTIONS

  const updateOption = (i: number, value: string) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)))

  const addOption = () => {
    if (options.length < MAX_OPTIONS) setOptions((prev) => [...prev, ""])
  }

  const removeOption = (i: number) => {
    if (options.length > MIN_OPTIONS)
      setOptions((prev) => prev.filter((_, idx) => idx !== i))
  }

  const shuffleName = () => setAuthor(pickAuthorName())

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,3,15,0.88)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        className="modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          background:
            "linear-gradient(160deg, var(--surface-2), var(--card-bottom))",
          border: "1px solid var(--border)",
          borderRadius: 24,
          padding: 24,
          width: "100%",
          maxWidth: 500,
          maxHeight: "min(85vh, 700px)",
          overflowY: "auto",
          marginBottom: 8,
          boxShadow: "0 -24px 60px var(--purple-glow)",
        }}
      >
        <h2
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: 22,
            fontWeight: 900,
            color: "var(--text)",
            margin: "0 0 18px",
          }}
        >
          Start a Poll 🌱
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "var(--text-dim)",
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 5,
              }}
            >
              Your name
            </label>
            <div style={{ display: "flex", gap: 7 }}>
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Pick a name..."
                maxLength={30}
                style={{
                  flex: 1,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  padding: "8px 11px",
                  color: "var(--text)",
                  fontSize: 13,
                  fontFamily: "Satoshi, sans-serif",
                  outline: "none",
                }}
              />
              <button
                onClick={shuffleName}
                title="Random name"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  padding: "0 12px",
                  color: "var(--text-dim)",
                  fontFamily: "Satoshi, sans-serif",
                  fontWeight: 800,
                  fontSize: 13,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                🎲
              </button>
            </div>
          </div>

          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "var(--text-dim)",
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 5,
              }}
            >
              Question
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask the island something..."
              maxLength={120}
              rows={2}
              style={{
                width: "100%",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 11,
                padding: "10px 13px",
                color: "var(--text)",
                fontSize: 14,
                fontFamily: "Satoshi, sans-serif",
                outline: "none",
                resize: "none",
              }}
            />
          </div>

          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "var(--text-dim)",
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 5,
              }}
            >
              Description{" "}
              <span
                style={{
                  color: "var(--text-faint)",
                  fontWeight: 600,
                  textTransform: "none",
                }}
              >
                (optional)
              </span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a bit of context..."
              maxLength={280}
              rows={2}
              style={{
                width: "100%",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 11,
                padding: "10px 13px",
                color: "var(--text)",
                fontSize: 14,
                fontFamily: "Satoshi, sans-serif",
                outline: "none",
                resize: "none",
              }}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                options.length === MIN_OPTIONS ? "1fr 1fr" : "1fr",
              gap: 9,
            }}
          >
            {options.map((opt, i) => {
              const color = OPTION_COLORS[i % OPTION_COLORS.length]
              return (
                <div
                  key={i}
                  style={{ display: "flex", gap: 7, alignItems: "flex-end" }}
                >
                  <div style={{ flex: 1 }}>
                    <label
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color,
                        letterSpacing: "0.09em",
                        textTransform: "uppercase",
                        display: "block",
                        marginBottom: 5,
                      }}
                    >
                      Option {i + 1}
                    </label>
                    <input
                      value={opt}
                      onChange={(e) => updateOption(i, e.target.value)}
                      placeholder={
                        i === 0
                          ? "First option"
                          : i === 1
                            ? "Second option"
                            : `Extra option ${i + 1}`
                      }
                      maxLength={50}
                      style={{
                        width: "100%",
                        background: "var(--bg)",
                        border: `2px solid ${
                          color === "var(--primary)"
                            ? "var(--primary-soft)"
                            : color === "var(--accent)"
                              ? "var(--accent-soft)"
                              : `${color}44`
                        }`,
                        borderRadius: 9,
                        padding: "8px 11px",
                        color: "var(--text)",
                        fontSize: 13,
                        fontFamily: "Satoshi, sans-serif",
                        outline: "none",
                      }}
                    />
                  </div>
                  {options.length > MIN_OPTIONS && (
                    <button
                      onClick={() => removeOption(i)}
                      title="Remove option"
                      style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 9,
                        padding: "8px 10px",
                        color: "var(--text-faint)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 12,
                        cursor: "pointer",
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {options.length < MAX_OPTIONS && (
            <button
              onClick={addOption}
              style={{
                alignSelf: "flex-start",
                background: "var(--surface-2)",
                border: "1px dashed var(--border)",
                borderRadius: 9,
                padding: "7px 14px",
                color: "var(--text-dim)",
                fontFamily: "Satoshi, sans-serif",
                fontWeight: 800,
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              + Add option ({options.length}/{MAX_OPTIONS})
            </button>
          )}

          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "var(--text-dim)",
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 7,
              }}
            >
              Category
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
                const m = CATEGORY_META[cat]
                const active = category === cat
                return (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    className="tag-pill"
                    style={{
                      background: active ? m.bg : "transparent",
                      color: active ? m.text : "var(--text-faint)",
                      padding: "4px 11px",
                      borderRadius: 99,
                      border: active
                        ? `1px solid ${m.border}`
                        : "1px solid var(--border)",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {m.emoji} {cat}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "var(--text-dim)",
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 7,
              }}
            >
              Time limit{" "}
              <span
                style={{
                  color: "var(--text-faint)",
                  fontWeight: 600,
                  textTransform: "none",
                }}
              >
                (archives automatically after)
              </span>
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {DURATION_CHOICES.map((h) => {
                const active = durationH === h
                return (
                  <button
                    key={h}
                    onClick={() => setDurationH(h)}
                    style={{
                      background: active
                        ? "var(--gradient)"
                        : "var(--surface-2)",
                      color: active ? "#fff" : "var(--text-dim)",
                      border: active ? "none" : "1px solid var(--border)",
                      borderRadius: 99,
                      padding: "6px 14px",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 12.5,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {h}h
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 9, marginTop: 2 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "11px",
                color: "var(--text-dim)",
                fontFamily: "Satoshi, sans-serif",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (valid) {
                  localStorage.setItem("bageecha-author", author.trim())
                  onSubmit({
                    question: question.trim(),
                    description: description.trim() || undefined,
                    author: author.trim(),
                    options: filledOptions,
                    category,
                    durationH,
                  })
                  onClose()
                }
              }}
              disabled={!valid}
              style={{
                flex: 2,
                background: valid ? "var(--gradient)" : "var(--surface-2)",
                border: "none",
                borderRadius: 12,
                padding: "11px",
                color: valid ? "#fff" : "var(--text-faint)",
                fontFamily: "Satoshi, sans-serif",
                fontWeight: 900,
                fontSize: 14,
                cursor: valid ? "pointer" : "default",
                transition: "all 0.2s",
                boxShadow: valid ? "0 4px 20px var(--primary-glow)" : "none",
              }}
            >
              Post Poll
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const isNarrow = useIsNarrow()
  const [anonId] = useState(() => {
    let id = localStorage.getItem("bageecha-anon-id")
    if (!id) {
      id = `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      localStorage.setItem("bageecha-anon-id", id)
    }
    return id
  })
  const [rawPolls, setRawPolls] = useState<RawPoll[]>([])
  const [archiveRawPolls, setArchiveRawPolls] = useState<RawPoll[]>([])
  const [profile, setProfile] = useState<ProfileMap>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("bageecha-profile") || "{}",
      ) as ProfileMap
    } catch {
      return {}
    }
  })
  const [loading, setLoading] = useState(true)
  const [dbError, setDbError] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Poll | null>(null)
  const [adminDeniedName, setAdminDeniedName] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [openCommentsId, setOpenCommentsId] = useState<string | null>(null)
  const [showMine, setShowMine] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [sharedPoll, setSharedPoll] = useState<Poll | null>(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("share")
    if (!code) return null
    const data = decodeShare(code)
    if (!data) return null
    return {
      id: `shared_${Date.now()}`,
      question: data.question ?? "Untitled poll",
      description: data.description,
      category:
        data.category && CATEGORY_META[data.category]
          ? data.category
          : "General",
      author: data.author ?? "Anonymous",
      options: data.options ?? [],
      votes: data.votes ?? (data.options ?? []).map(() => 0),
      voted: null,
      upvotes: data.upvotes ?? 0,
      downvotes: data.downvotes ?? 0,
      userVote: null,
      comments: [],
      timeAgo: "shared just now",
      hot: data.hot ?? false,
      createdAt: data.createdAt ?? Date.now(),
      durationH: data.durationH ?? 48,
    }
  })
  const [filter, setFilter] = useState<"all" | Category>("all")
  const [filterOpen, setFilterOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [searchPh, setSearchPh] = useState("Ask the island something…")
  const [searchActive, setSearchActive] = useState(false)
  const searchRef = useRef(search)
  searchRef.current = search
  const searchFocusedRef = useRef(false)
  const searchQRef = useRef<string[]>([])
  const [sort, setSort] =
    useState<"trending" | "popular" | "newest" | "mostVoted">("popular")
  const [view, setView] = useState<"list" | "grid">("list")
  const [liveCount, setLiveCount] = useState(1)
  const [theme, setTheme] = useState(
    () => localStorage.getItem("bageecha-theme") || "graphite",
  )
  const [ctaIndex, setCtaIndex] = useState(() =>
    Math.floor(Math.random() * CTA_PHRASES.length),
  )
  const [toast, setToast] = useState<string | null>(null)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const chromeRef = useRef<HTMLDivElement>(null)
  const chromeH = useRef(0)
  const isAdmin = user?.email === ADMIN_EMAIL
  const archiveView = isAdmin && showArchive
  const toastTimer = useRef(0)
  const showToast = (msg: string, ms = 2200) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }
  const polls = useMemo(
    () => rawPolls.map((d) => toViewPoll(d, anonId, profile, now)),
    [rawPolls, profile, anonId, now],
  )
  const archivePolls = useMemo(
    () => archiveRawPolls.map((d) => toViewPoll(d, anonId, profile, now)),
    [archiveRawPolls, profile, anonId, now],
  )

  const patchRaw = (id: string, fn: (p: RawPoll) => RawPoll) =>
    setRawPolls((prev) => prev.map((p) => (p.id === id ? fn(p) : p)))

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)
    localStorage.setItem("bageecha-theme", theme)
  }, [theme])

  useEffect(() => {
    if (!openCommentsId) return
    const t = window.setTimeout(() => {
      const el = document.getElementById(`poll-card-${openCommentsId}`)
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 120)
    return () => window.clearTimeout(t)
  }, [openCommentsId])

  useEffect(() => {
    const interval = setInterval(() => {
      setCtaIndex((prev) => (prev + 1) % CTA_PHRASES.length)
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const qs = [
      ...new Set(
        polls
          .filter((p) => !p.expired && p.question.trim())
          .map((p) => p.question.trim()),
      ),
    ].slice(0, 6)
    const key = qs.join("|")
    if (searchQRef.current.join("|") !== key) {
      searchQRef.current = qs
      setSearchPh(qs[0] ?? "Ask the island something…")
    }
  }, [polls])

  useEffect(() => {
    const interval = setInterval(() => {
      if (searchFocusedRef.current || searchRef.current) return
      const qs = searchQRef.current
      if (qs.length === 0) return
      setSearchPh((prev) => {
        const i = qs.indexOf(prev)
        return qs[(i + 1) % qs.length]
      })
    }, 3500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!filterOpen) return
    const close = () => setFilterOpen(false)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [filterOpen])

  useEffect(() => {
    localStorage.setItem("bageecha-profile", JSON.stringify(profile))
  }, [profile])

  useEffect(() => {
    const saved = localStorage.getItem("bageecha-my-polls")
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as Poll[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        parsed.forEach((p) =>
          setDoc(doc(db, "polls", p.id), toRawPoll(p, anonId)).catch((err) =>
            console.error("Migration write failed", err),
          ),
        )
      }
    } catch {
      /* ignore corrupt storage */
    }
    localStorage.removeItem("bageecha-my-polls")
  }, [anonId])

  useEffect(() => {
    const q = query(
      collection(db, "polls"),
      orderBy("createdAt", "desc"),
      limit(60),
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLoading(false)
        setDbError(false)
        const docs = snap.docs.map((d) => d.data() as RawPoll)
        if (docs.length > 0) {
          setRawPolls(docs)
          return
        }
        // Empty collection: seed the starter polls (idempotent setDoc by fixed id).
        const batch = writeBatch(db)
        INITIAL_POLLS.forEach((p, i) => {
          const raw: RawPoll = {
            id: p.id,
            question: p.question,
            description: p.description ?? "",
            category: p.category,
            author: p.author,
            creatorId: p.creatorId,
            options: p.options,
            votes: p.options.map(() => 0),
            upvotes: 0,
            downvotes: 0,
            hot: p.hot,
            createdAt: Date.now() - i * 60 * 60 * 1000,
            durationH: p.durationH ?? 48,
            archived: p.archived ?? false,
            timeAgo: p.timeAgo,
            comments: Object.fromEntries(
              (p.comments ?? []).map((c) => [
                c.id,
                {
                  id: c.id,
                  text: c.text,
                  timeAgo: c.timeAgo,
                  likes: c.likes,
                  likedBy: [],
                  replies: Object.fromEntries(
                    c.replies.map((r) => [
                      r.id,
                      {
                        id: r.id,
                        text: r.text,
                        timeAgo: r.timeAgo,
                        likes: r.likes,
                        likedBy: [],
                      },
                    ]),
                  ),
                },
              ]),
            ),
          }
          batch.set(doc(db, "polls", p.id), raw)
        })
        batch.commit().catch((err) => console.error("Seeding failed", err))
      },
      (err) => {
        setLoading(false)
        setDbError(true)
        console.error("Firestore sync failed", err)
      },
    )
    return () => unsub()
  }, [])

  // Admin-only: full collection for the archive view. Subscribes only while
  // signed in as admin so visitors never download the whole database.
  useEffect(() => {
    if (!isAdmin) return
    const q = query(collection(db, "polls"))
    const unsub = onSnapshot(
      q,
      (snap) => {
        setArchiveRawPolls(snap.docs.map((d) => d.data() as RawPoll))
      },
      (err) => console.error("Archive sync failed", err),
    )
    return () => unsub()
  }, [isAdmin])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u))
    return () => unsub()
  }, [])

  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (!result) return
        if (result.user.email !== ADMIN_EMAIL) {
          setAdminDeniedName(
            result.user.displayName ?? result.user.email ?? "friend",
          )
          signOut(auth).catch(() => {})
        }
      })
      .catch((err) => {
        if (
          err.code !== "auth/redirect-cancelled-by-user" &&
          err.code !== "auth/popup-closed-by-user"
        ) {
          console.error("Redirect sign-in result failed", err)
          showToast(`Sign-in failed (${err.code ?? "error"})`, 4000)
        }
      })
  }, [])

  useEffect(() => {
    if (localStorage.getItem("bageecha-welcomed")) return
    setWelcomeOpen(true)
  }, [])

  useEffect(() => {
    const measure = () => {
      if (chromeRef.current) chromeH.current = chromeRef.current.offsetHeight
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [view, isNarrow])

  // Lock page scroll while a modal/overlay is open so wheel and touch input
  // stay inside the dialog instead of scrolling the feed behind it.
  useEffect(() => {
    const overlayOpen =
      showModal ||
      showRules ||
      welcomeOpen ||
      confirmDelete !== null ||
      adminDeniedName !== null
    if (!overlayOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [showModal, showRules, welcomeOpen, confirmDelete, adminDeniedName])

  // Scroll-driven collapse of the header + filter bar. Starts animating only
  // while the user is scrolling and stops as soon as it settles, so it does
  // no work (and no jank) while the page is idle.
  useEffect(() => {
    const chrome = chromeRef.current
    if (!chrome) return

    chrome.style.transform = "translate3d(0, 0, 0)"

    let current = 0
    let target = 0
    let raf = 0

    const render = () => {
      raf = 0
      current += (target - current) * 0.28
      if (Math.abs(target - current) < 0.4) current = target

      chrome.style.transform = `translate3d(0, ${-current}px, 0)`

      if (Math.abs(target - current) >= 0.4) {
        raf = requestAnimationFrame(render)
      }
    }

    const onScroll = () => {
      target = Math.max(0, Math.min(window.scrollY, chromeH.current || 1))
      if (!raf) raf = requestAnimationFrame(render)
    }

    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    const pick = () => setLiveCount(Math.floor(Math.random() * 50) + 1)
    pick()
    const timer = window.setInterval(pick, 20000)
    return () => window.clearInterval(timer)
  }, [])

  const handleVote = (id: string, option: number) => {
    if (profile[id]?.voted !== undefined && profile[id]?.voted !== null) return
    const raw = rawPolls.find((p) => p.id === id)
    if (raw && Date.now() - raw.createdAt > pollLifetimeMs(raw)) return
    playVoteSound()
    setProfile((prev) => ({ ...prev, [id]: { ...prev[id], voted: option } }))
    const current = rawPolls.find((p) => p.id === id)
    const base = current ? normalizeVotes(current) : []
    const votes = base.length
      ? [...base]
      : (current?.options ?? []).map(() => 0)
    votes[option] = (votes[option] ?? 0) + 1
    patchRaw(id, (p) => ({ ...p, votes }))
    runTransaction(db, async (tx) => {
      const ref = doc(db, "polls", id)
      const snap = await tx.get(ref)
      if (!snap.exists()) return
      const cur = normalizeVotes(snap.data() as RawPoll)
      cur[option] = (cur[option] ?? 0) + 1
      tx.update(ref, { votes: cur })
    }).catch((err) => console.error("Vote write failed", err))
  }

  const handleComment = (pollId: string, text: string) => {
    const cid = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    const comment: RawComment = {
      id: cid,
      text,
      timeAgo: "just now",
      createdAt: Date.now(),
      likes: 0,
      likedBy: [],
      replies: {},
    }
    patchRaw(pollId, (p) => ({
      ...p,
      comments: { ...p.comments, [cid]: comment },
    }))
    updateDoc(doc(db, "polls", pollId), { [`comments.${cid}`]: comment }).catch(
      (err) => console.error("Comment write failed", err),
    )
  }

  const handleReplyComment = (
    pollId: string,
    commentId: string,
    text: string,
  ) => {
    const rid = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    const reply: RawReply = {
      id: rid,
      text,
      timeAgo: "just now",
      createdAt: Date.now(),
      likes: 0,
      likedBy: [],
    }
    patchRaw(pollId, (p) => {
      const comments = { ...p.comments }
      const c = comments[commentId]
      if (!c) return p
      comments[commentId] = {
        ...c,
        replies: { ...(c.replies ?? {}), [rid]: reply },
      }
      return { ...p, comments }
    })
    updateDoc(doc(db, "polls", pollId), {
      [`comments.${commentId}.replies.${rid}`]: reply,
    }).catch((err) => console.error("Reply write failed", err))
  }

  const handleLikeComment = (pollId: string, commentId: string) => {
    const poll = rawPolls.find((p) => p.id === pollId)
    const c = poll?.comments?.[commentId]
    const liked = (c?.likedBy ?? []).includes(anonId)
    patchRaw(pollId, (p) => {
      const comments = { ...p.comments }
      const cc = comments[commentId]
      if (!cc) return p
      const likedBy = liked
        ? (cc.likedBy ?? []).filter((x) => x !== anonId)
        : [...(cc.likedBy ?? []), anonId]
      comments[commentId] = {
        ...cc,
        likes: Math.max(0, cc.likes + (liked ? -1 : 1)),
        likedBy,
      }
      return { ...p, comments }
    })
    updateDoc(doc(db, "polls", pollId), {
      [`comments.${commentId}.likes`]: increment(liked ? -1 : 1),
      [`comments.${commentId}.likedBy`]: liked
        ? arrayRemove(anonId)
        : arrayUnion(anonId),
    }).catch((err) => console.error("Comment like write failed", err))
  }

  const handleRedditVote = (id: string, vote: "up" | "down") => {
    const raw = rawPolls.find((p) => p.id === id)
    if (raw && Date.now() - raw.createdAt > pollLifetimeMs(raw)) return
    if (vote === "up") playUpvoteSound()
    else playDownvoteSound()
    const current = profile[id]?.userVote ?? null
    let upDelta = 0
    let downDelta = 0
    if (current === vote) {
      if (vote === "up") upDelta = -1
      else downDelta = -1
      setProfile((prev) => ({ ...prev, [id]: { ...prev[id], userVote: null } }))
    } else {
      if (current === "up") upDelta = -1
      if (current === "down") downDelta = -1
      if (vote === "up") upDelta += 1
      else downDelta += 1
      setProfile((prev) => ({ ...prev, [id]: { ...prev[id], userVote: vote } }))
    }
    patchRaw(id, (p) => ({
      ...p,
      upvotes: Math.max(0, p.upvotes + upDelta),
      downvotes: Math.max(0, p.downvotes + downDelta),
    }))
    const update: Record<string, unknown> = {}
    if (upDelta) update.upvotes = increment(upDelta)
    if (downDelta) update.downvotes = increment(downDelta)
    if (Object.keys(update).length > 0)
      updateDoc(doc(db, "polls", id), update).catch((err) =>
        console.error("Reddit vote write failed", err),
      )
  }

  const handleShare = (poll: Poll) => {
    const url = buildShareUrl(poll)
    if (navigator.share) {
      navigator
        .share({ title: poll.question, url })
        .then(() => showToast("🔗 Link copied!"))
        .catch(() => {})
    } else {
      const textarea = document.createElement("textarea")
      textarea.value = url
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand("copy")
      } catch {
        /* ignore */
      }
      document.body.removeChild(textarea)
      showToast("🔗 Link copied!")
    }
  }

  const handleSharedVote = (option: number) => {
    playVoteSound()
    setSharedPoll((prev) => {
      if (!prev || prev.voted !== null) return prev
      const votes = [...prev.votes]
      votes[option] += 1
      return { ...prev, votes, voted: option }
    })
  }

  const exitShared = () => {
    setSharedPoll(null)
    setOpenCommentsId(null)
    const url = new URL(window.location.href)
    url.searchParams.delete("share")
    window.history.replaceState({}, "", url.toString())
  }

  const handleSharedComment = () => {
    if (!sharedPoll) return
    const targetId = `shared_${Date.now()}`
    const feedPoll: Poll = {
      ...sharedPoll,
      id: targetId,
      userVote: null,
      voted: null,
      comments: [],
    }
    setOpenCommentsId(targetId)
    setRawPolls((prev) => [toRawPoll(feedPoll, anonId), ...prev])
    setDoc(doc(db, "polls", targetId), toRawPoll(feedPoll, anonId)).catch(
      (err) => console.error("Shared poll save failed", err),
    )
    exitShared()
  }

  const handleNewPoll = (
    data: Omit<Poll, "id" | "votes" | "voted" | "comments" | "timeAgo" | "hot" | "createdAt" | "upvotes" | "downvotes" | "userVote">,
  ) => {
    const q = data.question.trim().toLowerCase()
    if (
      rawPolls.some(
        (p) =>
          p.creatorId === anonId &&
          (p.question ?? "").trim().toLowerCase() === q,
      )
    ) {
      showToast("You already posted that one! 🌴")
      return
    }
    const newPoll: Poll = {
      ...data,
      id: `p${Date.now()}`,
      creatorId: anonId,
      votes: data.options.map(() => 0),
      voted: null,
      upvotes: 0,
      downvotes: 0,
      userVote: null,
      comments: [],
      timeAgo: "just now",
      hot: false,
      createdAt: Date.now(),
    }
    setRawPolls((prev) => [toRawPoll(newPoll, anonId), ...prev])
    setDoc(doc(db, "polls", newPoll.id), toRawPoll(newPoll, anonId)).catch(
      (err) => console.error("Post poll failed", err),
    )
  }

  const handleDeletePoll = (id: string) => {
    setConfirmDelete(null)
    setRawPolls((prev) => prev.filter((p) => p.id !== id))
    deleteDoc(doc(db, "polls", id)).catch((err) =>
      console.error("Delete poll failed", err),
    )
  }

  const handleArchivePoll = (id: string) => {
    setConfirmDelete(null)
    setRawPolls((prev) =>
      prev.map((p) => (p.id === id ? { ...p, archived: true } : p)),
    )
    updateDoc(doc(db, "polls", id), { archived: true }).catch((err) =>
      console.error("Archive poll failed", err),
    )
  }

  const handleAdminLogin = () => {
    showToast("🔑 Signing in as admin…", 3200)
    const useRedirect = isNarrow || isIOS()
    if (useRedirect) {
      signInWithRedirect(auth, googleProvider).catch((err) => {
        console.error("Sign-in redirect failed", err)
        showToast(`Sign-in failed (${err.code ?? "error"})`, 4000)
      })
      return
    }
    signInWithPopup(auth, googleProvider)
      .then((result) => {
        if (result.user.email !== ADMIN_EMAIL) {
          setAdminDeniedName(
            result.user.displayName ?? result.user.email ?? "friend",
          )
          signOut(auth).catch(() => {})
        }
      })
      .catch((err) => {
        if (err.code === "auth/popup-blocked") {
          showToast("Popup blocked — trying redirect…", 3200)
          signInWithRedirect(auth, googleProvider).catch((e) => {
            console.error("Sign-in redirect failed", e)
            showToast(`Sign-in failed (${e.code ?? "error"})`, 4000)
          })
          return
        }
        if (err.code !== "auth/popup-closed-by-user") {
          console.error("Sign-in failed", err)
          showToast(`Sign-in failed (${err.code ?? "error"})`, 4000)
        }
      })
  }

  const handleAdminLogout = () => {
    signOut(auth).catch(() => {})
  }

  const filtered = (archiveView ? archivePolls : polls).filter((p) => {
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      p.question.toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q) ?? false) ||
      p.author.toLowerCase().includes(q) ||
      p.options.some((o) => o.toLowerCase().includes(q)) ||
      p.category.toLowerCase().includes(q)
    if (archiveView) return p.expired && matchSearch
    if (p.archived) return false
    if (showMine && p.creatorId !== anonId) return false
    const matchFilter = filter === "all" || p.category === filter
    return matchFilter && matchSearch
  })

  const sorted = [...filtered].sort((a, b) => {
    if (archiveView) return b.createdAt - a.createdAt
    const votesA = a.votes.reduce((s, v) => s + v, 0)
    const votesB = b.votes.reduce((s, v) => s + v, 0)
    if (sort === "newest") return b.createdAt - a.createdAt
    if (sort === "mostVoted") return votesB - votesA
    if (sort === "popular") return b.upvotes - a.upvotes
    if (sort === "trending" && a.expired !== b.expired)
      return a.expired ? 1 : -1
    if (a.hot !== b.hot) return a.hot ? -1 : 1
    return votesB - votesA
  })

  const contentWidth = isNarrow ? "100%" : view === "grid" ? 960 : 620

  if (sharedPoll) {
    return (
      <SharedPollView
        poll={sharedPoll}
        onHome={exitShared}
        onVote={handleSharedVote}
        onComment={handleSharedComment}
      />
    )
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* Header + filter bar: one sticky chrome that collapses together */}
      <div
        ref={chromeRef}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--bg-92)",
          willChange: "transform",
        }}
      >
        <header
          style={{
            background: "var(--bg-92)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              maxWidth: contentWidth,
              margin: "0 auto",
              padding: "0 16px",
            }}
          >
            {/* Top row */}
            {isNarrow ? (
              <>
                {/* Mobile row 1: logo + primary CTA */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 0 2px",
                  }}
                >
                  <button
                    onClick={() => {
                      setSearch("")
                      setFilter("all")
                      setSort("popular")
                      setShowMine(false)
                      setShowArchive(false)
                      window.scrollTo({ top: 0, behavior: "smooth" })
                    }}
                    title="Go to homepage"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <h1
                      style={{
                        fontFamily: "Satoshi, sans-serif",
                        fontSize: 25,
                        fontWeight: 900,
                        background: "var(--gradient)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                        margin: 0,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      Bageecha
                    </h1>
                    <IslandLogo size={20} />
                  </button>
                  <button
                    onClick={() => setShowModal(true)}
                    style={{
                      marginLeft: "auto",
                      background: "var(--gradient)",
                      border: "none",
                      borderRadius: 10,
                      height: 36,
                      padding: "0 20px",
                      lineHeight: 1,
                      color: "#fff",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 900,
                      fontSize: 13.5,
                      cursor: "pointer",
                      boxShadow: "0 3px 14px var(--primary-glow)",
                    }}
                  >
                    + Poll
                  </button>
                </div>
                {/* Mobile row 2: secondary controls */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: "10px 0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      background: "var(--surface)",
                      height: 26,
                      padding: "0 10px",
                      borderRadius: 99,
                      border: "1px solid var(--border)",
                    }}
                    title="people online"
                  >
                    <span
                      className="pulse-dot"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--primary)",
                        display: "inline-block",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "var(--text-dim)",
                        lineHeight: 1,
                      }}
                    >
                      {liveCount.toLocaleString()}
                    </span>
                  </div>
                  <ThemePicker theme={theme} onChange={setTheme} compact />
                  <button
                    onClick={() => setShowRules(true)}
                    title="Rules"
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      height: 34,
                      minWidth: 34,
                      padding: "0 10px",
                      lineHeight: 1,
                      color: "var(--text-dim)",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 13,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <RulesIcon />
                  </button>
                  {isAdmin ? (
                    <button
                      onClick={handleAdminLogout}
                      title={user?.email ?? "Signed in"}
                      style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--accent-soft)",
                        borderRadius: 9,
                        height: 34,
                        minWidth: 34,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: "var(--accent)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 13,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <KeyIcon />
                    </button>
                  ) : (
                    <button
                      onClick={handleAdminLogin}
                      title="Admin sign-in"
                      style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 9,
                        height: 34,
                        minWidth: 34,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: "var(--text-dim)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 13,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <KeyIcon />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowMine(!showMine)
                      setShowArchive(false)
                      setShowModal(false)
                    }}
                    title="My polls"
                    style={{
                      background: showMine ? "var(--surface-2)" : "none",
                      border: showMine
                        ? "1px solid var(--primary-soft)"
                        : "1px solid var(--border)",
                      borderRadius: 9,
                      height: 34,
                      minWidth: 34,
                      padding: "0 10px",
                      color: showMine ? "var(--primary)" : "var(--text-dim)",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 13,
                      cursor: "pointer",
                      transition: "all 0.15s",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <PersonIcon />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => {
                        setShowArchive(!showArchive)
                        setShowMine(false)
                        setShowModal(false)
                      }}
                      title="Archive"
                      style={{
                        background: showArchive ? "var(--surface-2)" : "none",
                        border: showArchive
                          ? "1px solid var(--accent-soft)"
                          : "1px solid var(--border)",
                        borderRadius: 9,
                        height: 34,
                        minWidth: 34,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: showArchive
                          ? "var(--accent)"
                          : "var(--text-dim)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 13,
                        cursor: "pointer",
                        transition: "all 0.15s",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <ArchiveIcon />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  height: 64,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 3,
                  }}
                >
                  <button
                    onClick={() => {
                      setSearch("")
                      setFilter("all")
                      setSort("popular")
                      setShowMine(false)
                      setShowArchive(false)
                      window.scrollTo({ top: 0, behavior: "smooth" })
                    }}
                    title="Go to homepage"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <h1
                      style={{
                        fontFamily: "Satoshi, sans-serif",
                        fontSize: 24,
                        fontWeight: 900,
                        background: "var(--gradient)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                        margin: 0,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      Bageecha
                    </h1>
                    <IslandLogo size={19} />
                  </button>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 800,
                      color: "var(--text-faint)",
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      lineHeight: 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      className="pulse-dot"
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "var(--primary)",
                        display: "inline-block",
                      }}
                    />
                    {liveCount.toLocaleString()} islanders online
                  </span>
                </div>

                <div
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <ThemePicker theme={theme} onChange={setTheme} />
                  <button
                    onClick={() => setShowRules(true)}
                    title="Rules"
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      height: 36,
                      minWidth: 36,
                      padding: "0 10px",
                      lineHeight: 1,
                      color: "var(--text-dim)",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <RulesIcon size={17} />
                  </button>
                  {isAdmin ? (
                    <button
                      onClick={handleAdminLogout}
                      title={`Signed in as ${user?.email ?? ""} — click to sign out`}
                      style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--accent-soft)",
                        borderRadius: 9,
                        height: 36,
                        minWidth: 36,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: "var(--accent)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 14,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <KeyIcon size={17} />
                    </button>
                  ) : (
                    <button
                      onClick={handleAdminLogin}
                      title="Admin sign-in (Google)"
                      style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 9,
                        height: 36,
                        minWidth: 36,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: "var(--text-dim)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 14,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <KeyIcon size={17} />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowMine(!showMine)
                      setShowArchive(false)
                      setShowModal(false)
                    }}
                    title="My polls"
                    style={{
                      background: showMine ? "var(--surface-2)" : "none",
                      border: showMine
                        ? "1px solid var(--primary-soft)"
                        : "1px solid var(--border)",
                      borderRadius: 9,
                      height: 36,
                      minWidth: 36,
                      padding: "0 10px",
                      lineHeight: 1,
                      color: showMine ? "var(--primary)" : "var(--text-dim)",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: "pointer",
                      transition: "all 0.15s",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <PersonIcon size={17} />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => {
                        setShowArchive(!showArchive)
                        setShowMine(false)
                        setShowModal(false)
                      }}
                      title="Archive"
                      style={{
                        background: showArchive ? "var(--surface-2)" : "none",
                        border: showArchive
                          ? "1px solid var(--accent-soft)"
                          : "1px solid var(--border)",
                        borderRadius: 9,
                        height: 36,
                        minWidth: 36,
                        padding: "0 10px",
                        lineHeight: 1,
                        color: showArchive
                          ? "var(--accent)"
                          : "var(--text-dim)",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                        fontSize: 14,
                        cursor: "pointer",
                        transition: "all 0.15s",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <ArchiveIcon size={17} />
                    </button>
                  )}
                  <button
                    onClick={() => setShowModal(true)}
                    style={{
                      background: "var(--gradient)",
                      border: "none",
                      borderRadius: 9,
                      height: 36,
                      padding: "0 20px",
                      lineHeight: 1,
                      color: "#fff",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 900,
                      fontSize: 13.5,
                      cursor: "pointer",
                      boxShadow: "0 3px 14px var(--primary-glow)",
                    }}
                  >
                    + Poll
                  </button>
                </div>
              </div>
            )}

            {/* Cove search */}
            <div style={{ paddingTop: isNarrow ? 4 : 8, paddingBottom: 16 }}>
              <div
                style={{
                  position: "relative",
                  borderRadius: 99,
                  padding: "1.5px",
                  background:
                    "linear-gradient(120deg, var(--primary-soft) 0%, var(--accent-soft) 50%, var(--primary-soft) 100%)",
                  boxShadow: searchActive
                    ? "0 10px 36px var(--primary-glow-strong)"
                    : "0 4px 18px var(--primary-glow)",
                  transition: "box-shadow 0.25s",
                }}
              >
                <div style={{ position: "relative" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 18,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 16,
                      pointerEvents: "none",
                      opacity: 0.6,
                    }}
                  >
                    🔍
                  </span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={searchPh}
                    onFocus={() => {
                      searchFocusedRef.current = true
                      setSearchActive(true)
                    }}
                    onBlur={() => {
                      searchFocusedRef.current = false
                      setSearchActive(false)
                    }}
                    style={{
                      width: "100%",
                      background: "var(--bg-92)",
                      border: "none",
                      outline: "none",
                      borderRadius: 99,
                      padding: "14px 46px",
                      color: "var(--text)",
                      fontSize: isNarrow ? 14 : 15,
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 700,
                    }}
                  />
                  {search && (
                    <button
                      onClick={() => setSearch("")}
                      title="Clear search"
                      style={{
                        position: "absolute",
                        right: 12,
                        top: "50%",
                        transform: "translateY(-50%)",
                        background: "var(--surface-2)",
                        border: "none",
                        borderRadius: 99,
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        fontSize: 12,
                        lineHeight: 1,
                        padding: "6px 9px",
                        fontFamily: "Satoshi, sans-serif",
                        fontWeight: 800,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Filter Bar */}
        <div
          style={{
            background: "var(--bg-96)",
            borderBottom: "1px solid var(--surface-2)",
          }}
        >
          <div
            style={{
              maxWidth: contentWidth,
              margin: "0 auto",
              padding: "10px 16px 0",
            }}
          >
            {archiveView ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 900,
                    color: "var(--accent)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  🗃️ Archive
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-dim)",
                  }}
                >
                  {sorted.length} closed poll{sorted.length !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setShowArchive(false)}
                  style={{
                    marginLeft: "auto",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    padding: "6px 14px",
                    color: "var(--text-dim)",
                    fontFamily: "Satoshi, sans-serif",
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  ← Back to feed
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      color: "var(--text-faint)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    Sort by
                  </span>
                  <div
                    style={{
                      display: "flex",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      padding: 3,
                      maxWidth: isNarrow ? "100%" : "none",
                      overflowX: isNarrow ? "auto" : "visible",
                    }}
                  >
                    {([
                      { value: "trending", label: "🔥 Trending" },
                      { value: "popular", label: "⭐ Popular" },
                      { value: "newest", label: "🕒 Newest" },
                      { value: "mostVoted", label: "📊 Most Voted" },
                    ] as const).map((opt) => {
                      const active = sort === opt.value
                      return (
                        <button
                          key={opt.value}
                          onClick={() => setSort(opt.value)}
                          style={{
                            background: active
                              ? "var(--gradient)"
                              : "transparent",
                            color: active ? "#fff" : "var(--text-muted)",
                            border: "none",
                            borderRadius: 8,
                            padding: "6px 11px",
                            fontFamily: "Satoshi, sans-serif",
                            fontWeight: 800,
                            fontSize: 12,
                            cursor: "pointer",
                            transition: "all 0.15s",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setFilterOpen(!filterOpen)
                    }}
                    className="tag-pill"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      background:
                        filter !== "all" ? "var(--gradient)" : "var(--surface)",
                      color: filter !== "all" ? "#fff" : "var(--text-muted)",
                      padding: "7px 14px",
                      borderRadius: 99,
                      border:
                        filter !== "all" ? "none" : "1px solid var(--border)",
                      cursor: "pointer",
                      transition: "all 0.15s",
                      fontFamily: "Satoshi, sans-serif",
                      fontWeight: 800,
                      fontSize: 13,
                      boxShadow:
                        filter !== "all"
                          ? "0 2px 10px var(--primary-glow)"
                          : "none",
                    }}
                  >
                    <span>
                      {ALL_FILTERS.find((f) => f.value === filter)?.label ??
                        "All"}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        opacity: 0.7,
                        transform: filterOpen ? "rotate(180deg)" : "none",
                        transition: "transform 0.15s",
                      }}
                    >
                      ▼
                    </span>
                  </button>
                  {filterOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: "calc(100% + 8px)",
                        zIndex: 61,
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 14,
                        padding: 6,
                        minWidth: 190,
                        maxHeight: 320,
                        overflowY: "auto",
                        boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
                      }}
                    >
                      {ALL_FILTERS.map((f) => {
                        const active = filter === f.value
                        return (
                          <button
                            key={String(f.value)}
                            onClick={() => {
                              setFilter(f.value)
                              setFilterOpen(false)
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              background: active ? "var(--bg)" : "transparent",
                              color: active
                                ? "var(--primary)"
                                : "var(--text-dim)",
                              border: "none",
                              borderRadius: 9,
                              padding: "8px 12px",
                              fontFamily: "Satoshi, sans-serif",
                              fontWeight: 700,
                              fontSize: 13,
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            <span>{f.label}</span>
                            {active && (
                              <span
                                style={{
                                  marginLeft: "auto",
                                  color: "var(--primary)",
                                  fontSize: 12,
                                }}
                              >
                                ✓
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* View toggle */}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  {([
                    { value: "list", label: "List" },
                    { value: "grid", label: "Grid" },
                  ] as const).map((opt) => {
                    const active = view === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setView(opt.value)}
                        title={`${opt.value} view`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          background: active
                            ? "var(--gradient)"
                            : "var(--surface)",
                          color: active ? "#fff" : "var(--text-muted)",
                          border: active ? "none" : "1px solid var(--border)",
                          borderRadius: 9,
                          padding: "6px 9px",
                          fontFamily: "Satoshi, sans-serif",
                          fontWeight: 800,
                          fontSize: 12,
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        {opt.value === "list" ? "≡" : "▦"}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <div
          className="tide-line"
          style={{
            height: 2,
            background:
              "linear-gradient(90deg, var(--primary), var(--accent), var(--primary))",
            backgroundSize: "200% 100%",
            opacity: 0.65,
          }}
        />
      </div>

      {/* Feed */}
      <main
        style={{
          maxWidth: contentWidth,
          margin: "0 auto",
          padding: "16px 14px 96px",
        }}
      >
        {dbError && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--accent-soft)",
              borderRadius: 11,
              padding: "10px 14px",
              marginBottom: 12,
              fontSize: 12,
              fontWeight: 700,
              color: "var(--accent)",
            }}
          >
            ⚠️ Can't reach the database. Check that Firestore security rules are
            deployed and the app is approved in the console.
          </div>
        )}
        {/* Results count when searching */}
        {!archiveView && (search || filter !== "all") && (
          <p
            style={{
              color: "var(--text-faint)",
              fontSize: 12,
              fontWeight: 700,
              margin: "0 0 12px 2px",
            }}
          >
            {filtered.length} poll{filtered.length !== 1 ? "s" : ""}{" "}
            {search ? `for "${search}"` : ""}
          </p>
        )}

        {archiveView ? (
          <ArchiveTable polls={sorted} onDelete={(p) => setConfirmDelete(p)} />
        ) : loading && sorted.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "60px 0",
              color: "var(--text-faint)",
            }}
          >
            <p
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 18,
                fontWeight: 700,
                margin: "0 0 4px",
                color: "var(--text-dim)",
              }}
            >
              Loading polls…
            </p>
            <p style={{ fontSize: 13, margin: 0, fontWeight: 600 }}>
              Fetching the island chatter 🌊
            </p>
          </div>
        ) : sorted.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "60px 0",
              color: "var(--text-faint)",
            }}
          >
            <p style={{ fontSize: 36, margin: "0 0 8px" }}>
              {showMine ? "🗳️" : "🌱"}
            </p>
            <p
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 18,
                fontWeight: 700,
                margin: "0 0 4px",
                color: "var(--text-dim)",
              }}
            >
              {showMine ? "No polls yet" : "Nothing here"}
            </p>
            <p style={{ fontSize: 13, margin: 0, fontWeight: 600 }}>
              {showMine
                ? "Polls you post will show up here."
                : search
                  ? "Try a different search."
                  : "Be the first to ask something."}
            </p>
          </div>
        ) : (
          <div
            style={
              view === "grid"
                ? {
                    display: "grid",
                    gridTemplateColumns: isNarrow
                      ? "repeat(auto-fill, minmax(158px, 1fr))"
                      : "repeat(auto-fill, minmax(270px, 1fr))",
                    gap: 12,
                  }
                : { display: "flex", flexDirection: "column", gap: 14 }
            }
          >
            {sorted.map((poll) => (
              <PollCard
                key={poll.id}
                poll={poll}
                now={now}
                onVote={handleVote}
                onComment={handleComment}
                onLikeComment={handleLikeComment}
                onRedditVote={handleRedditVote}
                onReplyComment={handleReplyComment}
                onShare={handleShare}
                openComments={poll.id === openCommentsId}
                compact={view === "grid" && isNarrow}
                isAdmin={isAdmin}
                onDelete={(id) =>
                  setConfirmDelete(polls.find((p) => p.id === id) ?? null)
                }
              />
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "18px 8px 0",
          }}
        >
          <span
            style={{
              fontFamily: "'Great Vibes', cursive",
              fontSize: 17,
              color: "var(--text-faint)",
              opacity: 0.9,
              lineHeight: 1,
              letterSpacing: "0.02em",
            }}
          >
            made by bulhaa1
          </span>
        </div>
      </main>

      {/* Bottom CTA */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "var(--bg-96)",
          backdropFilter: "blur(16px)",
          borderTop: "1px solid var(--border)",
          padding: "10px 16px 22px",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <button
          onClick={() => setShowModal(true)}
          style={{
            background: "var(--gradient-cta)",
            border: "none",
            borderRadius: 13,
            padding: "13px 0",
            color: "#fff",
            fontFamily: "Satoshi, sans-serif",
            fontWeight: 900,
            fontSize: 15,
            cursor: "pointer",
            maxWidth: 400,
            width: "100%",
            boxShadow: "0 4px 28px var(--primary-glow-strong)",
            letterSpacing: "0.01em",
          }}
        >
          {CTA_PHRASES[ctaIndex]}
        </button>
      </div>

      {showModal && (
        <NewPollModal
          onClose={() => setShowModal(false)}
          onSubmit={handleNewPoll}
        />
      )}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      {welcomeOpen && (
        <WelcomeModal
          onClose={() => {
            localStorage.setItem("bageecha-welcomed", "1")
            setWelcomeOpen(false)
          }}
        />
      )}

      {adminDeniedName && (
        <div
          className="modal-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onMouseDown={() => setAdminDeniedName(null)}
        >
          <div
            style={{
              background: "var(--card-top)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: 22,
              maxWidth: 340,
              width: "100%",
              boxShadow: "0 16px 60px rgba(0,0,0,0.35)",
              textAlign: "center",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ fontSize: 34, margin: "0 0 8px" }}>😏</p>
            <p
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 18,
                fontWeight: 800,
                margin: "0 0 8px",
                color: "var(--text)",
              }}
            >
              Nice try, {adminDeniedName}.
            </p>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                margin: "0 0 16px",
                color: "var(--text-dim)",
                lineHeight: 1.5,
              }}
            >
              There can be only one boss on this island — and it's not you. 🔑
            </p>
            <button
              onClick={() => setAdminDeniedName(null)}
              style={{
                background: "var(--gradient-cta)",
                border: "none",
                borderRadius: 10,
                padding: "9px 22px",
                color: "#fff",
                fontFamily: "Satoshi, sans-serif",
                fontWeight: 800,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Fine 😌
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="modal-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            style={{
              background: "var(--card-top)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: 22,
              maxWidth: 360,
              width: "100%",
              boxShadow: "0 16px 60px rgba(0,0,0,0.35)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                fontFamily: "Satoshi, sans-serif",
                fontSize: 17,
                fontWeight: 800,
                margin: "0 0 6px",
                color: "var(--text)",
              }}
            >
              What to do with this poll?
            </p>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                margin: "0 0 16px",
                color: "var(--text-dim)",
              }}
            >
              "{confirmDelete.question}"
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {!confirmDelete.expired && (
                <button
                  onClick={() => handleArchivePoll(confirmDelete.id)}
                  style={{
                    width: "100%",
                    background: "var(--gradient)",
                    border: "none",
                    borderRadius: 10,
                    padding: "10px 14px",
                    color: "#fff",
                    fontFamily: "Satoshi, sans-serif",
                    fontWeight: 900,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  🗃️ Archive instead
                </button>
              )}
              <button
                onClick={() => handleDeletePoll(confirmDelete.id)}
                style={{
                  width: "100%",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 14px",
                  color: "#fff",
                  fontFamily: "Satoshi, sans-serif",
                  fontWeight: 900,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                🗑️ Delete permanently
              </button>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  width: "100%",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 14px",
                  color: "var(--text-dim)",
                  fontFamily: "Satoshi, sans-serif",
                  fontWeight: 800,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className="toast-pop"
          style={{
            position: "fixed",
            top: 74,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 120,
            background: "var(--surface-2)",
            border: "1px solid var(--primary-soft)",
            color: "var(--text)",
            fontFamily: "Satoshi, sans-serif",
            fontWeight: 800,
            fontSize: 12,
            padding: "8px 16px",
            borderRadius: 99,
            boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
