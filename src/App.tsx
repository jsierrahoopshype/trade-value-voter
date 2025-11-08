import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./styles.css";

/* -------------------- Types -------------------- */
type Player = {
  player_id: number;
  player_name: string;
  team: string;
  headshot_url?: string | null;
  salary_2026?: number | null;
  salary_text?: string | null;
  active?: boolean | null;
};

type Agg = {
  p_small: number;
  p_large: number;
  wins_small: number;
  wins_large: number;
};

/* -------------------- Utils -------------------- */
const fmtMoney = (v?: number | null) => {
  if (v == null) return "";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `$${Math.round(v).toLocaleString()}`;
  }
};

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

const avatarBg = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 45%)`;
};

function PlayerAvatar({
  name,
  url,
  size = 56,
}: {
  name: string;
  url?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
          color: "white",
          background: avatarBg(name),
          border: "1px solid #e5e5e5",
        }}
      >
        {initials(name)}
      </div>
    );
  }
  return (
    <img
      alt={name}
      src={url}
      loading="lazy"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "cover",
        borderRadius: 12,
        border: "1px solid #e5e5e5",
        background: "#f8f8f8",
      }}
      onError={() => setBroken(true)}
    />
  );
}

/* -------------------- Bradley–Terry -> Avg win prob vs random opponent -------------------- */
// score(i) = average_j Pr(i beats j) = average_j w_i / (w_i + w_j)
function bradleyTerryWithWinRate(players: Player[], aggs: Agg[], team?: string) {
  const pool = players.filter((p) => !team || p.team === team);
  const ids = pool.map((p) => p.player_id);
  const idToIdx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  if (n < 2) return pool.map((p) => ({ player: p, score: 0.5 }));

  const prior = 0.5; // small smoothing

  const edges: Array<[number, number, number, number]> = [];
  for (const a of aggs) {
    const i = idToIdx.get(a.p_small);
    const j = idToIdx.get(a.p_large);
    if (i == null || j == null) continue;
    edges.push([i, j, a.wins_small + prior, a.wins_large + prior]);
  }
  if (edges.length === 0) return pool.map((p) => ({ player: p, score: 0.5 }));

  const w = new Array(n).fill(1 / n);

  for (let it = 0; it < 250; it++) {
    const denom = new Array(n).fill(0);
    const numer = new Array(n).fill(0);

    for (const [i, j, wij, wji] of edges) {
      const s = w[i] + w[j];
      if (s <= 0) continue;
      const tot = wij + wji;
      denom[i] += tot * (w[i] / s);
      denom[j] += tot * (w[j] / s);
      numer[i] += wij;
      numer[j] += wji;
    }

    for (let i = 0; i < n; i++) if (denom[i] > 0) w[i] = numer[i] / denom[i];

    const sum = w.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) w[i] /= sum;
  }

  const avgWin = (i: number) => {
    let s = 0;
    for (let j = 0; j < n; j++) if (j !== i) s += w[i] / (w[i] + w[j]);
    return s / (n - 1);
  };

  const scored = pool.map((p, idx) => ({ player: p, score: avgWin(idx) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* -------------------- Data fetch -------------------- */
async function fetchPlayers(): Promise<Player[]> {
  const { data, error } = await supabase
    .from("players")
    .select(
      "player_id, player_name, team, headshot_url, salary_2026, salary_text, active"
    )
    .order("player_name", { ascending: true });
  if (error) throw error;
  const rows = (data || []) as Player[];
  return rows.filter((r) => r.active == null || r.active);
}

async function fetchAggs(): Promise<Agg[]> {
  const { data, error } = await supabase
    .from("pairwise_aggregates")
    .select("p_small, p_large, wins_small, wins_large");
  if (error) throw error;
  return (data || []) as Agg[];
}

/* -------------------- Balanced sampler -------------------- */
/** Build exposure counts per player_id from aggregates. */
function exposureCounts(aggs: Agg[]) {
  const c = new Map<number, number>();
  for (const a of aggs) {
    c.set(a.p_small, (c.get(a.p_small) || 0) + a.wins_small + a.wins_large);
    c.set(a.p_large, (c.get(a.p_large) || 0) + a.wins_small + a.wins_large);
  }
  return c;
}

/** Pick one underexposed + one random (no repeats), with a short cooldown. */
function pickBalancedPair(pool: Player[], counts: Map<number, number>, cooldown: Set<string>) {
  if (pool.length < 2) return [];

  // sort by exposure ascending
  const withCnt = pool
    .map((p) => ({ p, cnt: counts.get(p.player_id) || 0 }))
    .sort((a, b) => a.cnt - b.cnt);

  // candidate A: among least-exposed 25%
  const k = Math.max(1, Math.floor(withCnt.length * 0.25));
  const a = withCnt[Math.floor(Math.random() * k)].p;

  // candidate B: random different
  let b: Player = a;
  let guard = 0;
  while (b.player_id === a.player_id && guard++ < 10) {
    b = pool[Math.floor(Math.random() * pool.length)];
  }

  // avoid immediate repeats (unordered)
  const key = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const pairKey = key(a.player_id, b.player_id);
  if (cooldown.has(pairKey)) {
    // try once more
    guard = 0;
    while (guard++ < 10) {
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (cand.player_id !== a.player_id && !cooldown.has(key(a.player_id, cand.player_id))) {
        b = cand;
        break;
      }
    }
  }
  return [a, b];
}

/* -------------------- App -------------------- */
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [aggs, setAggs] = useState<Agg[]>([]);
  const [team, setTeam] = useState<string>("ALL");
  const [pair, setPair] = useState<Player[]>([]);
  const cooldown = useRef<Set<string>>(new Set()); // remember recent pairs
  const teams = useMemo(() => ["ALL", ...Array.from(new Set(players.map(p => p.team))).sort()], [players]);

  useEffect(() => {
    (async () => {
      const [pl, ag] = await Promise.all([fetchPlayers(), fetchAggs()]);
      setPlayers(pl);
      setAggs(ag);
    })().catch(console.error);
  }, []);

  const pool = useMemo(
    () => players.filter((p) => team === "ALL" || p.team === team),
    [players, team]
  );

  const nextPair = () => {
    if (pool.length < 2) {
      setPair([]);
      return;
    }
    const counts = exposureCounts(aggs);
    const pick = pickBalancedPair(pool, counts, cooldown.current);
    if (pick.length === 2) {
      const [a, b] = pick;
      setPair([a, b]);

      // track cooldown (limit size)
      const key = a.player_id < b.player_id ? `${a.player_id}-${b.player_id}` : `${b.player_id}-${a.player_id}`;
      cooldown.current.add(key);
      if (cooldown.current.size > 50) {
        // drop oldest entry
        const first = cooldown.current.values().next().value as string | undefined;
        if (first) cooldown.current.delete(first);
      }
    }
  };

  useEffect(() => {
    nextPair();
    // reset cooldown when pool changes drastically
    cooldown.current.clear();
  }, [pool.length, team]);

  const rankings = useMemo(
    () => bradleyTerryWithWinRate(players, aggs, team === "ALL" ? undefined : team),
    [players, aggs, team]
  );

  // IMPORTANT: store the on-screen left/right, winner separately.
  const submitVote = async (winnerSide: "left" | "right") => {
    if (pair.length !== 2) return;
    const left = pair[0];
    const right = pair[1];
    const winnerId = winnerSide === "left" ? left.player_id : right.player_id;

    try {
      const { error } = await supabase.from("pair_votes").insert([
        {
          left_player_id: left.player_id,   // on-screen left
          right_player_id: right.player_id, // on-screen right
          winner_player_id: winnerId,       // who won
        },
      ]);
      if (error) throw error;

      // refresh aggregates & pick next
      const ag = await fetchAggs();
      setAggs(ag);
    } catch (e) {
      console.error(e);
    } finally {
      nextPair();
    }
  };

  return (
    <div className="page">
      <header className="hdr">
        <h1>HoopsHype Trade-Value Voter</h1>
        <p className="sub">
          Pick who has more <b>trade value</b>. Rankings update live.
        </p>
        <div className="controls">
          <label>
            Team view:
            <select
              value={team}
              onChange={(e) => {
                setTeam(e.target.value);
                setTimeout(nextPair, 0);
              }}
            >
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t === "ALL" ? "All Teams" : t}
                </option>
              ))}
            </select>
          </label>
          <button onClick={nextPair}>New Pair</button>
        </div>
      </header>

      <section className="pair">
        {pair.length === 2 ? (
          <>
            <PlayerCard player={pair[0]} onVote={() => submitVote("left")} />
            <PlayerCard player={pair[1]} onVote={() => submitVote("right")} />
          </>
        ) : (
          <div className="loading">Loading players…</div>
        )}
      </section>

      <section className="rankings">
        <h2>Overall Rankings</h2>
        <ol>
          {rankings.map((r, idx) => (
            <li key={r.player.player_id}>
              <div className="row">
                <span className="num">{idx + 1}.</span>
                <span className="name">
                  {r.player.player_name} <em>({r.player.team})</em>
                </span>
                <span className="meta">
                  {r.player.salary_2026 != null
                    ? fmtMoney(r.player.salary_2026)
                    : r.player.salary_text ?? ""}
                  {" • "}
                  <span className="score">
                    score {(r.score * 100).toFixed(1)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/* -------------------- Card -------------------- */
function PlayerCard({
  player,
  onVote,
}: {
  player: Player;
  onVote: () => void;
}) {
  const money =
    player.salary_2026 != null
      ? fmtMoney(player.salary_2026)
      : player.salary_text ?? "";
  return (
    <button className="card" onClick={onVote}>
      <div className="top">
        <PlayerAvatar name={player.player_name} url={player.headshot_url ?? undefined} />
        <div className="info">
          <div className="nm">{player.player_name}</div>
          <div className="tm">{player.team}</div>
          <div className="sal">{money}</div>
        </div>
      </div>
      <div className="cta">VOTE</div>
    </button>
  );
}
