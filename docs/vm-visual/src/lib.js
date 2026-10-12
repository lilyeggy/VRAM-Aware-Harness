import gsap from "gsap";

// 通用"节点轨道"：一排节点 + 一个会移动的光点 + 一行解说文字。
// 每一步 = 光点移动到某节点 → 高亮 → 显示解说 → 停留。
export function createTrack(root, nodes, captionEl) {
  root.classList.add("track");
  root.innerHTML = `
    <div class="track-line"></div>
    ${nodes.map((n, i) => `
      <div class="tnode" data-i="${i}" style="--c:${n.color || "#5ac8fa"}">
        <b>${n.label}</b><small>${n.sub || ""}</small>
      </div>`).join("")}
    <div class="tdot"></div>`;
  const els = [...root.querySelectorAll(".tnode")];
  const dot = root.querySelector(".tdot");
  const xOf = (i) => els[i].offsetLeft + els[i].offsetWidth / 2;

  let tl = null;
  function reset() {
    if (tl) tl.kill();
    els.forEach((e) => e.classList.remove("on"));
    gsap.set(dot, { left: xOf(0), opacity: 1, background: "#5ac8fa" });
    captionEl.innerHTML = "";
  }
  // steps: [{to, text, color?, hold?, mark?}]  mark = "bad" 表示被拒绝/异常
  function run(steps) {
    reset();
    tl = gsap.timeline();
    steps.forEach((s) => {
      tl.to(dot, { left: xOf(s.to), duration: s.dur ?? 0.8, ease: "power2.inOut" });
      tl.call(() => {
        els.forEach((e, i) => e.classList.toggle("on", i === s.to));
        gsap.to(dot, { background: s.color || "#5ac8fa", duration: 0.2 });
        captionEl.innerHTML = s.text;
        if (s.mark === "bad") root.classList.add("bad"); else root.classList.remove("bad");
      });
      tl.to({}, { duration: s.hold ?? 1.2 });
    });
    return tl;
  }
  requestAnimationFrame(reset);
  window.addEventListener("resize", () => gsap.set(dot, { left: xOf(0) }));
  return { run, reset };
}
