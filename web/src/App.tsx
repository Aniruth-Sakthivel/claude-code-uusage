import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import type { Capability } from "./api/types";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ClientPortalShell } from "./components/ClientPortalShell";
import { Layout } from "./components/Layout";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { Alert, Button, LoadingState, ToastProvider } from "./components/ui";
import { RealtimeProvider } from "./context/RealtimeContext";
import { ThemeProvider } from "./lib/theme";
import { AdminAudit } from "./pages/AdminAudit";
import { AdminKeys } from "./pages/AdminKeys";
import { AdminUserDetail } from "./pages/admin/AdminUserDetail";
import { AdminUserGrid } from "./pages/admin/AdminUserGrid";
import { Automations } from "./pages/Automations";
import { Calendar } from "./pages/Calendar";
import { Chat } from "./pages/Chat";
import { ClientProjectDetail } from "./pages/ClientProjectDetail";
import { ClientProjects } from "./pages/ClientProjects";
import { Connect } from "./pages/Connect";
import { ForgotPassword } from "./pages/ForgotPassword";
import { Initiatives } from "./pages/Initiatives";
import { InitiativeDetail } from "./pages/InitiativeDetail";
import { Landing } from "./pages/Landing";
import { Reports } from "./pages/Reports";
import { Whiteboard } from "./pages/Whiteboard";
import { Wiki } from "./pages/Wiki";
import { Login } from "./pages/Login";
import { ResetPassword } from "./pages/ResetPassword";
import { Overview } from "./pages/Overview";
import { Projects } from "./pages/Projects";
import { ProjectOwnerDetail } from "./pages/projects/ProjectOwnerDetail";
import { Register } from "./pages/Register";
import { Sessions } from "./pages/Sessions";
import { Accounts } from "./pages/Accounts";
import { AdminSettings } from "./pages/AdminSettings";
import { Settings } from "./pages/Settings";
import { Systems } from "./pages/Systems";
import { Welcome } from "./pages/Welcome";

/**
 * Auth-check result shared by every protected route tree in the app — used
 * both by Meterhouse's own routes (`Protected`, chrome: `Layout`) and by the
 * Workspace app (`WorkspaceProtected`, chrome: `WorkspaceShell`), which are
 * two different shells around the same login session, not two logins.
 */
function useAuthGate() {
  const { user, loading, error } = useAuth();
  if (loading) return { status: "loading" as const };
  if (error && !user) return { status: "error" as const, error };
  if (!user) return { status: "unauthenticated" as const };
  return { status: "ok" as const };
}

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center">
      <LoadingState />
    </div>
  );
}

// Surface a boot failure instead of redirecting to login, which would look
// like a sign-out and hide the real problem.
function ErrorScreen({ error }: { error: string }) {
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

/** Requires a signed-in user; optionally a specific capability. Renders
 * Meterhouse's own chrome (`Layout`). A `client`-role account never belongs
 * here — the whole fleet/PM surface is outside what was shared with them —
 * so it's redirected to its own portal instead. */
function Protected({
  children,
  capability,
}: {
  children: ReactNode;
  capability?: Capability;
}) {
  const { user, can } = useAuth();
  const gate = useAuthGate();

  if (gate.status === "loading") return <LoadingScreen />;
  if (gate.status === "error") return <ErrorScreen error={gate.error} />;
  if (gate.status === "unauthenticated") return <Navigate to="/login" replace />;
  if (user?.role === "client") return <Navigate to="/portal" replace />;

  // Signed in but lacking the capability: send them somewhere useful rather
  // than showing a dead page.
  if (capability && !can(capability)) return <Navigate to="/dashboard" replace />;

  return <Layout>{children}</Layout>;
}

/** Same guard as `Protected`, but renders the Workspace app's own shell
 * instead of Meterhouse's — see components/WorkspaceShell.tsx. Same client
 * redirect as `Protected`: Workspace is the internal-staff PM app. */
function WorkspaceProtected() {
  const { user } = useAuth();
  const gate = useAuthGate();

  if (gate.status === "loading") return <LoadingScreen />;
  if (gate.status === "error") return <ErrorScreen error={gate.error} />;
  if (gate.status === "unauthenticated") return <Navigate to="/login" replace />;
  if (user?.role === "client") return <Navigate to="/portal" replace />;

  return <WorkspaceShell />;
}

/** Guard for the client portal — any signed-in user may view it (staff can
 * preview what a client sees), so there's no role redirect here. */
function PortalProtected() {
  const gate = useAuthGate();

  if (gate.status === "loading") return <LoadingScreen />;
  if (gate.status === "error") return <ErrorScreen error={gate.error} />;
  if (gate.status === "unauthenticated") return <Navigate to="/login" replace />;

  return <ClientPortalShell />;
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
              <Route path="/workspace" element={<WorkspaceProtected />}>
                <Route index element={<Initiatives />} />
                <Route path="initiatives/:id" element={<InitiativeDetail />} />
                <Route path="calendar" element={<Calendar />} />
                <Route path="chat" element={<Chat />} />
                <Route path="reports" element={<Reports />} />
                <Route path="wiki" element={<Wiki />} />
                <Route path="whiteboard" element={<Whiteboard />} />
                <Route path="automations" element={<Automations />} />
              </Route>
              <Route path="/portal" element={<PortalProtected />}>
                <Route index element={<ClientProjects />} />
                <Route path=":id" element={<ClientProjectDetail />} />
              </Route>
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
                path="/projects/:owner"
                element={
                  <Protected>
                    <ProjectOwnerDetail />
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
                    <AdminUserGrid />
                  </Protected>
                }
              />
              <Route
                path="/admin/users/:id"
                element={
                  <Protected capability="manage_users">
                    <AdminUserDetail />
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
