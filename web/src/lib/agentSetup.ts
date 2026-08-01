/** Server URL the agent should register against (Netlify proxies /api/*). */
export function serverUrl(): string {
  return window.location.origin;
}

export const AGENT_INSTALL = "pip install meterhouse-rotor";

/** Fallback when the package is not on PyPI yet — installs from the repo (needs git). */
export function agentInstallFromGit(repoUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage.git"): string {
  return `pip install "git+${repoUrl}#subdirectory=agent"`;
}

export function registerCommand(server: string, apiKey: string, displayName: string): string {
  return `meterhouse register --server ${server} --api-key ${apiKey} --display-name ${displayName}`;
}

export function scanSyncCommands(): string {
  return "meterhouse scan\nmeterhouse sync";
}

export function fullSetupBlock(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  useGitFallback?: boolean;
  repoUrl?: string;
}): string {
  const install = opts.useGitFallback ? agentInstallFromGit(opts.repoUrl) : AGENT_INSTALL;
  return [
    `# 1 — Install agent (once per PC)`,
    install,
    ``,
    `# 2 — Connect this PC (once)`,
    registerCommand(opts.server, opts.apiKey, opts.displayName),
    ``,
    `# 3 — Scan local transcripts and send to dashboard`,
    scanSyncCommands(),
  ].join("\n");
}

export function windowsInstallScript(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  scriptUrl?: string;
}): string {
  const url = opts.scriptUrl ?? `${opts.server}/install.ps1`;
  return `irm ${url} | iex -Args "-Server ${opts.server} -ApiKey ${opts.apiKey} -Name ${opts.displayName}"`;
}

const PENDING_KEY = "meterhouse_pending_api_key";
const PENDING_NAME = "meterhouse_pending_display_name";

export function stashConnectInfo(apiKey: string, displayName?: string): void {
  sessionStorage.setItem(PENDING_KEY, apiKey);
  if (displayName) sessionStorage.setItem(PENDING_NAME, displayName);
}

export function readStashedConnect(): { apiKey: string | null; displayName: string | null } {
  return {
    apiKey: sessionStorage.getItem(PENDING_KEY),
    displayName: sessionStorage.getItem(PENDING_NAME),
  };
}

export function clearStashedConnect(): void {
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_NAME);
}
