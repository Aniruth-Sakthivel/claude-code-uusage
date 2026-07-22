import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, tokenStore } from "../api/client";
import type { User } from "../api/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, fullName: string, password: string) => Promise<User>;
  logout: () => void;
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
    if (!tokenStore.get()) { setLoading(false); return; }
    api.get<User>("/api/v1/auth/me")
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const { access_token } = await api.post<{ access_token: string }>(
      "/api/v1/auth/login", { email, password });
    tokenStore.set(access_token);
    const me = await api.get<User>("/api/v1/auth/me");
    setUser(me);
    return me;
  }

  async function register(email: string, fullName: string, password: string) {
    const { access_token } = await api.post<{ access_token: string }>(
      "/api/v1/auth/register", { email, full_name: fullName, password });
    tokenStore.set(access_token);
    const me = await api.get<User>("/api/v1/auth/me");
    setUser(me);
    return me;
  }

  function logout() {
    tokenStore.clear();
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
