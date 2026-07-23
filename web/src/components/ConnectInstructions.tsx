import { useState } from "react";
import {
  AGENT_INSTALL,
  agentInstallFromGit,
  fullSetupBlock,
  registerCommand,
  scanSyncCommands,
  serverUrl,
  windowsInstallScript,
} from "../lib/agentSetup";
import { Button } from "./ui";

function CodeBlock({ label, code, copyLabel }: { label: string; code: string; copyLabel?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[12.5px] font-semibold">{label}</div>
        <Button variant="ghost" onClick={copy}>{copied ? "Copied" : (copyLabel ?? "Copy")}</Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed whitespace-pre-wrap"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ConnectInstructions({
  apiKey,
  displayName,
  showGitFallback = true,
}: {
  apiKey: string;
  displayName: string;
  showGitFallback?: boolean;
}) {
  const server = serverUrl();
  const hasKey = apiKey.trim().length > 0;
  const name = displayName.trim() || "PC-01";
  const keyPlaceholder = "cfk_PASTE_YOUR_KEY_HERE";

  return (
    <div>
      <div className="mb-4 rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink-2)" }}>
        Run these commands <b>on the PC where Claude Code is installed</b> — not in the browser.
        The agent reads local transcript files and sends only token metadata to{" "}
        <code className="text-[11.5px]">{server}</code>.
      </div>

      <CodeBlock label="Step 1 · Install agent (once per PC)" code={AGENT_INSTALL} />

      {showGitFallback && (
        <details className="mb-4">
          <summary className="cursor-pointer text-[12.5px] font-medium" style={{ color: "var(--accent)" }}>
            Package not found? Install from git instead
          </summary>
          <div className="mt-2">
            <CodeBlock label="Install from repository" code={agentInstallFromGit()} />
          </div>
        </details>
      )}

      <CodeBlock
        label="Step 2 · Connect this PC (once)"
        code={registerCommand(server, hasKey ? apiKey : keyPlaceholder, name)}
      />

      <CodeBlock label="Step 3 · Scan and sync" code={scanSyncCommands()} />

      {hasKey && (
        <>
          <CodeBlock
            label="All steps (copy everything)"
            code={fullSetupBlock({ server, apiKey, displayName: name })}
            copyLabel="Copy all"
          />

          <CodeBlock
            label="Windows one-click installer (PowerShell)"
            code={windowsInstallScript({ server, apiKey, displayName: name })}
          />
        </>
      )}

      {!hasKey && (
        <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          Paste your API key above to see the full command block. Keys are shown once when an admin
          creates a system — ask your admin if you do not have one yet.
        </p>
      )}
    </div>
  );
}
