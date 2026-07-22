import sys
from pathlib import Path

# Make the package importable when running pytest from the agent/ dir.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SYSTEM_ID = "test-system-0001"


def assistant_record(session_id="s1", message_id="m1", model="claude-opus-4-8",
                     inp=100, out=50, cache_read=0, cache_creation=0,
                     ts="2026-07-22T10:00:00.000Z", cwd="/home/u/Github/proj",
                     tool_name=None, is_sidechain=False):
    content = []
    if tool_name:
        content.append({"type": "tool_use", "name": tool_name})
    rec = {
        "type": "assistant",
        "sessionId": session_id,
        "timestamp": ts,
        "cwd": cwd,
        "gitBranch": "main",
        "message": {
            "id": message_id,
            "model": model,
            "usage": {
                "input_tokens": inp,
                "output_tokens": out,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_creation,
            },
            "content": content,
        },
    }
    if is_sidechain:
        rec["isSidechain"] = True
    return rec
