export function PrivacyContent() {
  return (
    <div className="privacy">
      <h1>Privacy policy</h1>
      <p>GridTheory is a small, invite-only chess training site. This explains what it keeps about you and why.</p>
      <h2>What's kept</h2>
      <ul>
        <li><strong>Your email address and a scrambled form of your password</strong>, to sign you in. Nobody can read your password.</li>
        <li><strong>Your chess data</strong>: games, reviews, lesson progress, drills, ratings and settings, so that they follow you between devices.</li>
        <li><strong>A short record of account events</strong>, such as when an access code was used or an account was removed, kept to protect the site. It holds account ids, not email addresses.</li>
        <li><strong>A scrambled form of your internet address</strong> when you use an access code, kept for up to a day to limit guessing.</li>
      </ul>
      <h2>What isn't</h2>
      <p>There are no ads, analytics or tracking. Sign-in details are saved in your browser only to keep you signed in, and nothing is used to follow you around the web.</p>
      <h2>Who else handles it</h2>
      <ul>
        <li><strong>Supabase</strong> stores accounts and data.</li>
        <li><strong>The site's host</strong> delivers its pages, and keeps ordinary request logs, which can include internet addresses.</li>
        <li><strong>An email provider</strong> delivers set-up and password-reset emails.</li>
        <li><strong>Lichess and Chess.com</strong> receive the username you enter, only if you import games.</li>
      </ul>
      <p>Your data isn't sold or shared with anyone else. The site's administrator can see your email address, when you joined and how much storage you use. The admin tools don't show your games or progress.</p>
      <h2>Your choices</h2>
      <ul>
        <li><strong>Get a copy:</strong> download a backup from Settings at any time.</li>
        <li><strong>Delete it:</strong> deleting your account in Settings permanently removes your account and chess data from the live database. Backups are overwritten on a rolling schedule. The event record stays, without your email address.</li>
        <li><strong>Ask a question:</strong> contact the person who invited you.</li>
      </ul>
      <h2>Younger players</h2>
      <p>If you're under 16, ask a parent or guardian before using an access code.</p>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="page narrow">
      <PrivacyContent />
    </div>
  );
}
