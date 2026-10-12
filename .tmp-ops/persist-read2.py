import sqlite3
con = sqlite3.connect("file:/data/harness/live-full-flow/harness.sqlite?mode=ro", uri=True)
print([r[1] for r in con.execute("pragma table_info(run_events)")])
print([r[1] for r in con.execute("pragma table_info(run_output_chunks)")])
rid = "02450d88-5191-4048-8916-417db3910f7d"
print("channels", con.execute("select channel, count(*) from run_output_chunks where run_id=? group by channel", (rid,)).fetchall())
for seq, t, p in con.execute("select sequence, type, substr(data,1,260) from run_events where run_id=? order by sequence", (rid,)).fetchall()[-8:]:
    print(seq, t, p[:240])
