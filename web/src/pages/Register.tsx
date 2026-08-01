/**
 * First-run admin account creation.
 *
 * Only reachable while zero users exist. After that, accounts are created by an
 * administrator, and this page says so plainly instead of failing with an
 * opaque "no account for this login" error the way the old flow did.
 */

import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { RegistrationStatus } from "../api/types";
import { EmailConfirmationRequiredError, useAuth } from "../auth/AuthContext";
import { Brand } from "../components/Layout";
import {
  Alert,
  Button,
  Card,
  Field,
  FormCard,
  Input,
  LoadingState,
} from "../components/ui";
import { ThemeToggle } from "../lib/theme";

export function Register() {
  const { user, loading, signUp } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    email: "",
    full_name: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [checkEmailMessage, setCheckEmailMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registration = useQuery({
    queryKey: qk.registrationOpen,
    queryFn: () => api.get<RegistrationStatus>("/auth/registration-open"),
  });

  useEffect(() => {
    document.title = "Create admin account — Meterhouse";
  }, []);

  if (!loading && user) return <Navigate to="/dashboard" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setCheckEmailMessage(null);
    try {
      await signUp(form.email.trim(), form.full_name.trim(), form.password);
      navigate("/welcome", { replace: true });
    } catch (err) {
      if (err instanceof EmailConfirmationRequiredError) {
        // A success, not a failure — the account was created, it just needs
        // confirming. Shown as a neutral state, not a red error.
        setCheckEmailMessage(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Could not create the account");
      }
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

        {checkEmailMessage ? (
          <Card className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
            <p className="mt-2 text-sm text-muted">{checkEmailMessage}</p>
            <div className="mt-5">
              <Link to="/login">
                <Button variant="ghost">Back to sign in</Button>
              </Link>
            </div>
          </Card>
        ) : registration.isLoading ? (
          <Card>
            <LoadingState />
          </Card>
        ) : registration.data?.open === false ? (
          <Card className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Registration is closed</h1>
            <p className="mt-2 text-sm text-muted">
              An administrator account already exists. Ask your administrator to invite
              you — you will receive an email to set your password.
            </p>
            <div className="mt-5">
              <Link to="/login">
                <Button variant="ghost">Back to sign in</Button>
              </Link>
            </div>
          </Card>
        ) : (
          <FormCard className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Create the admin account
              </h1>
              <p className="mt-1 text-sm text-muted">
                This is the first account, so it becomes the administrator. Everyone else
                is invited from here afterwards.
              </p>
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            <Field label="Your name">
              {(p) => (
                <Input
                  {...p}
                  value={form.full_name}
                  onChange={set("full_name")}
                  autoComplete="name"
                  autoFocus
                />
              )}
            </Field>

            <Field label="Email" required>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={form.email}
                  onChange={set("email")}
                  autoComplete="username"
                  required
                />
              )}
            </Field>

            <Field label="Password" hint="At least 8 characters." required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={form.password}
                  onChange={set("password")}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              )}
            </Field>

            <Field label="Confirm password" required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={form.confirm}
                  onChange={set("confirm")}
                  autoComplete="new-password"
                  required
                />
              )}
            </Field>

            <Button type="submit" loading={busy}>
              Create account
            </Button>

            <p className="text-center text-sm text-muted">
              Already have an account?{" "}
              <Link to="/login" className="font-semibold text-accent">
                Sign in
              </Link>
            </p>
          </FormCard>
        )}
      </div>
    </div>
  );
}
