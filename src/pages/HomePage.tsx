import { ArrowRight, BookOpen, Check, Crosshair, Flame, Puzzle as PuzzleIcon, Repeat, Swords } from 'lucide-react';
import { ALL_LESSONS } from '../course/content';
import { BOTS } from '../engine/bots';
import { loadGames, loadProgress, loadRating } from '../lib/storage';
import { loadPuzzleRating, todaysPlan, trainingStreak } from '../training/activity';
import { itemDone, planDone, type PlanKind } from '../training/plan';

const PLAN_ICONS: Record<PlanKind, typeof Repeat> = { drills: Repeat, puzzles: PuzzleIcon, scenario: Crosshair, lesson: BookOpen };

export function HomePage() {
  const rating = loadRating();
  const progress = loadProgress();
  const done = ALL_LESSONS.filter((lesson) => progress[lesson.id]).length;
  const games = loadGames();
  const suggested = BOTS.reduce((best, bot) =>
    Math.abs(bot.rating - rating.value) < Math.abs(best.rating - rating.value) ? bot : best,
  );
  const plan = todaysPlan();
  const finished = plan.items.filter((item) => itemDone(item, plan.progress)).length;
  const streak = trainingStreak();

  return (
    <div className="page home">
      <header className="hero">
        <div>
          <h1>Your next move starts here.</h1>
          <p>Play the ladder, fix your own mistakes, study the course, and see what really happened in your games.</p>
          <a href="#/play" className="btn btn-primary btn-large"><Swords size={20} aria-hidden="true" />Play {suggested.name}</a>
        </div>
        <dl className="hero-stats">
          <div><dt>Bot rating</dt><dd>{rating.value}</dd></div>
          <div><dt>Puzzle rating</dt><dd>{loadPuzzleRating().value}</dd></div>
          <div><dt>Lessons</dt><dd>{done}<small>/{ALL_LESSONS.length}</small></dd></div>
          <div><dt>Streak</dt><dd><Flame size={18} aria-hidden="true" className="streak-icon" />{streak}<small> {streak === 1 ? 'day' : 'days'}</small></dd></div>
        </dl>
      </header>

      <section className="today" aria-labelledby="today-heading">
        <div className="section-head">
          <h2 id="today-heading">Today's training</h2>
          <span className="small muted">{planDone(plan.items, plan.progress) ? 'All done. Nice work.' : `${finished} of ${plan.items.length} done · about 15 minutes`}</span>
        </div>
        <ol className="plan">
          {plan.items.map((item) => {
            const complete = itemDone(item, plan.progress);
            const Icon = PLAN_ICONS[item.kind];
            const count = Math.min(plan.progress[item.kind] ?? 0, item.target);
            return (
              <li key={item.kind}>
                <a href={item.href} className={complete ? 'plan-item plan-done' : 'plan-item'}>
                  <span className="plan-icon" aria-hidden="true">{complete ? <Check size={20} /> : <Icon size={20} />}</span>
                  <span className="plan-text">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </span>
                  {item.target > 1 && <span className="plan-count">{count}/{item.target}</span>}
                  {complete && <span className="sr-only">Done</span>}
                </a>
              </li>
            );
          })}
        </ol>
      </section>

      {games.length > 0 && (
        <section className="recent">
          <div className="section-head">
            <h2>Recent games</h2>
            <a href="#/review">All games <ArrowRight size={16} aria-hidden="true" /></a>
          </div>
          <ul className="library">
            {games.slice(0, 5).map((game) => (
              <li key={game.id}>
                <a href={`#/review/${game.id}`}>
                  <strong>{game.white} vs {game.black}</strong>
                  <span className="muted"> {game.result} · {new Date(game.date).toLocaleDateString()}{game.review ? ' · reviewed' : ''}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
