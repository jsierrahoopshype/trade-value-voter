import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import './styles.css'

type Player = { player_id: number; player_name: string; team: string }
type Agg = { p_small:number; p_large:number; wins_small:number; wins_large:number }

function shuffle<T>(a: T[]): T[] {
  for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] }
  return a
}

function bradleyTerry(players: Player[], aggs: Agg[], team?: string) {
  const filtered = players.filter(p => !team || p.team === team)
  const ids = filtered.map(p => p.player_id)
  const idToIdx = new Map(ids.map((id,i)=>[id,i]))
  const n = ids.length
  if (n === 0) return [] as Array<{player: Player; score:number}>
  const w = new Array(n).fill(1/n)

  const edges: Array<[number, number, number, number]> = []
  for (const a of aggs) {
    const i = idToIdx.get(a.p_small); const j = idToIdx.get(a.p_large)
    if (i==null || j==null) continue
    edges.push([i,j,a.wins_small,a.wins_large])
  }
  if (edges.length === 0) return filtered.map((p)=>({player:p, score:1/n}))

  for (let iter=0; iter<200; iter++) {
    const denom = new Array(n).fill(0)
    for (const [i,j,w_ij,w_ji] of edges) {
      const s = w[i]+w[j]
      const tot = (w_ij + w_ji)
      denom[i] += tot * (w[i]/s)
      denom[j] += tot * (w[j]/s)
    }
    const newW = new Array(n).fill(0)
    for (const [i,j,w_ij,w_ji] of edges) {
      newW[i] += w_ij
      newW[j] += w_ji
    }
    for (let i=0;i<n;i++) newW[i] = denom[i] > 0 ? (newW[i] / denom[i]) : w[i]
    const sum = newW.reduce((a,b)=>a+b,0)
    for (let i=0;i<n;i++) w[i] = newW[i] / (sum || 1)
  }
  return filtered.map((p, idx)=>({ player: p, score: w[idx] })).sort((a,b)=>b.score-a.score)
}

export default function App(){
  const [players, setPlayers] = useState<Player[]>([])
  const [aggs, setAggs] = useState<Agg[]>([])
  const [pair, setPair] = useState<[Player,Player] | null>(null)
  const [team, setTeam] = useState('ALL')
  const [loading, setLoading] = useState(true)
  const busy = useRef(false)

  useEffect(()=>{ (async ()=>{
    setLoading(true)
    const { data: p } = await supabase.from('players').select('player_id, player_name, team').eq('active', true)
    setPlayers(p || [])
    const { data: a } = await supabase.from('pairwise_aggregates').select('p_small, p_large, wins_small, wins_large')
    setAggs(a || [])
    setLoading(false)
  })() }, [])

  const rankings = useMemo(()=> bradleyTerry(players, aggs, team==='ALL'? undefined : team), [players, aggs, team])

  function nextPair(){
    const pool = players.filter(p => team==='ALL' || p.team === team)
    if (pool.length < 2) return
    const [a,b] = shuffle(pool.slice()).slice(0,2)
    setPair(a.player_id < b.player_id ? [a,b] : [b,a])
  }
  useEffect(()=>{ if(!loading) nextPair() }, [loading, team])

  async function vote(winner: Player){
    if (!pair || busy.current) return
    busy.current = true
    const [L,R] = pair
    await supabase.from('pair_votes').insert({
      left_player_id: L.player_id,
      right_player_id: R.player_id,
      winner_player_id: winner.player_id,
      team_context: team==='ALL' ? null : team
    })
    const a = Math.min(L.player_id, R.player_id)
    const b = Math.max(L.player_id, R.player_id)
    setAggs(prev => {
      const idx = prev.findIndex(x => x.p_small===a && x.p_large===b)
      const leftWins = (winner.player_id===a) ? 1 : 0
      const rightWins = (winner.player_id===b) ? 1 : 0
      if (idx === -1) return [...prev, { p_small:a, p_large:b, wins_small:leftWins, wins_large:rightWins }]
      const copy = prev.slice()
      copy[idx] = { ...copy[idx], wins_small: copy[idx].wins_small + leftWins, wins_large: copy[idx].wins_large + rightWins }
      return copy
    })
    nextPair()
    busy.current = false
  }

  return (
    <div className="wrap">
      <h1>HoopsHype Trade-Value Voter</h1>
      <p>Pick who has more <b>trade value</b>. Rankings update live.</p>
      <div className="bar">
        <label>Team view:</label>
        <select value={team} onChange={e=>setTeam(e.target.value)}>
          <option value="ALL">All Teams</option>
          {[...new Set(players.map(p=>p.team))].sort().map(t=> <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={nextPair}>New Pair</button>
      </div>

      {pair ? (
        <div className="pair">
          <button className="card" onClick={()=>vote(pair[0])}>
            <div className="name">{pair[0].player_name}</div>
            <div className="team">{pair[0].team}</div>
            <div className="vote">Vote</div>
          </button>
          <button className="card" onClick={()=>vote(pair[1])}>
            <div className="name">{pair[1].player_name}</div>
            <div className="team">{pair[1].team}</div>
            <div className="vote">Vote</div>
          </button>
        </div>
      ) : (
        <div className="panel">Loading players…</div>
      )}

      <h2>{team==='ALL' ? 'Overall' : team} Rankings</h2>
      <ol>
        {rankings.slice(0, 100).map((r,i)=>(
          <li key={r.player.player_id}>
            <span>{i+1}. {r.player.player_name} ({r.player.team})</span>
            <span className="score">score {r.score.toFixed(4)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
