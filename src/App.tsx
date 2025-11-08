import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./styles.css";

/** ---------- Types ---------- */
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

/** ---------- Utils ---------- */
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

const initials = (name: string) => {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
};

const avatarBg = (name: string) => {
  // deterministic soft color from name
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 45%)`;
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

/** ---------- Bradley–Terry MM -> Avg win rate vs random opponent ---------- */
function bradleyTerryWithWinRate(
  players: Player[],
  aggs: Agg[],
  team?: string
) {
  const pool = players.filter((p) => !team || p.team === team);
  const ids = pool.map((p) => p.player_id);
  const idToIdx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  if (n < 2) return pool.map((p) => ({ player: p, score: 0.5 }));

  // Gentle prior to stabilize small samples
  const prior = 0.5;

  // Edge list
  const edges: Array<[number, number, number, number]> = [];
  for (const a of aggs) {
    const i = idToIdx.get(a.p_small);
    const j = idToIdx.get(a.p_large);
    if (i == null || j == null) continue;
    edges.push([i, j, a.wins_small + prior, a.wins_large + prior]);
  }
  if (edges.length === 0) {
    return pool.map((p) => ({ player: p, score: 0.5 }));
  }

  // Initialize strengths
  const w = new Array(n).fill(1 / n);

  // MM iterations
  for (let it = 0; it < 250; it++) {
    const denom = new Array(n).fill(0);
    const numer = new Array(n).fill(0);

    for (const [i, j, wij, wji] of edges) {
      const s = w[i] + w[j];
      const tot = wij + wji;
      if (s <= 0 || tot <= 0) continue;

      denom[i] += tot * (w[i] / s);
      denom[j] += tot * (w[j] / s);

      numer[i] += wij;
      numer[j] += wji;
    }

    for (let i = 0; i < n; i++) {
      if (denom[i] > 0) w[i] = numer[i] / denom[i];
    }

    // Normalize (sum=1)
    const sum = w.reduce((a, b) => a + b, 0);
    const s = sum || 1;
    for (let i = 0; i < n; i++) w[i] /= s;
  }

  // Average win probability vs a random opponent in current pool
  const avgWinProb = (i: number) => {
    let s = 0;
    for (let j = 0; j < n; j++) if (j !== i) s += w[i] / (w[i] + w[j]);
    return s / (n - 1);
  };

  const scored = pool.map((p, idx) => ({ player: p, score: avgWinProb(idx) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** ---------- Data hooks ---------- */
async function fetchPlayers(): Promise<Player[]> {
  const { data, error } = await supabase
    .from("players")
    .select(
      "player_id, player_name, team, headshot_url, salary_2026, salary_text, active"
    )
    .order("player_name", { ascending: true });
  if (error) throw error;
  const rows = (data || []) as Player[];
  // If there's an 'active' column, keep only active; else keep all
  return rows.filter((r) => r.active == null || r.active);
}

async function fetchAggs(): Promise<Agg[]> {
  const { data, error } = await supabase
    .from("pairwise_aggregates")
    .select("p_small, p_large, wins_small, wins_large");
  if (error) throw error;
  return (data || []) as Agg[];
}

/** ---------- UI ---------- */
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [aggs, setAggs] = useState<Agg[]>([]);
  const [team, setTeam] = useState<string>("ALL");
  const teams = useMemo(() => {
    const t = Array.from(new Set(players.map((p) => p.team))).sort();
    return ["ALL", ...t];
  }, [players]);

  // pick a pair to vote on
  const pool = useMemo(
    () => players.filter((p) => team === "ALL" || p.team === team),
    [players, team]
  );
  const [pair, setPair] = useState<Player[]>([]);

  const nextPair = () => {
    if (pool.length < 2) {
      setPair([]);
      return;
    }
    const i = Math.floor(Math.random() * pool.length);
    let j = Math.floor(Math.random() * pool.length);
    if (j === i) j = (j + 1) % pool.length;
    setPair([pool[i], pool[j]]);
  };

  // load data
  useEffect(() => {
    (async () => {
      const [pl, ag] = await Promise.all([fetchPlayers(), fetchAggs()]);
      setPlayers(pl);
      setAggs(ag);
    })().catch(console.error);
  }, []);

  useEffect(() => {
    nextPair();
  }, [pool.length]);

  // compute rankings with All-Our-Ideas style score
  const rankings = useMemo(
    () =>
      bradleyTerryWithWinRate(
        players,
        aggs,
        team === "ALL" ? undefined : team
      ),
    [players, aggs, team]
  );

  const handleVote = async (winner: Player, loser: Player) => {
    try {
      const left = winner.player_id;
      const right = loser.player_id;
      // Store canonical order (small, large) in your view; for votes we just log what user saw
      const { error } = await supabase.from("pair_votes").insert([
        {
          left_player_id: winner.player_id, // we keep the on-screen left/right simple
          right_player_id: loser.player_id,
          winner_player_id: winner.player_id,
        },
      ]);
      if (error) throw error;

      // Refresh aggregates after vote
      const ag = await fetchAggs();
      setAggs(ag);
      nextPair();
    } catch (e) {
      console.error(e);
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
            <PlayerCard player={pair[0]} onVote={() => handleVote(pair[0], pair[1])} />
            <PlayerCard player={pair[1]} onVote={() => handleVote(pair[1], pair[0])} />
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
                  <span className="score">score {(r.score * 100).toFixed(1)}</span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** ---------- Presentational card ---------- */
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
