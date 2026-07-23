import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Overview } from "./pages/Overview";
import { Systems } from "./pages/Systems";
import { Projects } from "./pages/Projects";
import { AdminUsers } from "./pages/AdminUsers";
import { AdminKeys } from "./pages/AdminKeys";
import { AdminAudit } from "./pages/AdminAudit";
import { Connect } from "./pages/Connect";
import type { ReactNode } from "react";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/connect" element={<Protected><Connect /></Protected>} />
          <Route path="/dashboard" element={<Protected><Overview /></Protected>} />
          <Route path="/systems" element={<Protected><Systems /></Protected>} />
          <Route path="/projects" element={<Protected><Projects /></Protected>} />
          <Route path="/admin/users" element={<Protected><AdminUsers /></Protected>} />
          <Route path="/admin/keys" element={<Protected><AdminKeys /></Protected>} />
          <Route path="/admin/audit" element={<Protected><AdminAudit /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
