import { LAYERS, MODULES } from "./data.js";

// 八模块探索器：四层泳道，点击模块看"做什么 / 怎么做 / 代码在哪"
export function mountArchitecture(root, detailEl) {
  const lanes = document.createElement("div");
  lanes.className = "lanes";

  // 从上到下：接入 → 管理 → 通道 → 底座
  LAYERS.forEach((layer) => {
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.style.setProperty("--c", layer.color);
    lane.innerHTML = `
      <div class="lane-name"><b>${layer.name}</b><span>${layer.sub}</span></div>
      <div class="lane-cards"></div>`;
    const cards = lane.querySelector(".lane-cards");
    MODULES.filter((m) => m.layer === layer.id).forEach((m) => {
      const card = document.createElement("button");
      card.className = "mod";
      card.dataset.id = m.id;
      card.innerHTML = `<span class="mid">${m.id}</span><b>${m.name}</b><small>${m.short}</small>`;
      card.addEventListener("click", () => select(m.id));
      cards.appendChild(card);
    });
    lanes.appendChild(lane);
  });

  const boundary = document.createElement("div");
  boundary.className = "boundary";
  boundary.textContent = "▲ 宿主机侧（以上）　｜　硬件隔离边界 KVM　｜　▼ VM 内部（guest 执行命令）";
  lanes.insertBefore(boundary, lanes.children[2]);

  root.appendChild(lanes);

  function select(id) {
    root.querySelectorAll(".mod").forEach((el) => el.classList.toggle("on", el.dataset.id === id));
    const m = MODULES.find((x) => x.id === id);
    const layer = LAYERS.find((l) => l.id === m.layer);
    detailEl.innerHTML = `
      <div class="pill" style="--c:${layer.color}">${layer.name} · ${m.id}</div>
      <h3>${m.name}</h3>
      <dl>
        <dt>做什么</dt><dd>${m.what}</dd>
        <dt>怎么做</dt><dd>${m.how}</dd>
        <dt>代码位置</dt><dd><code>${m.code}</code></dd>
      </dl>`;
    detailEl.classList.remove("flash");
    void detailEl.offsetWidth;
    detailEl.classList.add("flash");
  }

  select("M8");
  return { select };
}
