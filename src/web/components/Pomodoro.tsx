import { useEffect, useState, type KeyboardEvent } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import {
  formatRemaining,
  loadPomodoro,
  pausePomodoro,
  resetPomodoro,
  savePomodoro,
  setBreakMin,
  setWorkMin,
  startPomodoro,
  tickPomodoro,
  type PomodoroState,
} from "../lib/pomodoro";

export function Pomodoro() {
  const [state, setState] = useState<PomodoroState>(() => loadPomodoro());

  useEffect(() => {
    savePomodoro(state);
  }, [state]);

  useEffect(() => {
    if (!state.running) return;
    const id = window.setInterval(() => {
      setState((s) => tickPomodoro(s));
    }, 250);
    return () => window.clearInterval(id);
  }, [state.running]);

  const toggle = () => {
    setState((s) => (s.running ? pausePomodoro(s) : startPomodoro(s)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only when the control itself is focused — never a global hotkey.
    if (e.key !== " " && e.key !== "Enter") return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    toggle();
  };

  return (
    <div
      className="pomodoro"
      data-mode={state.mode}
      data-running={state.running ? "true" : "false"}
      tabIndex={0}
      role="group"
      aria-label={`Pomodoro ${state.mode}, ${formatRemaining(state.remainingMs)}${state.running ? ", running" : ", paused"}`}
      onKeyDown={onKeyDown}
    >
      <span className="pomodoro-mode">{state.mode === "work" ? "Focus" : "Break"}</span>
      <span className="pomodoro-time" aria-live="polite">
        {formatRemaining(state.remainingMs)}
      </span>
      <label className="pomodoro-dur" title="Work minutes">
        <span>W</span>
        <input
          type="number"
          min={1}
          max={180}
          value={state.workMin}
          disabled={state.running}
          aria-label="Work minutes"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            setState((s) => setWorkMin(s, n));
          }}
        />
      </label>
      <label className="pomodoro-dur" title="Break minutes">
        <span>B</span>
        <input
          type="number"
          min={1}
          max={180}
          value={state.breakMin}
          disabled={state.running}
          aria-label="Break minutes"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            setState((s) => setBreakMin(s, n));
          }}
        />
      </label>
      <button
        type="button"
        className="top-btn pomodoro-btn"
        onClick={toggle}
        aria-label={state.running ? "Pause timer" : "Start timer"}
        title={state.running ? "Pause" : "Start"}
      >
        {state.running ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button
        type="button"
        className="top-btn pomodoro-btn"
        onClick={() => setState((s) => resetPomodoro(s))}
        aria-label="Reset timer"
        title="Reset"
      >
        <RotateCcw size={15} />
      </button>
    </div>
  );
}
