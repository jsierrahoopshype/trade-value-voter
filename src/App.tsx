import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import './styles.css'

type Player = {
  player_id: number
  player_name: string
  team: string | null
  active: boolean
  headshot_url: string | null
  salary_text: string | null
}

type PairRow = {
  p_small: number
  p_large: number
  wins_small: number
  wins_large: number
  n_votes: number
}

type Score = {
  player_id: number
  wins: number
  total: number
  score: number // 0..100 – p(win vs random) * 100
}

const TEAMS = [
  'All Teams','ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA',
  'MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'
]

function formatScore(s: number) {
  return (Math.round(s * 10000) / 10000).toFixed(4)
}

function letterAvatar(name: string) {
  const initials = name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase()
  return `https://placehold.co/160x160?text=${encodeURIComponent(initials)}`
}

export default function App() {
  const [players, setPlayers] = useState<Player[]>([])
  const [pairs, setPairs] = useState<PairRow[]>([])
  const [teamFilter, setTeamFilter] = useState<string>('All Teams')
  const [loading, setLoading] = useState(true)
  const [left, setLeft] = useState<Player | null>(null)
  const [right, setRight] = useState<Player | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // ---- load players and aggregates
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)

      // players from the tv view (read-only)
      const { data: pData, error: pErr } = await supabase
        .from('tv_players')
        .select('player_id,player_name,team,active,headshot_url,salary_text')
        .order('player_name', { ascending: true })

      if (pErr) {
        console.error('players error', pErr)
        setLoading(false)
        return
      }

      // aggregates view
      const { data: aData, error: aErr } = await supabase
        .from('tv_pairwise_aggregates')
        .select('p_small,p_large,wins_small,wins_large,n_votes')

      if (aErr) {
        console.error('aggregates error', aErr)
        setLoading(false)
        return
      }

      if (!cancelled) {
        setPlayers(pData || [])
        setPairs(aData || [])
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [])

  // ---- compute simple “p vs random” from aggregates
  const coverage = useMemo(() => {
    // wins/total across all pairs the player appears in
    const byId: Record<number, Score> = {}
    for (const p of players) {
      byId[p.player_id] = { player_id: p.player_id, wins: 0, total: 0, score: 50 }
    }
    for (const row of pairs) {
      const a = byId[row.p_small]; const b = byId[row.p_large]
      if (!a || !b) continue
      a.wins += row.wins_small
      b.wins += row.wins_large
      a.total += row.n_votes
      b.total += row.n_votes
    }
    // Laplace smoothing so new players don’t start at 0/NaN
    for (const s of Object.values(byId)) {
      const wins = s.wins + 1
      const total = s.total + 2
      s.score = 100 * (total > 0 ? wins / total : 0.5)
      s.wins = wins
      s.total = total
    }
    return byId
  }, [players, pairs])

  // ---- filtered list and rankings
  const filteredPlayers = useMemo(() => {
    if (teamFilter === 'All Teams') return players
    return players.filter(p => (p.team || '') === teamFilter)
  }, [players, teamFilter])

  const rankings = useMemo(() => {
    return [...players]
      .map(p => ({ p, s: coverage[p.player_id]?.score ?? 50 }))
      .sort((a, b) => b.s - a.s)
  }, [players, coverage])

  // ---- pick a pair (ε-greedy to boost coverage)
  function newPair() {
    const epsilon = 0.35 // exploration rate
    const pool = filteredPlayers
    if (pool.length < 2) { setLeft(null); setRight(null); return }

    let a: Player
    let b: Player

    if (Math.random() < epsilon) {
      // explore: prioritize under-voted
      const sortedByVotes = [...pool].sort((x, y) =>
        (coverage[x.player_id]?.total ?? 0) - (coverage[y.player_id]?.total ?? 0)
      )
      a = sortedByVotes[0]
      b = sortedByVotes.find(p => p.player_id !== a.player_id) || sortedByVotes[1]
    } else {
      // exploit: random two
      const i = Math.floor(Math.random() * pool.length)
      let j = Math.floor(Math.random() * (pool.length - 1))
      if (j >= i) j += 1
      a = pool[i]
      b = pool[j]
    }

    // avoid same-player and keep consistent ordering
    if (a.player_id === b.player_id) { return newPair() }
    setLeft(a); setRight(b)
  }

  useEffect(() => { if (!loading) newPair() }, [loading, teamFilter])

  // ---- voting
  async function vote(winner: 'left' | 'right') {
    if (!left || !right) return
    setSubmitting(true)
    const winner_id = (winner === 'left') ? left.player_id : right.player_id
    const { error } = await supabase.from('pair_votes').insert([{
      left_player_id: left.player_id,
      right_player_id: right.player_id,
      winner_player_id: winner_id,
    }])
    setSubmitting(false)
    if (error) { console.error('vote error', error); return }

    // refresh aggregates only (cheap)
    const { data: aData, error: aErr } = await supabase
      .from('tv_pairwise_aggregates')
      .select('p_small,p_large,wins_small,wins_large,n_votes')
    if (!aErr && aData) setPairs(aData)

    newPair()
  }

  return (
    <div className="container">
      <h1>HoopsHype <span className="accent">Trade</span>-Value Voter</h1>
      <p className="sub">
        Pick who has more <strong>trade value</strong>. Rankings update live.
      </p>

      <div className="toolbar">
        <label>Team view:&nbsp;</label>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
          {TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={newPair} className="btn">New Pair</button>
      </div>

      {loading ? (
        <div className="loading">Loading players…</div>
      ) : filteredPlayers.length < 2 ? (
        <div className="loading">No players available for this filter.</div>
      ) : (
        <div className="duel">
          {[left, right].map((pl, i) => (
            <div key={i} className="card">
              {pl ? (
                <>
                  <img
                    src={pl.headshot_url || letterAvatar(pl.player_name)}
                    alt={pl.player_name}
                    className="headshot"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).src = letterAvatar(pl.player_name) }}
                  />
                  <div className="name">{pl.player_name}</div>
                  <div className="meta">{(pl.team || '').toUpperCase()} • {pl.salary_text || ''}</div>
                  <button
                    disabled={submitting}
                    onClick={() => vote(i === 0 ? 'left' : 'right')}
                    className="btn primary"
                  >
                    VOTE
                  </button>
                </>
              ) : <div className="loading">Loading…</div>}
            </div>
          ))}
        </div>
      )}

      <h2>Overall Rankings</h2>
      <ol className="rankings">
        {rankings.map(({ p, s }) => (
          <li key={p.player_id}>
            <span className="rank-name">{p.player_name}</span>
            <span className="rank-team">{(p.team || '').toUpperCase()}</span>
            <span className="rank-salary">{p.salary_text || ''}</span>
            <span className="rank-score">score {formatScore(s / 100)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
