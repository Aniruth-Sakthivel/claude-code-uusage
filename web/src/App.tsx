import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import type { Capability } from "./api/types";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Alert, Button, LoadingState, ToastProvider } from "./components/ui";
import { RealtimeProvider } from "./context/RealtimeContext";
import { ThemeProvider } from "./lib/theme";
import { AdminAudit } from "./pages/AdminAudit";
import { AdminKeys } from "./pages/AdminKeys";
import { AdminUsers } from "./pages/AdminUsers";
import { Connect } from "./pages/Connect";
import { ForgotPassword } from "./pages/ForgotPassword";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { ResetPassword } from "./pages/ResetPassword";
import { Overview } from "./pages/Overview";
import { Projects } from "./pages/Projects";
import { Register } from "./pages/Register";
import { Sessions } from "./pages/Sessions";
import { Accounts } from "./pages/Accounts";
import { AdminSettings } from "./pages/AdminSettings";
import { Settings } from "./pages/Settings";
import { Systems } from "./pages/Systems";
import { Welcome } from "./pages/Welcome";

/** Requires a signed-in user; optionally a specific capability. */
function Protected({
  children,
  capability,
}: {
  children: ReactNode;
  capability?: Capability;
}) {
  const { user, loading, error, can } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <LoadingState />
      </div>
    );
  }

  // Surface a boot failure instead of redirecting to login, which would look
  // like a sign-out and hide the real problem.
  if (error && !user) {
    return (
      <div className="grid min-h-screen place-items-center p-4">
        <div className="w-full max-w-md">
          <Alert tone="error" title="Could not load your session">
            {error}
          </Alert>
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  // Signed in but lacking the capability: send them somewhere useful rather
  // than showing a dead page.
  if (capability && !can(capability)) return <Navigate to="/dashboard" replace />;

  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
        <RealtimeProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              <Route
                path="/welcome"
                element={
                  <Protected>
                    <Welcome />
                  </Protected>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <Protected>
                    <Overview />
                  </Protected>
                }
              />
              <Route
                path="/connect"
                element={
                  <Protected>
                    <Connect />
                  </Protected>
                }
              />
              <Route
                path="/systems"
                element={
                  <Protected>
                    <Systems />
                  </Protected>
                }
              />
              <Route
                path="/settings"
                element={
                  <Protected>
                    <Settings />
                  </Protected>
                }
              />
              <Route
                path="/admin/settings"
                element={
                  <Protected capability="manage_users">
                    <AdminSettings />
                  </Protected>
                }
              />
              <Route
                path="/accounts"
                element={
                  <Protected capability="view_all">
                    <Accounts />
                  </Protected>
                }
              />
              <Route
                path="/projects"
                element={
                  <Protected>
                    <Projects />
                  </Protected>
                }
              />
              <Route
                path="/sessions"
                element={
                  <Protected>
                    <Sessions />
                  </Protected>
                }
              />

              <Route
                path="/admin/users"
                element={
                  <Protected capability="manage_users">
                    <AdminUsers />
                  </Protected>
                }
              />
              <Route
                path="/admin/keys"
                element={
                  <Protected capability="manage_keys">
                    <AdminKeys />
                  </Protected>
                }
              />
              <Route
                path="/admin/audit"
                element={
                  <Protected capability="view_audit">
                    <AdminAudit />
                  </Protected>
                }
              />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
