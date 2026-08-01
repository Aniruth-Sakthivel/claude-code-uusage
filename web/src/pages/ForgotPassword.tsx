/**
 * Password reset request.
 *
 * Previously there was no recovery path at all — a wrong/forgotten password
 * just repeated "Incorrect email or password" forever with no way out. This
 * sends Supabase's reset email, which links to /reset-password.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Brand } from "../components/Layout";
import { Alert, Button, Card, Field, FormCard, Input } from "../components/ui";
import { supabase } from "../lib/supabase";
import { ThemeToggle } from "../lib/theme";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    document.title = "Reset password — Meterhouse";
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    // Always show success, whether or not the email exists — otherwise this
    // form becomes a way to enumerate registered accounts.
    if (resetError && !/rate limit/i.test(resetError.message)) {
      setSent(true);
      return;
    }
    if (resetError) {
      setError("Too many attempts — wait a moment and try again.");
      return;
    }
    setSent(true);
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

        {sent ? (
          <Card className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
            <p className="mt-2 text-sm text-muted">
              If an account exists for {email.trim()}, a password reset link is on its way.
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
              <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
              <p className="mt-1 text-sm text-muted">
                Enter your email and we'll send you a link to set a new password.
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

            <Button type="submit" loading={busy}>
              Send reset link
            </Button>

            <p className="text-center text-sm text-muted">
              <Link to="/login" className="font-semibold text-accent">
                Back to sign in
              </Link>
            </p>
          </FormCard>
        )}
      </div>
    </div>
  );
}
