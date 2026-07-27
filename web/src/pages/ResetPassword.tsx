/**
 * Set a new password, reached from the Supabase reset-email link.
 *
 * Supabase's client auto-detects the recovery token in the URL and
 * establishes a temporary session (see supabase.ts / AuthContext's
 * PASSWORD_RECOVERY handling) before this page even mounts — so this is
 * just a plain "new password" form, not a token-parsing exercise.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Brand } from "../components/Layout";
import { Alert, Button, Card, Field, FormCard, Input } from "../components/ui";
import { supabase } from "../lib/supabase";
import { ThemeToggle } from "../lib/theme";

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = "Set new password — ClaudeFleet";
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(
        /session|token|expired/i.test(updateError.message)
          ? "This reset link has expired. Request a new one from the sign-in page."
          : updateError.message,
      );
      return;
    }
    setDone(true);
    setTimeout(() => navigate("/dashboard", { replace: true }), 1500);
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

        {done ? (
          <Card className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Password updated</h1>
            <p className="mt-2 text-sm text-muted">Taking you to your dashboard…</p>
          </Card>
        ) : (
          <FormCard className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Set a new password</h1>
            </div>

            {error && (
              <Alert tone="error">
                {error}{" "}
                {/expired/i.test(error) && (
                  <Link to="/forgot-password" className="font-semibold underline">
                    Request a new link
                  </Link>
                )}
              </Alert>
            )}

            <Field label="New password" hint="At least 8 characters." required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                  autoFocus
                />
              )}
            </Field>

            <Field label="Confirm new password" required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              )}
            </Field>

            <Button type="submit" loading={busy}>
              Update password
            </Button>
          </FormCard>
        )}
      </div>
    </div>
  );
}
