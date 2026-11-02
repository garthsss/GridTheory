import { ArrowDownRight, ArrowUpRight, Flame } from 'lucide-react';
import { useMemo } from 'react';
import { TrendChart } from '../components/TrendChart';
import { lessonById } from '../course/content';
import { loadGames, loadRating, loadRatingHistory } from '../lib/storage';
import { loadDrills, loadEvents, loadPuzzleHistory, loadPuzzleRating, trainingStreak } from '../training/activity';
import { MIN_EVIDENCE, SKILLS, scoreSkills, weakestSkills } from '../training/skills';

export function ProgressPage() {
  const scores = useMemo(() => scoreSkills(loadEvents()), []);
  const weakest = weakestSkills(scores, 1)[0];
  const focus = SKILLS.find((skill) => skill.id === weakest);
  const games = useMemo(() => loadGames(), []);
  const accuracy = useMemo(
    () =>
      games
        .filter((game) => game.review && game.playerColor)
        .map((game) => ({ t: new Date(game.date).getTime(), value: game.review!.sides[game.playerColor!].accuracy }))
        .sort((a, b) => a.t - b.t),
    [games],
  );
  const drills = loadDrills();
  const hasData = SKILLS.some((skill) => scores[skill.id].samples > 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Your progress</h1>
        <p className="muted">Built from your analysed games, puzzles, drills and scenarios. Recent results count for more.</p>
      </header>

      <dl className="hero-stats progress-stats">
        <div><dt>Bot rating</dt><dd>{loadRating().value}</dd></div>
        <div><dt>Puzzle rating</dt><dd>{loadPuzzleRating().value}</dd></div>
        <div><dt>Training streak</dt><dd><Flame size={20} aria-hidden="true" className="streak-icon" />{trainingStreak()}</dd></div>
        <div><dt>Drills mastered</dt><dd>{drills.filter((drill) => drill.retired).length}<small>/{drills.length}</small></dd></div>
      </dl>

      {focus && (
        <section className="focus-card" aria-labelledby="focus-heading">
          <h2 id="focus-heading">Work on next: {focus.label}</h2>
          <p>{focus.about}</p>
          <div className="btn-row">
            <a className="btn btn-primary" href={focus.practice.href}>{focus.practice.label}</a>
            {focus.lessons.map((id) => <a key={id} className="btn" href={`#/learn/${id}`}>{lessonById(id)?.title ?? id}</a>)}
          </div>
        </section>
      )}

      <section aria-labelledby="skills-heading">
        <h2 id="skills-heading">Skill map</h2>
        {!hasData && (
          <p className="muted">
            Nothing here yet. <a href="#/review">Analyse a game</a> or <a href="#/train/puzzles/all">solve some puzzles</a>, and your scores will start to fill in.
          </p>
        )}
        <ul className="skills">
          {SKILLS.map((skill) => {
            const entry = scores[skill.id];
            return (
              <li key={skill.id} className="skill">
                <div className="skill-top">
                  <strong>{skill.label}</strong>
                  {entry.score !== null ? (
                    <span className="skill-value">
                      {entry.trend !== null && entry.trend !== 0 && (
                        <span className="skill-trend" aria-label={`${entry.trend > 0 ? 'Up' : 'Down'} ${Math.abs(entry.trend)} recently`}>
                          {entry.trend > 0 ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownRight size={14} aria-hidden="true" />}
                          {Math.abs(entry.trend)}
                        </span>
                      )}
                      {entry.score}
                    </span>
                  ) : (
                    <span className="muted small">Needs more data</span>
                  )}
                </div>
                <div className="meter" role="progressbar" aria-label={skill.label} aria-valuenow={entry.score ?? 0} aria-valuemin={0} aria-valuemax={100} aria-valuetext={entry.score === null ? 'Not enough data' : String(entry.score)}>
                  <div className={entry.score === null ? 'meter-empty' : ''} style={{ width: `${entry.score ?? 0}%` }} />
                </div>
                <p className="small muted">{skill.about}</p>
              </li>
            );
          })}
        </ul>
        <p className="small muted">About 70 is par for your level, so use these to compare your skills with each other. They need at least {MIN_EVIDENCE} results' worth of evidence, and they're a training guide, not a rating.</p>
      </section>

      <section className="trends" aria-label="Trends">
        <TrendChart title="Bot rating" points={loadRatingHistory()} />
        <TrendChart title="Puzzle rating" points={loadPuzzleHistory()} />
        <TrendChart title="Game accuracy" points={accuracy} unit="%" />
      </section>
    </div>
  );
}
