import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

// ---- Types ----
type Player = {
  player_id: number;
  player_name: string;
  team: string | null;
  headshot_url: string | null;
  salary_text: string | null;    // always a string from the players_app view
  active: boolean | null;
};

type AggRow = {
  p_small: number;
  p_large: number;
  wins_small: number;
  wins_large: number;
  n_votes?: number;
};

// ---- Helpers ----
const TEAMS = [
  "All Teams","ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND",
  "LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC",
  "SAS","TOR","UTA","WAS"
];

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0,2).map(p => p[0] ?? "").join("").toUpperCase();

// =======================================================
//                        APP
// =======================================================
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [agg, setAgg] = useState<AggRow[]>([]);
  const [teamFilter, setTeamFilter] = useState<string>("All Teams");
  const [left, setLeft] = useState<Player | null>(null);
  const [right, setRight] = useState<Player | null>(null);
  const recentPairs = useRef<string[]>([]);

  // ---------- Load players (robust: active=true → active null/true → no filter) ----------
  useEffect(() => {
    (async () => {
      const fields =
        "player_id, player_name, team, headshot_url, salary_text, active";

      // 1) prefer active=true
      let { data, error } = await supabase
        .from("players_app")
        .select(fields)
        .eq("active", true)
        .order("player_name", { ascending: true });

      if (error) console.error("players_app (active=true) error:", error);

      // 2) fallback: active true OR null
      if (!data || data.length === 0) {
        const f = await supabase
          .from("players_app")
          .select(fields)
          .or("active.is.true,active.is.null")
          .order("player_name", { ascending: true });

        if (f.error) console.error("players_app (true/null) error:", f.error);
        data = f.data ?? data;
      }

      // 3) last resort: no filter (still limited to view’s columns)
      if (!data || data.length === 0) {
        const any = await supabase
          .from("players_app")
          .select(fields)
          .order("player_name", { ascending: true });

        if (any.error) console.error("players_app (no filter) error:", any.error);
        data = any.data ?? [];
      }

      setPlayers(data ?? []);
    })();
  }, []);

  // ---------- Load pairwise aggregates ----------
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("pairwise_aggregates")
        .select("p_small, p_large, wins_small, wins_large, n_votes");

      if (error) {
        console.error("pairwise_aggregates error:", error);
        setAgg([]);
        return;
      }
      setAgg((data ?? []) as AggRow[]);
    })();
  }, []);

  // ---------- Build player stats and scores (win rate proxy) ----------
  const stats = useMemo(() => {
    const m = new Map<number, { wins: number; losses: number; votes: number }>();
    for (const p of players) m.set(p.player_id, { wins: 0, losses: 0, votes: 0 });

    for (const r of agg) {
      const n = r.n_votes ?? r.wins_small + r.wins_large;
      const a = m.get(r.p_small);
      const b = m.get(r.p_large);
      if (a) { a.wins += r.wins_small; a.losses += r.wins_large; a.votes += n; }
      if (b) { b.wins += r.wins_large; b.losses += r.wins_small; b.votes += n; }
    }

    const score = (id: number) => {
      const s = m.get(id);
      if (!s || s.votes === 0) return 0.5;
      const wr = s.wins / (s.wins + s.losses);
      return isFinite(wr) ? wr : 0.5;
    };

    return { map: m, score };
  }, [players, agg]);

  const ranked = useMemo(
    () => [...players]
      .map(p => ({ player: p, score: stats.score(p.player_id) }))
      .sort((a, b) => b.score - a.score),
    [players, stats]
  );

  // ---------- Pair sampler (under-exposed bias + recent-pair cooldown) ----------
  const pickPair = () => {
    if (players.length < 2) return;

    const pool = teamFilter === "All Teams"
      ? players
      : players.filter(p => p.team === teamFilter);

    if (pool.length < 2) return;

    const exposure = pool
      .map(p => ({ p, votes: stats.map.get(p.player_id)?.votes ?? 0 }))
      .sort((a, b) => a.votes - b.votes);

    const slice = Math.max(2, Math.ceil(pool.length * 0.25));
    const under = exposure.slice(0, slice).map(x => x.p);

    function rand<T>(arr: T[]) { return arr[Math.floor(Math.random() * arr.length)]; }

    let a: Player, b: Player;
    let tries = 50;
    while (tries-- > 0) {
      a = Math.random() < 0.7 ? rand(under) : rand(pool);
      do { b = rand(pool); } while (b.player_id === a.player_id);

      const key = a.player_id < b.player_id
        ? `${a.player_id}-${b.player_id}`
        : `${b.player_id}-${a.player_id}`;

      if (!recentPairs.current.includes(key)) {
        recentPairs.current.unshift(key);
        if (recentPairs.current.length > 50) recentPairs.current.pop();
        setLeft(a); setRight(b);
        return;
      }
    }
    // fallback
    a = rand(pool); do { b = rand(pool); } while (b.player_id === a.player_id);
    setLeft(a); setRight(b);
  };

  useEffect(() => { if (players.length) pickPair(); /* eslint-disable-next-line */}, [players, teamFilter]);

  // ---------- Vote ----------
  const vote = async (side: "left" | "right") => {
    if (!left || !right) return;
    const winnerId = side === "left" ? left.player_id : right.player_id;

    const { error } = await supabase.from("pair_votes").insert([{
      left_player_id: left.player_id,
      right_player_id: right.player_id,
      winner_player_id: winnerId,
    }]);

    if (error) console.error("vote insert error:", error);
    pickPair();
  };

  // ---------- UI ----------
  return (
    <div className="max-w-5xl mx-auto p-4">
      <h1 className="text-2xl font-semibold mb-2">HoopsHype Trade-Value Voter</h1>
      <p className="mb-4">Pick who has more <strong>trade value</strong>. Rankings update live.</p>

      <div className="flex items-center gap-2 mb-4">
        <label>Team view:</label>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
          {TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={pickPair}>New Pair</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {[left, right].map((p, idx) => (
          <div key={idx} className="border rounded-lg p-4 flex items-center gap-4">
            {p?.headshot_url ? (
              <img
                src={p.headshot_url}
                alt={p.player_name}
                width={64}
                height={64}
                style={{ borderRadius: 8 }}
                loading="lazy"
              />
            ) : (
              <div style={{
                width: 64, height: 64, borderRadius: 8,
                display: "grid", placeItems: "center",
                background: "#eee", fontWeight: 700
              }}>
                {p ? initials(p.player_name) : ""}
              </div>
            )}
            <div className="flex-1">
              <div className="font-medium">{p?.player_name ?? "Loading…"}</div>
              <div className="text-sm text-gray-600">
                {(p?.team ?? "").toUpperCase()} {p?.salary_text ? ` • ${p.salary_text}` : ""}
              </div>
            </div>
            <button onClick={() => vote(idx === 0 ? "left" : "right")} disabled={!p}>VOTE</button>
          </div>
        ))}
      </div>

      <h2 className="text-xl font-semibold mb-2">Overall Rankings</h2>
      <ol className="space-y-2">
        {ranked.map((r, i) => (
          <li key={r.player.player_id} className="flex items-center justify-between border-b pb-1">
            <span>
              {i + 1}. {r.player.player_name} ({r.player.team || ""})
            </span>
            <span className="text-sm text-gray-600">
              {r.player.salary_text ? `${r.player.salary_text} • ` : ""}
              score {(r.score * 100).toFixed(4)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
