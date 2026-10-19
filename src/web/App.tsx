import { useCallback, useEffect, useState } from "react";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { Login } from "./components/Login";
import { Workspace } from "./components/Workspace";

type Auth = "checking" | "out" | "in";

export function App() {
  const [auth, setAuth] = useState<Auth>("checking");

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth("out"));
    api
      .me()
      .then(() => setAuth("in"))
      .catch((e) => {
        // Network failure: still show login so the user is not stuck on a blank screen.
        if (!(e instanceof ApiError)) console.warn("OwnNote: API unreachable", e);
        setAuth("out");
      });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth("out");
    }
  }, []);

  if (auth === "checking") {
    return (
      <div className="boot" aria-busy="true">
        <span className="boot-mark">own<em>note</em></span>
      </div>
    );
  }
  if (auth === "out") return <Login onLoggedIn={() => setAuth("in")} />;
  return <Workspace onLogout={logout} />;
}
