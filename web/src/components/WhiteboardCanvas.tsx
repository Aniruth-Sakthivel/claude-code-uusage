/**
 * The actual canvas for one board: sticky notes + freehand strokes, synced
 * live over the dashboard WebSocket (see lib/ws.ts `sendBoardOp`/
 * `onBoardUpdate`/`onBoardDelete` — there's no REST write path, see
 * routes/whiteboard.ts).
 *
 * Explicit v1 cuts: fixed-size canvas, no pan/zoom (so "infinite" is
 * aspirational, not literal); no live cursors/presence; strokes can be
 * drawn but not individually selected or deleted (notes can be); no
 * undo/redo.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import { useRealtime } from "../context/RealtimeContext";
import type { BoardElement } from "../lib/ws";
import { Button } from "./ui";

const CANVAS_W = 2000;
const CANVAS_H = 1200;
const NOTE_W = 160;
const NOTE_H = 120;
const NOTE_COLORS = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#e9d5ff"];

interface NoteData {
  x: number;
  y: number;
  text: string;
  color: string;
}
interface StrokeData {
  points: [number, number][];
  color: string;
}

type Tool = "select" | "note" | "pen";

export function WhiteboardCanvas({ boardId }: { boardId: number }) {
  const { onBoardUpdate, onBoardDelete, sendBoardOp } = useRealtime();
  const [tool, setTool] = useState<Tool>("select");
  const [elements, setElements] = useState<Map<number, BoardElement>>(new Map());
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [dragging, setDragging] = useState<{ id: number; dx: number; dy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const q = useQuery({
    queryKey: qk.boardElements(boardId),
    queryFn: () => api.get<BoardElement[]>(`/workspace/boards/${boardId}/elements`),
  });

  useEffect(() => {
    if (q.data) setElements(new Map(q.data.map((e) => [e.id, e])));
  }, [q.data]);

  useEffect(() => {
    const offUpdate = onBoardUpdate((evt) => {
      if (evt.board_id !== boardId) return;
      setElements((prev) => new Map(prev).set(evt.element.id, evt.element));
    });
    const offDelete = onBoardDelete((evt) => {
      if (evt.board_id !== boardId) return;
      setElements((prev) => {
        const next = new Map(prev);
        next.delete(evt.element_id);
        return next;
      });
    });
    return () => {
      offUpdate();
      offDelete();
    };
  }, [boardId, onBoardUpdate, onBoardDelete]);

  const toSvgPoint = (e: React.MouseEvent): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return [x, y];
  };

  const addNote = (x: number, y: number) => {
    const color = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)]!;
    sendBoardOp(boardId, {
      kind: "create",
      element_kind: "note",
      data: { x: x - NOTE_W / 2, y: y - NOTE_H / 2, text: "New note", color } satisfies NoteData,
    });
    setTool("select");
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const [x, y] = toSvgPoint(e);
    if (tool === "note") {
      addNote(x, y);
    } else if (tool === "pen") {
      setDrawing([[x, y]]);
    }
  };

  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (drawing) {
      const [x, y] = toSvgPoint(e);
      setDrawing((pts) => (pts ? [...pts, [x, y]] : pts));
    } else if (dragging) {
      const [x, y] = toSvgPoint(e);
      const el = elements.get(dragging.id);
      if (!el) return;
      const data = el.data as unknown as NoteData;
      setElements((prev) =>
        new Map(prev).set(dragging.id, {
          ...el,
          data: { ...data, x: x - dragging.dx, y: y - dragging.dy },
        }),
      );
    }
  };

  const onCanvasMouseUp = () => {
    if (drawing && drawing.length > 1) {
      sendBoardOp(boardId, { kind: "create", element_kind: "stroke", data: { points: drawing, color: "#334155" } satisfies StrokeData });
    }
    setDrawing(null);
    if (dragging) {
      const el = elements.get(dragging.id);
      if (el) sendBoardOp(boardId, { kind: "update", element_id: dragging.id, data: el.data });
    }
    setDragging(null);
  };

  const startDragNote = (e: React.MouseEvent, el: BoardElement) => {
    if (tool !== "select") return;
    e.stopPropagation();
    const [x, y] = toSvgPoint(e);
    const data = el.data as unknown as NoteData;
    setDragging({ id: el.id, dx: x - data.x, dy: y - data.y });
  };

  const updateNoteText = (el: BoardElement, text: string) => {
    const data = el.data as unknown as NoteData;
    sendBoardOp(boardId, { kind: "update", element_id: el.id, data: { ...data, text } });
  };

  const deleteElement = (id: number) => {
    sendBoardOp(boardId, { kind: "delete", element_id: id });
  };

  const notes = [...elements.values()].filter((e) => e.kind === "note");
  const strokes = [...elements.values()].filter((e) => e.kind === "stroke");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <Button size="sm" variant={tool === "select" ? "primary" : "ghost"} onClick={() => setTool("select")}>
          Select
        </Button>
        <Button size="sm" variant={tool === "note" ? "primary" : "ghost"} onClick={() => setTool("note")}>
          + Sticky note
        </Button>
        <Button size="sm" variant={tool === "pen" ? "primary" : "ghost"} onClick={() => setTool("pen")}>
          Draw
        </Button>
      </div>

      <div className="overflow-auto rounded-2xl border border-line bg-surface-2" style={{ maxHeight: "70vh" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          width={CANVAS_W}
          height={CANVAS_H}
          className={tool === "pen" ? "cursor-crosshair" : tool === "note" ? "cursor-copy" : ""}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
        >
          <rect width={CANVAS_W} height={CANVAS_H} fill="var(--surface-2)" />

          {strokes.map((s) => {
            const data = s.data as unknown as StrokeData;
            return (
              <polyline
                key={s.id}
                fill="none"
                stroke={data.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={data.points.map((p) => p.join(",")).join(" ")}
              />
            );
          })}
          {drawing && (
            <polyline
              fill="none"
              stroke="#334155"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={drawing.map((p) => p.join(",")).join(" ")}
            />
          )}

          {notes.map((n) => {
            const data = n.data as unknown as NoteData;
            return (
              <foreignObject
                key={n.id}
                x={data.x}
                y={data.y}
                width={NOTE_W}
                height={NOTE_H}
                onMouseDown={(e) => startDragNote(e, n)}
              >
                <div
                  className="group relative h-full w-full rounded-md p-2 text-xs shadow-sm"
                  style={{ background: data.color, cursor: tool === "select" ? "grab" : "default" }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteElement(n.id);
                    }}
                    className="absolute right-1 top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-black/10 text-2xs group-hover:flex"
                    aria-label="Delete note"
                  >
                    ×
                  </button>
                  <textarea
                    value={data.text}
                    onChange={(e) => updateNoteText(n, e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="h-full w-full resize-none bg-transparent text-ink-2 outline-none"
                    style={{ color: "#1f2937" }}
                  />
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
