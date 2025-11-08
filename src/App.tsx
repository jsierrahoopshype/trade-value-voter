// Bradley–Terry (MM) -> "All Our Ideas" style score:
// score(i) = average_j  Pr(i beats j) = average_j w_i / (w_i + w_j)
function bradleyTerryWithWinRate(players: Player[], aggs: Agg[], team?: string) {
  const pool = players.filter(p => !team || p.team === team)
  const ids = pool.map(p => p.player_id)
  const idToIdx = new Map(ids.map((id,i)=>[id,i]))
  const n = ids.length
  if (n < 2) return pool.map(p => ({ player: p, score: 0.5 }))

  // add tiny prior to stabilize small samples
  const prior = 0.5

  // collect edges (i<->j, wins for each direction)
  const edges: Array<[number, number, number, number]> = []
  for (const a of aggs) {
    const i = idToIdx.get(a.p_small); const j = idToIdx.get(a.p_large)
    if (i==null || j==null) continue
    // MM updates use totals; add a small prior to both directions
    edges.push([i, j, a.wins_small + prior, a.wins_large + prior])
  }
  if (edges.length === 0) {
    return pool.map(p => ({ player: p, score: 0.5 }))
  }

  // Initialize strengths
  const w = new Array(n).fill(1 / n)

  // Minorize–maximize iterations
  for (let it = 0; it < 200; it++) {
    const denom = new Array(n).fill(0)
    const numer = new Array(n).fill(0)

    for (const [i,j,wij,wji] of edges) {
      const s = w[i] + w[j]
      // denominators for MM
      denom[i] += (wij + wji) * (w[i] / s)
      denom[j] += (wij + wji) * (w[j] / s)
      // numerators are wins
      numer[i] += wij
      numer[j] += wji
    }

    // update strengths
    for (let i=0;i<n;i++) {
      w[i] = denom[i] > 0 ? numer[i] / denom[i] : w[i]
    }

    // normalize to avoid drift
    const sum = w.reduce((a,b)=>a+b,0)
    for (let i=0;i<n;i++) w[i] /= (sum || 1)
  }

  // Convert to "win rate vs random opponent" in the current pool
  const avgWinProb = (i: number) => {
    let s = 0
    for (let j=0;j<n;j++) if (j !== i) s += w[i] / (w[i] + w[j])
    return s / (n - 1)
  }

  const scored = pool.map((p, idx)=>({
    player: p,
    score: avgWinProb(idx)   // 0..1
  }))

  // Sort by win rate (desc)
  scored.sort((a,b)=> b.score - a.score)
  return scored
}
