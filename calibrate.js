"use strict";

// 下絵の位置合わせ。上の「基準」（位置の分かっている画像。config.json の reference）と、下の「下絵」で、
// 同じ場所（改札の端、柱、通路の角など）を 上 → 下 の順に押して組にする。3組以上で、
// 下絵のピクセル → 共通座標の1次変換を最小二乗で求め、組ごとのずれ（m）を出す。
// 結果は config.json として保存し、data/ に下絵の画像と一緒に置く
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const TAP_TOLERANCE_PX = 8;

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

const state = {
  config: null,
  target: { src: "", name: "", width: 0, height: 0 },
  pairs: [], // [{ ref: {u, v}, target: {u, v} }]
  pending: null, // 基準だけ押した点
  fit: null,
};

// 1枚ぶんの地図（ドラッグで移動、2本指とホイールで拡大縮小、動かさずに離したらタップ）
function makePane(svg, onTap) {
  const pane = { svg, view: { x: 0, y: 0, w: 100, h: 100 }, width: 0, height: 0, image: svgElement("g", {}), overlay: svgElement("g", {}), marks: svgElement("g", {}) };
  svg.append(pane.image, pane.overlay, pane.marks);
  const apply = () => svg.setAttribute("viewBox", `${pane.view.x} ${pane.view.y} ${pane.view.w} ${pane.view.h}`);
  pane.fit = () => {
    const rect = svg.getBoundingClientRect();
    const aspect = rect.width / rect.height || 1;
    const w = aspect > pane.width / pane.height ? pane.height * aspect : pane.width;
    pane.view = { x: pane.width / 2 - w / 2, y: pane.height / 2 - w / aspect / 2, w, h: w / aspect };
    apply();
  };
  pane.unit = () => pane.view.w / (svg.getBoundingClientRect().width || 1);
  pane.apply = apply;
  const toPoint = (x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  const zoom = (k, cx, cy) => {
    const v = pane.view;
    pane.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: v.w * k, h: v.h * k };
    apply();
    redraw();
  };
  const pointers = new Map();
  let gesture = null;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture = { moved: pointers.size > 1, start: { x: e.clientX, y: e.clientY } };
  });
  svg.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev || !gesture) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (pointers.size === 1) {
      if (Math.hypot(cur.x - gesture.start.x, cur.y - gesture.start.y) > TAP_TOLERANCE_PX) gesture.moved = true;
      if (gesture.moved) {
        const u = pane.unit();
        pane.view.x -= (cur.x - prev.x) * u;
        pane.view.y -= (cur.y - prev.y) * u;
        apply();
      }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.entries()].map(([id, p]) => (id === e.pointerId ? cur : p));
      const [pa, pb] = [...pointers.values()];
      const before = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0 && after > 0) {
        const p = toPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoom(before / after, p.x, p.y);
      }
    }
    pointers.set(e.pointerId, cur);
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (gesture && !gesture.moved && pointers.size === 0 && e.type === "pointerup") {
      const p = toPoint(e.clientX, e.clientY);
      onTap(p.x, p.y);
    }
    if (pointers.size === 0) gesture = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = toPoint(e.clientX, e.clientY);
    zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }, { passive: false });
  return pane;
}

const refPane = makePane($("ref"), (u, v) => {
  state.pending = { u, v };
  redraw();
});
const targetPane = makePane($("target"), (u, v) => {
  if (!state.pending) return;
  state.pairs.push({ ref: state.pending, target: { u, v } });
  state.pending = null;
  refit();
});

function setImage(pane, src, width, height) {
  pane.width = width;
  pane.height = height;
  pane.image.replaceChildren(svgElement("image", { href: src, x: 0, y: 0, width, height, preserveAspectRatio: "none" }));
  pane.fit();
}

// 組から変換を求め、組ごとのずれ（求めた変換で下絵の点を共通座標にしたものと、基準の点の共通座標の差）を出す
function refit() {
  const refT = state.config.reference.transform;
  const rows = state.pairs.map((p) => {
    const w = Geo.toWorld(refT, p.ref.u, p.ref.v);
    return { u: p.target.u, v: p.target.v, x: w.x, z: w.z };
  });
  state.fit = Geo.fit(rows);
  if (state.fit) {
    state.residuals = rows.map((r) => {
      const w = Geo.toWorld(state.fit, r.u, r.v);
      return Math.hypot(w.x - r.x, w.z - r.z);
    });
  }
  redraw();
}

function mark(pane, p, label, pending) {
  const r = 9 * pane.unit();
  const g = svgElement("g", { class: pending ? "pt pending" : "pt" });
  g.append(svgElement("circle", { cx: p.u, cy: p.v, r, "stroke-width": 2 * pane.unit() }));
  const t = svgElement("text", { x: p.u, y: p.v, "font-size": 10 * pane.unit() });
  t.textContent = label;
  g.append(t);
  pane.marks.append(g);
}

function redraw() {
  for (const pane of [refPane, targetPane]) pane.marks.replaceChildren();
  state.pairs.forEach((p, i) => {
    mark(refPane, p.ref, String(i + 1));
    mark(targetPane, p.target, String(i + 1));
  });
  if (state.pending) mark(refPane, state.pending, String(state.pairs.length + 1), true);
  // 求めた変換で、基準の画像を下絵の上に重ねる（基準のピクセル → 共通座標 → 下絵のピクセル）
  targetPane.overlay.replaceChildren();
  if (state.fit && $("overlay").checked) {
    const refT = state.config.reference.transform;
    const map = (u, v) => {
      const w = Geo.toWorld(refT, u, v);
      return Geo.toPixel(state.fit, w.x, w.z);
    };
    const o = map(0, 0);
    const ex = map(1, 0);
    const ey = map(0, 1);
    const m = [ex.u - o.u, ex.v - o.v, ey.u - o.u, ey.v - o.v, o.u, o.v].map((n) => n.toFixed(6)).join(" ");
    const { src, width, height } = state.config.reference;
    targetPane.overlay.append(svgElement("image", { href: src, x: 0, y: 0, width, height, preserveAspectRatio: "none", class: "overlay-image", transform: `matrix(${m})` }));
  }
  $("hint").textContent = state.pending ? `${state.pairs.length + 1}: 下絵で同じ場所を押す` : `${state.pairs.length + 1}: 基準で目印（改札の端・柱・通路の角など）を押す`;
  $("pairs").replaceChildren(
    ...state.pairs.map((p, i) => {
      const li = document.createElement("li");
      const res = state.fit ? `  ずれ ${state.residuals[i].toFixed(2)} m` : "";
      li.textContent = `基準 (${p.ref.u.toFixed(0)}, ${p.ref.v.toFixed(0)}) → 下絵 (${p.target.u.toFixed(0)}, ${p.target.v.toFixed(0)})${res}`;
      return li;
    }),
  );
  const fitLine = $("fit");
  fitLine.className = "fit-line";
  if (!state.fit) {
    fitLine.textContent = state.pairs.length < 3 ? `あと ${3 - state.pairs.length} 組で計算します（6〜8組を広く散らすのがおすすめ）` : "計算できません（点が一直線に並んでいます）";
  } else {
    const rms = Math.sqrt(state.residuals.reduce((s, r) => s + r * r, 0) / state.residuals.length);
    const max = Math.max(...state.residuals);
    fitLine.textContent = `ずれ 平均 ${rms.toFixed(2)} m・最大 ${max.toFixed(2)} m（1px = ${(Geo.metersPerPixel(state.fit) * 100).toFixed(1)} cm）`;
    fitLine.classList.add(max <= 1.5 ? "good" : "bad");
  }
  $("save").disabled = !state.fit;
}

$("overlay").addEventListener("change", redraw);
$("undo").addEventListener("click", () => {
  if (state.pending) state.pending = null;
  else state.pairs.pop();
  refit();
});

// 下絵の画像はこの端末の中で開くだけ（どこにも送らない）
$("target-file").addEventListener("change", async () => {
  const file = $("target-file").files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  state.target = { src: url, name: file.name, width: image.naturalWidth, height: image.naturalHeight };
  state.pairs = [];
  state.pending = null;
  setImage(targetPane, url, image.naturalWidth, image.naturalHeight);
  refit();
});

// config.json を保存する。下絵の画像は data/ に、この名前（base.png か base.jpg）で置く
$("save").addEventListener("click", () => {
  const ext = /\.jpe?g$/i.test(state.target.name) ? "jpg" : "png";
  const round = (n) => Number(n.toPrecision(10));
  const t = Object.fromEntries(Object.entries(state.fit).map(([k, v]) => [k, round(v)]));
  const config = {
    ...state.config,
    image: {
      src: `data/base.${ext}`,
      width: state.target.width,
      height: state.target.height,
      transform: t,
      note: `${state.target.name || "下絵"} を ${state.pairs.length} 組の目印で合わせた（ずれ 最大 ${Math.max(...state.residuals).toFixed(2)} m）`,
      pairs: state.pairs.map((p) => ({ ref: [round(p.ref.u), round(p.ref.v)], target: [round(p.target.u), round(p.target.v)] })),
    },
  };
  const blob = new Blob([JSON.stringify(config, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "config.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

window.addEventListener("resize", () => {
  refPane.fit();
  targetPane.fit();
  redraw();
});

async function main() {
  state.config = await (await fetch("data/config.json", { cache: "no-cache" })).json();
  const { reference, image } = state.config;
  setImage(refPane, reference.src, reference.width, reference.height);
  // 最初は今の下絵を出す（JR の構内図は右上のボタンで開く）
  state.target = { src: image.src, name: image.src.split("/").pop(), width: image.width, height: image.height };
  setImage(targetPane, image.src, image.width, image.height);
  redraw();
}

main();
