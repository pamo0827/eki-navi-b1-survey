"use strict";

// 新宿駅 地下1階の、看板の記録・改札の中の道筋・経路のページ（サーバーなしで動く静的なページ）。
// 地図は下絵の画像のピクセル (u, v) で描き、記録や道筋は eki-navi の共通座標 (x = 東, z = 北) で持つ。
// 変換は data/config.json の transform（geo.js）。下絵を JR の構内図に差し替えても、transform を変えるだけで済む
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

// 看板の大きさ。値は signs.json にある看板の実測値。heightMeters はアプリが看板までの距離を求めるのに使う
const SIZES = [
  { key: "hanging-thin", width: 3.0, height: 0.3, centerHeight: 2.7, mount: "hanging", label: "吊り下げ（細長）" }, // S-B1-H02
  { key: "hanging-large", width: 6.5, height: 0.6, centerHeight: 3.5, mount: "hanging", label: "吊り下げ（大）" }, // S-2F-R01-A
];
// 好きな大きさ。幅と高さだけを入れてもらい、取り付けと床から中心までは吊り下げ（細長）と同じにする
const CUSTOM_SIZE = { key: "custom", centerHeight: 2.7, mount: "hanging", label: "好きな大きさ" };
const TAP_TOLERANCE_PX = 8;
const MARKER_SCALE = 1 / 45; // 看板の板の幅（地図全体を映したときの画面の幅に対する割合）
const MARKER_HIT_PX = 22; // 板とつまみをつかめる最小の半径（画面のピクセル）
const MARKER_KNOB_PX = 40; // 板の真ん中からつまみまで（地図全体を映したときの画面のピクセル）
const MIN_VIEW_METERS = 8; // いちばん拡大したときの画面の幅
const MARKER_RISE_MS = 380;
const DEFAULT_AZIMUTH = 180; // 印を出したときの表の向き（南）
const PHOTO_MAX_PX = 1600; // 写真は長辺をこの大きさに縮めて保存する
const PHOTO_QUALITY = 0.85;
const NODE_PX = 7; // 道の点の半径（画面のピクセル）
const NODE_HIT_PX = 20; // 道の点をつかめる半径（画面のピクセル）
const NETWORK_KEY = "eki-b1-network-v1"; // 道筋はこの端末に残す（看板の記録と違い、開き直しても消さない）
const RECORDS_KEY = "eki-b1-records-v1";

const state = {
  config: null,
  t: null, // 下絵のピクセル → 共通座標の変換
  mode: "sign", // sign（看板）・path（道）・route（経路）
  view: { x: 0, y: 0, w: 100, h: 100 }, // 画面に映す範囲（下絵のピクセル）
  home: null, // 下絵全体を映したときの view。これより縮小しない
  sign: null, // 置いている看板の印（下絵のピクセル {u, v}）
  azimuth: DEFAULT_AZIMUTH, // 表の向き（北 = 0 時計回り、度）
  knownSigns: [],
  records: [], // 開くたびに空から始める
  network: { ordinal: -1, nodes: [], edges: [] },
  selected: null, // 道で選んでいる点の id
  route: { start: null, goal: null, path: [], length: 0 },
};

// ---- 共通 ----

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function normalizeDeg(deg) {
  const value = ((deg % 360) + 360) % 360;
  return round1(value) === 360 ? 0 : round1(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showStatus(element, text, isError) {
  element.textContent = text;
  element.classList.toggle("error", Boolean(isError));
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pixelOf = (point) => Geo.toPixel(state.t, point.x, point.z);
const worldOf = (u, v) => Geo.toWorld(state.t, u, v);

// ---- 画面の切り替え（地図 → 写真 → 保存） ----

const SCREENS = ["map", "photo", "list"];
let currentScreen = "map";

function showScreen(name, push = true) {
  currentScreen = name;
  const index = SCREENS.indexOf(name);
  SCREENS.forEach((other, i) => {
    const element = $(`screen-${other}`);
    const isBehind = i < index && !(name === "list" && other === "photo");
    element.hidden = other !== name && !isBehind;
    element.classList.toggle("behind", isBehind);
  });
  if (push) {
    history.pushState({ screen: name }, "", location.search);
  }
  if (name === "map") {
    requestAnimationFrame(applyView);
  }
}

// 保存の画面から地図へ戻るときは「リセットしていい？」と聞く（← のボタンでも、端末の戻る操作でも）
let skipAskOnBack = false;
window.addEventListener("popstate", async (event) => {
  const leaving = currentScreen;
  const target = event.state?.screen || "map";
  if (leaving === "list" && target === "map" && !skipAskOnBack && !(await confirmReset())) {
    history.pushState({ screen: "list" }, "", location.search);
    return;
  }
  skipAskOnBack = false;
  showScreen(target, false);
});
document.querySelectorAll(".back").forEach((button) => button.addEventListener("click", () => history.back()));

// ---- 地図の表示 ----

const map = $("survey-map");
const imageLayer = svgElement("g", {});
const networkLayer = svgElement("g", { class: "network-layer" });
const overlayLayer = svgElement("g", {});
const markerLayer = svgElement("g", {});
map.append(imageLayer, networkLayer, overlayLayer, markerLayer);

function svgUnitsPerPixel() {
  return state.view.w / (map.getBoundingClientRect().width || 1);
}

function toMapPoint(clientX, clientY) {
  const matrix = map.getScreenCTM();
  return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : null;
}

function applyView() {
  const { x, y, w, h } = state.view;
  map.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  drawNetwork();
  drawOverlay();
  drawMarker();
}

// 下絵全体が画面に収まる大きさにして、真ん中に置く
function fitImage() {
  const { width, height } = state.config.image;
  const rect = map.getBoundingClientRect();
  const aspect = rect.width / rect.height || 1;
  const w = aspect > width / height ? height * aspect : width;
  const h = w / aspect;
  state.view = { x: width / 2 - w / 2, y: height / 2 - h / 2, w, h };
}

// 地図を動かせるのは下絵の範囲の中だけ
function clampView() {
  const { width, height } = state.config.image;
  const v = state.view;
  v.x = v.w >= width ? width / 2 - v.w / 2 : clamp(v.x, 0, width - v.w);
  v.y = v.h >= height ? height / 2 - v.h / 2 : clamp(v.y, 0, height - v.h);
}

function zoom(factor, cx, cy) {
  const { x, y, w, h } = state.view;
  const maxW = state.home ? state.home.w : w;
  const minW = MIN_VIEW_METERS / Geo.metersPerPixel(state.t);
  const nextW = clamp(w * factor, Math.min(minW, maxW), maxW);
  const k = nextW / w;
  state.view = { x: cx - (cx - x) * k, y: cy - (cy - y) * k, w: w * k, h: h * k };
  clampView();
  applyView();
}

// 印の大きさ。地図全体を映したときの画面のピクセルで決め、地図と一緒に拡大縮小する
function markerSizes() {
  const home = state.home || state.view;
  const bp = home.w / (map.getBoundingClientRect().width || 1);
  return { s: home.w * MARKER_SCALE, bp, px: svgUnitsPerPixel() || bp, knob: MARKER_KNOB_PX * bp };
}

function insideImage(point) {
  const { u, v } = pixelOf(point);
  return u >= 0 && v >= 0 && u <= state.config.image.width && v <= state.config.image.height;
}

// 記録した看板と signs.json の看板は、板と表の向きへの短い線で残す（既存のものは薄く）
function drawSaved(sign, className) {
  const { s, bp } = markerSizes();
  const { u, v } = pixelOf(sign);
  const group = svgElement("g", { class: className, transform: `translate(${u} ${v}) rotate(${Geo.screenAngleOf(state.t, sign.azimuthDeg)})` });
  group.append(
    svgElement("path", { d: `M0 ${-s * 0.12} V${-s * 0.55}`, class: "tick", "stroke-width": 1.5 * bp }),
    svgElement("rect", { x: -s / 2, y: -s * 0.12, width: s, height: s * 0.24, rx: s * 0.05, class: "board" }),
  );
  overlayLayer.append(group);
}

function drawOverlay() {
  overlayLayer.replaceChildren();
  if (state.mode !== "sign") {
    return;
  }
  for (const sign of state.knownSigns.filter(insideImage)) {
    drawSaved(sign, "saved known");
  }
  for (const record of state.records) {
    drawSaved(record, "saved");
  }
}

// 看板の印: 板と、表の向きを示す点線と、向きを変えるつまみ
function drawMarker() {
  markerLayer.replaceChildren();
  if (!state.sign || state.mode !== "sign") {
    return;
  }
  const { s, bp, px, knob } = markerSizes();
  const group = svgElement("g", {
    class: "marker",
    transform: `translate(${state.sign.u} ${state.sign.v}) rotate(${Geo.screenAngleOf(state.t, state.azimuth)})`,
  });
  group.append(
    svgElement("circle", { cx: 0, cy: 0, r: Math.max(MARKER_HIT_PX * px, s * 0.6), class: "hit", "data-handle": "move" }),
    svgElement("path", { d: `M0 0 V${-knob + 6 * bp}`, class: "face", "stroke-width": 1.5 * bp, "stroke-dasharray": `${3 * bp} ${2.5 * bp}` }),
    svgElement("rect", { x: -s / 2, y: -s * 0.12, width: s, height: s * 0.24, rx: s * 0.05, class: "board", "stroke-width": bp, "data-handle": "move" }),
    svgElement("circle", { cx: 0, cy: -knob, r: Math.max(MARKER_HIT_PX * px, 10 * bp), class: "hit", "data-handle": "rotate" }),
    svgElement("circle", { cx: 0, cy: -knob, r: 6 * bp, class: "knob", "stroke-width": 2 * bp, "data-handle": "rotate" }),
  );
  markerLayer.append(group);
}

// ---- 使い方の切り替え（看板・道・経路） ----

function setMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll(".modes-nav button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  for (const bar of document.querySelectorAll("#screen-map .bar")) {
    bar.hidden = bar.dataset.bar !== mode;
  }
  state.selected = null;
  updatePathButtons();
  applyView();
}

document.querySelectorAll(".modes-nav button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));

// ---- 看板の印 ----

function setSign(u, v) {
  const { width, height } = state.config.image;
  state.sign = { u: clamp(u, 0, width), v: clamp(v, 0, height) };
  $("to-photo").disabled = false;
  $("add-sign").classList.add("placed");
  drawMarker();
}

// 看板の印を、画面の下から地図の真ん中まで上げる
function riseMarker() {
  const { x, y, w, h } = state.view;
  const from = { u: x + w / 2, v: y + h };
  const to = { u: x + w / 2, v: y + h / 2 };
  state.azimuth = DEFAULT_AZIMUTH;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / MARKER_RISE_MS);
    const ease = 1 - (1 - t) ** 3;
    setSign(from.u + (to.u - from.u) * ease, from.v + (to.v - from.v) * ease);
    if (t < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

$("add-sign").addEventListener("click", riseMarker);

// ---- 道（改札の中の道筋） ----
// 点と線の集まり。点は共通座標で持つ。何もない所を押すと点を足し、選んでいる点とつなぐ。
// 点を押すと選ぶ。点を選んでいるときに別の点を押すと、その2点の線をつなぐ／外す。点はドラッグで動かす

function saveNetwork() {
  try {
    localStorage.setItem(NETWORK_KEY, JSON.stringify(state.network));
  } catch {
    // 保存できなくても、この画面を閉じるまでは使える
  }
}

function nodeById(id) {
  return state.network.nodes.find((node) => node.id === id);
}

function nextNodeId() {
  const max = state.network.nodes.reduce((m, node) => Math.max(m, Number(String(node.id).replace(/\D/g, "")) || 0), 0);
  return `n${max + 1}`;
}

function edgeIndex(a, b) {
  return state.network.edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
}

function toggleEdge(a, b) {
  const i = edgeIndex(a, b);
  if (i >= 0) {
    state.network.edges.splice(i, 1);
  } else {
    state.network.edges.push([a, b]);
  }
}

function updatePathButtons() {
  $("path-delete").disabled = !state.selected;
}

function drawNetwork() {
  networkLayer.replaceChildren();
  if (state.mode === "sign") {
    return;
  }
  const px = svgUnitsPerPixel();
  const onPath = new Set();
  const path = state.route.path;
  for (let i = 1; i < path.length; i += 1) {
    onPath.add(`${path[i - 1]}|${path[i]}`);
    onPath.add(`${path[i]}|${path[i - 1]}`);
  }
  for (const [a, b] of state.network.edges) {
    const p = nodeById(a);
    const q = nodeById(b);
    if (!p || !q) continue;
    const pp = pixelOf(p);
    const qp = pixelOf(q);
    const routed = state.mode === "route" && onPath.has(`${a}|${b}`);
    networkLayer.append(svgElement("line", { x1: pp.u, y1: pp.v, x2: qp.u, y2: qp.v, class: routed ? "edge routed" : "edge", "stroke-width": (routed ? 7 : 3) * px }));
  }
  for (const node of state.network.nodes) {
    const { u, v } = pixelOf(node);
    const isEnd = state.mode === "route" && (node.id === state.route.start || node.id === state.route.goal);
    const cls = ["node", node.id === state.selected ? "selected" : "", isEnd ? "end" : ""].join(" ").trim();
    const r = (isEnd ? NODE_PX * 1.6 : NODE_PX) * px;
    networkLayer.append(svgElement("circle", { cx: u, cy: v, r: NODE_HIT_PX * px, class: "hit", "data-node": node.id }));
    networkLayer.append(svgElement("circle", { cx: u, cy: v, r, class: cls, "stroke-width": 2 * px, "data-node": node.id }));
  }
}

function tapEmptyForPath(u, v) {
  // 点は下絵の中だけに置く
  if (u < 0 || v < 0 || u > state.config.image.width || v > state.config.image.height) return;
  const world = worldOf(u, v);
  const node = { id: nextNodeId(), x: round1(world.x), z: round1(world.z) };
  state.network.nodes.push(node);
  if (state.selected) {
    state.network.edges.push([state.selected, node.id]);
  }
  state.selected = node.id;
  saveNetwork();
  updatePathButtons();
  drawNetwork();
}

function tapNodeForPath(id) {
  if (state.selected === id) {
    state.selected = null;
  } else {
    if (state.selected) {
      toggleEdge(state.selected, id);
      saveNetwork();
    }
    state.selected = id;
  }
  updatePathButtons();
  drawNetwork();
}

$("path-delete").addEventListener("click", () => {
  if (!state.selected) return;
  const id = state.selected;
  state.network.nodes = state.network.nodes.filter((node) => node.id !== id);
  state.network.edges = state.network.edges.filter(([a, b]) => a !== id && b !== id);
  state.selected = null;
  saveNetwork();
  updatePathButtons();
  drawNetwork();
});

// 道は JSON で保存する。nodes の x・z は共通座標（m）、edges は点の id の組。距離は x・z から求める
$("path-save").addEventListener("click", () => {
  const body = { ordinal: state.config.floor.ordinal, nodes: state.network.nodes, edges: state.network.edges };
  downloadBlob(new Blob([JSON.stringify(body, null, 2) + "\n"], { type: "application/json" }), `network_${state.config.floor.code}_${stamp()}.json`);
});

$("path-import").addEventListener("change", async () => {
  const file = $("path-import").files[0];
  $("path-import").value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error();
    if (state.network.nodes.length && (await ask("今の道を置き換えていい？", "やめる", "置き換える", true)) !== "yes") return;
    state.network = { ordinal: data.ordinal ?? state.config.floor.ordinal, nodes: data.nodes, edges: data.edges };
    state.selected = null;
    saveNetwork();
    drawNetwork();
  } catch {
    await ask("読み込めないファイルです", "閉じる", "OK");
  }
});

// ---- 経路（2つの点の最短経路） ----

function shortestPath(start, goal) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const done = new Set();
  const lengthOf = (a, b) => {
    const p = nodeById(a);
    const q = nodeById(b);
    return Math.hypot(p.x - q.x, p.z - q.z);
  };
  const neighbors = new Map();
  for (const [a, b] of state.network.edges) {
    if (!nodeById(a) || !nodeById(b)) continue;
    (neighbors.get(a) || neighbors.set(a, []).get(a)).push(b);
    (neighbors.get(b) || neighbors.set(b, []).get(b)).push(a);
  }
  for (;;) {
    let current = null;
    for (const [id, d] of dist) {
      if (!done.has(id) && (current === null || d < dist.get(current))) current = id;
    }
    if (current === null) return null;
    if (current === goal) break;
    done.add(current);
    for (const next of neighbors.get(current) || []) {
      const d = dist.get(current) + lengthOf(current, next);
      if (!dist.has(next) || d < dist.get(next)) {
        dist.set(next, d);
        prev.set(next, current);
      }
    }
  }
  const path = [goal];
  while (path[0] !== start) path.unshift(prev.get(path[0]));
  return { path, length: dist.get(goal) };
}

function nearestNode(u, v) {
  const limit = NODE_HIT_PX * 1.5 * svgUnitsPerPixel();
  let best = null;
  let bestD = Infinity;
  for (const node of state.network.nodes) {
    const p = pixelOf(node);
    const d = Math.hypot(p.u - u, p.v - v);
    if (d < bestD && d <= limit) {
      best = node.id;
      bestD = d;
    }
  }
  return best;
}

function tapForRoute(u, v) {
  const id = nearestNode(u, v);
  const r = state.route;
  if (!id) {
    state.route = { start: null, goal: null, path: [], length: 0 };
  } else if (!r.start || r.goal) {
    state.route = { start: id, goal: null, path: [], length: 0 };
  } else if (id !== r.start) {
    const found = shortestPath(r.start, id);
    state.route = { start: r.start, goal: id, path: found ? found.path : [], length: found ? found.length : 0 };
  }
  const label = $("route-length");
  label.hidden = !state.route.goal;
  label.textContent = state.route.path.length ? `${Math.round(state.route.length)} m` : "つながっていません";
  drawNetwork();
}

// ---- 地図の操作 ----
// 1本指: 看板では印の板で位置・つまみで向き、道では点を動かす。ほかは地図の移動。2本指とホイールで拡大縮小。
// 動かさずに離したら、使い方ごとのタップ（看板を置く、点を足す・選ぶ、経路の点を選ぶ）
const pointers = new Map();
let gesture = null;

map.addEventListener("pointerdown", (event) => {
  map.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const target = event.target.closest?.("[data-handle], [data-node]");
  let handle = null;
  let node = null;
  if (pointers.size === 1) {
    if (state.mode === "sign" && state.sign) handle = target?.dataset.handle || null;
    if (state.mode === "path") node = target?.dataset.node || null;
  }
  let offset = null;
  const p = toMapPoint(event.clientX, event.clientY);
  if (handle === "move" && p) offset = { u: state.sign.u - p.x, v: state.sign.v - p.y };
  if (node && p) {
    const np = pixelOf(nodeById(node));
    offset = { u: np.u - p.x, v: np.v - p.y };
  }
  gesture = { moved: pointers.size > 1, start: { x: event.clientX, y: event.clientY }, handle, node, offset };
});

map.addEventListener("pointermove", (event) => {
  const previous = pointers.get(event.pointerId);
  if (!previous || !gesture) return;
  const current = { x: event.clientX, y: event.clientY };
  if (pointers.size === 1) {
    if (Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) > TAP_TOLERANCE_PX) gesture.moved = true;
    if (gesture.moved) {
      const p = toMapPoint(current.x, current.y);
      if (gesture.handle === "move" && p) {
        setSign(p.x + gesture.offset.u, p.y + gesture.offset.v);
      } else if (gesture.handle === "rotate" && p) {
        state.azimuth = normalizeDeg(Geo.azimuthOf(state.t, p.x - state.sign.u, p.y - state.sign.v));
        drawMarker();
      } else if (gesture.node && p) {
        const { width, height } = state.config.image;
        const world = worldOf(clamp(p.x + gesture.offset.u, 0, width), clamp(p.y + gesture.offset.v, 0, height));
        const node = nodeById(gesture.node);
        node.x = round1(world.x);
        node.z = round1(world.z);
        drawNetwork();
      } else {
        const unit = svgUnitsPerPixel();
        state.view.x -= (current.x - previous.x) * unit;
        state.view.y -= (current.y - previous.y) * unit;
        clampView();
        applyView();
      }
    }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.entries()].map(([id, p]) => (id === event.pointerId ? current : p));
    const [pa, pb] = [...pointers.values()];
    const before = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    if (before > 0 && after > 0) {
      const p = toMapPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (p) zoom(before / after, p.x, p.y);
    }
  }
  pointers.set(event.pointerId, current);
});

function endPointer(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (gesture && pointers.size === 0) {
    const p = toMapPoint(event.clientX, event.clientY);
    if (gesture.node && gesture.moved) saveNetwork();
    if (!gesture.moved && event.type === "pointerup" && p) {
      if (state.mode === "sign" && !gesture.handle) setSign(p.x, p.y);
      if (state.mode === "path") gesture.node ? tapNodeForPath(gesture.node) : tapEmptyForPath(p.x, p.y);
      if (state.mode === "route") tapForRoute(p.x, p.y);
    }
  }
  if (pointers.size === 0) {
    gesture = null;
    drawMarker();
  }
}

map.addEventListener("pointerup", endPointer);
map.addEventListener("pointercancel", endPointer);
map.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const p = toMapPoint(event.clientX, event.clientY);
    if (p) zoom(Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  },
  { passive: false },
);
window.addEventListener("resize", () => {
  fitImage();
  state.home = { ...state.view };
  applyView();
});

$("to-photo").addEventListener("click", () => {
  $("azimuth").value = state.azimuth;
  showScreen("photo");
});

// ---- 写真 ----

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("写真を開けませんでした"));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("写真を読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

async function shrinkPhoto(file) {
  const image = await loadImage(file);
  const scale = Math.min(1, PHOTO_MAX_PX / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
}

// 写真は大きいので localStorage ではなく IndexedDB に、看板の imageName ごとに入れる
const PHOTO_DB = "eki-b1-photos";
const PHOTO_STORE = "photos";

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PHOTO_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function photoStore(mode, action) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, mode);
    const result = action(tx.objectStore(PHOTO_STORE));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const putPhoto = (key, dataUrl) => photoStore("readwrite", (store) => store.put(dataUrl, key));
const deletePhoto = (key) => photoStore("readwrite", (store) => store.delete(key));
const getPhoto = (key) => photoStore("readonly", (store) => store.get(key));
const clearPhotos = () => photoStore("readwrite", (store) => store.clear());

const photoData = { A: "", B: "" };
const photoNames = { A: "", B: "" };

function clearFace(face) {
  const box = document.querySelector(`.face[data-face="${face}"]`);
  box.querySelector(".photo").value = "";
  box.querySelector(".preview").hidden = true;
  box.querySelector(".camera-icon").style.display = "";
  box.querySelector(".camera").classList.remove("has-photo");
  showStatus(box.querySelector(".status"), "", false);
  photoNames[face] = "";
  photoData[face] = "";
}

for (const box of document.querySelectorAll(".face")) {
  const face = box.dataset.face;
  const input = box.querySelector(".photo");
  const status = box.querySelector(".status");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    photoNames[face] = file.name;
    showStatus(status, "", false);
    let dataUrl;
    try {
      dataUrl = await shrinkPhoto(file);
    } catch (error) {
      showStatus(status, error.message, true);
      return;
    }
    const preview = box.querySelector(".preview");
    preview.src = dataUrl;
    photoData[face] = dataUrl;
    preview.hidden = false;
    box.querySelector(".camera-icon").style.display = "none";
    box.querySelector(".camera").classList.add("has-photo");
  });
}

// ---- 大きさ ----

function renderSizes() {
  const box = $("sizes");
  const k = 44 / Math.max(...SIZES.map((item) => item.width));
  for (const size of SIZES) {
    const icon = svgElement("svg", { viewBox: "0 0 48 48", "aria-hidden": "true" });
    const w = size.width * k;
    const h = Math.max(size.height * k, 2.5);
    icon.append(svgElement("rect", { x: 24 - w / 2, y: 24 - h / 2, width: w, height: h, rx: 1 }));
    box.append(sizeButton(size.key, `${size.label} 幅 ${size.width} m、高さ ${size.height} m`, icon, `${size.width}×${size.height}`));
  }
  const icon = svgElement("svg", { viewBox: "0 0 48 48", "aria-hidden": "true" });
  icon.append(svgElement("rect", { x: 6, y: 18, width: 36, height: 12, rx: 1, class: "custom" }));
  box.append(sizeButton(CUSTOM_SIZE.key, CUSTOM_SIZE.label, icon, "□×□"));
  for (const id of ["custom-width", "custom-height"]) {
    $(id).addEventListener("input", () => {
      selectSize(CUSTOM_SIZE.key);
      showStatus($("form-status"), "", false);
    });
  }
}

function sizeButton(key, ariaLabel, icon, caption) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "size";
  button.dataset.key = key;
  button.setAttribute("role", "radio");
  button.setAttribute("aria-label", ariaLabel);
  const label = document.createElement("span");
  label.textContent = caption;
  button.append(icon, label);
  button.addEventListener("click", () => {
    selectSize(key);
    if (key === CUSTOM_SIZE.key && !$("custom-width").value) $("custom-width").focus();
  });
  return button;
}

function selectSize(key) {
  const custom = key === CUSTOM_SIZE.key;
  const size = custom
    ? { ...CUSTOM_SIZE, width: Number($("custom-width").value) || "", height: Number($("custom-height").value) || "" }
    : SIZES.find((item) => item.key === key) || SIZES[0];
  $("width").value = size.width;
  $("height").value = size.height;
  $("center-height").value = size.centerHeight;
  $("mount").value = size.mount;
  $("custom-size").hidden = !custom;
  for (const button of document.querySelectorAll(".size")) {
    button.setAttribute("aria-checked", String(button.dataset.key === size.key));
  }
}

// ---- 記録 ----

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // I と O は使わない

function randomCode() {
  const values = crypto.getRandomValues(new Uint32Array(3));
  return [...values].map((v) => CODE_LETTERS[v % CODE_LETTERS.length]).join("");
}

// ID は S-<階>-<3文字>（表と裏は末尾に -A / -B）。記録済みと signs.json の看板と重ならないものを選ぶ
function suggestId() {
  const used = new Set([...state.records, ...state.knownSigns].map((record) => record.id));
  for (;;) {
    const base = `S-${state.config.floor.code}-${randomCode()}`;
    if (![base, `${base}-A`, `${base}-B`].some((id) => used.has(id))) return base;
  }
}

function imageNameOf(id) {
  return `sign_${id.replace(/^S-/i, "").toLowerCase().replace(/-/g, "_")}`;
}

// 表は必ず記録する。裏は写真があるときだけ、反対向きの看板として記録する。板の文字（text）は写真から後で入れる
function buildRecords() {
  const id = $("sign-id").value.trim();
  const floor = state.config.floor;
  const name = $("name").value.trim() || `${floor.label}の看板 ${id.split("-")[2] || ""}`.trim();
  const note = $("note").value.trim();
  const world = worldOf(state.sign.u, state.sign.v);
  const base = {
    x: round1(world.x),
    z: round1(world.z),
    ordinal: floor.ordinal,
    widthMeters: Number($("width").value),
    heightMeters: Number($("height").value),
    centerHeightMeters: Number($("center-height").value),
    mount: $("mount").value,
    correctionYawDeg: 0,
    correctionX: 0,
    correctionZ: 0,
    confidence: $("confidence").value,
  };
  const azimuth = normalizeDeg(Number($("azimuth").value));
  const photoNote = (face) => (photoNames[face] ? `写真 ${photoNames[face]}` : "");
  if (!photoNames.B) {
    return [{ id, name, imageName: imageNameOf(id), ...base, azimuthDeg: azimuth, note: [note, photoNote("A")].filter(Boolean).join("。") }];
  }
  const faces = [
    { suffix: "A", label: "表", azimuthDeg: azimuth, extra: photoNote("A") },
    { suffix: "B", label: "裏", azimuthDeg: normalizeDeg(azimuth + 180), extra: ["裏面", photoNote("B")].filter(Boolean).join("。") },
  ];
  return faces.map((face) => {
    const faceId = `${id}-${face.suffix}`;
    return { id: faceId, name: `${name}（${face.label}）`, imageName: imageNameOf(faceId), ...base, azimuthDeg: face.azimuthDeg, note: [note, face.extra].filter(Boolean).join("。") };
  });
}

// eki-navi の signs.schema.json のキーの順にそろえる
function orderedRecord(record) {
  const keys = ["id", "name", "text", "imageName", "x", "z", "ordinal", "azimuthDeg", "widthMeters", "heightMeters", "centerHeightMeters", "mount", "correctionYawDeg", "correctionX", "correctionZ", "confidence", "note"];
  return Object.fromEntries(keys.filter((key) => key !== "text" || record.text).map((key) => [key, record[key]]));
}

function renderOutput() {
  $("output").textContent = JSON.stringify({ signs: state.records.map(orderedRecord) }, null, 2);
}

function saveRecords() {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(state.records));
  } catch {
    // 保存できなくても、この画面を閉じるまでは使える
  }
}

function resetForNext() {
  state.sign = null;
  state.azimuth = DEFAULT_AZIMUTH;
  $("to-photo").disabled = true;
  $("add-sign").classList.remove("placed");
  $("azimuth").value = "";
  $("name").value = "";
  $("note").value = "";
  clearFace("A");
  clearFace("B");
  $("sign-id").value = suggestId();
  drawMarker();
}

$("sign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("form-status");
  if (!state.sign) {
    showStatus(status, "地図に看板を置いてください。", true);
    return;
  }
  if (!(Number($("width").value) > 0 && Number($("height").value) > 0)) {
    showStatus(status, "幅と高さを入れてください。", true);
    $("custom-width").focus();
    return;
  }
  if (!photoData.A && !photoData.B && (await ask("写真なしで記録していい？", "やめる", "記録する")) !== "yes") return;
  let added = buildRecords();
  const used = new Set(state.records.map((record) => record.id));
  if (added.some((record) => used.has(record.id))) {
    $("sign-id").value = suggestId();
    added = buildRecords();
  }
  try {
    for (const record of added) {
      const data = photoData[record.id.endsWith("-B") ? "B" : "A"];
      if (data) await putPhoto(record.imageName, data);
    }
  } catch {
    showStatus(status, "写真を保存できませんでした。", true);
    return;
  }
  state.records.push(...added);
  saveRecords();
  renderOutput();
  showStatus(status, "", false);
  resetForNext();
  drawOverlay();
  showStatus($("copy-status"), "", false);
  history.replaceState({ screen: "list" }, "", location.search);
  showScreen("list", false);
});

// ---- 確認 ----

const confirmDialog = $("confirm-dialog");

// "yes"（右のボタン）、"no"（左のボタン）、""（外側を押して閉じた）のどれかを返す
function ask(title, noLabel, yesLabel, danger = false) {
  $("confirm-title").textContent = title;
  $("confirm-no").textContent = noLabel;
  $("confirm-yes").textContent = yesLabel;
  $("confirm-yes").className = `pill ${danger ? "danger" : "primary"}`;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue), { once: true });
  });
}

confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) confirmDialog.close("");
});

function resetRecords() {
  for (const record of state.records) deletePhoto(record.imageName).catch(() => {});
  state.records = [];
  saveRecords();
  renderOutput();
  drawOverlay();
  showStatus($("copy-status"), "", false);
  $("sign-id").value = suggestId();
}

// 保存の画面から出るときに「リセットしていい？」と聞く。残す・外側なら保存の画面のまま
async function confirmReset() {
  if (state.records.length === 0) return true;
  if ((await ask("リセットしていい？", "残す", "リセット", true)) !== "yes") return false;
  resetRecords();
  return true;
}

$("list-back").addEventListener("click", async () => {
  if (!(await confirmReset())) return;
  skipAskOnBack = true;
  history.back();
});

$("add-another").addEventListener("click", async () => {
  if (!(await confirmReset())) return;
  history.replaceState({ screen: "map" }, "", location.search);
  showScreen("map", false);
  requestAnimationFrame(riseMarker);
});

// ---- ZIP（圧縮しない store。写真は JPEG なので圧縮しても縮まない） ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, file.bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// signs.json（eki-navi の signs.json と同じ形）と photos/<imageName>.jpg をまとめた ZIP
$("download").addEventListener("click", async () => {
  const status = $("copy-status");
  if (state.records.length === 0) {
    showStatus(status, "まだ記録がありません。", true);
    return;
  }
  const now = new Date();
  const files = [{ name: "signs.json", bytes: new TextEncoder().encode($("output").textContent + "\n") }];
  for (const record of state.records) {
    try {
      const data = await getPhoto(record.imageName);
      if (data) files.push({ name: `photos/${record.imageName}.jpg`, bytes: dataUrlToBytes(data) });
    } catch {
      // 写真が読めなくても、看板の記録は保存する
    }
  }
  downloadBlob(buildZip(files, now), `signs_${state.config.floor.code}_${stamp(now)}.zip`);
  showStatus(status, `保存しました（写真 ${files.length - 1} 枚）`, false);
});

// ---- はじめ ----

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path} を読めませんでした`);
  return response.json();
}

async function main() {
  // 看板の記録は開くたびに空から始める（保存は毎回 ZIP で端末に残す）。道筋はこの端末に残す
  saveRecords();
  await clearPhotos().catch(() => {});
  const [config, signs, network] = await Promise.all([
    loadJson("data/config.json"),
    loadJson("data/signs.json").catch(() => ({ signs: [] })),
    loadJson("data/network.json").catch(() => ({ nodes: [], edges: [] })),
  ]);
  state.config = config;
  state.t = config.image.transform;
  state.knownSigns = (signs.signs || []).filter((sign) => sign.ordinal === config.floor.ordinal);
  try {
    const saved = JSON.parse(localStorage.getItem(NETWORK_KEY) || "null");
    state.network = saved && Array.isArray(saved.nodes) ? saved : { ordinal: config.floor.ordinal, nodes: network.nodes || [], edges: network.edges || [] };
  } catch {
    state.network = { ordinal: config.floor.ordinal, nodes: network.nodes || [], edges: network.edges || [] };
  }
  document.title = `新宿駅 ${config.floor.label}`;
  const { src, width, height } = config.image;
  imageLayer.append(svgElement("image", { href: src, x: 0, y: 0, width, height, preserveAspectRatio: "none" }));
  history.replaceState({ screen: "map" }, "", location.search);
  renderSizes();
  selectSize(SIZES[0].key);
  renderOutput();
  $("sign-id").value = suggestId();
  fitImage();
  state.home = { ...state.view };
  setMode("sign");
}

main().catch((error) => showStatus($("form-status"), error.message, true));
