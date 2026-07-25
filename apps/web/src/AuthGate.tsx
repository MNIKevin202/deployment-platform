import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState
} from "react";

interface SessionResponse {
  authenticated: boolean;
  username?: string;
  expiresAt?: number;
}

interface LoginResponse {
  success?: boolean;
  username?: string;
  message?: string;
}

interface AuthContextValue {
  username: string;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthGate");
  }

  return context;
}

interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [checkingSession, setCheckingSession] = useState(true);
  const [username, setUsername] = useState("");
  const [loginUsername, setLoginUsername] = useState("kevin");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin"
        });

        if (!response.ok) {
          throw new Error("Unable to check login status");
        }

        const session = (await response.json()) as SessionResponse;

        if (session.authenticated && session.username) {
          setUsername(session.username);
        }
      } catch (sessionError) {
        setError(
          sessionError instanceof Error
            ? sessionError.message
            : "Unable to check login status"
        );
      } finally {
        setCheckingSession(false);
      }
    };

    void checkSession();
  }, []);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      setLoggingIn(true);
      setError("");

      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password
        })
      });

      const result = (await response.json()) as LoginResponse;

      if (!response.ok || !result.success || !result.username) {
        throw new Error(result.message || "Unable to log in");
      }

      setUsername(result.username);
      setPassword("");
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : "Unable to log in"
      );
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin"
      });
    } finally {
      setUsername("");
      setPassword("");
      setError("");
    }
  };

  if (checkingSession) {
    return (
      <main className="auth-page">
        <section className="auth-card auth-loading">
          <p className="eyebrow">Deployment Platform</p>
          <h1>Checking session...</h1>
        </section>
      </main>
    );
  }

  if (!username) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-brand">
            <div className="auth-mark">DP</div>

            <div>
              <p className="eyebrow">Deployment Platform</p>
              <h1>Welcome back</h1>
              <p>
                Sign in to manage applications and containers on your server.
              </p>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <form className="auth-form" onSubmit={(event) => void login(event)}>
            <label>
              <span>Username</span>
              <input
                value={loginUsername}
                onChange={(event) =>
                  setLoginUsername(event.target.value)
                }
                autoComplete="username"
                required
                autoFocus
              />
            </label>

            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>

            <button
              className="primary-button auth-submit"
              type="submit"
              disabled={loggingIn}
            >
              {loggingIn ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <p className="auth-note">
            Sessions expire automatically after eight hours.
          </p>
        </section>
      </main>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        username,
        logout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
