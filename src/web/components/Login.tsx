import { useState, type FormEvent } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { api, ApiError } from "../api";
import { ThemeToggle } from "./ThemeToggle";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("That's not the password.");
      else if (err instanceof ApiError && err.status === 429)
        setError("Too many attempts. Give it a minute.");
      else setError("Can't reach the server. Is the API running?");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <ThemeToggle className="login-theme" />
      <section className="login-art">
        <p className="login-mark">ownnote</p>
        <p className="login-tagline">Notes and a watch queue, kept private.</p>
      </section>

      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <h1>Open your notes</h1>
          <label htmlFor="pw" className="sr-only">
            Password
          </label>
          <div className="pw-row">
            <input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "pw-err" : undefined}
            />
            <button type="submit" className="btn-primary" disabled={busy || !password}>
              {busy ? <Loader2 size={18} className="spin" /> : <ArrowRight size={18} />}
              <span>Open</span>
            </button>
          </div>
          <p id="pw-err" role="alert" className="form-error">
            {error}
          </p>
        </form>
      </section>
    </main>
  );
}
