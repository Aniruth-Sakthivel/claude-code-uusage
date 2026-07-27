/**
 * Authentication state.
 *
 * Supabase owns credentials; the app's own `/auth/provision` endpoint links a
 * Supabase identity to a local account carrying role + system scoping.
 *
 * Fixes over the previous version:
 *   - the boot promise had no `.catch`, so a rejection left `loading` true
 *     forever and the app showed "Loading…" permanently
 *   - there was no error state, so every page invented its own
 *   - capabilities were hardcoded, with manager/developer/viewer all empty —
 *     which is why non-admins saw a dead UI. They now come from the server.
 *   - only SIGNED_OUT was handled; token refresh and cross-tab sign-in were not
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import type { Capability, User } from "../api/types";
import { supabase } from "../lib/supabase";

/** Thrown by signUp() when the account was created but needs email
 * confirmation before a session exists — a success, not a failure, so
 * callers should render it distinctly from a real error. */
export class EmailConfirmationRequiredError extends Error {}

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Set when the session could not be established; surfaced by the UI. */
  error: string | null;
  login: (email: string, password: string) => Promise<User>;
  signUp: (email: string, fullName: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (capability: Capability) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUser = useCallback(async () => {
    const me = await api.get<User>("/auth/me");
    setUser(me);
    return me;
  }, []);

  // Shared by initial load AND cross-tab/email-link sign-in: a valid Supabase
  // session with no local account yet tries to provision (first-run admin),
  // otherwise signs out cleanly. Previously only the initial-mount path did
  // this — a session established via SIGNED_IN (e.g. clicking an email
  // confirmation link) hit the same 401 but silently swallowed it, leaving
  // the user looking signed-out with no error and no explanation.
  const loadOrProvisionUser = useCallback(async () => {
    try {
      await loadUser();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          setUser(await api.post<User>("/auth/provision"));
        } catch {
          await supabase.auth.signOut();
        }
      } else {
        throw e;
      }
    }
  }, [loadUser]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!session) return;
        // A password-recovery link establishes a real (if short-lived)
        // session before this page even mounts — don't treat that as a
        // normal login and pull the user into the full app mid-reset.
        if (window.location.pathname === "/reset-password") return;
        await loadOrProvisionUser();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not restore your session");
        }
      } finally {
        // Always runs — this is what the previous version lacked.
        if (!cancelled) setLoading(false);
      }
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
      } else if (event === "PASSWORD_RECOVERY") {
        // Handled entirely by the /reset-password page itself.
      } else if (event === "SIGNED_IN" && session) {
        // Covers sign-in from another tab, and landing back from an email
        // confirmation/invite link.
        loadOrProvisionUser().catch(() => {});
      }
      // TOKEN_REFRESHED needs no action: the client reads the session per
      // request, so the new token is picked up automatically.
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadOrProvisionUser]);

  // Session expiry reported by the API — sign out once, centrally.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      supabase.auth.signOut().catch(() => {});
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw new Error(friendlyAuthError(signInError.message));
    // Idempotent; also links an admin-created account on first sign-in.
    const me = await api.post<User>("/auth/provision");
    setUser(me);
    return me;
  }, []);

  const signUp = useCallback(async (email: string, fullName: string, password: string) => {
    setError(null);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (signUpError) throw new Error(friendlyAuthError(signUpError.message));
    // With email confirmation enabled there is no session yet, so provisioning
    // would 401. This is a distinct type (not a plain Error) so the caller can
    // render it as a neutral "check your inbox" state instead of a red error —
    // the signup itself succeeded.
    if (!data.session) {
      throw new EmailConfirmationRequiredError(
        "Check your email to confirm your account, then sign in.",
      );
    }
    try {
      const me = await api.post<User>("/auth/provision");
      setUser(me);
      return me;
    } catch {
      // The Supabase account exists; only linking the local profile failed
      // (network blip, server hiccup). Provisioning is idempotent, so signing
      // in again resolves it — tell the user that, not a generic failure.
      throw new Error(
        "Your account was created, but we couldn't finish setting it up. Please sign in again.",
      );
    }
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    window.location.href = "/";
  }, []);

  const refresh = useCallback(async () => {
    try {
      await loadUser();
    } catch {
      /* keep the current user; the page will surface its own error */
    }
  }, [loadUser]);

  const can = useCallback(
    (capability: Capability) => !!user?.capabilities?.includes(capability),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, error, login, signUp, logout, refresh, can }),
    [user, loading, error, login, signUp, logout, refresh, can],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Supabase error strings are terse; make the common ones actionable. */
function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) {
    return "Incorrect email or password.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Confirm your email address first — check your inbox.";
  }
  if (/already registered/i.test(message)) {
    return "An account with this email already exists. Sign in instead.";
  }
  return message;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
