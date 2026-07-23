import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { supabase } from "../lib/supabase";
import type { User } from "../api/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, fullName: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  can: (capability: Capability) => boolean;
}

type Capability = "manage_users" | "manage_keys" | "manage_systems" | "view_audit";

const CAPS: Record<string, Capability[]> = {
  admin: ["manage_users", "manage_keys", "manage_systems", "view_audit"],
  manager: [],
  developer: [],
  viewer: [],
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { setLoading(false); return; }
      api.get<User>("/api/v1/auth/me")
        .then(setUser)
        .catch(() => supabase.auth.signOut())
        .finally(() => setLoading(false));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setUser(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function login(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Ensures a local User row exists for this Supabase identity (first-run admin bootstrap).
    const me = await api.post<User>("/api/v1/auth/provision");
    setUser(me);
    return me;
  }

  async function register(email: string, fullName: string, password: string) {
    const { error } = await supabase.auth.signUp({
      email, password, options: { data: { full_name: fullName } },
    });
    if (error) throw error;
    const me = await api.post<User>("/api/v1/auth/provision");
    setUser(me);
    return me;
  }

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
    window.location.href = "/";   // back to the public intro page
  }

  const can = (c: Capability) => !!user && (CAPS[user.role] ?? []).includes(c);

  return <Ctx.Provider value={{ user, loading, login, register, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
