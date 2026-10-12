import gsap from "gsap";
import { EXEC_REQUEST, EXEC_OUTPUT, EXEC_RESULT, COLD_MS, WARM_BREAKDOWN, WARM_TOTAL_MS } from "./data.js";

const HOPS = [
  { id: "tool", label: "工具调用", sub: "pi-tool-gateway", lane: "host" },
  { id: "bridge", label: "vsock 桥", sub: "宿主侧 bridge.ts", lane: "host" },
  { id: "sock", label: "vsock.sock", sub: "Firecracker 的门", lane: "edge" },
  { id: "socat", label: "socat", sub: "guest 接线员 :5000", lane: "guest" },
  { id: "agent", label: "agent", sub: "spawn(argv)", lane: "guest" },
  { id: "ws", label: "/workspace", sub: "执行 sh -lc", lane: "guest" },
];

// ---------- 通信：一次 exec 的往返 ----------
export function mountChannel(root) {
  root.innerHTML = `
    <div class="ch-track">
      <div class="ch-zone host"><span>宿主机</span></div>
      <div class="ch-zone edge"><span>KVM 边界</span></div>
      <div class="ch-zone guest"><span>虚拟机内部</span></div>
      <div class="ch-nodes"></div>
      <div class="ch-packet"><span>exec</span></div>
    </div>
    <div class="ch-frames">
      <div class="ch-frame"><div class="ch-fh up">宿主 → guest</div><pre class="ch-req"></pre></div>
      <div class="ch-frame"><div class="ch-fh down">guest → 宿主</div><pre class="ch-res"></pre></div>
    </div>
    <div class="ch-controls">
      <button class="primary ch-go">▶ 执行一次 exec</button>
      <span class="ch-status">就绪：通道已握手（CONNECT 5000 → OK，ping/pong）</span>
    </div>`;

  const nodesEl = root.querySelector(".ch-nodes");
  const packet = root.querySelector(".ch-packet");
  const reqEl = root.querySelector(".ch-req");
  const resEl = root.querySelector(".ch-res");
  const status = root.querySelector(".ch-status");
  const go = root.querySelector(".ch-go");

  reqEl.textContent = JSON.stringify(EXEC_REQUEST, null, 2);
  resEl.textContent = "（等待 guest 返回）";

  // 节点位置：六个节点横向均分
  const pos = HOPS.map((h, i) => {
    const el = document.createElement("div");
    el.className = `ch-node ${h.lane}`;
    el.innerHTML = `<b>${h.label}</b><small>${h.sub}</small>`;
    el.style.left = `${(i / (HOPS.length - 1)) * 86 + 7}%`;
    nodesEl.appendChild(el);
    return el;
  });

  function xOf(i) {
    const r = pos[i].getBoundingClientRect();
    const parent = root.querySelector(".ch-track").getBoundingClientRect();
    return r.left - parent.left + r.width / 2;
  }

  let busy = false;
  go.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    resEl.textContent = "（等待 guest 返回）";
    status.textContent = "发送中…";
    const tl = gsap.timeline({
      onComplete: () => {
        busy = false;
        status.textContent = "完成：exitCode=0，timedOut=false，truncated=false";
      },
    });
    // 请求方向：经过每一跳
    tl.set(packet, { opacity: 1, x: xOf(0), y: 0 });
    HOPS.forEach((h, i) => {
      if (i === 0) return;
      tl.add(() => { status.textContent = `经过：${h.label}`; });
      tl.to(packet, { x: xOf(i), duration: 0.55, ease: "power2.inOut" });
    });
    tl.add(() => { reqEl.classList.add("hot"); status.textContent = "agent 在 /workspace 下 spawn(argv)"; });
    tl.to({}, { duration: 0.6 });
    tl.add(() => { reqEl.classList.remove("hot"); resEl.textContent = JSON.stringify(EXEC_OUTPUT, null, 2) + "\n\n" + JSON.stringify(EXEC_RESULT, null, 2); });
    // 返回方向：反向穿过（用第二个小包）
    tl.set(packet, { x: xOf(HOPS.length - 1), opacity: 1 });
    tl.add(() => packet.classList.add("back"));
    for (let i = HOPS.length - 2; i >= 0; i--) {
      tl.to(packet, { x: xOf(i), duration: 0.45, ease: "power2.inOut" });
    }
    tl.to(packet, { opacity: 0, duration: 0.2 });
    tl.add(() => packet.classList.remove("back"));
  });

  // 初始包位置
  requestAnimationFrame(() => gsap.set(packet, { opacity: 0, x: xOf(0) }));
  window.addEventListener("resize", () => gsap.set(packet, { x: xOf(0) }));
}

// ---------- 启动耗时对比 ----------
export function mountStartup(root) {
  const scale = 1600; // ms → 100%
  const pct = (ms) => (ms / scale) * 100;
  root.innerHTML = `
    <div class="st-rows">
      <div class="st-row">
        <div class="st-label"><b>冷启动</b><small>从零开机（无快照）</small></div>
        <div class="st-track"><div class="st-bar cold"></div></div>
        <div class="st-val">${COLD_MS} ms</div>
      </div>
      <div class="st-row">
        <div class="st-label"><b>快照恢复</b><small>同模板复用存档</small></div>
        <div class="st-track"><div class="st-stack"></div></div>
        <div class="st-val">≈ ${WARM_TOTAL_MS} ms</div>
      </div>
    </div>
    <div class="st-legend"></div>
    <div class="st-note">数字来自项目历史真机实测（docs/vm-lifecycle-benchmark.zh-CN.md、platform-boundary.md），本页未重测。</div>
    <button class="st-replay">↻ 重新播放动画</button>`;

  const coldBar = root.querySelector(".st-bar.cold");
  const stack = root.querySelector(".st-stack");
  const legend = root.querySelector(".st-legend");

  WARM_BREAKDOWN.forEach((seg) => {
    const s = document.createElement("div");
    s.className = "st-seg";
    s.style.background = seg.color;
    s.style.width = "0%";
    s.title = `${seg.name}：${seg.ms} ms`;
    stack.appendChild(s);
    const li = document.createElement("span");
    li.innerHTML = `<i style="background:${seg.color}"></i>${seg.name} <em>${seg.ms}ms</em>`;
    legend.appendChild(li);
  });

  function play() {
    gsap.set(coldBar, { width: "0%" });
    const segs = stack.querySelectorAll(".st-seg");
    segs.forEach((s) => gsap.set(s, { width: "0%" }));
    gsap.to(coldBar, { width: `${pct(COLD_MS)}%`, duration: 1.6, ease: "power2.out" });
    const tl = gsap.timeline({ delay: 0.2 });
    WARM_BREAKDOWN.forEach((seg, i) => {
      tl.to(segs[i], { width: `${pct(seg.ms)}%`, duration: 0.45, ease: "power1.inOut" });
    });
  }
  root.querySelector(".st-replay").addEventListener("click", play);
  play();
}
