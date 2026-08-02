/**
 * Shared markdown textarea + preview toggle — used by the Docs tab and any
 * task/initiative description field, so the edit/preview logic isn't
 * duplicated in three places.
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";

import { Button, Textarea } from "./ui";

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
}) {
  const [preview, setPreview] = useState(readOnly);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={preview ? "subtle" : "ghost"}
          onClick={() => setPreview(false)}
          disabled={readOnly}
        >
          Write
        </Button>
        <Button
          type="button"
          size="sm"
          variant={preview ? "ghost" : "subtle"}
          onClick={() => setPreview(true)}
        >
          Preview
        </Button>
      </div>

      {preview ? (
        <div className="prose-sm min-h-[3rem] rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-base text-ink [&_a]:text-accent [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-3">
          {value.trim() ? (
            <ReactMarkdown>{value}</ReactMarkdown>
          ) : (
            <span className="text-muted">Nothing written yet.</span>
          )}
        </div>
      ) : (
        <Textarea
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          rows={rows}
        />
      )}
    </div>
  );
}
