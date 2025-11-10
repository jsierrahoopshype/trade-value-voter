:root {
  --fg: #0b1320;
  --muted: #5d6574;
  --accent: #0ea5e9;
  --bg: #ffffff;
  --border: #e6e8ec;
}

* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; color: var(--fg); background: var(--bg); }
.container { max-width: 980px; margin: 28px auto 80px; padding: 0 16px; }
h1 { margin: 0 0 8px; font-size: 30px; }
.accent { color: var(--accent); }
.sub { color: var(--muted); margin: 0 0 16px; }

.toolbar { display: flex; align-items: center; gap: 10px; margin: 4px 0 18px; }
select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; }
.btn { padding: 7px 12px; border-radius: 10px; border: 1px solid var(--border); background: #f7f8fa; cursor: pointer; }
.btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }

.loading { color: var(--muted); padding: 16px 0; }

.duel { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; margin: 12px 0 26px; }
.card { border: 1px solid var(--border); border-radius: 14px; padding: 16px; display: grid; justify-items: center; gap: 10px; background: white; }
.headshot { width: 120px; height: 120px; border-radius: 14px; object-fit: cover; background: #f2f3f6; }
.name { font-weight: 700; text-align: center; }
.meta { color: var(--muted); font-size: 13px; text-align: center; min-height: 18px; }

h2 { margin: 24px 0 8px; }
.rankings { padding-left: 20px; margin: 0; }
.rankings li { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.rank-name { font-weight: 600; }
.rank-team { color: var(--muted); }
.rank-salary { color: var(--muted); }
.rank-score { color: var(--muted); }

@media (max-width: 680px) {
  .duel { grid-template-columns: 1fr; }
  .rankings li { grid-template-columns: 1fr; gap: 6px; }
}
