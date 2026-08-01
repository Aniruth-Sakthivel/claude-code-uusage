/**
 * Sign in.
 *
 * Does exactly one thing. The previous version switched this screen into a
 * system-creation form for admins after login, which conflated "sign in" with
 * "set up a machine" and left users unsure what had happened. Machine setup now
 * lives on /connect, and first-run admin setup on /welcome.
 */

import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { RegistrationStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Brand } from "../components/Layout";
import { Alert, Button, Field, FormCard, Input } from "../components/ui";
import { ThemeToggle } from "../lib/theme";

export function Login() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only advertise sign-up while this is a fresh install.
  const registration = useQuery({
    queryKey: qk.registrationOpen,
    queryFn: () => api.get<RegistrationStatus>("/auth/registration-open"),
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title = "Sign in — Meterhouse";
  }, []);

  if (!loading && user) return <Navigate to="/dashboard" replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center bg-plane p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>

        <FormCard className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-sm text-muted">
              Track Claude Code usage across your machines.
            </p>
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Email" required>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            )}
          </Field>

          <Field label="Password" required>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}
          </Field>

          <div className="-mt-2 text-right">
            <Link to="/forgot-password" className="text-sm font-semibold text-accent">
              Forgot password?
            </Link>
          </div>

          <Button type="submit" loading={busy}>
            Sign in
          </Button>

          {registration.data?.open ? (
            <p className="text-center text-sm text-muted">
              First time here?{" "}
              <Link to="/register" className="font-semibold text-accent">
                Create the admin account
              </Link>
            </p>
          ) : (
            <p className="text-center text-sm text-muted">
              Need an account? Ask an administrator to invite you.
            </p>
          )}
        </FormCard>
      </div>
    </div>
  );
}
