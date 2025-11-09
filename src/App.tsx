// src/App.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

type Player = {
  player_id: number;
  player_name: string;
  team: string | null;
  active?: boolean | null;
  headshot_url?: string | null;
  salary_text?: string | null;
  salary_2026?: number | null;
};

type AggRow = {
  p_small: number;
  p_large: number;
  wins_small: number | null;
  wins_large: number | null;
  n_votes: number | null;
};

function formatMoney(s?: string | null, n?: number | null) {
  if (s && s.trim()) return s;
  if (n != null) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }
  return "—";
}

/* -------------------- Bradley–Terry scoring (All Our Ideas style) -------------------- */
/** Estimate strengths p_i so P(i beats j) = p_i / (p_i + p_j) and report
 *  score = avg probability to beat a random opponent (0..1).
 */
function computeBT(
  players: Player[],
  agg: AggRow[],
  options: { iters?: number; priorMatches?: number } = {}
) {
  const iters = options.iters ?? 60;
  const priorMatches = options.priorMatches ?? 2; // small Laplace smoothing

  const ids = players.map((p) => p.player_id);
  const N = ids.length;

  const idx = new Map<number, number>();
  ids.forEach((id, i) => idx.set(id, i));

  // directed wins W[i][j], undirected matches M[i][j]
  const W = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const M = Array.from({ length: N }, () => new Array<number>(N).fill(0));

  for (const r of agg) {
    const i = idx.get(r.p_small);
    const j = idx.get(r.p_large);
    if (i == null || j == null) continue;
    const ws = r.wins_small ?? 0;
    const wl = r.wins_large ?? 0;
    const n = (r.n_votes ?? 0);
    // i beat j: ws, j beat i: wl
    W[i][j] += ws;
    W[j][i] += wl;
    M[i][j] += n;
    M[j][i] += n;
  }

  // mild prior so cold-start players don't spike wildly
  if (priorMatches > 0 && N > 1) {
    const add = priorMatches / (N - 1);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) if (i !== j) {
        M[i][j] += add;
        W[i][j] += add * 0.5;
      }
    }
  }

  const p = new Array<number>(N).fill(1); // initial abilities

  for (let t = 0; t < iters; t++) {
    const pNew = new Array<number>(N).fill(0);
    for (let i = 0; i < N; i++) {
      let Wi = 0;
      let denom = 0;
      for (let j = 0; j < N; j++) if (i !== j) {
        const n_ij = M[i][j];
        if (n_ij <= 0) continue;
        Wi += W[i][j];
        denom += n_ij / (p[i] + p[j]);
      }
      pNew[i] = denom > 0 ? Math.max(Wi / denom, 1e-12) : p[i];
    }
    // normalize for stability
    const mean = pNew.reduce((a, b) => a + b, 0) / (N || 1);
    for (let i = 0; i < N; i++) p[i] = pNew[i] / (mean || 1);
  }

  // score = avg P(i beats random j)
  const probVsRandom = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (N === 1) { probVsRandom.set(ids[i], 0.5); continue; }
    let sum = 0;
    for (let j = 0; j < N; j++) if (i !== j) {
      sum += p[i] / (p[i] + p[j]);
    }
    probVsRandom.set(ids[i], sum / (N - 1));
  }

  // exposure for sampling (total matches involving i)
  const exposure = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    let votes = 0;
    for (let j = 0; j < N; j++) if (i !== j) votes += M[i][j];
    exposure.set(ids[i], votes);
  }

  return { probVsRandom, exposure };
}

/* --------------------------------- Data Fetch --------------------------------- */

async function fetchPlayers(): Promise<Player[]> {
  const { data, error } = await supabase
    .from("players")
    .select("player_id, player_name, team, active, headshot_url, salary_text, salary_2026")
    .eq("active", true)
    .order("player_name");
  if (error) throw error;
  return data ?? [];
}

async function fetchAgg(): Promise<AggRow[]> {
  const { data, error } = await supabase
    .from("pairwise_aggregates")
    .select("p_small, p_large, wins_small, wins_large, n_votes");
  if (error) throw error;
  return data ?? [];
}

async function insertVote(leftId: number, rightId: number, winnerId: number) {
  const { error } = await supabase
    .from("pair_votes")
    .insert([{ left_player_id: leftId, right_player_id: rightId, winner_player_id: winnerId }]);
  if (error) throw error;
}

/* ------------------------------- UI Components ------------------------------- */

function PlayerCard({
  p,
  onVote,
  disabled,
}: {
  p: Player;
  onVote: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="card">
      <div className="card__media">
        {p.headshot_url ? (
          <img src={p.headshot_url} alt={p.player_name} loading="lazy" />
        ) : (
          <div className="avatar-fallback">{p.player_name.slice(0, 1)}</div>
        )}
      </div>
      <div className="card__body">
        <div className="card__name">{p.player_name}</div>
        <div className="card__meta">
          <span className="chip">{p.team ?? "—"}</span>
          <span className="dot">•</span>
          <span>{formatMoney(p.salary_text, p.salary_2026)}</span>
        </div>
      </div>
      <button className="btn" onClick={onVote} disabled={disabled}>VOTE</button>
    </div>
  );
}

/* ----------------------------------- App ----------------------------------- */

export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [agg, setAgg] = useState<AggRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [pair, setPair] = useState<[Player | null, Player | null]>([null, null]);
  const [busy, setBusy] = useState(false);

  // load data
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [ps, a] = await Promise.all([fetchPlayers(), fetchAgg()]);
        setPlayers(ps);
        setAgg(a);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // BT scoring
  const bt = useMemo(() => computeBT(players, agg, { iters: 60, priorMatches: 2 }), [players, agg]);

  const ranked = useMemo(
    () =>
      [...players]
        .map((p) => ({
          player: p,
          score: bt.probVsRandom.get(p.player_id) ?? 0.5,
        }))
        .sort((a, b) => b.score - a.score),
    [players, bt]
  );

  // available teams
  const teams = useMemo(() => {
    const set = new Set<string>();
    players.forEach((p) => p.team && set.add(p.team));
    return ["ALL", ...Array.from(set).sort()];
  }, [players]);

  const filteredPlayers = useMemo(
    () => (teamFilter === "ALL" ? players : players.filter((p) => p.team === teamFilter)),
    [players, teamFilter]
  );

  // pick a pair, biasing to lower exposure (under-voted players)
  function pickPair() {
    if (filteredPlayers.length < 2) {
      setPair([null, null]);
      return;
    }
    const ids = filteredPlayers.map((p) => p.player_id);
    const exps = ids.map((id) => bt.exposure.get(id) ?? 0);
    const maxExp = Math.max(1, ...exps);
    // weights ~ 1 / (1 + exposure), normalized
    const weights = exps.map((e) => 1 / (1 + e));
    const sumW = weights.reduce((a, b) => a + b, 0);
    const pickIndex = () => {
      const r = Math.random() * sumW;
      let acc = 0;
      for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (r <= acc) return i;
      }
      return weights.length - 1;
    };
    let i = pickIndex();
    let j = pickIndex();
    for (let tries = 0; tries < 6 && j === i; tries++) j = pickIndex();
    const left = filteredPlayers[i];
    const right = filteredPlayers[j === i ? (j + 1) % filteredPlayers.length : j];
    setPair([left, right]);
  }

  useEffect(() => {
    pickPair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamFilter, players, agg]); // repick when data or filter change

  async function handleVote(winner: Player, loser: Player) {
    if (busy) return;
    setBusy(true);
    try {
      // persist vote
      await insertVote(winner.player_id, loser.player_id, winner.player_id);
      // refresh aggregates (lightweight)
      const a = await fetchAgg();
      setAgg(a);
      // new pair
      pickPair();
    } catch (e) {
      console.error(e);
      alert("Vote failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="header">
        <h1>HoopsHype <strong>Trade</strong>-Value Voter</h1>
        <p className="sub">Pick who has more <strong>trade value</strong>. Rankings update live.</p>
        <div className="toolbar">
          <label>
            Team view:&nbsp;
            <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              {teams.map((t) => (
                <option key={t} value={t}>{t === "ALL" ? "All Teams" : t}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={pickPair}>New Pair</button>
        </div>
      </header>

      <main>
        <section className="vote-grid">
          {loading ? (
            <>
              <div className="card loading" />
              <div className="card loading" />
            </>
          ) : pair[0] && pair[1] ? (
            <>
              <PlayerCard
                p={pair[0]}
                disabled={busy}
                onVote={() => handleVote(pair[0]!, pair[1]!)}
              />
              <PlayerCard
                p={pair[1]}
                disabled={busy}
                onVote={() => handleVote(pair[1]!, pair[0]!)}
              />
            </>
          ) : (
            <div className="empty">No players available for this filter.</div>
          )}
        </section>

        <section className="table-block">
          <h2>Overall Rankings</h2>
          <ol className="rank-table">
            {ranked.map(({ player, score }) => (
              <li key={player.player_id} className="rank-row">
                <span className="rank-name">
                  {player.player_name} <span className="team">({player.team ?? "—"})</span>
                </span>
                <span className="rank-meta">
                  <span className="salary">{formatMoney(player.salary_text, player.salary_2026)}</span>
                  <span className="dot">•</span>
                  <span className="score">score {(score * 100).toFixed(3)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
