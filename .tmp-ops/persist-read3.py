import sqlite3, json
ids = {"write":"94ed81a6-e2da-4f91-9cd1-da36a7f4c873","ls":"608db158-2f4f-4460-9c57-c3a51ad87514","cat":"02450d88-5191-4048-8916-417db3910f7d"}
con = sqlite3.connect("file:/data/harness/live-full-flow/harness.sqlite?mode=ro", uri=True)
for name, rid in ids.items():
    answer = "".join(d for c, d in con.execute("select channel, delta from run_output_chunks where run_id=? order by sequence", (rid,)).fetchall() if c == "answer")
    print("== " + name, rid[:8], "answer:", answer[:300].replace(chr(10), " | "))
    for seq, t, p in con.execute("select sequence, type, substr(payload_json,1,300) from run_events where run_id=? and type like 'TOOL_%' order by sequence", (rid,)).fetchall():
        print("    ", seq, t, p[:230])
