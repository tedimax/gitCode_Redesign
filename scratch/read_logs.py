import json
import os

log_file = r"C:\Users\peter\.gemini\antigravity\brain\693c6ee8-12b2-4454-bc5d-6f122855e30b\.system_generated\logs\transcript.jsonl"

with open(log_file, "r", encoding="utf-8") as f:
    for line in f:
        try:
            data = json.loads(line)
            if "content" in data:
                content = data["content"]
                if "Merged" in content and "SSID" in content:
                    print(content[:2000]) # Print first 2000 chars of the log content
                    print("="*80)
        except Exception as e:
            pass
