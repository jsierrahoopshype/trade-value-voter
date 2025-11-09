import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ---------- Supabase client (env must exist in Vercel) ----------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseAnon);

// ---------- Types ----------
type Player = {
  player_id: number;
  player_name: string;
  team: string | null;
  headshot_url: string | null;
  salary_text: string | null;
  salary_2026: number | null;
};

type PairAgg = {
  p_small: number;
  p_large: number;
  wins_small: number;
  wins_large: number;
  n_votes: number;
};

// ---------- Helpers ----------
function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? "").join("");
}

function fmtMoney(x?: number | null) {
  if (x == null) return "";
  try {
    return x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(x).toLocaleString("en-US")}`;
  }
}

function shuffle2<T>(arr: T[]): [T, T] {
  if (arr.length < 2) throw new Error("Need at least 2 players");
  const a = Math.floor(Math.random() * arr.length);
  let b = Math.floor(Math.random() * arr.length);
  while (b === a) b = Math.floor(Math.random() * arr.length);
  return [arr[a], arr[b]];
}

// ---------- App ----------
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);

  const [pair, setPair] = useState<[Player | null, Player | null]>([null, null]);
  const [teamFilter, setTeamFilter] = useState<string>("ALL");

  const [ranking, setRanking] = useState<
    { player: Player; score: number; wins: number; total: number }[]
  >([]);
  const [loadingRanks, setLoadingRanks] = useState(true);
  const [voting, setVoting] = useState(false);

  // ---- Load players (no active filter) ----
  useEffect(() => {
    (async () => {
      setLoadingPlayers(true);
      const { data, error } = await supabase
        .from("players")
        .select("player_id, player_name, team, headshot_url, salary_text, salary_2026")
        .order("player_name");

      if (error) {
        console.error("load players error", error);
        setPlayers([]);
      } else {
        setPlayers(data as Player[]);
      }
      setLoadingPlayers(false);
    })();
  }, []);

  // ---- Load pairwise aggregates and build “All Our Ideas”-style score ----
  useEffect(() => {
    (async () => {
      setLoadingRanks(true);

      // Expect the view with columns: p_small, p_large, wins_small, wins_large, n_votes
      const { data, error } = await supabase
        .from("pairwise_aggregates")
        .select("p_small, p_large, wins_small, wins_large, n_votes");

      if (error) {
        console.error("load pairwise_aggregates error", error);
        setRanking([]);
        setLoadingRanks(false);
        return;
      }

      const rows = (data || []) as PairAgg[];

      // Accumulate per-player wins/total
      const wins = new Map<number, number>();
      const tot = new Map<number, number>();

      const add = (id: number, w: number, t: number) => {
        wins.set(id, (wins.get(id) || 0) + w);
        tot.set(id, (tot.get(id) || 0) + t);
      };

      for (const r of rows) {
        // p_small’s wins vs p_large are wins_small
        add(r.p_small, r.wins_small, r.n_votes);
        // p_large’s wins vs p_small are wins_large
        add(r.p_large, r.wins_large, r.n_votes);
      }

      // Create ranking array (default 0 when no votes)
      const byId = new Map(players.map(p => [p.player_id, p]));
      const ranked = players.map(p => {
        const w = wins.get(p.player_id) || 0;
        const t = tot.get(p.player_id) || 0;
        const score = t > 0 ? (w / t) * 100 : 50; // prior: 50 when unseen
        return { player: p, score, wins: w, total: t };
      });

      ranked.sort((a, b) => b.score - a.score);
      setRanking(ranked);
      setLoadingRanks(false);
    })();
    // re-run when players change (so we always score current list)
  }, [players]);

  // ---- Build list for current team filter ----
  const filteredPlayers = useMemo(() => {
    if (teamFilter === "ALL") return players;
    return players.filter(p => (p.team || "").toUpperCase() === teamFilter);
  }, [players, teamFilter]);

  // ---- Pick a new pair for current filter ----
  const dealPair = () => {
    if (filteredPlayers.length < 2) {
      setPair([null, null]);
      return;
    }
    const [a, b] = shuffle2(filteredPlayers);
    setPair([a, b]);
  };

  // pick a pair on load / whenever filter changes or players load
  useEffect(() => {
    if (!loadingPlayers) dealPair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingPlayers, teamFilter]);

  // ---- Teams for dropdown ----
  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const p of players) {
      const t = (p.team || "").toUpperCase();
      if (t) set.add(t);
    }
    return ["ALL", ...Array.from(set).sort()];
  }, [players]);

  // ---- Vote handler ----
  const doVote = async (winner: Player, loser: Player) => {
    try {
      setVoting(true);
      const left_id = pair[0]?.player_id ?? null;
      const right_id = pair[1]?.player_id ?? null;
      const { error } = await supabase.from("pair_votes").insert({
        left_player_id: left_id,
        right_player_id: right_id,
        winner_player_id: winner.player_id,
      });
      if (error) {
        console.error("insert vote error", error);
      }
    } finally {
      setVoting(false);
      dealPair(); // show a fresh pair
      // Optimistic: nudge the winner’s score locally to feel responsive (optional)
      setRanking(prev => {
        const n = prev.map(r =>
          r.player.player_id === (winner.player_id)
            ? { ...r, total: r.total + 1, wins: r.wins + 1, score: ((r.wins + 1) / (r.total + 1)) * 100 }
            : r.player.player_id === (loser.player_id)
            ? { ...r, total: r.total + 1, score: (r.wins / (r.total + 1)) * 100 }
            : r
        );
        n.sort((a, b) => b.score - a.score);
        return n;
      });
    }
  };

  // ---- Render helpers ----
  const PlayerCard = ({ p, onVote }: { p: Player; onVote: () => void }) => {
    const head = p.headshot_url;
    return (
      <div style={{
        border: "1px solid #ddd",
        borderRadius: 12,
        padding: 12,
        width: 340,
        display: "flex",
        gap: 12,
        alignItems: "center",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)"
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: 8, overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#f3f4f6", border: "1px solid #e5e7eb", flexShrink: 0
        }}>
          {head ? (
            // Avoid layout shift while loading images
            <img src={head} alt={p.player_name} width={64} height={64} style={{ objectFit: "cover" }} />
          ) : (
            <div style={{ fontWeight: 700, fontSize: 20 }}>{initials(p.player_name)}</div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{p.player_name}</div>
          <div style={{ fontSize: 12, color: "#4b5563" }}>
            {(p.team || "").toUpperCase()}
            {p.salary_text ? ` • ${p.salary_text}` : p.salary_2026 ? ` • ${fmtMoney(p.salary_2026)}` : ""}
          </div>
          <button
            onClick={onVote}
            disabled={voting}
            style={{
              marginTop: 8,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: voting ? "#f9fafb" : "#111827",
              color: voting ? "#6b7280" : "white",
              cursor: voting ? "not-allowed" : "pointer"
            }}
          >
            VOTE
          </button>
        </div>
      </div>
    );
  };

  // ---- UI ----
  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
        HoopsHype Trade-Value Voter
      </h1>
      <div style={{ color: "#374151", marginBottom: 12 }}>
        Pick who has more <b>trade value</b>. Rankings update live.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <span>Team view:</span>
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e5e7eb" }}
        >
          {teams.map(t => <option key={t} value={t}>{t === "ALL" ? "All Teams" : t}</option>)}
        </select>
        <button
          onClick={dealPair}
          style={{ marginLeft: 6, padding: "6px 10px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#f9fafb" }}
        >
          New Pair
        </button>
      </div>

      {/* Pair */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        {loadingPlayers ? (
          <div>Loading players…</div>
        ) : pair[0] && pair[1] ? (
          <>
            <PlayerCard p={pair[0]} onVote={() => doVote(pair[0]!, pair[1]!)} />
            <PlayerCard p={pair[1]} onVote={() => doVote(pair[1]!, pair[0]!)} />
          </>
        ) : (
          <div>No players available for this filter.</div>
        )}
      </div>

      {/* Rankings */}
      <h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 20, marginBottom: 10 }}>Overall Rankings</h2>
      {loadingRanks ? (
        <div>Loading rankings…</div>
      ) : (
        <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
          {ranking.map((r, i) => (
            <li key={r.player.player_id}>
              {i + 1}. {r.player.player_name} ({(r.player.team || "").toUpperCase()})
              {r.player.salary_text ? ` • ${r.player.salary_text}` : ""}
              {` • score ${r.score.toFixed(4)}`}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
