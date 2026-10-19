import { useState, type FormEvent } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { api, ApiError } from "../api";

const LOG_LINES: { text: string; state: "done" | "now" | "todo" }[] = [
  { text: "Tokenizers & embeddings", state: "done" },
  { text: "Attention, from scratch", state: "done" },
  { text: "RAG pipelines that don't lie", state: "now" },
  { text: "Evals for agents", state: "todo" },
];

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
      <section className="login-art" aria-hidden="true">
        <h1 className="login-mark">
          <span className="rise" style={{ "--i": 0 } as React.CSSProperties}>own</span>
          <span className="rise hl-word" style={{ "--i": 1 } as React.CSSProperties}>note</span>
        </h1>
        <ol className="login-log">
          {LOG_LINES.map((l, i) => (
            <li
              key={l.text}
              data-state={l.state}
              className="rise"
              style={{ "--i": i + 3 } as React.CSSProperties}
            >
              <span className="log-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="log-t">{l.text}</span>
              <span className="log-s">{l.state === "now" ? "watching" : l.state}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="login-form-wrap">
        <form className="login-form rise" style={{ "--i": 2 } as React.CSSProperties} onSubmit={submit}>
          <p className="eyebrow">Private notebook</p>
          <h2>Open your notes</h2>
          <label htmlFor="pw" className="sr-only">
            Password
          </label>
          <div className="pw-row">
            <input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="password"
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
