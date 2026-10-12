import sqlite3, json
ids = ["94ed81a6-e2da-4f91-9cd1-da36a7f4c873","608db158-2f4f-4460-9c57-c3a51ad87514","02450d88-5191-4048-8916-417db3910f7d"]
con = sqlite3.connect("file:/data/harness/live-full-flow/harness.sqlite?mode=ro", uri=True)
for rid in ids:
    chunks = con.execute("select channel, delta from run_output_chunks where run_id=? order by sequence", (rid,)).fetchall()
    text = "".join(d for c, d in chunks if c == "assistant")
    print("== run", rid[:8], "assistant chars", len(text))
    print(text[:500].replace("\n", " | "))
    rows = con.execute("select sequence, type, substr(payload,1,300) from run_events where run_id=? and type like 'TOOL%%' order by sequence", (rid,)).fetchall()
    for seq, t, p in rows:
        print("   ", seq, t, p[:240])
