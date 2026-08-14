import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useLayoutEffect,
  Fragment,
  type ReactNode,
  type CSSProperties,
} from "react"

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
  getDocs,
  getDoc,
  startAfter,
  type QueryDocumentSnapshot,
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

// Subtle tick for the first (staging) tap on an option — a soft confirmation
// that the choice was selected, before the louder two-note "locked" jingle.
const playStageSound = () => {
  playTone(660, 0.05, "sine", 0.09)
}

const playCreateSound = () => {
  playTone(440, 0.08, "sine", 0.16)

  setTimeout(() => playTone(659.25, 0.1, "sine", 0.13), 75)
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

const decodeShare = (s: string): Partial<Poll> | null => {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/")

    const json = decodeURIComponent(escape(atob(b64)))

    const data = JSON.parse(json)

    if (
      !data ||
      typeof data.question !== "string" ||
      !Array.isArray(data.options) ||
      data.options.length < 2 ||
      !data.options.every((o: unknown) => typeof o === "string")
    )
      return null

    return data
  } catch {
    return null
  }
}

const buildShareUrl = (poll: Poll) =>
  `${window.location.origin}${window.location.pathname}?share=${poll.id}`

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

  category: string

  tags: string[]

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

type RawPoll = Omit<Poll, "voted" | "userVote" | "comments" | "tags"> & {
  tags?: string[]

  comments?: Record<string, RawComment>
}

type ProfileMap = Record<string, {
  voted: number | null

  userVote: "up" | "down" | null
}>

const MAX_OPTIONS = 7

const MIN_OPTIONS = 2

const DURATION_CHOICES = [4, 6, 12, 24, 48] as const

const pollLifetimeMs = (d: { durationH?: number }) =>
  (d.durationH ?? 48) * 60 * 60 * 1000

// Format the moment a closed poll's voting ended, e.g. "Aug 13, 6:30 PM".
const formatPollEnd = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

// Tag normalization: tags are stored lowercase with trimmed, single-spaced

// text, so "Gaming", "gaming" and "GAMING" all resolve to the same reusable

// tag. Whitespace-only input produces an empty tag (never stored). Spaces are

// stripped entirely, so a tag is always a single unbroken token.

const normalizeTag = (s: string) => s.trim().replace(/\s+/g, "").toLowerCase()

// Tag sanitization: strips control characters, zero-width/format chars and

// emoji so gibberish and invisible-character spam can't create look-alike or

// junk tags. Keeps letters, digits and a small safe punctuation set.

const TAG_ALLOWED = /[^a-z0-9#.+&'_-]/gi

const sanitizeTag = (s: string) => normalizeTag(s).replace(TAG_ALLOWED, "")

const MAX_TAGS = 3

const TAG_MAX_LEN = 20

// Curated common tags for autocomplete, offered even when no poll or preset
// category has used them yet. Normalized/deduped against the pool at build time.
const GENERAL_TAGS = [
  "memes",
  "news",
  "gaming",
  "movies",
  "tv",
  "anime",
  "music",
  "travel",
  "food",
  "sports",
  "crypto",
  "ai",
  "tech",
  "fitness",
  "health",
  "science",
  "space",
  "history",
  "school",
  "work",
  "money",
  "relationships",
  "fashion",
  "life",
]

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s

// Resolve a category/tag string to a canonical known-category key so legacy

// "Food"-style values keep their accent even when stored lowercase as tags.

const resolveCategoryKey = (cat: string) =>
  Object.keys(CATEGORY_META).find(
    (k) => k.toLowerCase() === String(cat).toLowerCase(),
  ) ?? cat

// Derive the effective tag list for a raw poll: stored tags win, the legacy

// free-text `category` is folded in as a tag so pre-tag posts stay usable.

const deriveTags = (d: { tags?: string[]; category?: string }): string[] => {
  const set = new Set(
    (Array.isArray(d.tags) ? d.tags : [])

      .map((t) => normalizeTag(String(t)))

      .filter((t) => t !== ""),
  )

  if (d.category) {
    const c = normalizeTag(d.category)

    if (c !== "") set.add(c)
  }

  return [...set]
}

// Pick a display category for old `category`-style accents from the tag list:

// the first tag matching a known category wins (keeps its Famous accent),

// otherwise the first tag is title-cased as the label.

const deriveCategory = (tags: string[]): string => {
  if (!tags || tags.length === 0) return "General"

  const known = tags.map(resolveCategoryKey).find((t) => t in CATEGORY_META)

  if (known) return known

  return titleCase(tags[0])
}

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

  tags: poll.tags?.length
    ? poll.tags
    : poll.category
      ? [normalizeTag(poll.category)]
      : [],

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

    category: deriveCategory(d.tags?.length ? d.tags : deriveTags(d)),

    tags: deriveTags(d),

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

    expired: d.archived || now - d.createdAt > pollLifetimeMs(d),

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

// Merge two raw-poll arrays by id, deduplicating. The first array wins on

// conflicts (its caller passes the fresher window first).

const mergeRawById = (a: RawPoll[], b: RawPoll[]): RawPoll[] => {
  const byId = new Map<string, RawPoll>()

  for (const p of b) byId.set(p.id, p)

  for (const p of a) byId.set(p.id, p)

  return [...byId.values()]
}

// Live-window shift handling: when new polls push the oldest window doc out

// of the snapshot, it is not deleted — it just left the query window. Verify

// with a cheap getDoc: if it still exists, absorb it into the paginated pile

// so it stays visible; if it's gone (admin delete), let it drop.

const absorbWindowShift = (
  prevWindowRef: { current: Set<string> },

  newDocs: { id: string }[],

  setter: (fn: (prev: RawPoll[]) => RawPoll[]) => void,
) => {
  const newIds = new Set(newDocs.map((d) => d.id))

  const dropped: string[] = []

  for (const id of prevWindowRef.current) {
    if (!newIds.has(id)) dropped.push(id)
  }

  prevWindowRef.current = newIds

  if (dropped.length === 0) return

  Promise.all(dropped.map((id) => getDoc(doc(db, "polls", id))))

    .then((results) => {
      const surviving = results

        .filter((s) => s.exists())

        .map((s) => s.data() as RawPoll)

      if (surviving.length > 0) setter((prev) => mergeRawById(prev, surviving))
    })

    .catch(() => {
      /* drop the shifted-out docs on network error */
    })
}

const CTA_PHRASES = [
  "Ask the island something",

  "What are the islanders thinking?",

  "Drop a question into the lagoon",

  "Put the island to a vote",

  "Start a fresh debate",

  "Your question, their take",

  "Poll the whole atoll",

  "Ask away, dhariyaa!",

  "Got a hot take? Spill it",

  "Test the waters with a poll",
]

const CATEGORY_META: Record<Category, {
  bg: string

  text: string

  border: string
}> = {
  Food: { bg: "#ff2d7820", text: "#ff6b9d", border: "#ff2d7835" },

  Transport: {
    bg: "#00e5ff18",

    text: "#00e5ff",

    border: "#00e5ff30",
  },

  Lifestyle: {
    bg: "#ffe03320",

    text: "#ffe033",

    border: "#ffe03335",
  },

  "Hot Take": {
    bg: "#ff2d7820",

    text: "#ff2d78",

    border: "#ff2d7840",
  },

  Community: {
    bg: "#b57bff20",

    text: "#b57bff",

    border: "#b57bff35",
  },

  Sports: {
    bg: "#5eead420",

    text: "#5eead4",

    border: "#5eead435",
  },

  Politics: {
    bg: "#fb923c20",

    text: "#fb923c",

    border: "#fb923c35",
  },

  Tech: { bg: "#60a5fa20", text: "#60a5fa", border: "#60a5fa35" },

  Music: { bg: "#e879f920", text: "#e879f9", border: "#e879f935" },

  Dating: {
    bg: "#f4717120",

    text: "#f47171",

    border: "#f4717135",
  },

  Environment: {
    bg: "#4ade8020",

    text: "#4ade80",

    border: "#4ade8035",
  },

  Fashion: {
    bg: "#f9a8d420",

    text: "#f9a8d4",

    border: "#f9a8d435",
  },

  General: {
    bg: "#8a7fb026",

    text: "#a89bd4",

    border: "#8a7fb045",
  },

  Controversial: {
    bg: "#f43f5e20",

    text: "#f43f5e",

    border: "#f43f5e35",
  },
}

// Light-touch styling: every category chip uses one muted accent so the UI

// stays calm. Custom categories get a tag icon.

const NEUTRAL_CATEGORY_META = {
  bg: "var(--primary-soft-bg)",

  text: "var(--primary)",

  border: "var(--primary-soft)",
}

// Darker versions of each category accent for light themes, where the vivid

// dark-theme hues don't have enough contrast against white surfaces.

const LIGHT_CATEGORY_TEXT: Record<string, string> = {
  Food: "#c2255c",

  Transport: "#0e7490",

  Lifestyle: "#a16207",

  "Hot Take": "#be185d",

  Community: "#6d28d9",

  Sports: "#0f766e",

  Politics: "#c2410c",

  Tech: "#1d4ed8",

  Music: "#a21caf",

  Dating: "#b91c1c",

  Environment: "#15803d",

  Fashion: "#c2458f",

  General: "#6b5ea8",

  Controversial: "#be123c",
}

const categoryMeta = (cat: string) => {
  const meta = {
    ...NEUTRAL_CATEGORY_META,

    ...CATEGORY_META[(resolveCategoryKey(cat) as keyof typeof CATEGORY_META)],
  }

  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dawn"

  if (!isLight) return meta

  const light = LIGHT_CATEGORY_TEXT[resolveCategoryKey(cat)]

  if (light) {
    meta.text = light

    meta.border = `${light}38`
  } else {
    meta.text = "#9a2f5d"

    meta.bg = "rgba(194, 87, 127, 0.1)"

    meta.border = "rgba(154, 47, 93, 0.35)"
  }

  return meta
}

const INITIAL_POLLS: Omit<Poll, "createdAt" | "votes" | "upvotes" | "downvotes" | "userVote" | "tags">[] =
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

  value: "all" | string
}

interface ThemeOption {
  id: string

  name: string

  swatch: [string, string, string]
}

const THEMES: ThemeOption[] = [
  {
    id: "neon",

    name: "Dhanvaru",

    swatch: ["#ff2d78", "#b57bff", "#00e5ff"],
  },

  {
    id: "ocean",

    name: "Kandu",

    swatch: ["#38bdf8", "#818cf8", "#22d3ee"],
  },

  {
    id: "forest",

    name: "Jangali",

    swatch: ["#4ade80", "#2dd4bf", "#a3e635"],
  },

  {
    id: "sunset",

    name: "Finifenma",

    swatch: ["#fb7185", "#f472b6", "#fbbf24"],
  },

  {
    id: "graphite",

    name: "Vaarey",

    swatch: ["#60a5fa", "#94a3b8", "#a5b4fc"],
  },

  {
    id: "dawn",

    name: "Handhu",

    swatch: ["#e11d74", "#7c3aed", "#0891b2"],
  },
]

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640)

  useEffect(() => {
    let raf = 0

    const onResize = () => {
      window.cancelAnimationFrame(raf)

      raf = window.requestAnimationFrame(() =>
        setNarrow(window.innerWidth < 640),
      )
    }

    window.addEventListener("resize", onResize)

    return () => {
      window.cancelAnimationFrame(raf)

      window.removeEventListener("resize", onResize)
    }
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

function SearchIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </svg>
  )
}

function StarIcon({ size = 16 }: { size?: number }) {
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
      <polygon points="12 3.5 14.7 9.2 21 9.9 16.3 14.3 17.6 20.5 12 17.4 6.4 20.5 7.7 14.3 3 9.9 9.3 9.2" />
    </svg>
  )
}

function ClockIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function ChartIcon({ size = 16 }: { size?: number }) {
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
      <path d="M3.5 20.5h17" />
      <path d="M6.5 20.5V12" />
      <path d="M12 20.5V7" />
      <path d="M17.5 20.5V10" />
    </svg>
  )
}

function ListIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M8.5 6h12" />
      <path d="M8.5 12h12" />
      <path d="M8.5 18h12" />
      <path d="M3.5 6h.01" />
      <path d="M3.5 12h.01" />
      <path d="M3.5 18h.01" />
    </svg>
  )
}

function GridIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function TrendingUpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  )
}

function BoltIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M13 2L4.5 13.5H11L9.5 22 19.5 10H13z" />
    </svg>
  )
}

function BallotIcon({ size = 16 }: { size?: number }) {
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
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <path d="M7 9.5l2 2 3.5-3.5" />
      <path d="M7 15.5h6" />
    </svg>
  )
}

function ChatIcon({ size = 16 }: { size?: number }) {
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
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3.5V18H6a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function LinkIcon({ size = 16 }: { size?: number }) {
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
      <path d="M10 13.5a5 5 0 0 0 7.07.06l2.2-2.2a5 5 0 0 0-7.07-7.07l-1.3 1.3" />
      <path d="M14 10.5a5 5 0 0 0-7.07-.06l-2.2 2.2a5 5 0 0 0 7.07 7.07l1.3-1.3" />
    </svg>
  )
}

function TrashIcon({ size = 16 }: { size?: number }) {
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
      <path d="M4 6.5h16" />
      <path d="M9 3.5h6" />
      <path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M10 10.5v6" />
      <path d="M14 10.5v6" />
    </svg>
  )
}

function FlagIcon({ size = 16 }: { size?: number }) {
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
      <path d="M5 20.5v-16" />
      <path d="M5 5c2.5-1.5 4.5-1.5 7 0s4.5 1.5 7 0v8c-2.5 1.5-4.5 1.5-7 0s-4.5-1.5-7 0" />
    </svg>
  )
}

function SproutIcon({ size = 16 }: { size?: number }) {
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
      <path d="M12 20.5v-7" />
      <path d="M12 13.5c-3.5 0-6.5-2.4-6.5-6.2 3.5 0 6.5 2.4 6.5 6.2z" />
      <path d="M12 13.5c0-3.8 3-6.2 6.5-6.2 0 3.8-3 6.2-6.5 6.2z" />
    </svg>
  )
}

function CategoryIcon({ cat, size = 14 }: { cat: string; size?: number }) {
  const p = {
    viewBox: "0 0 24 24",

    width: size,

    height: size,

    fill: "none",

    stroke: "currentColor",

    strokeWidth: 1.8,

    strokeLinecap: "round",

    strokeLinejoin: "round",

    "aria-hidden": true,

    style: { display: "block" },
  } as const

  switch (cat) {
    case "Food":
      return (
        <svg {...p}>
          <path d="M4.5 11.5a7.5 7.5 0 0 0 15 0z" />
          <path d="M8 8.5c-.5-1.5.5-2.5 2-3" />
          <path d="M13 8.5c.5-1.5-.5-2.5-2-3" />
        </svg>
      )

    case "Transport":
      return (
        <svg {...p}>
          <path d="M3 15l2-6h14l2 6" />
          <path d="M5 15h14" />
          <path d="M3.5 18.5h17" />
        </svg>
      )

    case "Lifestyle":
      return (
        <svg {...p}>
          <path d="M12 4l1.8 4.7 4.7 1.8-4.7 1.8L12 17l-1.8-4.7-4.7-1.8 4.7-1.8z" />
          <path d="M18.5 3.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
        </svg>
      )

    case "Hot Take":
      return <BoltIcon size={size} />

    case "Community":
      return (
        <svg {...p}>
          <path d="M4 11l8-6.5L20 11" />
          <path d="M6 10v9.5h12V10" />
          <path d="M10 19.5v-5h4v5" />
        </svg>
      )

    case "Sports":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5c-2 2.5-3 5.2-3 8.5s1 6 3 8.5c2-2.5 3-5.2 3-8.5s-1-6-3-8.5z" />
          <path d="M3.8 9h16.4" />
          <path d="M3.8 15h16.4" />
        </svg>
      )

    case "Politics":
      return <BallotIcon size={size} />

    case "Tech":
      return (
        <svg {...p}>
          <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
          <path d="M9.5 20.5h5" />
          <path d="M12 16.5v4" />
        </svg>
      )

    case "Music":
      return (
        <svg {...p}>
          <path d="M9 17.5V6l8-2v11.5" />
          <circle cx="6.5" cy="17.5" r="2.5" />
          <circle cx="14.5" cy="15.5" r="2.5" />
        </svg>
      )

    case "Dating":
      return (
        <svg {...p}>
          <path d="M12 19.5C7 15.5 4 12.7 4 9.5A4 4 0 0 1 12 7a4 4 0 0 1 8 2.5c0 3.2-3 6-8 10z" />
        </svg>
      )

    case "Environment":
      return <SproutIcon size={size} />

    case "Fashion":
      return (
        <svg {...p}>
          <path d="M8.5 4.5L5 7.5l2.5 2.5 1-1v10h7V9l1 1L19 7.5 15.5 4.5c-1.2 1.5-5.8 1.5-7 0z" />
        </svg>
      )

    case "General":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c-2.8 2.2-2.8 14.8 0 17" />
          <path d="M12 3.5c2.8 2.2 2.8 14.8 0 17" />
        </svg>
      )

    case "Controversial":
      return (
        <svg {...p}>
          <path d="M12 4.5L21 20H3z" />
          <path d="M12 10v4.5" />
          <path d="M12 17.2v.3" />
        </svg>
      )

    default:
      return (
        <svg {...p}>
          <path d="M3.5 11V5.5A2 2 0 0 1 5.5 3.5H11L20.5 13 13 20.5z" />
          <circle cx="8" cy="8" r="1.2" />
        </svg>
      )
  }
}

function UserMenu({
  isAdmin,

  userEmail,

  onMyPolls,

  onRules,

  onSignIn,

  onSignOut,
}: {
  isAdmin: boolean

  userEmail?: string | null

  onMyPolls: () => void

  onRules: () => void

  onSignIn: () => void

  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)

  const btnRef = useRef<HTMLButtonElement>(null)

  const menuRef = useRef<HTMLDivElement>(null)

  const close = () => setOpen(false)

  // Close on outside mousedown and on Escape (Escape also returns focus to

  // the trigger so keyboard users re-enter the flow where they left off).

  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        close()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close()

        btnRef.current?.focus()
      }
    }

    window.addEventListener("mousedown", onDown)

    window.addEventListener("keydown", onKey)

    return () => {
      window.removeEventListener("mousedown", onDown)

      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  // Focus the first actionable item when the menu opens.

  useEffect(() => {
    if (!open) return

    const t = requestAnimationFrame(() => {
      const first =
        menuRef.current?.querySelector<HTMLButtonElement>(
          '[role="menuitem"]',
        )

      first?.focus()
    })

    return () => cancelAnimationFrame(t)
  }, [open])

  const focusAt = (idx: number) => {
    const items =
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      )

    if (!items || items.length === 0) return

    const el = items[(idx + items.length) % items.length]

    el?.focus()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    )

    const idx = items.indexOf(e.target as HTMLButtonElement)

    if (e.key === "ArrowDown") {
      e.preventDefault()

      focusAt(idx + 1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()

      focusAt(idx - 1)
    } else if (e.key === "Home") {
      e.preventDefault()

      focusAt(0)
    } else if (e.key === "End") {
      e.preventDefault()

      focusAt(items.length - 1)
    }
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation()

          setOpen(!open)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          isAdmin && userEmail ? `Account: ${userEmail}` : "User menu"
        }
        title={isAdmin && userEmail ? `Signed in as ${userEmail}` : "User menu"}
        style={{
          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          background: open ? "var(--surface-2)" : "var(--surface)",

          border: open
            ? "1px solid var(--primary-soft)"
            : "1px solid var(--border)",

          borderRadius: 10,

          height: 40,

          minWidth: 40,

          padding: 0,

          lineHeight: 1,

          color: open ? "var(--primary)" : "var(--text-dim)",

          cursor: "pointer",

          transition: "all 0.15s",
        }}
      >
        <PersonIcon size={19} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="User menu"
          onKeyDown={onMenuKeyDown}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",

            right: 0,

            top: "calc(100% + 8px)",

            zIndex: 61,

            background: "var(--surface-2)",

            border: "1px solid var(--border)",

            borderRadius: 14,

            padding: 5,

            width: 188,

            boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              onMyPolls()

              close()
            }}
            style={{
              display: "flex",

              alignItems: "center",

              gap: 8,

              width: "100%",

              background: "transparent",

              border: "none",

              borderRadius: 8,

              padding: "7px 10px",

              color: "var(--text-dim)",

              fontFamily: "Satoshi, sans-serif",

              fontWeight: 700,

              fontSize: 12.5,

              textAlign: "left",

              cursor: "pointer",

              transition: "background 0.15s, color 0.15s",
            }}
          >
            <PersonIcon size={15} />
            My polls
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onRules()

              close()
            }}
            style={{
              display: "flex",

              alignItems: "center",

              gap: 8,

              width: "100%",

              background: "transparent",

              border: "none",

              borderRadius: 8,

              padding: "7px 10px",

              color: "var(--text-dim)",

              fontFamily: "Satoshi, sans-serif",

              fontWeight: 700,

              fontSize: 12.5,

              textAlign: "left",

              cursor: "pointer",

              transition: "background 0.15s, color 0.15s",
            }}
          >
            <RulesIcon size={15} />
            Rules
          </button>

          <div
            style={{
              borderTop: "1px solid var(--border)",

              marginTop: 3,

              paddingTop: 3,
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                if (isAdmin) onSignOut()
                else onSignIn()

                close()
              }}
              style={{
                display: "flex",

                alignItems: "center",

                gap: 8,

                width: "100%",

                background: "transparent",

                border: "none",

                borderRadius: 8,

                padding: "7px 10px",

                color: isAdmin ? "var(--accent)" : "var(--text-dim)",

                fontFamily: "Satoshi, sans-serif",

                fontWeight: 700,

                fontSize: 12.5,

                textAlign: "left",

                cursor: "pointer",

                transition: "background 0.15s, color 0.15s",
              }}
            >
              <KeyIcon size={15} />
              <span
                style={{
                  display: "flex",

                  alignItems: "center",

                  gap: 6,

                  minWidth: 0,
                }}
              >
                <span style={{ flexShrink: 0 }}>
                  {isAdmin ? "Sign out" : "Admin sign-in"}
                </span>
                {isAdmin && userEmail && (
                  <span
                    style={{
                      fontSize: 10,

                      fontWeight: 600,

                      opacity: 0.7,

                      overflow: "hidden",

                      textOverflow: "ellipsis",

                      whiteSpace: "nowrap",
                    }}
                  >
                    {userEmail}
                  </span>
                )}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const FEED_SORTS = [
  { value: "trending", label: "Trending", Icon: TrendingUpIcon },

  { value: "popular", label: "Popular", Icon: StarIcon },

  { value: "newest", label: "Newest", Icon: ClockIcon },

  { value: "mostVoted", label: "Most Voted", Icon: ChartIcon },
] as const

function CharCounter({
  length,

  max,

  id,

  float = false,
}: {
  length: number

  max: number

  id?: string

  float?: boolean
}) {
  const at = length >= max

  const near = length >= Math.floor(max * 0.85) && !at

  const color = at
    ? "var(--accent)"
    : near
      ? "var(--primary)"
      : "var(--text-faint)"

  return (
    <div
      id={id}
      role="status"
      aria-live="polite"
      aria-label={`${length} of ${max} characters${
        at ? ", maximum reached" : ""
      }`}
      style={{
        display: "flex",

        alignItems: "center",

        justifyContent: "flex-end",

        gap: 8,

        marginTop: float ? 0 : 5,

        fontSize: 11,

        fontWeight: at ? 900 : 700,

        color,

        fontVariantNumeric: "tabular-nums",

        position: float ? "absolute" : "static",

        right: float ? 10 : undefined,

        bottom: float ? 8 : undefined,

        pointerEvents: float ? "none" : undefined,
      }}
    >
      <span>
        {length} / {max}{" "}
        <span style={{ fontWeight: 600, opacity: 0.85 }}>characters</span>
      </span>
      {(near || at) && (
        <span style={{ opacity: at ? 1 : 0.8 }}>
          {at ? "• Maximum reached" : "• Getting close to the limit"}
        </span>
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

  animateEnter = false,

  enterDelay = 0,

  openResults = false,

  isNarrow = false,

  bareResults = false,
}: {
  poll: Poll

  now: number

  onVote: (id: string, option: number) => void

  onComment: (id: string, text: string) => boolean

  onLikeComment: (pollId: string, commentId: string) => void

  onRedditVote: (id: string, vote: "up" | "down") => void

  onReplyComment: (pollId: string, commentId: string, text: string) => boolean

  onShare: (poll: Poll) => void

  openComments: boolean

  compact?: boolean

  isAdmin?: boolean

  onDelete?: (id: string) => void

  animateEnter?: boolean

  enterDelay?: number

  openResults?: boolean

  isNarrow?: boolean

  bareResults?: boolean
}) {
  const [showComments, setShowComments] = useState(openComments)

  const [commentText, setCommentText] = useState("")

  const [replyTo, setReplyTo] = useState<string | null>(null)

  const [replyText, setReplyText] = useState("")

  const [hovering, setHovering] = useState(false)

  const [nowT, setNowT] = useState(() => Date.now())

  const [animateComments, setAnimateComments] = useState(false)

  const showResults = openResults || poll.expired

  const [entered, setEntered] = useState(false)

  // Two-tap voting: first tap stages an option (nothing written yet), second
  // tap on the same option locks it in. Lets a misclick be corrected before
  // the vote ever reaches the server.
  const [staged, setStaged] = useState<number | null>(null)

  const [rip, setRip] = useState<{ i: number; x: number; y: number } | null>(
    null,
  )

  const popRipple = (i: number, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()

    const hb = { i, x: e.clientX - rect.left, y: e.clientY - rect.top }

    window.setTimeout(
      () => setRip((prev) => (prev === hb ? null : prev)),
      650,
    )

    setRip(hb)
  }

  const live = !poll.expired && poll.voted === null

  // Entrance animation is strictly one-shot: once it has played (delay +

  // duration), the class is removed so no re-render, reorder, or re-sort can

  // ever restart it. Card positions settle and stay put.

  useEffect(() => {
    if (!animateEnter || entered) return

    const t = window.setTimeout(() => setEntered(true), (enterDelay ?? 0) + 480)

    return () => window.clearTimeout(t)
  }, [animateEnter, entered, enterDelay])

  const animating = animateEnter && !entered

  const meta = categoryMeta(poll.category)

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
    total > 0 ? Math.round((poll.votes[i] / total) * 100) : 0

  const handleComment = () => {
    if (commentText.trim()) {
      // Only clear the input when the write was accepted (a pending

      // previous write leaves the text in place so nothing is lost).

      if (onComment(poll.id, commentText.trim())) setCommentText("")
    }
  }

  const handleReply = () => {
    if (replyTo && replyText.trim()) {
      if (onReplyComment(poll.id, replyTo, replyText.trim())) {
        setReplyText("")

        setReplyTo(null)
      }
    }
  }

  return (
    <div
      id={`poll-card-${poll.id}`}
      className={"card-hover" + (animating ? " card-enter" : "")}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        borderRadius: 20,

        overflow: "hidden",

        minWidth: 0,

        maxWidth: "100%",

        background:
          "linear-gradient(160deg, var(--card-top) 0%, var(--card-bottom) 100%)",

        border: `1px solid var(--border)`,

        ...(animating ? { animationDelay: `${enterDelay}ms` } : {}),
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
          {poll.tags.map((t) => {
            const m = categoryMeta(t)

            const known = resolveCategoryKey(t) in CATEGORY_META

            return (
              <span
                key={t}
                className="tag-pill"
                style={{
                  background: m.bg,

                  color: m.text,

                  padding: "3px 10px",

                  borderRadius: 99,

                  border: `1px solid ${m.border}`,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",

                    alignItems: "center",

                    gap: 5,
                  }}
                >
                  {known && (
                    <CategoryIcon cat={resolveCategoryKey(t)} size={12} />
                  )}
                  {titleCase(t)}
                </span>
              </span>
            )
          })}
          {!compact && poll.hot && (
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
              <TrendingUpIcon size={13} /> Trending
            </span>
          )}
          {!compact && poll.expired && (
            <span
              className="tag-pill"
              style={{
                background: "var(--accent-soft-bg)",

                color: "var(--accent)",

                padding: "3px 10px",

                borderRadius: 99,

                border: "1px solid var(--accent-soft)",

                display: "inline-flex",

                alignItems: "center",

                gap: 5,
              }}
            >
              {!bareResults && <FlagIcon size={13} />} Closed
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

            overflowWrap: "anywhere",

            ...(compact
              ? {
                  display: "-webkit-box",

                  WebkitLineClamp: 2,

                  WebkitBoxOrient: "vertical",

                  overflow: "hidden",
                }
              : {}),
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
        {!bareResults && (
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
                <FlagIcon size={13} /> This poll closed after{" "}
                {poll.durationH ?? 48}h — voting is done.
              </p>
            )}
            {poll.options.map((label, i) => {
              const pct = pctOf(i)

              const isVoted = poll.voted === i

              const didVote = poll.voted !== null

              const isStaged = live && staged === i

              const clickable = live

              const barColor = "var(--primary)"

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
                  onClick={(e) => {
                    if (!live) return

                    popRipple(i, e)

                    if (staged === i) {
                      setStaged(null)

                      playVoteSound()

                      onVote(poll.id, i)
                    } else {
                      playStageSound()

                      setStaged(i)
                    }
                  }}
                  className={live ? "press-pop" : undefined}
                  style={{
                    position: "relative",

                    width: "100%",

                    padding: compact ? "8px 10px" : "11px 14px",

                    borderRadius: 11,

                    border: isVoted
                      ? `2px solid ${barColor}`
                      : isStaged
                        ? `2px solid ${barColor}`
                        : `2px solid var(--border-strong)`,

                    background: "var(--bg)",

                    cursor: clickable ? "pointer" : "default",

                    overflow: "hidden",

                    textAlign: "left",

                    transition: "border-color 0.2s, box-shadow 0.2s",

                    boxShadow: isVoted
                      ? `0 0 14px ${votedGlow}`
                      : isStaged
                        ? `0 0 0 3px color-mix(in srgb, ${barColor} 26%, transparent), 0 0 18px ${votedGlow}`
                        : "none",

                    opacity: poll.expired ? 0.65 : 1,
                  }}
                >
                  {rip && rip.i === i && (
                    <span
                      className="ripple"
                      style={{ left: rip.x, top: rip.y }}
                    />
                  )}
                  <AnimatedBar
                    pct={pct}
                    className={
                      isVoted
                        ? "vote-bar vote-bar-lit"
                        : isStaged
                          ? "vote-stage-glow"
                          : "vote-bar"
                    }
                    style={{
                      position: "absolute",

                      top: 0,

                      left: 0,

                      height: "100%",

                      background: isStaged
                        ? "color-mix(in srgb, var(--primary) 9%, transparent)"
                        : barBg,
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

                        fontWeight: isVoted ? 800 : isStaged ? 700 : 600,

                        overflowWrap: "anywhere",

                        color: isVoted
                          ? barColor
                          : isStaged
                            ? barColor
                            : didVote
                              ? "var(--text-faint-3)"
                              : "var(--text-bright)",

                        transition: "color 0.2s",
                      }}
                    >
                      {label}
                    </span>
                    {isStaged ? (
                      <span
                        className="stage-hint"
                        style={{
                          display: "inline-flex",

                          alignItems: "center",

                          gap: 5,

                          fontFamily: "Satoshi, sans-serif",

                          fontSize: compact ? 10 : 11,

                          fontWeight: 800,

                          color: barColor,

                          whiteSpace: "nowrap",

                          background:
                            "color-mix(in srgb, var(--primary) 12%, transparent)",

                          borderRadius: 99,

                          padding: "3px 9px",
                        }}
                      >
                        ✓ tap again to lock
                      </span>
                    ) : (
                      <span
                        key={pct}
                        style={{
                          fontFamily: "Satoshi, sans-serif",

                          fontSize: compact ? 13 : 15,

                          fontWeight: 800,

                          color: barColor,

                          opacity: isVoted ? 1 : 0.45,

                          transition: "opacity 0.2s",
                        }}
                      >
                        {pct}%
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {showResults && poll.expired && (
          <div
            style={{
              padding: bareResults
                ? "0 14px 12px"
                : compact
                  ? "2px 14px 12px"
                  : "4px 18px 14px",
            }}
          >
            <PollResults poll={poll} compact={compact} bare={bareResults} />
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
            className="press-pop"
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
            style={{
              fontFamily: "Satoshi, sans-serif",

              fontSize: 13,

              fontWeight: 800,

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
            className="press-pop"
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
          {poll.expired ? (
            <span>Ended {formatPollEnd(poll.createdAt + pollLifetimeMs(poll))}</span>
          ) : (
            <>
              <RollingNumber
                value={total}
                style={{ color: "var(--text-muted)" }}
              />{" "}
              votes
            </>
          )}
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

            padding: isNarrow ? "9px 8px" : "2px 0",

            transition: "color 0.15s",
          }}
        >
          <ChatIcon size={14} />{" "}
          {poll.comments.length > 0
            ? `${poll.comments.length} comment${
                poll.comments.length !== 1 ? "s" : ""
              }`
            : "comment"}
        </button>
        {!bareResults && !compact && (
          <button
            onClick={() => onShare(poll)}
            title="Share this poll"
            style={{
              background: "var(--primary-soft-bg)",

              border: "1px solid var(--primary-soft)",

              cursor: "pointer",

              color: "var(--primary)",

              fontSize: 12,

              fontWeight: 800,

              fontFamily: "Satoshi, sans-serif",

              display: "flex",

              alignItems: "center",

              gap: 5,

              padding: isNarrow ? "9px 14px" : "4px 12px",

              borderRadius: 99,

              transition: "background 0.15s, transform 0.1s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--primary-soft)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "var(--primary-soft-bg)")
            }
          >
            <LinkIcon size={14} /> Share
          </button>
        )}
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

              padding: isNarrow ? "9px 8px" : "2px 0",

              transition: "color 0.15s",
            }}
          >
            <TrashIcon size={14} /> Delete
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

                  overflowWrap: "anywhere",
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

              {!bareResults && replyTo === c.id && (
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

                      fontSize: isNarrow ? 16 : 12,

                      fontFamily: "Satoshi, sans-serif",
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

                          overflowWrap: "anywhere",
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
          {!bareResults && (
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

                  fontSize: isNarrow ? 16 : 13,

                  fontFamily: "Satoshi, sans-serif",
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
          )}
        </div>
      )}
    </div>
  )
}

function SharedStatusView({
  message,
  sub,
  onHome,
}: {
  message: string
  sub: string
  onHome: () => void
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--bg-92)",
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
                fontSize: 18,
                fontWeight: 900,
                color: "var(--text)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Bageecha
            </span>
            <IslandLogo size={16} />
          </button>
        </div>
      </header>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--text-faint)",
        }}
      >
        <p
          style={{
            fontFamily: "Satoshi, sans-serif",
            fontSize: 18,
            fontWeight: 900,
            color: "var(--text-dim)",
            margin: "0 0 6px",
          }}
        >
          {message}
        </p>
        <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 18px" }}>
          {sub}
        </p>
        <button
          onClick={onHome}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 99,
            padding: "8px 16px",
            color: "var(--text-dim)",
            fontFamily: "Satoshi, sans-serif",
            fontWeight: 800,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ← Explore more
        </button>
      </div>
    </div>
  )
}

function SharedPollView({
  poll,

  onHome,

  onVote,
}: {
  poll: Poll

  onHome: () => void

  onVote: (option: number) => void
}) {
  // Votes and the user's choice are derived from the parent's state (the

  // parent guards the vote atomically), so a rapid double-tap can never

  // double-count locally and re-renders always reflect the real values.

  const votes = poll.options.map((_, i) => poll.votes[i] ?? 0)

  const voted = poll.voted

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30000)

    return () => clearInterval(iv)
  }, [])

  const meta = categoryMeta(poll.category)

  const total = votes.reduce((s, v) => s + v, 0)

  const pctOf = (i: number) =>
    total > 0 ? Math.round((votes[i] / total) * 100) : 0

  const castVote = (i: number) => {
    if (voted !== null) return

    onVote(i)
  }

  // Two-tap confirm as on the feed cards: first tap stages, second tap locks.
  const [staged, setStaged] = useState<number | null>(null)

  const [rip, setRip] = useState<{ i: number; x: number; y: number } | null>(
    null,
  )

  const popRipple = (i: number, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()

    const hb = { i, x: e.clientX - rect.left, y: e.clientY - rect.top }

    window.setTimeout(
      () => setRip((prev) => (prev === hb ? null : prev)),
      650,
    )

    setRip(hb)
  }

  const stageOrVote = (i: number, e: React.MouseEvent<HTMLButtonElement>) => {
    if (voted !== null) return

    popRipple(i, e)

    if (staged === i) {
      setStaged(null)

      playVoteSound()

      castVote(i)
    } else {
      playStageSound()

      setStaged(i)
    }
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
              {poll.tags.map((t) => {
                const tm = categoryMeta(t)

                const known = resolveCategoryKey(t) in CATEGORY_META

                return (
                  <span
                    key={t}
                    className="tag-pill"
                    style={{
                      background: tm.bg,

                      color: tm.text,

                      padding: "3px 10px",

                      borderRadius: 99,

                      border: `1px solid ${tm.border}`,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",

                        alignItems: "center",

                        gap: 5,
                      }}
                    >
                      {known && (
                        <CategoryIcon cat={resolveCategoryKey(t)} size={12} />
                      )}
                      {titleCase(t)}
                    </span>
                  </span>
                )
              })}
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

                overflowWrap: "anywhere",
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

                const barColor = "var(--primary)"

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
                    onClick={(e) => stageOrVote(i, e)}
                    className={didVote ? undefined : "press-pop"}
                    style={{
                      position: "relative",

                      width: "100%",

                      padding: "13px 16px",

                      borderRadius: 11,

                      border: isVoted
                        ? `2px solid ${barColor}`
                        : !didVote && staged === i
                          ? `2px solid ${barColor}`
                          : `2px solid var(--border-strong)`,

                      background: "var(--bg)",

                      cursor: didVote ? "default" : "pointer",

                      overflow: "hidden",

                      textAlign: "left",

                      transition: "border-color 0.2s, box-shadow 0.2s",

                      boxShadow: isVoted
                        ? `0 0 14px ${votedGlow}`
                        : !didVote && staged === i
                          ? `0 0 0 3px color-mix(in srgb, ${barColor} 26%, transparent), 0 0 18px ${votedGlow}`
                          : "none",
                    }}
                  >
                    {rip && rip.i === i && (
                      <span
                        className="ripple"
                        style={{ left: rip.x, top: rip.y }}
                      />
                    )}
                    {didVote && (
                      <AnimatedBar
                        pct={pct}
                        className={
                          isVoted ? "vote-bar vote-bar-lit" : "vote-bar"
                        }
                        style={{
                          position: "absolute",

                          inset: 0,

                          background: barBg,
                        }}
                      />
                    )}
                    {staged === i && !didVote && (
                      <AnimatedBar
                        pct={pct}
                        className="vote-stage-glow"
                        style={{
                          position: "absolute",

                          inset: 0,

                          background:
                            "color-mix(in srgb, var(--primary) 9%, transparent)",
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

                          fontWeight: isVoted ? 800 : !didVote && staged === i ? 700 : 600,

                          color: isVoted
                            ? barColor
                            : !didVote && staged === i
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
                          key={pct}
                          style={{
                            fontFamily: "Satoshi, sans-serif",

                            fontSize: 18,

                            fontWeight: 800,

                            color: barColor,

                            opacity: isVoted ? 1 : 0.3,
                          }}
                        >
                          {pct}%
                        </span>
                      ) : !didVote && staged === i ? (
                        <span
                          className="stage-hint"
                          style={{
                            display: "inline-flex",

                            alignItems: "center",

                            gap: 5,

                            fontFamily: "Satoshi, sans-serif",

                            fontSize: 11,

                            fontWeight: 800,

                            color: barColor,

                            whiteSpace: "nowrap",

                            background:
                              "color-mix(in srgb, var(--primary) 12%, transparent)",

                            borderRadius: 99,

                            padding: "4px 10px",
                          }}
                        >
                          ✓ tap again to lock
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

// Static percentage bar: width set directly from the value with no state,

// effects, or transitions, so vote updates can never re-trigger renders or

// animations on the feed.

function AnimatedBar({
  pct,

  className,

  style,
}: {
  pct: number

  className?: string

  style?: CSSProperties
}) {
  return (
    <div
      className={className}
      style={{
        width: `${Math.max(0, Math.min(100, pct))}%`,

        ...style,
      }}
    />
  )
}

// Odometer-style count: digits that changed since the last value roll in

// smoothly, unchanged digits stay put.

function RollingNumber({
  value,

  style,
}: {
  value: number

  style?: CSSProperties
}) {
  const prevRef = useRef<number | null>(null)

  const prev = prevRef.current

  prevRef.current = value

  const str = String(Math.max(0, value))

  const prevStr = prev === null ? null : String(Math.max(0, prev))

  const n = Math.max(str.length, prevStr ? prevStr.length : 0)

  const cur = str.padStart(n, "0")

  const old = prevStr ? prevStr.padStart(n, "0") : null

  const parts: { d: string; changed: boolean }[] = []

  for (let i = 0; i < n; i++) {
    const ci = cur.length - 1 - i

    const oi = old ? old.length - 1 - i : -1

    parts.unshift({
      d: cur[ci],

      changed: old === null || oi < 0 || old[oi] !== cur[ci],
    })
  }

  return (
    <span
      aria-label={str}
      style={{
        display: "inline-flex",

        fontVariantNumeric: "tabular-nums",

        ...style,
      }}
    >
      {parts.map((p, i) => {
        const sep = i !== 0 && (n - i) % 3 === 0

        return (
          <span key={i} style={{ display: "inline-flex" }}>
            {sep && <span style={{ opacity: 0.55 }}>,</span>}
            <span key={p.d} className={p.changed ? "digit-roll" : undefined}>
              {p.d}
            </span>
          </span>
        )
      })}
    </span>
  )
}

function ResultRow({
  color,

  label,

  votes,

  pct,

  crowned,

  showCrown = true,

  showBar = false,

  active = false,

  onHover,

  wrap = false,
}: {
  color: string

  label: string

  votes: number

  pct: number

  crowned: boolean

  showCrown?: boolean

  showBar?: boolean

  active?: boolean

  onHover?: (h: boolean) => void

  wrap?: boolean
}) {
  return (
    <div
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      style={{
        display: "flex",

        flexDirection: "column",

        gap: 5,

        padding: "7px 10px",

        borderRadius: 10,

        background: active
          ? "var(--surface-2)"
          : crowned
            ? "var(--primary-soft-bg)"
            : "var(--surface)",

        border: active
          ? `1px solid ${color}`
          : crowned
            ? "1px solid var(--primary-soft)"
            : "1px solid var(--border)",

        cursor: "default",
      }}
    >
      <div
        style={{
          display: "flex",

          alignItems: "center",

          gap: 8,
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

            overflow: wrap ? "visible" : "hidden",

            textOverflow: wrap ? "clip" : "ellipsis",

            whiteSpace: wrap ? "normal" : "nowrap",

            lineHeight: wrap ? 1.35 : undefined,

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
          <RollingNumber value={votes} />
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
        {showCrown && crowned && <span title="Winner">👑</span>}
      </div>
      {showBar && (
        <div
          style={{
            height: 4,

            borderRadius: 99,

            background: "var(--surface-2)",

            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",

              width: `${pct}%`,

              borderRadius: 99,

              background: color,

              opacity: 0.85,
            }}
          />
        </div>
      )}
    </div>
  )
}

function PollResults({
  poll,

  compact = false,

  bare = false,
}: {
  poll: Poll

  compact?: boolean

  bare?: boolean
}) {
  const [mounted, setMounted] = useState(false)

  const [hovered, setHovered] = useState<number | null>(null)

  const isNarrow = useIsNarrow()

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))

    return () => cancelAnimationFrame(raf)
  }, [])

  const total = poll.votes.reduce((s, v) => s + v, 0)

  const max = total > 0 ? Math.max(...poll.votes) : 0

  const winners = poll.votes

    .map((v, i) => (v === max && v > 0 ? i : -1))

    .filter((i) => i >= 0)

  const centerTotal = useMemo(
    () => (hovered !== null ? (poll.votes[hovered] ?? 0) : total),
    [hovered, poll.votes, total],
  )

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

      color: "var(--primary)",
    }

    acc += frac

    return seg
  })

  const pctOf = (i: number) =>
    total > 0 ? Math.round((poll.votes[i] / total) * 100) : 0

  const winPct = winners.length === 1 ? pctOf(winners[0]) : 0

  const donutSize = bare ? (compact ? 96 : 118) : compact ? 150 : 170

  const strokeW = bare ? 10 : 13

  return (
    <div>
      {!bare && (
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

                color: "var(--primary)",
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
      )}

      <div
        style={{
          display: "flex",

          alignItems: "center",

          flexDirection: bare ? "column" : "row",

          gap: bare ? 12 : 16,

          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flexShrink: 0 }}>
          <svg
            viewBox="0 0 100 100"
            width={donutSize}
            height={donutSize}
            style={{ transform: "rotate(-90deg)", display: "block" }}
          >
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--surface-2)"
              strokeWidth={strokeW}
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
                strokeWidth={hovered === s.i ? strokeW + 4 : strokeW}
                strokeDasharray={`${mounted ? s.len : 0} ${C}`}
                strokeDashoffset={-s.offset}
                opacity={hovered === null || hovered === s.i ? 1 : 0.28}
                style={{
                  transitionDelay: `${hovered === null ? s.i * 0.12 : 0}s`,

                  cursor: "pointer",
                }}
                onMouseEnter={() => setHovered(s.i)}
                onMouseLeave={() => setHovered(null)}
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
            {!bare && total > 0 && (
              <span style={{ fontSize: 16, lineHeight: 1 }}>
                {winners.length > 1 ? "🤝" : "👑"}
              </span>
            )}
            <span
              style={{
                fontFamily: "Satoshi, sans-serif",

                fontSize: bare ? 20 : compact ? 22 : 26,

                fontWeight: 900,

                color: "var(--text)",

                lineHeight: 1.1,

                fontVariantNumeric: "tabular-nums",
              }}
            >
              <RollingNumber value={centerTotal} />
            </span>
            {!isNarrow && (
              <span
                style={{
                  fontSize: 10,

                  fontWeight: 800,

                  color:
                    hovered !== null ? "var(--primary)" : "var(--text-faint)",

                  letterSpacing: "0.06em",

                  textTransform: "uppercase",

                  maxWidth: donutSize - 24,

                  overflow: "hidden",

                  textOverflow: "ellipsis",

                  whiteSpace: "nowrap",

                  transition: "color 0.2s",
                }}
              >
                {hovered !== null
                  ? poll.options[hovered]
                  : total === 1
                    ? "vote"
                    : "votes"}
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,

            width: bare ? "100%" : undefined,

            minWidth: bare ? 0 : 200,

            display: "grid",

            gridTemplateColumns: bare ? "1fr" : compact ? "1fr" : "1fr 1fr",

            gap: bare ? 6 : 7,
          }}
        >
          {poll.options.map((label, i) => (
            <ResultRow
              key={i}
              color="var(--primary)"
              label={label}
              votes={poll.votes[i] ?? 0}
              pct={pctOf(i)}
              crowned={winners.includes(i)}
              showCrown={!bare}
              showBar={bare}
              active={hovered === i}
              onHover={(h) => setHovered(h ? i : null)}
              wrap={isNarrow || bare}
            />
          ))}
        </div>
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

      body: "Polls close automatically after 6–48 hours (the poll creator picks the limit) — results land in the Results tab. Vote, comment, upvote, and share any poll.",
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

/* Compact header pill that opens the theme gallery */
function ThemeSwatchButton({
  theme,

  compact = false,

  onOpen,
}: {
  theme: string

  compact?: boolean

  onOpen: () => void
}) {
  const swatch = THEMES.find((t) => t.id === theme)?.swatch ?? THEMES[0].swatch

  return (
    <button
      onClick={onOpen}
      title="Color theme"
      aria-label="Color theme"
      style={{
        display: "flex",

        alignItems: "center",

        gap: 5,

        background: "var(--surface)",

        border: "1px solid var(--border)",

        borderRadius: 9,

        height: 36,

        padding: compact ? "0 10px" : "0 12px",

        lineHeight: 1,

        color: "var(--text-dim)",

        fontFamily: "Satoshi, sans-serif",

        fontWeight: 800,

        fontSize: 12,

        cursor: "pointer",

        transition: "all 0.15s",
      }}
    >
      <span style={{ display: "inline-flex", gap: 2 }}>
        {swatch.map((c, i) => (
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
        ))}
      </span>
      {!compact && <span style={{ whiteSpace: "nowrap" }}>Theme</span>}
    </button>
  )
}

/* Theme gallery modal: pick from all the island colors at once */
function ThemeModal({
  theme,

  onTheme,

  onClose,
}: {
  theme: string

  onTheme: (t: string) => void

  onClose: () => void
}) {
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

          maxHeight: "min(85vh, 700px)",

          overflowY: "auto",
        }}
      >
        <h2
          style={{
            fontFamily: "Satoshi, sans-serif",

            fontSize: 22,

            fontWeight: 900,

            margin: "0 0 2px",

            color: "var(--text)",
          }}
        >
          Theme
        </h2>
        <p
          style={{
            fontSize: 13,

            fontWeight: 600,

            color: "var(--text-faint)",

            margin: "0 0 18px",
          }}
        >
          Pick the island colors. Changes take effect instantly.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {THEMES.map((t) => {
            const active = theme === t.id

            return (
              <button
                key={t.id}
                onClick={() => onTheme(t.id)}
                style={{
                  display: "flex",

                  alignItems: "center",

                  gap: 12,

                  width: "100%",

                  background: active
                    ? "var(--primary-soft-bg)"
                    : "var(--bg)",

                  border: active
                    ? "1px solid var(--primary-soft)"
                    : "1px solid var(--border)",

                  borderRadius: 12,

                  padding: "12px 14px",

                  cursor: "pointer",

                  transition: "all 0.15s",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",

                    gap: 3,

                    flexShrink: 0,
                  }}
                >
                  {t.swatch.map((c, i) => (
                    <span
                      key={i}
                      style={{
                        width: 10,

                        height: 10,

                        borderRadius: "50%",

                        background: c,

                        display: "inline-block",
                      }}
                    />
                  ))}
                </span>
                <span
                  style={{
                    fontFamily: "Satoshi, sans-serif",

                    fontSize: 15,

                    fontWeight: 800,

                    color: "var(--text)",
                  }}
                >
                  {t.name}
                </span>
                <span
                  style={{
                    marginLeft: "auto",

                    fontFamily: "Satoshi, sans-serif",

                    fontSize: 10.5,

                    fontWeight: 800,

                    color: active ? "var(--primary)" : "var(--text-faint)",
                  }}
                >
                  {active ? "✓ Active" : "Apply"}
                </span>
              </button>
            )
          })}
        </div>

        <button
          onClick={onClose}
          style={{
            width: "100%",

            marginTop: 18,

            background: "var(--gradient)",

            border: "none",

            borderRadius: 12,

            padding: "12px 0",

            color: "#fff",

            fontFamily: "Satoshi, sans-serif",

            fontWeight: 900,

            fontSize: 14,

            cursor: "pointer",
          }}
        >
          Done
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

    "🗳️ Your vote only locks when you tap an option twice — tap an option, then tap it again to confirm. After that it's final.",

    "Admin can remove polls that break these rules.",

    "⏰ Polls close 6–48 hours after being posted (you choose the limit) — closed polls land in Results.",
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

  existingTags,
}: {
  onClose: () => void

  onSubmit: (
    p: Omit<Poll, "id" | "votes" | "voted" | "comments" | "timeAgo" | "hot" | "createdAt" | "upvotes" | "downvotes" | "userVote">,
  ) => void

  existingTags: string[]
}) {
  const isNarrow = useIsNarrow()

  const [question, setQuestion] = useState("")

  const [description, setDescription] = useState("")

  const [author, setAuthor] = useState(
    () => localStorage.getItem("bageecha-author") || pickAuthorName(),
  )

  const [options, setOptions] = useState<string[]>(["", ""])

  const [tags, setTags] = useState<string[]>([])

  const [tagInput, setTagInput] = useState("")

  const [tagFocused, setTagFocused] = useState(false)

  const [durationH, setDurationH] = useState(24)

  const filledOptions = options.map((o) => o.trim()).filter((o) => o !== "")

  const hasDuplicates =
    new Set(filledOptions.map((o) => o.toLowerCase())).size !==
    filledOptions.length

  const addTag = (raw: string) => {
    const t = sanitizeTag(raw)

    // Pure symbols/emoji/whitespace sanitize to nothing — clear the input so

    // the box doesn't get stuck on a tag that can never be added.

    if (!t) {
      setTagInput("")

      return
    }

    if (t.length > TAG_MAX_LEN) return

    setTags((prev) =>
      prev.length >= MAX_TAGS || prev.some((x) => x === t)
        ? prev
        : [...prev, t],
    )

    setTagInput("")
  }

  const removeTag = (t: string) =>
    setTags((prev) => prev.filter((x) => x !== t))

  // Autocomplete for custom tags seen on existing polls (preset category chips
  // are already shown in full below the input). Only STARTING-word (prefix)
  // matches qualify so "ga" completes gaming but "in" does not; shown only
  // while the user is typing.
  const tagSuggestions = useMemo(() => {
    const preset = new Set(Object.keys(CATEGORY_META).map(normalizeTag))
    const q = tagInput.toLowerCase()
    if (q === "") return []
    return existingTags
      .filter(
        (t) =>
          !preset.has(t) &&
          !tags.includes(t) &&
          t !== q &&
          t.startsWith(q),
      )
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 6)
  }, [existingTags, tags, tagInput])

  // Pool for inline ghost completion: preset category keys first (so the box
  // suggests what the highlighted chip below shows), then custom tags.
  const allTagPool = useMemo(() => {
    const presets = Object.keys(CATEGORY_META).map(normalizeTag)
    return [...presets, ...existingTags.filter((t) => !presets.includes(t))]
  }, [existingTags])

  // Best prefix match for the ghost text inside the input. First Enter commits
  // it into the box, a second Enter adds the tag.
  const q = tagInput.toLowerCase()

  const ghostMatch = useMemo(() => {
    if (q === "" || tags.length >= MAX_TAGS) return null
    return (
      allTagPool.find(
        (t) => t !== q && !tags.includes(t) && t.startsWith(q),
      ) ?? null
    )
  }, [allTagPool, q, tags])

  const ghostSuffix = ghostMatch ? ghostMatch.slice(q.length) : ""

  const valid =
    question.trim() !== "" &&
    author.trim() !== "" &&
    filledOptions.length >= MIN_OPTIONS &&
    !hasDuplicates &&
    tags.length > 0

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
        className="modal-panel create-poll-glow"
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

            display: "flex",

            alignItems: "center",

            gap: 8,
          }}
        >
          <SproutIcon size={19} />
          Poll eh Fashaa
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 17 }}>
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
              magey namakee
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Pick a name..."
                maxLength={20}
                style={{
                  flex: 1,

                  background: "var(--bg)",

                  border: "1px solid var(--border)",

                  borderRadius: 9,

                  padding: "8px 11px",

                  color: "var(--text)",

                  fontSize: isNarrow ? 16 : 13,

                  fontFamily: "Satoshi, sans-serif",
                }}
              />
              <button
                onClick={shuffleName}
                title="Random name"
                className="press-pop"
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

          <div style={{ position: "relative" }}>
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
              Question
            </label>
            <textarea
              id="new-poll-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask the island something..."
              maxLength={120}
              rows={2}
              aria-label="Poll question"
              aria-describedby="new-poll-question-count"
              style={{
                width: "100%",

                background: "var(--bg)",

                border: "1px solid var(--border)",

                borderRadius: 11,

                padding: "10px 13px 32px",

                color: "var(--text)",

                fontSize: isNarrow ? 16 : 14,

                fontFamily: "Satoshi, sans-serif",

                resize: "none",
              }}
            />
            <CharCounter
              id="new-poll-question-count"
              length={question.length}
              max={120}
              float
            />
          </div>

          <div style={{ position: "relative" }}>
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
              id="new-poll-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a bit of context..."
              maxLength={350}
              rows={2}
              aria-label="Poll description"
              aria-describedby="new-poll-description-count"
              style={{
                width: "100%",

                background: "var(--bg)",

                border: "1px solid var(--border)",

                borderRadius: 11,

                padding: "10px 13px 32px",

                color: "var(--text)",

                fontSize: isNarrow ? 16 : 14,

                fontFamily: "Satoshi, sans-serif",

                resize: "none",
              }}
            />
            <CharCounter
              id="new-poll-description-count"
              length={description.length}
              max={350}
              float
            />
          </div>

          <div
            style={{
              display: "grid",

              gridTemplateColumns:
                options.length === MIN_OPTIONS ? "1fr 1fr" : "1fr",

              gap: 12,
            }}
          >
            {options.map((opt, i) => {
              const color = "var(--primary)"

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

          {hasDuplicates && (
            <p
              style={{
                margin: 0,

                fontSize: 12,

                fontWeight: 700,

                color: "#e05d5d",
              }}
            >
              Options must be different — two choices read the same.
            </p>
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
              Tags{" "}
              <span
                style={{
                  color: "var(--text-faint)",

                  fontWeight: 600,

                  textTransform: "none",
                }}
              >
                ({tags.length}/{MAX_TAGS} — press Enter)
              </span>
            </label>
            {tags.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 5,
                  marginBottom: 8,
                }}
              >
                {tags.map((t) => {
                  const m = categoryMeta(t)

                  return (
                    <button
                      key={t}
                      onClick={() => removeTag(t)}
                      title="Remove tag"
                      className="tag-pill"
                      style={{
                        background: m.bg,

                        color: m.text,

                        padding: "4px 11px",

                        borderRadius: 99,

                        border: `1px solid ${m.border}`,

                        cursor: "pointer",

                        transition: "all 0.15s",
                      }}
                    >
                      {titleCase(t)} ×
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ position: "relative" }}>
              {tagFocused && ghostMatch && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 1,
                    left: 1,
                    right: 1,
                    bottom: 1,
                    padding: "8px 11px",
                    fontSize: isNarrow ? 16 : 13,
                    fontFamily: "Satoshi, sans-serif",
                    lineHeight: "1.4",
                    whiteSpace: "pre",
                    overflow: "hidden",
                    pointerEvents: "none",
                    color: "transparent",
                  }}
                >
                  {tagInput}
                  <span style={{ color: "var(--text-faint)" }}>
                    {ghostSuffix}
                  </span>
                </div>
              )}
              <input
                value={tagInput}
                onChange={(e) =>
                  setTagInput(e.target.value.replace(/\s+/g, ""))
                }
                onFocus={() => setTagFocused(true)}
                onBlur={() => setTagFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()

                    // First Enter commits the inline ghost completion into the
                    // box; a second Enter adds the tag.
                    if (ghostMatch && ghostMatch !== tagInput) {
                      setTagInput(ghostMatch)

                      return
                    }

                    addTag(tagInput)
                  }

                  if (
                    e.key === "Backspace" &&
                    tagInput === "" &&
                    tags.length > 0
                  ) {
                    removeTag(tags[tags.length - 1])
                  }
                }}
                disabled={tags.length >= MAX_TAGS}
                placeholder={
                  tags.length >= MAX_TAGS
                    ? "Tag limit reached"
                    : "Add a tag… (e.g. gaming, memeology)"
                }
                maxLength={TAG_MAX_LEN}
                style={{
                  width: "100%",

                  background: "transparent",

                  border: "1px solid var(--border)",

                  borderRadius: 9,

                  padding: "8px 11px",

                  color: "var(--text)",

                  fontSize: isNarrow ? 16 : 13,

                  fontFamily: "Satoshi, sans-serif",

                  lineHeight: "1.4",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 5,
                marginTop: 8,
              }}
            >
              {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
                const used =
                  tags.includes(normalizeTag(cat)) || tags.length >= MAX_TAGS

                const matching =
                  !used && q !== "" && normalizeTag(cat).startsWith(q)

                const m = categoryMeta(cat)

                return (
                  <button
                    key={cat}
                    onClick={() => addTag(cat)}
                    disabled={used}
                    className="tag-pill"
                    style={{
                      background: matching ? m.bg : "transparent",

                      color: matching
                        ? m.text
                        : used
                          ? "var(--text-faint)"
                          : "var(--text-faint)",

                      padding: "4px 11px",

                      borderRadius: 99,

                      border: used
                        ? "1px dashed var(--border-strong)"
                        : matching
                          ? `1px solid ${m.border}`
                          : "1px solid var(--border)",

                      boxShadow: matching
                        ? `0 0 0 3px ${m.border}, 0 0 12px ${m.bg}`
                        : undefined,

                      cursor: used ? "default" : "pointer",

                      transition: "all 0.15s",

                      opacity: used ? 0.45 : matching ? 1 : 0.9,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",

                        alignItems: "center",

                        gap: 5,
                      }}
                    >
                      <CategoryIcon cat={cat} size={12} />
                      {cat}
                    </span>
                  </button>
                )
              })}
            </div>
            {tagSuggestions.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 5,
                  marginTop: 8,
                }}
              >
                {tagSuggestions.map((t) => {
                  const m = categoryMeta(t)
                  return (
                    <button
                      key={t}
                      onClick={() => addTag(t)}
                      className="tag-pill"
                      style={{
                        background: m.bg,
                        color: m.text,
                        padding: "4px 11px",
                        borderRadius: 99,
                        border: `1px solid ${m.border}`,
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {titleCase(t)}
                    </button>
                  )
                })}
              </div>
            )}
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
                        ? "var(--primary-soft-bg)"
                        : "var(--surface-2)",

                      color: active ? "var(--primary)" : "var(--text-dim)",

                      border: active
                        ? "1px solid var(--primary-soft)"
                        : "1px solid var(--border)",

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
                  try {
                    localStorage.setItem("bageecha-author", author.trim())
                  } catch {
                    /* storage unavailable — nothing to persist */
                  }

                  onSubmit({
                    question: question.trim(),

                    description: description.trim() || undefined,

                    author: author.trim(),

                    options: filledOptions,

                    tags,

                    category: deriveCategory(tags),

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

      try {
        localStorage.setItem("bageecha-anon-id", id)
      } catch {
        /* storage unavailable — keep the id in memory only */
      }
    }

    return id
  })

  const [rawPolls, setRawPolls] = useState<RawPoll[]>([])

  const [archiveRawPolls, setArchiveRawPolls] = useState<RawPoll[]>([])

  // Paginated tail: docs older than the live snapshot window, fetched on

  // demand. Never replaced by snapshots — only merged, deduped by id.

  const [olderPolls, setOlderPolls] = useState<RawPoll[]>([])

  const [olderArchivePolls, setOlderArchivePolls] = useState<RawPoll[]>([])

  const [hasMore, setHasMore] = useState(false)

  const [loadingMore, setLoadingMore] = useState(false)

  const [archiveHasMore, setArchiveHasMore] = useState(false)

  const [archiveLoadingMore, setArchiveLoadingMore] = useState(false)

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

  const [showTheme, setShowTheme] = useState(false)

  const [openCommentsId, setOpenCommentsId] = useState<string | null>(null)

  const [showMine, setShowMine] = useState(false)

  const [showArchive, setShowArchive] = useState(false)

  // Share links: `?share=<code>`. New links carry the poll's real Firestore
  // id (short); legacy long links embed a base64 snapshot and are kept
  // working via decodeShare below.
  const [shareCode, setShareCode] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("share"),
  )

  const [sharedPoll, setSharedPoll] = useState<Poll | null>(() => {
    if (!shareCode) return null

    const data = decodeShare(shareCode)

    if (!data) return null

    return {
      id: `shared_${Date.now()}`,

      question: data.question ?? "Untitled poll",

      description: data.description,

      category: data.category ? data.category : "General",

      tags: data.tags?.length
        ? data.tags.map(sanitizeTag).filter(Boolean).slice(0, MAX_TAGS)
        : deriveTags(data),

      author: data.author ?? "Anonymous",

      options: data.options ?? [],

      votes: (data.options ?? []).map((_, i) => Number(data.votes?.[i]) || 0),

      voted: null,

      upvotes: Math.max(0, Number(data.upvotes) || 0),

      downvotes: Math.max(0, Number(data.downvotes) || 0),

      userVote: null,

      comments: [],

      timeAgo: "shared just now",

      hot: data.hot === true,

      createdAt: Number(data.createdAt) || Date.now(),

      durationH: Math.min(48, Math.max(1, Number(data.durationH) || 48)),
    }
  })

  // A share code that isn't a legacy snapshot is a real poll id: subscribe to
  // the live document so the shared view shows real, current data and votes
  // made here land on the same doc the feed reads from.
  const [sharedLoading, setSharedLoading] = useState(false)

  const [sharedMissing, setSharedMissing] = useState(false)

  useEffect(() => {
    if (!shareCode || decodeShare(shareCode)) return

    setSharedLoading(true)

    const unsub = onSnapshot(
      doc(db, "polls", shareCode),

      (snap) => {
        setSharedLoading(false)

        if (!snap.exists()) {
          setSharedMissing(true)

          setSharedPoll(null)

          return
        }

        setSharedMissing(false)

        const raw = { ...(snap.data() as RawPoll), id: snap.id }

        setSharedPoll(toViewPoll(raw, anonId, profile, Date.now()))
      },

      (err) => {
        console.error("Shared poll sync failed", err)

        setSharedLoading(false)

        setSharedMissing(true)
      },
    )

    return () => unsub()
  }, [shareCode, anonId, profile])

  const [filter, setFilter] = useState<"all" | string>("all")

  const [filterOpen, setFilterOpen] = useState(false)

  const [mobileTagsOpen, setMobileTagsOpen] = useState(false)

  const [search, setSearch] = useState("")

  const [searchPh, setSearchPh] = useState("Ask the island something…")

  const [searchActive, setSearchActive] = useState(false)

  const searchRef = useRef(search)

  searchRef.current = search

  const searchFocusedRef = useRef(false)

  const searchQRef = useRef<string[]>([])

  const [sort, setSort] =
    useState<"trending" | "popular" | "newest" | "mostVoted">("newest")

  const [archiveSort, setArchiveSort] = useState<"newest" | "mostVoted">(
    "newest",
  )

  const [view, setView] = useState<"list" | "grid">("list")

  const [viewTouched, setViewTouched] = useState(false)

  const [liveCount, setLiveCount] = useState(1)

  const [theme, setTheme] = useState(
    () => localStorage.getItem("bageecha-theme") || "graphite",
  )

  const [ctaIndex, setCtaIndex] = useState(() =>
    Math.floor(Math.random() * CTA_PHRASES.length),
  )

  const [ripples, setRipples] = useState<
    { id: number; x: number; y: number }[]
  >([])

  const rippleSeq = useRef(0)

  const ctaFollowerRef = useRef<HTMLDivElement>(null)

  const addCtaRipple = (x: number, y: number) => {
    const id = ++rippleSeq.current

    setRipples((r) => [...r, { id, x, y }])

    window.setTimeout(() => {
      setRipples((r) => r.filter((p) => p.id !== id))
    }, 700)
  }

  const [toast, setToast] = useState<string | null>(null)

  const [welcomeOpen, setWelcomeOpen] = useState(false)

  const [now, setNow] = useState(() => Date.now())

  const chromeRef = useRef<HTMLDivElement>(null)

  const [chromeHidden, setChromeHidden] = useState(false)

  const feedSeenRef = useRef<Set<string>>(new Set())

  const feedSnapKeyRef = useRef("")

  const archiveSnapKeyRef = useRef("")

  const bootedRef = useRef(false)

  // Pagination cursors and guards (authoritative flags live in refs so

  // snapshot callbacks and async loads never read stale state).

  const feedCursorRef = useRef<QueryDocumentSnapshot | null>(null)

  const feedHasMoreRef = useRef(false)

  const feedFetchCountRef = useRef(0)

  const feedLoadedRef = useRef(false)

  const feedPrevWindowRef = useRef<Set<string>>(new Set())

  const archiveCursorRef = useRef<QueryDocumentSnapshot | null>(null)

  const archiveHasMoreRef = useRef(false)

  const archiveLoadedRef = useRef(false)

  const archivePrevWindowRef = useRef<Set<string>>(new Set())

  const sentinelRef = useRef<HTMLDivElement>(null)

  const isAdmin = user?.email === ADMIN_EMAIL

  const archiveView = showArchive

  const toastTimer = useRef(0)

  // In-flight action guards: state updates are async, so two rapid clicks

  // (or Enter presses) within the same frame would otherwise double-apply

  // votes/likes/comments against stale closure state.

  const votePendingRef = useRef<Set<string>>(new Set())

  const redditVotePendingRef = useRef<Set<string>>(new Set())

  const likePendingRef = useRef<Set<string>>(new Set())

  const commentPendingRef = useRef<Set<string>>(new Set())

  const replyPendingRef = useRef<Set<string>>(new Set())

  const showToast = (msg: string, ms = 2200) => {
    setToast(msg)

    window.clearTimeout(toastTimer.current)

    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

  const allRawPolls = useMemo(
    () => mergeRawById(rawPolls, olderPolls),

    [rawPolls, olderPolls],
  )

  const allArchiveRawPolls = useMemo(
    () => mergeRawById(archiveRawPolls, olderArchivePolls),

    [archiveRawPolls, olderArchivePolls],
  )

  const polls = useMemo(
    () => allRawPolls.map((d) => toViewPoll(d, anonId, profile, now)),

    [allRawPolls, profile, anonId, now],
  )

  const archivePolls = useMemo(
    () => allArchiveRawPolls.map((d) => toViewPoll(d, anonId, profile, now)),

    [allArchiveRawPolls, profile, anonId, now],
  )

  const archiveClosed = useMemo(
    () => archivePolls.filter((p) => p.expired),

    [archivePolls],
  )

  // Autocomplete pool for the create-poll tag field: preset category keys, a
  // curated list of common general tags, plus custom tags already used on live
  // (non-expired, non-archived) polls. Closed polls and the results archive are
  // excluded so suggestions stay fresh and reduce duplication.
  const tagSuggestions = useMemo(() => {
    const seen = new Set<string>()
    for (const p of polls) {
      if (p.expired || p.archived) continue
      for (const t of p.tags) {
        if (t) seen.add(t)
      }
    }
    for (const k of Object.keys(CATEGORY_META)) seen.add(normalizeTag(k))
    for (const t of GENERAL_TAGS) seen.add(normalizeTag(t))
    return [...seen].filter((t) => t !== "").sort()
  }, [polls])

  const filters = useMemo(() => {
    // Rank tags by how many polls use them so junk/one-off tags can't crowd

    // the rail; only the most-used ones are offered as filter pills.

    const counts = new Map<string, number>()

    for (const p of [...polls, ...archivePolls]) {
      for (const t of p.tags) {
        if (!t) continue

        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }

    const list = [...counts.entries()]

      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

      .slice(0, 12)

      .map(([t]) => t)

    return [
      { label: "All", value: "all" },

      ...list.map((t) => ({ label: titleCase(t), value: t })),
    ] as FilterOption[]
  }, [polls, archivePolls])

  const patchRaw = (id: string, fn: (p: RawPoll) => RawPoll) => {
    const patch = (prev: RawPoll[]) =>
      prev.map((p) => (p.id === id ? fn(p) : p))

    // Patch every list a poll can render from (live window, paginated

    // tails, archive) so optimistic updates show instantly everywhere

    // and stay consistent when the poll shifts between lists.

    setRawPolls(patch)

    setOlderPolls(patch)

    setArchiveRawPolls(patch)

    setOlderArchivePolls(patch)
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)

    try {
      localStorage.setItem("bageecha-theme", theme)
    } catch {
      /* storage unavailable */
    }
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }

    window.addEventListener("click", close)

    window.addEventListener("keydown", onKey)

    return () => {
      window.removeEventListener("click", close)

      window.removeEventListener("keydown", onKey)
    }
  }, [filterOpen])

  useEffect(() => {
    if (!mobileTagsOpen) return

    const close = () => setMobileTagsOpen(false)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }

    window.addEventListener("click", close)

    window.addEventListener("keydown", onKey)

    return () => {
      window.removeEventListener("click", close)

      window.removeEventListener("keydown", onKey)
    }
  }, [mobileTagsOpen])

  useEffect(() => {
    try {
      localStorage.setItem("bageecha-profile", JSON.stringify(profile))
    } catch {
      /* storage unavailable — votes just won't persist across reloads */
    }
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
          // Only touch state when the snapshot data actually changed:

          // Firestore re-fires on metadata-only events (local writes,

          // connectivity) with identical data, and replacing the whole

          // polls array with fresh references on every event re-renders

          // every card and re-runs sorting endlessly.

          const key = docs.map((d) => JSON.stringify(d)).join("|")

          if (key !== feedSnapKeyRef.current) {
            feedSnapKeyRef.current = key

            setRawPolls(docs)

            // A doc that left the live window was either pushed out by new

            // arrivals (still exists — keep it visible) or deleted (drop it).

            absorbWindowShift(feedPrevWindowRef, docs, setOlderPolls)
          }

          // First real data: anchor the pagination cursor to the window's

          // oldest doc and advertise more pages if the window is full.

          if (!feedLoadedRef.current) {
            feedLoadedRef.current = true

            feedCursorRef.current = snap.docs[snap.docs.length - 1] ?? null
          }

          if (snap.docs.length === 60 && feedFetchCountRef.current < 9) {
            feedHasMoreRef.current = true

            setHasMore(true)
          }

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

  // Recent polls for the archive view — everyone can see closed polls. The

  // live window is the newest 50; older pages load on demand via cursor

  // pagination (a where+orderBy composite index isn't available, so

  // expired-but-archived polls are filtered client-side by `p.expired`).

  useEffect(() => {
    const q = query(
      collection(db, "polls"),

      orderBy("createdAt", "desc"),

      limit(50),
    )

    const unsub = onSnapshot(
      q,

      (snap) => {
        const docs = snap.docs.map((d) => d.data() as RawPoll)

        const key = docs.map((d) => JSON.stringify(d)).join("|")

        if (key !== archiveSnapKeyRef.current) {
          archiveSnapKeyRef.current = key

          setArchiveRawPolls(docs)

          absorbWindowShift(archivePrevWindowRef, docs, setOlderArchivePolls)
        }

        if (!archiveLoadedRef.current) {
          archiveLoadedRef.current = true

          archiveCursorRef.current = snap.docs[snap.docs.length - 1] ?? null
        }

        if (snap.docs.length === 50 && !archiveHasMoreRef.current) {
          archiveHasMoreRef.current = true

          setArchiveHasMore(true)
        }
      },

      (err) => console.error("Archive sync failed", err),
    )

    return () => unsub()
  }, [])

  // Auto-archive: polls past their lifetime leave the feed and become

  // available in the archive. Runs on mount, whenever a poll list changes,

  // and on a minute timer (a poll can expire mid-session with no new

  // snapshot event to trigger the check); the write is idempotent. Both the

  // feed window and the archive window are scanned so polls ranked 51–60

  // (present only in the feed) still get archived.

  const runAutoArchive = () => {
    const candidates = allRawPolls.concat(allArchiveRawPolls)

    if (candidates.length === 0) return

    const toArchive = candidates.filter(
      (d) => !d.archived && Date.now() - d.createdAt > pollLifetimeMs(d),
    )

    if (toArchive.length === 0) return

    const batch = writeBatch(db)

    toArchive.forEach((d) =>
      batch.update(doc(db, "polls", d.id), { archived: true }),
    )

    batch.commit().catch((err) => console.error("Auto-archive failed", err))
  }

  useEffect(() => {
    runAutoArchive()

    const iv = setInterval(runAutoArchive, 60000)

    return () => clearInterval(iv)
  }, [allRawPolls, allArchiveRawPolls])

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

  // Lock page scroll while a modal/overlay is open so wheel and touch input

  // stay inside the dialog instead of scrolling the feed behind it. Also

  // close the topmost dialog on Escape and hand focus back to whatever the

  // user was interacting with before the overlay opened.

  useEffect(() => {
    const overlayOpen =
      showModal ||
      showRules ||
      showTheme ||
      welcomeOpen ||
      confirmDelete !== null ||
      adminDeniedName !== null

    if (!overlayOpen) return

    const prevOverflow = document.body.style.overflow

    const prevFocus = document.activeElement as HTMLElement | null

    document.body.style.overflow = "hidden"

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return

      e.preventDefault()

      if (adminDeniedName) setAdminDeniedName(null)
      else if (confirmDelete) setConfirmDelete(null)
      else if (showTheme) setShowTheme(false)
      else if (showRules) setShowRules(false)
      else if (showModal) setShowModal(false)
      else if (welcomeOpen) setWelcomeOpen(false)
    }

    window.addEventListener("keydown", onKey)

    return () => {
      document.body.style.overflow = prevOverflow

      window.removeEventListener("keydown", onKey)

      prevFocus?.focus?.()
    }
  }, [showModal, showRules, showTheme, welcomeOpen, confirmDelete, adminDeniedName])

  // Scroll-driven collapse of the header + filter bar. Starts animating only

  // while the user is scrolling and stops as soon as it settles, so it does

  // no work (and no jank) while the page is idle.

  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 24) setChromeHidden(true)
      else if (window.scrollY < 12) setChromeHidden(false)
    }

    window.addEventListener("scroll", onScroll, { passive: true })

    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Sync the collapsed state on mount and on layout changes so a reload at a

  // scrolled position starts already hidden instead of animating from the top.

  useLayoutEffect(() => {
    // Functional update: if the value is unchanged React bails out, so this

    // effect can never contribute to a render loop.

    setChromeHidden((prev) =>
      prev === window.scrollY > 24 ? prev : window.scrollY > 24,
    )
  }, [view, isNarrow])

  useEffect(() => {
    let disposed = false

    let source: EventSource | null = null

    let attempts = 0

    let fallbackTimer: number | undefined

    let connectTimer: number | undefined

    let firstCountTimer: number | undefined

    const startFallback = () => {
      if (disposed || fallbackTimer !== undefined) return

      const pick = () => setLiveCount(Math.floor(Math.random() * 50) + 1)

      pick()

      fallbackTimer = window.setInterval(pick, 20000)
    }

    const connect = () => {
      if (disposed) return

      source = new EventSource(`${import.meta.env.BASE_URL}api/online`)

      firstCountTimer = window.setTimeout(
        () => {
          // No count arrived in time: this origin has no SSE endpoint

          // (e.g. static hosting), so fall back to the jitter counter.

          source?.close()

          startFallback()
        },
        5000,
      )

      source.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(ev.data) as { count?: unknown }

          if (typeof data.count === "number" && data.count > 0) {
            window.clearTimeout(firstCountTimer)

            window.clearInterval(fallbackTimer)

            attempts = 0

            setLiveCount(data.count)
          }
        } catch {
          /* malformed payload */
        }
      })

      source.addEventListener("error", () => {
        window.clearTimeout(firstCountTimer)

        source?.close()

        attempts += 1

        if (attempts >= 3) {
          startFallback()
        } else {
          connectTimer = window.setTimeout(connect, attempts * 3000)
        }
      })
    }

    connect()

    return () => {
      disposed = true

      window.clearTimeout(firstCountTimer)

      window.clearTimeout(connectTimer)

      window.clearInterval(fallbackTimer)

      source?.close()
    }
  }, [])

  const handleVote = (id: string, option: number) => {
    if (votePendingRef.current.has(id)) return

    if (profile[id]?.voted !== undefined && profile[id]?.voted !== null) return

    const raw = allRawPolls.find((p) => p.id === id)

    if (raw && Date.now() - raw.createdAt > pollLifetimeMs(raw)) return

    votePendingRef.current.add(id)

    setProfile((prev) => ({ ...prev, [id]: { ...prev[id], voted: option } }))

    const current = allRawPolls.find((p) => p.id === id)

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
    }).then(
      () => votePendingRef.current.delete(id),

      (err) => {
        console.error("Vote write failed", err)

        votePendingRef.current.delete(id)

        // Roll back the optimistic vote so the UI never shows a count

        // that doesn't exist on the server.

        setProfile((prev) => ({
          ...prev,

          [id]: { ...prev[id], voted: null },
        }))

        patchRaw(id, (p) => {
          const votes = normalizeVotes(p).map((v, i) =>
            i === option ? Math.max(0, v - 1) : v,
          )

          return { ...p, votes }
        })

        showToast("Vote failed — please try again", 3000)
      },
    )
  }

  const handleComment = (pollId: string, text: string): boolean => {
    if (commentPendingRef.current.has(pollId)) {
      showToast("Still sending your previous comment…", 2200)

      return false
    }

    commentPendingRef.current.add(pollId)

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

    updateDoc(doc(db, "polls", pollId), { [`comments.${cid}`]: comment })

      .then(() => commentPendingRef.current.delete(pollId))

      .catch((err) => {
        console.error("Comment write failed", err)

        commentPendingRef.current.delete(pollId)

        // Roll back the optimistic comment so it doesn't linger forever.

        patchRaw(pollId, (p) => {
          const comments = { ...p.comments }

          delete comments[cid]

          return { ...p, comments }
        })

        showToast("Comment failed — please try again", 3000)
      })

    return true
  }

  const handleReplyComment = (
    pollId: string,

    commentId: string,

    text: string,
  ): boolean => {
    const replyKey = `${pollId}:${commentId}`

    if (replyPendingRef.current.has(replyKey)) {
      showToast("Still sending your previous reply…", 2200)

      return false
    }

    replyPendingRef.current.add(replyKey)

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
    })

      .then(() => replyPendingRef.current.delete(replyKey))

      .catch((err) => {
        console.error("Reply write failed", err)

        replyPendingRef.current.delete(replyKey)

        // Roll back the optimistic reply so it doesn't linger forever.

        patchRaw(pollId, (p) => {
          const comments = { ...p.comments }

          const c = comments[commentId]

          if (!c) return p

          const replies = { ...(c.replies ?? {}) }

          delete replies[rid]

          comments[commentId] = { ...c, replies }

          return { ...p, comments }
        })

        showToast("Reply failed — please try again", 3000)
      })

    return true
  }

  const handleLikeComment = (pollId: string, commentId: string) => {
    const likeKey = `${pollId}:${commentId}`

    if (likePendingRef.current.has(likeKey)) return

    likePendingRef.current.add(likeKey)

    const poll =
      allRawPolls.find((p) => p.id === pollId) ??
      allArchiveRawPolls.find((p) => p.id === pollId)

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
    }).then(
      () => likePendingRef.current.delete(likeKey),

      (err) => {
        console.error("Comment like write failed", err)

        likePendingRef.current.delete(likeKey)

        // Roll back the optimistic like so the UI can't stay out of sync
        // with the server when the write is rejected (e.g. offline).
        patchRaw(pollId, (p) => {
          const comments = { ...p.comments }

          const cc = comments[commentId]

          if (!cc) return p

          comments[commentId] = {
            ...cc,
            likes: Math.max(0, cc.likes + (liked ? 1 : -1)),
            likedBy: liked
              ? [...(cc.likedBy ?? []), anonId]
              : (cc.likedBy ?? []).filter((x) => x !== anonId),
          }

          return { ...p, comments }
        })
      },
    )
  }

  const handleRedditVote = (id: string, vote: "up" | "down") => {
    if (redditVotePendingRef.current.has(id)) return

    const raw = allRawPolls.find((p) => p.id === id)

    if (raw && Date.now() - raw.createdAt > pollLifetimeMs(raw)) return

    redditVotePendingRef.current.add(id)

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
      updateDoc(doc(db, "polls", id), update).then(
        () => redditVotePendingRef.current.delete(id),

        (err) => {
          console.error("Reddit vote write failed", err)

          redditVotePendingRef.current.delete(id)

          // Roll back the optimistic up/down vote.

          setProfile((prev) => ({
            ...prev,

            [id]: { ...prev[id], userVote: current },
          }))

          patchRaw(id, (p) => ({
            ...p,

            upvotes: Math.max(0, p.upvotes - upDelta),

            downvotes: Math.max(0, p.downvotes - downDelta),
          }))

          showToast("Vote failed — please try again", 3000)
        },
      )
    else redditVotePendingRef.current.delete(id)
  }

  const handleShare = (poll: Poll) => {
    const url = buildShareUrl(poll)

    const copyLink = async () => {
      try {
        await navigator.clipboard.writeText(url)
      } catch {
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
      }

      showToast("Link copied!")
    }

    if (navigator.share) {
      navigator

        .share({ title: poll.question, url })

        .catch(() => copyLink())
    } else {
      copyLink()
    }
  }

  const handleSharedVote = (option: number) => {
    // Legacy long-format snapshot links embed no real poll id, so the vote
    // only updates the local view (unchanged behavior).
    if (!shareCode || decodeShare(shareCode)) {
      setSharedPoll((prev) => {
        if (!prev || prev.voted !== null) return prev

        const votes = [...prev.votes]

        votes[option] = (votes[option] ?? 0) + 1

        return { ...prev, votes, voted: option }
      })

      return
    }

    const id = shareCode

    if (votePendingRef.current.has(id)) return

    if (profile[id]?.voted !== undefined && profile[id]?.voted !== null) return

    const raw = allRawPolls.find((p) => p.id === id)

    if (raw && Date.now() - raw.createdAt > pollLifetimeMs(raw)) return

    votePendingRef.current.add(id)

    setProfile((prev) => ({ ...prev, [id]: { ...prev[id], voted: option } }))

    setSharedPoll((prev) => {
      if (!prev || prev.voted !== null) return prev

      const votes = [...prev.votes]

      votes[option] = (votes[option] ?? 0) + 1

      return { ...prev, votes, voted: option }
    })

    runTransaction(db, async (tx) => {
      const ref = doc(db, "polls", id)

      const snap = await tx.get(ref)

      if (!snap.exists()) return

      const cur = normalizeVotes(snap.data() as RawPoll)

      cur[option] = (cur[option] ?? 0) + 1

      tx.update(ref, { votes: cur })
    }).then(
      () => votePendingRef.current.delete(id),

      (err) => {
        console.error("Shared vote write failed", err)

        votePendingRef.current.delete(id)

        setProfile((prev) => ({
          ...prev,

          [id]: { ...prev[id], voted: null },
        }))

        setSharedPoll((prev) => {
          if (!prev) return prev

          const votes = [...prev.votes]

          votes[option] = Math.max(0, (votes[option] ?? 0) - 1)

          return { ...prev, votes, voted: null }
        })

        showToast("Vote failed — please try again", 3000)
      },
    )
  }

  const exitShared = () => {
    setSharedPoll(null)

    setShareCode(null)

    setSharedLoading(false)

    setSharedMissing(false)

    setOpenCommentsId(null)

    const url = new URL(window.location.href)

    url.searchParams.delete("share")

    window.history.replaceState({}, "", url.toString())
  }

  // Cursor-based pagination: fetch the next page of older polls (by

  // createdAt desc — the only server-ordered axis; active sort modes are

  // applied client-side over the merged set). Feed is capped at 10 pages

  // (~600 polls) per session; the archive loads until exhausted.

  const loadMoreFeed = async () => {
    if (loadingMore || !feedHasMoreRef.current || !feedCursorRef.current) return

    if (feedFetchCountRef.current >= 9) {
      feedHasMoreRef.current = false

      setHasMore(false)

      return
    }

    setLoadingMore(true)

    try {
      const q = query(
        collection(db, "polls"),

        orderBy("createdAt", "desc"),

        startAfter(feedCursorRef.current),

        limit(60),
      )

      const snap = await getDocs(q)

      const last = snap.docs[snap.docs.length - 1]

      if (last) feedCursorRef.current = last

      const docs = snap.docs.map((d) => d.data() as RawPoll)

      if (docs.length > 0) setOlderPolls((prev) => mergeRawById(prev, docs))

      const nextCount = feedFetchCountRef.current + 1

      feedFetchCountRef.current = nextCount

      const full = snap.docs.length === 60

      feedHasMoreRef.current = full && nextCount < 9

      setHasMore(feedHasMoreRef.current)
    } catch (err) {
      console.error("Feed load more failed", err)
    } finally {
      setLoadingMore(false)
    }
  }

  const loadMoreArchive = async () => {
    if (
      archiveLoadingMore ||
      !archiveHasMoreRef.current ||
      !archiveCursorRef.current
    )
      return

    setArchiveLoadingMore(true)

    try {
      const q = query(
        collection(db, "polls"),

        orderBy("createdAt", "desc"),

        startAfter(archiveCursorRef.current),

        limit(50),
      )

      const snap = await getDocs(q)

      const last = snap.docs[snap.docs.length - 1]

      if (last) archiveCursorRef.current = last

      const docs = snap.docs.map((d) => d.data() as RawPoll)

      if (docs.length > 0)
        setOlderArchivePolls((prev) => mergeRawById(prev, docs))

      archiveHasMoreRef.current = snap.docs.length === 50

      setArchiveHasMore(archiveHasMoreRef.current)
    } catch (err) {
      console.error("Archive load more failed", err)
    } finally {
      setArchiveLoadingMore(false)
    }
  }

  const loadMoreRef = useRef<() => void>(() => {})

  loadMoreRef.current = () => {
    if (archiveView) loadMoreArchive()
    else loadMoreFeed()
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

      tags:
        Array.isArray(data.tags) && data.tags.length > 0
          ? data.tags

              .map(sanitizeTag)

              .filter(Boolean)

              .slice(0, MAX_TAGS)
          : deriveTags(data),

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

    setDoc(doc(db, "polls", newPoll.id), toRawPoll(newPoll, anonId))

      .then(() => showToast("🌴 Posted!", 2000))

      .catch((err) => {
        console.error("Post poll failed", err)

        // Roll back the optimistic insert so no phantom poll lingers

        // in the feed after a rejected write.

        setRawPolls((prev) => prev.filter((p) => p.id !== newPoll.id))

        showToast("Post failed — check your connection", 3500)
      })
  }

  const handleDeletePoll = (id: string) => {
    setConfirmDelete(null)

    const remove = (prev: RawPoll[]) => prev.filter((p) => p.id !== id)

    setRawPolls(remove)

    setOlderPolls(remove)

    setArchiveRawPolls(remove)

    setOlderArchivePolls(remove)

    deleteDoc(doc(db, "polls", id)).catch((err) =>
      console.error("Delete poll failed", err),
    )
  }

  const handleArchivePoll = (id: string) => {
    setConfirmDelete(null)

    const archive = (prev: RawPoll[]) =>
      prev.map((p) => (p.id === id ? { ...p, archived: true } : p))

    setRawPolls(archive)

    setOlderPolls(archive)

    setArchiveRawPolls(archive)

    setOlderArchivePolls(archive)

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

  const filtered = useMemo(
    () =>
      (archiveView ? archivePolls : polls).filter((p) => {
        const q = search.toLowerCase()

        const matchSearch =
          !q ||
          p.question.toLowerCase().includes(q) ||
          (p.description?.toLowerCase().includes(q) ?? false) ||
          p.author.toLowerCase().includes(q) ||
          p.options.some((o) => o.toLowerCase().includes(q)) ||
          p.tags.some((t) => t.includes(q))

        if (archiveView)
          return (
            p.expired &&
            matchSearch &&
            (filter === "all" || p.tags.includes(filter))
          )

        if (p.archived) return false

        if (showMine && p.creatorId !== anonId) return false

        const matchFilter = filter === "all" || p.tags.includes(filter)

        return matchFilter && matchSearch
      }),

    [archiveView, archivePolls, polls, search, showMine, anonId, filter],
  )

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (archiveView) {
          const votesA = a.votes.reduce((s, v) => s + v, 0)

          const votesB = b.votes.reduce((s, v) => s + v, 0)

          if (archiveSort === "newest") return b.createdAt - a.createdAt

          return votesB - votesA
        }

        const votesA = a.votes.reduce((s, v) => s + v, 0)

        const votesB = b.votes.reduce((s, v) => s + v, 0)

        if (sort === "newest") return b.createdAt - a.createdAt

        if (sort === "mostVoted") return votesB - votesA

        if (sort === "popular") return b.upvotes - a.upvotes

        if (sort === "trending" && a.expired !== b.expired)
          return a.expired ? 1 : -1

        if (a.hot !== b.hot) return a.hot ? -1 : 1

        return votesB - votesA
      }),

    [filtered, archiveView, archiveSort, sort],
  )

  // Everything already on screen during the first paint is "seen": entrance

  // animations are reserved for polls that arrive after the page has loaded,

  // so a reload at any scroll position never triggers a full-feed strobe.

  if (!bootedRef.current && sorted.length > 0) {
    bootedRef.current = true

    feedSeenRef.current = new Set(sorted.map((p) => p.id))
  }

  const effectiveView: "list" | "grid" = isNarrow
    ? "list"
    : archiveView
      ? "grid"
      : viewTouched
        ? view
        : "list"

  const gridView = effectiveView === "grid"

  const contentWidth = isNarrow ? "100%" : gridView ? 960 : 620

  // Infinite scroll: when the sentinel at the bottom of the feed enters the

  // viewport (600px margin), pull the next page. Re-observes whenever the

  // list size or active view changes so the sentinel is always wired up.

  useEffect(() => {
    const el = sentinelRef.current

    if (!el || typeof IntersectionObserver === "undefined") return

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current()
      },

      { rootMargin: "600px 0px" },
    )

    obs.observe(el)

    return () => obs.disconnect()
  }, [sorted.length, archiveView])

  if (sharedLoading) {
    return (
      <SharedStatusView
        message="Loading poll…"
        sub="Fetching the island chatter."
        onHome={exitShared}
      />
    )
  }

  if (sharedMissing) {
    return (
      <SharedStatusView
        message="Poll not found"
        sub="This poll may have been removed or expired."
        onHome={exitShared}
      />
    )
  }

  if (sharedPoll) {
    return (
      <SharedPollView
        poll={sharedPoll}
        onHome={exitShared}
        onVote={handleSharedVote}
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

          background: "var(--bg)",

          transform: chromeHidden ? "translateY(-100%)" : "translateY(0)",

          transition: "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <header
          style={{
            background: "var(--bg)",

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
                {/* Mobile row 1: logo + online counter, controls right */}
                <div
                  style={{
                    display: "flex",

                    alignItems: "flex-start",

                    gap: 8,

                    padding: "10px 0 6px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",

                      flexDirection: "column",

                      gap: 5,
                    }}
                  >
                    <button
                      onClick={() => {
                        setSearch("")

                        setFilter("all")

                        setSort("newest")

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
                        className="logo-flow"
                        style={{
                          fontFamily: "Satoshi, sans-serif",

                          fontSize: 22,

                          fontWeight: 900,

                          background: "var(--gradient)",

                          backgroundSize: "200% auto",

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
                      <IslandLogo size={18} />
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

                      gap: 8,
                    }}
                  >
                    <button
                      onClick={() => setShowArchive(true)}
                      title="View results"
                      style={{
                        display: "flex",

                        alignItems: "center",

                        gap: 5,

                        background: "var(--surface)",

                        border: "1px solid var(--border)",

                        borderRadius: 10,

                        height: 40,

                        padding: "0 14px",

                        lineHeight: 1,

                        color: "var(--text-dim)",

                        fontFamily: "Satoshi, sans-serif",

                        fontWeight: 800,

                        fontSize: 13.5,

                        cursor: "pointer",

                        transition: "all 0.15s",
                      }}
                    >
                      <ArchiveIcon size={15} />
                      Results
                    </button>
                    <ThemeSwatchButton theme={theme} compact onOpen={() => setShowTheme(true)} />
                    <UserMenu
                      isAdmin={isAdmin}
                      userEmail={user?.email}
                      onMyPolls={() => {
                        setShowMine(!showMine)

                        setShowArchive(false)

                        setShowModal(false)

                        window.scrollTo({ top: 0, behavior: "smooth" })
                      }}
                      onRules={() => setShowRules(true)}
                      onSignIn={handleAdminLogin}
                      onSignOut={handleAdminLogout}
                    />
                  </div>
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

                      setSort("newest")

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
                        className="logo-flow"
                        style={{
                          fontFamily: "Satoshi, sans-serif",

                          fontSize: 22,

                          fontWeight: 900,

                          background: "var(--gradient)",

                          backgroundSize: "200% auto",

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
                  <button
                    onClick={() => setShowArchive(true)}
                    title="View results"
                    style={{
                      display: "flex",

                      alignItems: "center",

                      gap: 5,

                      background: "var(--surface)",

                      border: "1px solid var(--border)",

                      borderRadius: 9,

                      height: 36,

                      padding: "0 16px",

                      lineHeight: 1,

                      color: "var(--text-dim)",

                      fontFamily: "Satoshi, sans-serif",

                      fontWeight: 800,

                      fontSize: 13,

                      cursor: "pointer",

                      transition: "all 0.15s",
                    }}
                  >
                    <ArchiveIcon size={15} />
                    Results
                  </button>
                  <ThemeSwatchButton theme={theme} onOpen={() => setShowTheme(true)} />
                  <UserMenu
                    isAdmin={isAdmin}
                    userEmail={user?.email}
                    onMyPolls={() => {
                      setShowMine(!showMine)

                      setShowArchive(false)

                      setShowModal(false)

                      window.scrollTo({ top: 0, behavior: "smooth" })
                    }}
                    onRules={() => setShowRules(true)}
                    onSignIn={handleAdminLogin}
                    onSignOut={handleAdminLogout}
                  />
                </div>
              </div>
            )}

            {/* Cove search — hidden on mobile main feed where search lives
                inline next to the tags/sort controls */}
            {!(isNarrow && !archiveView) && (
              <div
                style={{
                  paddingTop: isNarrow ? 5 : 11,

                  paddingBottom: isNarrow ? 12 : 16,
                }}
              >
                <div
                  style={{
                    position: "relative",

                    borderRadius: 99,

                    padding: "1.5px",

                    background:
                      "linear-gradient(120deg, var(--primary-soft) 0%, var(--accent-soft) 50%, var(--primary-soft) 100%)",

                    boxShadow: searchActive
                      ? "0 10px 36px var(--primary-glow-strong)"
                      : "none",

                    transition: "box-shadow 0.25s",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <span
                      style={{
                        position: "absolute",

                        left: isNarrow ? 15 : 18,

                        top: "50%",

                        transform: "translateY(-50%)",

                        pointerEvents: "none",

                        opacity: 0.6,

                        color: "var(--text-muted)",
                      }}
                    >
                      <SearchIcon size={isNarrow ? 14 : 15} />
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

                        padding: isNarrow ? "10px 40px" : "14px 46px",

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
            )}
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
              isNarrow ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: "var(--accent)",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <ArchiveIcon size={16} /> Results
                    </span>
                    <button
                      onClick={() => setShowArchive(false)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
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
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    {(() => {
                      const totalVotes = archiveClosed.reduce(
                        (s, p) => s + p.votes.reduce((a, v) => a + v, 0),
                        0,
                      )
                      return (
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            color: "var(--text-dim)",
                          }}
                        >
                          {sorted.length} closed poll
                          {sorted.length !== 1 ? "s" : ""}
                          <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                          {totalVotes} votes cast
                        </span>
                      )
                    })()}
                    <div
                      style={{
                        display: "flex",
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 9,
                        padding: 2,
                      }}
                    >
                      {([
                        { value: "newest", label: "Newest", Icon: ClockIcon },
                        {
                          value: "mostVoted",
                          label: "Most Voted",
                          Icon: ChartIcon,
                        },
                      ] as const).map((opt) => {
                        const active = archiveSort === opt.value
                        return (
                          <button
                            key={opt.value}
                            onClick={() => setArchiveSort(opt.value)}
                            style={{
                              background: active
                                ? "var(--primary-soft-bg)"
                                : "transparent",
                              color: active
                                ? "var(--primary)"
                                : "var(--text-muted)",
                              border: "none",
                              borderRadius: 7,
                              padding: "5px 9px",
                              fontFamily: "Satoshi, sans-serif",
                              fontWeight: 800,
                              fontSize: 11.5,
                              cursor: "pointer",
                              transition: "all 0.15s",
                              whiteSpace: "nowrap",
                              flexShrink: 0,
                            }}
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                            >
                              <opt.Icon size={12} />
                              {opt.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
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
                    <ArchiveIcon size={14} /> Results
                  </span>
                  {archiveView &&
                    (() => {
                      const totalVotes = archiveClosed.reduce(
                        (s, p) => s + p.votes.reduce((a, v) => a + v, 0),
                        0,
                      )
                      return (
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            color: "var(--text-dim)",
                          }}
                        >
                          {sorted.length} closed poll
                          {sorted.length !== 1 ? "s" : ""}
                          <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                          {totalVotes} votes cast
                        </span>
                      )
                    })()}
                  <div
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <button
                      onClick={() => setShowArchive(false)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-start",
                        gap: 7,
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
                    <div
                      style={{
                        display: "flex",
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 3,
                      }}
                    >
                      {([
                        { value: "newest", label: "Newest", Icon: ClockIcon },
                        {
                          value: "mostVoted",
                          label: "Most Voted",
                          Icon: ChartIcon,
                        },
                      ] as const).map((opt) => {
                        const active = archiveSort === opt.value
                        return (
                          <button
                            key={opt.value}
                            onClick={() => setArchiveSort(opt.value)}
                            style={{
                              background: active
                                ? "var(--primary-soft-bg)"
                                : "transparent",
                              color: active
                                ? "var(--primary)"
                                : "var(--text-muted)",
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
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 5,
                              }}
                            >
                              <opt.Icon size={13} />
                              {opt.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div
                style={{
                  display: "flex",

                  alignItems: "center",

                  gap: 10,

                  marginBottom: isNarrow ? 6 : 8,

                  flexWrap: "nowrap",
                }}
              >
                {isNarrow && (
                  <div
                    style={{
                      position: "relative",

                      flex: 1,

                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",

                        left: 11,

                        top: "50%",

                        transform: "translateY(-50%)",

                        pointerEvents: "none",

                        opacity: 0.6,

                        color: "var(--text-muted)",
                      }}
                    >
                      <SearchIcon size={13} />
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

                        padding: "8px 28px",

                        color: "var(--text)",

                        fontSize: 12.5,

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

                          right: 8,

                          top: "50%",

                          transform: "translateY(-50%)",

                          background: "var(--surface-2)",

                          border: "none",

                          borderRadius: 99,

                          color: "var(--text-muted)",

                          cursor: "pointer",

                          fontSize: 10,

                          lineHeight: 1,

                          padding: "4px 6px",

                          fontFamily: "Satoshi, sans-serif",

                          fontWeight: 800,
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
                {isNarrow && (
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()

                        setMobileTagsOpen(!mobileTagsOpen)
                      }}
                      className="tag-pill"
                      style={{
                        display: "flex",

                        alignItems: "center",

                        gap: 5,

                        background: "var(--surface)",

                        color: "var(--text-muted)",

                        padding: "7px 9px",

                        borderRadius: 99,

                        border: "1px solid var(--border)",

                        cursor: "pointer",

                        transition: "all 0.15s",

                        fontFamily: "Satoshi, sans-serif",

                        fontWeight: 800,

                        fontSize: 11.5,

                        boxShadow: "none",
                      }}
                    >
                      <span
                        style={{
                          whiteSpace: "nowrap",

                          maxWidth: 90,

                          overflow: "hidden",

                          textOverflow: "ellipsis",
                        }}
                      >
                        {filters.find((f) => String(f.value) === filter)
                          ?.label ?? "All"}
                      </span>
                      <span
                        style={{
                          fontSize: 9,

                          opacity: 0.7,

                          transform: mobileTagsOpen ? "rotate(180deg)" : "none",

                          transition: "transform 0.15s",
                        }}
                      >
                        ▼
                      </span>
                    </button>
                    {mobileTagsOpen && (
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

                          padding: 6,

                          minWidth: 160,

                          width: "max-content",

                          maxWidth: "calc(100vw - 28px)",

                          maxHeight: 320,

                          overflowY: "auto",

                          overflowX: "hidden",

                          boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
                        }}
                      >
                        {filters.map((f) => {
                          const fv = String(f.value)

                          const active = filter === fv

                          return (
                            <button
                              key={fv}
                              onClick={() => {
                                setFilter(fv)

                                setMobileTagsOpen(false)
                              }}
                              style={{
                                display: "flex",

                                alignItems: "center",

                                gap: 8,

                                width: "100%",

                                background: active
                                  ? "var(--bg)"
                                  : "transparent",

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
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {String(f.label)}
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
                )}
                {!isNarrow && (
                  <div
                    style={{
                      display: "flex",

                      alignItems: "center",

                      gap: 6,

                      flex: 1,

                      minWidth: 0,

                      flexWrap: "nowrap",
                    }}
                  >
                    <div
                      ref={(el) => {
                        if (!el) return

                        el.onwheel = (e) => {
                          const canScroll = el.scrollWidth > el.clientWidth

                          if (
                            !canScroll ||
                            Math.abs(e.deltaY) <= Math.abs(e.deltaX)
                          )
                            return

                          e.preventDefault()

                          el.scrollLeft += e.deltaY
                        }
                      }}
                      style={{
                        display: "flex",

                        flex: 1,

                        minWidth: 0,

                        background: "var(--surface)",

                        border: "1px solid var(--border)",

                        borderRadius: 9,

                        padding: 2,

                        width: "100%",

                        overflowX: "auto",

                        overflowY: "hidden",

                        scrollbarWidth: "none",

                        userSelect: "none",

                        WebkitUserSelect: "none",
                      }}
                    >
                      {filters.map((f, i) => {
                        const fv = String(f.value)

                        const active = filter === fv

                        return (
                          <Fragment key={fv}>
                            {i > 0 && (
                              <span
                                aria-hidden
                                style={{
                                  width: 1,

                                  alignSelf: "stretch",

                                  background: "var(--border)",

                                  margin: "3px 1px",
                                }}
                              />
                            )}
                            <button
                              onClick={() => setFilter(fv)}
                              style={{
                                display: "flex",

                                alignItems: "center",

                                justifyContent: "center",

                                background: active
                                  ? "var(--primary-soft-bg)"
                                  : "transparent",

                                color: active
                                  ? "var(--primary)"
                                  : "var(--text-muted)",

                                border: "none",

                                borderRadius: 7,

                                padding: "5px 10px",

                                fontFamily: "Satoshi, sans-serif",

                                fontWeight: 800,

                                fontSize: isNarrow ? 11 : 11.5,

                                cursor: "pointer",

                                transition: "all 0.15s",

                                whiteSpace: "nowrap",

                                flexShrink: 0,
                              }}
                            >
                              {String(f.label)}
                            </button>
                          </Fragment>
                        )
                      })}
                    </div>
                  </div>
                )}

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

                      gap: 6,

                      background: "var(--surface)",

                      color: "var(--text-muted)",

                      padding: "7px 10px",

                      borderRadius: 99,

                      border: "1px solid var(--border)",

                      cursor: "pointer",

                      transition: "all 0.15s",

                      fontFamily: "Satoshi, sans-serif",

                      fontWeight: 800,

                      fontSize: 13,

                      boxShadow: "none",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",

                        alignItems: "center",

                        gap: 6,
                      }}
                    >
                      {(() => {
                        const cur =
                          FEED_SORTS.find((o) => o.value === sort) ??
                          FEED_SORTS[0]

                        const CurIcon = cur.Icon

                        return <CurIcon size={15} />
                      })()}
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

                        left: isNarrow ? "auto" : 0,

                        right: isNarrow ? 0 : "auto",

                        top: "calc(100% + 8px)",

                        zIndex: 61,

                        background: "var(--surface-2)",

                        border: "1px solid var(--border)",

                        borderRadius: 14,

                        padding: 6,

                        minWidth: 190,

                        width: "max-content",

                        maxWidth: isNarrow ? "calc(100vw - 28px)" : 380,

                        maxHeight: 320,

                        overflowY: "auto",

                        overflowX: "hidden",

                        boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
                      }}
                    >
                      {FEED_SORTS.map((o) => {
                        const active = sort === o.value

                        return (
                          <button
                            key={o.value}
                            onClick={() => {
                              setSort(o.value)

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
                            <span
                              style={{
                                display: "inline-flex",

                                alignItems: "center",

                                gap: 8,
                              }}
                            >
                              <o.Icon size={13} />
                              {o.label}
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

                {/* View toggle */}
                {!isNarrow && !archiveView && (
                  <div
                    style={{
                      display: "flex",

                      gap: 2,

                      flexShrink: 0,

                      marginLeft: 0,

                      background: "var(--surface)",

                      border: "1px solid var(--border)",

                      borderRadius: 9,

                      padding: 2,
                    }}
                  >
                    {([
                      { value: "list", label: "List" },

                      { value: "grid", label: "Grid" },
                    ] as const).map((opt) => {
                      const active = effectiveView === opt.value

                      return (
                        <button
                          key={opt.value}
                          onClick={() => {
                            setView(opt.value)

                            setViewTouched(true)
                          }}
                          title={`${opt.value} view`}
                          style={{
                            display: "flex",

                            alignItems: "center",

                            justifyContent: "center",

                            gap: 5,

                            background: active
                              ? "var(--primary-soft-bg)"
                              : "transparent",

                            color: active
                              ? "var(--primary)"
                              : "var(--text-muted)",

                            border: "none",

                            borderRadius: 7,

                            padding: "5px 8px",

                            fontFamily: "Satoshi, sans-serif",

                            fontWeight: 800,

                            fontSize: 12,

                            cursor: "pointer",

                            transition: "all 0.15s",
                          }}
                        >
                          {opt.value === "list" ? (
                            <ListIcon size={15} />
                          ) : (
                            <GridIcon size={15} />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div
          className="filter-line"
          style={{
            height: 3,
          }}
        />
      </div>

      {/* Feed */}
      <main
        style={{
          maxWidth: contentWidth,

          margin: "0 auto",

          padding: isNarrow ? "12px 14px 96px" : "22px 14px 96px",
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
        {(search || (!archiveView && filter !== "all")) && (
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

        {archiveView && <div style={{ height: 12 }} />}

        {loading && sorted.length === 0 ? (
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
              background:
                "linear-gradient(160deg, var(--card-top) 0%, var(--card-bottom) 100%)",

              border: "1px solid var(--border)",

              borderRadius: 20,

              padding: "44px 20px",

              textAlign: "center",

              color: "var(--text-faint)",
            }}
          >
            <p style={{ fontSize: 36, margin: "0 0 10px" }}>
              {archiveView ? "🕰️" : showMine ? "🗳️" : "🌱"}
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
              {archiveView
                ? "No results yet"
                : showMine
                  ? "No polls yet"
                  : "Nothing here"}
            </p>
            <p
              style={{
                fontSize: 13,

                margin: "0 0 22px",

                fontWeight: 600,
              }}
            >
              {archiveView
                ? search
                  ? "No results match that search."
                  : "Polls stay live for a while — when they close, results land here."
                : showMine
                  ? "Polls you post will show up here."
                  : search
                    ? "Try a different search."
                    : "Be the first to ask something."}
            </p>
            {search && (
              <button
                onClick={() => setSearch("")}
                style={{
                  background: "var(--gradient)",

                  border: "none",

                  borderRadius: 10,

                  padding: "9px 18px",

                  color: "#fff",

                  fontFamily: "Satoshi, sans-serif",

                  fontWeight: 800,

                  fontSize: 13,

                  cursor: "pointer",

                  boxShadow: "0 4px 18px var(--primary-glow-strong)",
                }}
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div
            style={
              gridView
                ? {
                    // Pure CSS masonry via multi-column flow: cards pack to

                    // their own content height (height: auto) with no row

                    // stretching and no JS column-height measurement. On

                    // desktop exactly two masonry columns fill the container,

                    // so two poll tiles sit side by side in each "row".

                    columnCount: isNarrow ? 3 : 2,

                    columnGap: isNarrow ? 12 : 14,

                    minWidth: 0,

                    maxWidth: "100%",
                  }
                : {
                    display: "flex",

                    flexDirection: "column",

                    gap: 16,

                    minWidth: 0,

                    maxWidth: "100%",
                  }
            }
          >
            {sorted.map((poll, i) => {
              const isNew = !feedSeenRef.current.has(poll.id)

              return (
                <div
                  key={poll.id}
                  style={{
                    breakInside: "avoid",

                    display: "inline-block",

                    width: "100%",

                    marginBottom: gridView ? (isNarrow ? 12 : 14) : 0,
                  }}
                >
                  <PollCard
                    poll={poll}
                    now={now}
                    onVote={handleVote}
                    onComment={handleComment}
                    onLikeComment={handleLikeComment}
                    onRedditVote={handleRedditVote}
                    onReplyComment={handleReplyComment}
                    onShare={handleShare}
                    openComments={poll.id === openCommentsId}
                    compact={false}
                    isAdmin={isAdmin}
                    animateEnter={isNew}
                    enterDelay={Math.min(i, 4) * 40}
                    openResults={archiveView}
                    bareResults={archiveView}
                    isNarrow={isNarrow}
                    onDelete={(id) =>
                      setConfirmDelete(polls.find((p) => p.id === id) ?? null)
                    }
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Infinite-scroll sentinel: invisible marker that triggers the next
        page of older polls when it scrolls into view. A manual "Load more"
        button is also rendered as a fallback (e.g. no IntersectionObserver). */}
        {(hasMore || archiveHasMore) && (
          <div ref={sentinelRef} style={{ height: 1, width: "100%" }} />
        )}

        {(hasMore || archiveHasMore) && (
          <div
            style={{
              display: "flex",

              justifyContent: "center",

              padding: "16px 0 4px",
            }}
          >
            <button
              onClick={() => loadMoreRef.current()}
              disabled={loadingMore || archiveLoadingMore}
              style={{
                background: "var(--surface-2)",

                border: "1px solid var(--accent-soft)",

                borderRadius: 10,

                padding: "9px 18px",

                color: "var(--accent)",

                fontFamily: "Satoshi, sans-serif",

                fontWeight: 800,

                fontSize: 13,

                cursor: loadingMore || archiveLoadingMore ? "wait" : "pointer",

                transition: "all 0.15s",
              }}
            >
              {loadingMore || archiveLoadingMore
                ? "Loading…"
                : "Load more polls"}
            </button>
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
            made by zaylo69
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

          borderTop: "1px solid var(--border)",

          padding: isNarrow
            ? "10px 16px calc(16px + env(safe-area-inset-bottom))"
            : "10px 16px 22px",

          display: "flex",

          justifyContent: "center",
        }}
      >
        <button
          onClick={() => setShowModal(true)}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()

            addCtaRipple(e.clientX - rect.left, e.clientY - rect.top)

            if (e.pointerType === "touch") playCreateSound()
          }}
          onMouseMove={(e) => {
            if (!window.matchMedia("(hover: hover)").matches) return

            const el = ctaFollowerRef.current

            if (el) {
              el.style.left = `${e.clientX - e.currentTarget.getBoundingClientRect().left}px`

              el.style.top = `${e.clientY - e.currentTarget.getBoundingClientRect().top}px`

              el.classList.add("on")
            }
          }}
          onMouseLeave={() => ctaFollowerRef.current?.classList.remove("on")}
          style={{
            position: "relative",

            overflow: "hidden",

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

            boxShadow: "0 4px 18px var(--primary-glow)",

            letterSpacing: "0.01em",
          }}
        >
          <div
            ref={ctaFollowerRef}
            className="cta-follower"
            style={{
              width: 240,

              height: 240,

              marginLeft: -120,

              marginTop: -120,

              left: "50%",

              top: "50%",
            }}
          />
          {ripples.map((r) => (
            <span
              key={r.id}
              className="ripple"
              style={{
                left: r.x,

                top: r.y,

                width: 180,

                height: 180,
              }}
            />
          ))}
          <span
            style={{
              position: "relative",

              display: "flex",

              alignItems: "center",

              justifyContent: "center",

              gap: 8,
            }}
          >
            <SproutIcon size={17} />
            {CTA_PHRASES[ctaIndex]}
          </span>
        </button>
      </div>

      {showModal && (
        <NewPollModal
          onClose={() => setShowModal(false)}
          onSubmit={handleNewPoll}
          existingTags={tagSuggestions}
        />
      )}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      {showTheme && (
        <ThemeModal
          theme={theme}
          onTheme={setTheme}
          onClose={() => setShowTheme(false)}
        />
      )}
      {welcomeOpen && (
        <WelcomeModal
          onClose={() => {
            try {
              localStorage.setItem("bageecha-welcomed", "1")
            } catch {
              /* storage unavailable — welcome may show again */
            }

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
                  <ArchiveIcon size={15} /> Close instead
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
                <TrashIcon size={15} /> Delete permanently
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
