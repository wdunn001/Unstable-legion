import type { LeaderboardEntry } from '../viewmodels/meshViewModels.js';

export function Leaderboard(props: { entries: readonly LeaderboardEntry[] }) {
  return (
    <section className="mesh-card leaderboard">
      <h3>Top contributors</h3>
      {props.entries.length === 0 ? (
        <p className="leaderboard-empty">No contribution history yet — be the first.</p>
      ) : (
        <ol className="leaderboard-list">
          {props.entries.map((e) => (
            <li key={e.peerId} className={e.isSelf ? 'leaderboard-self' : undefined}>
              <span className="leaderboard-rank">#{e.rank}</span>
              <span className="leaderboard-name">{e.label}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
