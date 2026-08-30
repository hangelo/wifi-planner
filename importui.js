/* ============================================================
   importui.js — the "import a floor plan" workspace

   Owns the modal: image loading, live segmentation preview,
   the correction brush, scale calibration. Hands a finished
   geometry object to applyImportedPlan() in app.js.
   ============================================================ */
"use strict";

(function(){

const MAX_DIM = 720;           // working resolution cap, long side, px
const UNDO_LIMIT = 40;

const dlg      = document.getElementById("impDlg");
const openBtn  = document.getElementById("importBtn");
const closeBtn = document.getElementById("impClose");
const cancelBtn= document.getElementById("impCancel");
const useBtn   = document.getElementById("impUse");
const drop     = document.getElementById("impDrop");
const fileInp  = document.getElementById("impFile");
const stage    = document.getElementById("impStage");
const cv       = document.getElementById("impCv");
const ctx      = cv.getContext("2d");
const panel    = document.getElementById("impPanel");
const statusEl = document.getElementById("impStatus");
const intoEl   = document.getElementById("impInto");
const floorSel = document.getElementById("impFloor");
const warnEl   = document.getElementById("impWarn");

/* offscreen: the decoded plan at working resolution */
const base = document.createElement("canvas");
const baseCtx = base.getContext("2d", {willReadFrequently:true});
/* offscreen: the mask overlay, blitted over the plan each redraw */
const ov = document.createElement("canvas");
const ovCtx = ov.getContext("2d");

let S = null;                  // whole import session, null until an image loads

function freshSession(imgData){
  return {
    img: imgData,
    mw: imgData.width,
    mh: imgData.height,
    det: null,                 // {mode, color|threshold, tolerance|maxSat}
    closeR: 2,
    openR: 2,
    doorW: 90,
    paint: new Int8Array(imgData.width * imgData.height),
    undo: [],
    wall: null,
    geo: null,
    tool: "brush",
    brush: 8,
    cal: null,                 // {x0,y0,x1,y1} in mask px
    calCm: 0,
    view: {s:1, ox:0, oy:0},
    dirty: 0                   // 1 = mask only, 2 = mask + geometry
  };
}

/* ============================================================
   IMAGE LOADING
   ============================================================ */
function loadFile(file){
  if(!file || !/^image\//.test(file.type)){
    return;
  }
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => {
    URL.revokeObjectURL(url);
    const k = Math.min(1, MAX_DIM / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * k));
    const h = Math.max(1, Math.round(im.naturalHeight * k));
    base.width = w;
    base.height = h;
    baseCtx.imageSmoothingEnabled = true;
    baseCtx.imageSmoothingQuality = "high";
    baseCtx.clearRect(0, 0, w, h);
    baseCtx.drawImage(im, 0, 0, w, h);
    startSession(baseCtx.getImageData(0, 0, w, h));
  };
  im.onerror = () => {
    URL.revokeObjectURL(url);
    warn("That file could not be decoded as an image.");
  };
  im.src = url;
}

function startSession(imgData){
  S = freshSession(imgData);
  ov.width = S.mw;
  ov.height = S.mh;
  S.det = PlanImport.autoDetect(detectSource(imgData));
  if(S.det.mode === "ink"){
    S.closeR = 5;
    S.openR = 3;
  } else {
    S.closeR = 1;
    S.openR = 1;
  }
  drop.hidden = true;
  stage.hidden = false;
  panel.hidden = false;
  buildPanel();
  layout();
  invalidate(2);
}

/* auto-detect runs on a half-size copy: six candidate colours each need a
   distance transform, and the answer does not change with resolution */
function detectSource(imgData){
  const k = Math.min(1, 520 / Math.max(imgData.width, imgData.height));
  if(k >= 1){
    return imgData;
  }
  const w = Math.max(1, Math.round(imgData.width * k));
  const h = Math.max(1, Math.round(imgData.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cc = c.getContext("2d", {willReadFrequently:true});
  cc.imageSmoothingEnabled = false;
  cc.drawImage(base, 0, 0, w, h);
  return cc.getImageData(0, 0, w, h);
}

/* ============================================================
   PIPELINE
   ============================================================ */
let timer = 0;
function invalidate(level){
  S.dirty = Math.max(S.dirty, level);
  clearTimeout(timer);
  timer = setTimeout(run, 110);
}

function run(){
  if(!S){
    return;
  }
  const level = S.dirty;
  S.dirty = 0;
  const t0 = performance.now();

  const raw = PlanImport.segment(S.img, S.det);
  let wall = PlanImport.cleanup(raw, S.mw, S.mh, {
    closeR: S.closeR,
    openR: S.openR,
    minArea: Math.max(24, Math.round(S.mw * S.mh * 0.0004))
  });
  for(let i=0;i<wall.length;i++){
    if(S.paint[i] === 1){
      wall[i] = 1;
    } else if(S.paint[i] === 2){
      wall[i] = 0;
    }
  }
  S.wall = wall;

  if(level >= 2 && S.calCm > 0){
    S.geo = PlanImport.buildGeometry(wall, S.mw, S.mh, cmPerPx(), {
      doorCm: S.doorW,
      minRoomM2: 0.5
    });
  } else if(!S.calCm){
    S.geo = null;
  }
  paintOverlay();
  redraw();
  report(performance.now() - t0);
}

function cmPerPx(){
  if(!S.cal || !S.calCm){
    return 0;
  }
  const d = Math.hypot(S.cal.x1 - S.cal.x0, S.cal.y1 - S.cal.y0);
  if(d < 3){
    return 0;
  }
  return S.calCm / d;
}

/* ============================================================
   RENDER
   ============================================================ */
function paintOverlay(){
  const n = S.mw * S.mh;
  const im = ovCtx.createImageData(S.mw, S.mh);
  const D = im.data;
  const g = S.geo;
  for(let i=0;i<n;i++){
    const o = i*4;
    let r = 0, gg = 0, b = 0, a = 0;
    if(g){
      const k = g.kind[i];
      if(k === 2){
        r = 92; gg = 194; b = 178; a = 150;
      } else if(k === 3){
        r = 255; gg = 158; b = 69; a = 190;
      } else if(k === 0){
        r = 10; gg = 12; b = 14; a = 96;
      }
    } else if(S.wall[i]){
      r = 92; gg = 194; b = 178; a = 150;
    }
    D[o] = r; D[o+1] = gg; D[o+2] = b; D[o+3] = a;
  }
  ovCtx.putImageData(im, 0, 0);
}

function layout(){
  if(!S){
    return;
  }
  const box = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(240, box.width), ch = Math.max(240, box.height);
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  cv.style.width = cw + "px";
  cv.style.height = ch + "px";
  const s = Math.min(cv.width / S.mw, cv.height / S.mh);
  S.view = {s, ox:(cv.width - S.mw*s)/2, oy:(cv.height - S.mh*s)/2, dpr};
}

function redraw(){
  if(!S){
    return;
  }
  const v = S.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0C0E10";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = 0.85;
  ctx.drawImage(base, v.ox, v.oy, S.mw*v.s, S.mh*v.s);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ov, v.ox, v.oy, S.mw*v.s, S.mh*v.s);
  ctx.imageSmoothingEnabled = true;

  if(S.cal){
    const x0 = v.ox + S.cal.x0*v.s, y0 = v.oy + S.cal.y0*v.s;
    const x1 = v.ox + S.cal.x1*v.s, y1 = v.oy + S.cal.y1*v.s;
    ctx.strokeStyle = "#FF5F56";
    ctx.lineWidth = 2*v.dpr;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    for(const p of [[x0,y0],[x1,y1]]){
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4*v.dpr, 0, 7);
      ctx.fillStyle = "#FF5F56";
      ctx.fill();
    }
    if(S.calCm){
      ctx.font = `600 ${11*v.dpr}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,.9)";
      ctx.shadowBlur = 5*v.dpr;
      ctx.fillText(S.calCm + " cm", (x0+x1)/2, (y0+y1)/2 - 8*v.dpr);
      ctx.shadowBlur = 0;
    }
  }
}

function report(ms){
  const g = S.geo;
  const bits = [];
  if(!S.calCm){
    bits.push("not calibrated");
  } else if(g){
    bits.push(g.rooms.length + (g.rooms.length === 1 ? " room" : " rooms"));
    bits.push(g.openings.length + (g.openings.length === 1 ? " doorway" : " doorways"));
    bits.push("walls ≈ " + g.wallT + " cm");
    bits.push(g.area.toFixed(1) + " m²");
    bits.push(Math.round(g.w*g.cmPerPx) + " × " + Math.round(g.h*g.cmPerPx) + " cm");
  }
  bits.push(ms.toFixed(0) + " ms");
  statusEl.textContent = bits.join(" · ");

  let msg = "";
  if(!S.calCm){
    msg = "Set the scale: pick <b>Calibrate</b>, drag along a dimension you know, then type its length.";
  } else if(!g || !g.rooms.length){
    msg = "No enclosed rooms found. The wall outline is probably broken — switch detector, raise <b>Seal gaps</b>, or paint the break closed with the brush.";
  } else if(g.rooms.length === 1 && g.openings.length === 0){
    msg = "Only one region was found. If the plan has interior walls, they were not detected — try the other detector or lower <b>Remove thin lines</b>.";
  } else if(g.rooms.length > 1 && g.openings.length < g.rooms.length - 1){
    msg = "Only " + g.openings.length + " doorway" + (g.openings.length === 1 ? "" : "s") +
      " for " + g.rooms.length + " rooms, so some are sealed shut and will read as far worse coverage than the real place. Where the drawing shows a door as a symbol rather than a gap in the wall, click it with the <b>Door</b> tool.";
  }
  warnEl.innerHTML = msg;
  warnEl.hidden = !msg;
  useBtn.disabled = !(g && g.rooms.length);
}

function warn(m){
  warnEl.innerHTML = m;
  warnEl.hidden = false;
}

/* ============================================================
   CONTROL PANEL
   ============================================================ */
function row(label, node, val){
  const l = document.createElement("label");
  l.className = "f";
  const s = document.createElement("span");
  s.innerHTML = label + (val ? ' <b>' + val + '</b>' : "");
  l.appendChild(s);
  l.appendChild(node);
  return l;
}

/* While a slider is moving, only the wall mask is recomputed — the room and
   doorway pass costs about a second and would make the drag unusable. It runs
   once on release. */
function slider(id, min, max, step, value, fmt, onInput){
  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const l = row(id, inp, fmt(value));
  const b = l.querySelector("b");
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value);
    b.textContent = fmt(v);
    onInput(v, true);
  });
  inp.addEventListener("change", () => {
    onInput(parseFloat(inp.value), false);
  });
  return l;
}

function buildPanel(){
  panel.innerHTML = "";

  const detWrap = document.createElement("div");
  detWrap.className = "seg";
  detWrap.setAttribute("role", "group");
  detWrap.innerHTML =
    `<button data-m="fill" aria-pressed="${S.det.mode === "fill"}">Filled walls</button>` +
    `<button data-m="ink" aria-pressed="${S.det.mode === "ink"}">Dark ink</button>`;
  detWrap.addEventListener("click", e => {
    const b = e.target.closest("button");
    if(!b){
      return;
    }
    setMode(b.dataset.m);
  });
  panel.appendChild(detWrap);

  const detBody = document.createElement("div");
  detBody.id = "impDetBody";
  panel.appendChild(detBody);
  buildDetBody();

  panel.appendChild(slider("Seal gaps &amp; hatching", 0, 10, 1, S.closeR, v => v + " px", (v, drag) => {
    S.closeR = v;
    invalidate(drag ? 1 : 2);
  }));
  panel.appendChild(slider("Remove thin lines", 0, 10, 1, S.openR, v => v + " px", (v, drag) => {
    S.openR = v;
    invalidate(drag ? 1 : 2);
  }));
  panel.appendChild(slider("Doorway width", 60, 260, 5, S.doorW, v => v + " cm", (v, drag) => {
    S.doorW = v;
    invalidate(drag ? 1 : 2);
  }));

  const hr1 = document.createElement("div");
  hr1.className = "imphr";
  panel.appendChild(hr1);

  const tools = document.createElement("div");
  tools.className = "seg";
  tools.id = "impTools";
  tools.innerHTML =
    `<button data-t="brush" aria-pressed="true">Wall</button>` +
    `<button data-t="erase" aria-pressed="false">Erase</button>` +
    `<button data-t="door" aria-pressed="false">Door</button>` +
    `<button data-t="pick" aria-pressed="false">Pick colour</button>` +
    `<button data-t="cal" aria-pressed="false">Calibrate</button>`;
  tools.addEventListener("click", e => {
    const b = e.target.closest("button");
    if(!b){
      return;
    }
    S.tool = b.dataset.t;
    [...tools.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
  });
  panel.appendChild(tools);

  panel.appendChild(slider("Brush size", 2, 40, 1, S.brush, v => v + " px", v => {
    S.brush = v;
  }));

  const undoRow = document.createElement("div");
  undoRow.className = "btnrow";
  undoRow.innerHTML = `<button class="btn" id="impUndo">Undo stroke</button><button class="btn" id="impClear">Clear edits</button>`;
  undoRow.querySelector("#impUndo").addEventListener("click", undo);
  undoRow.querySelector("#impClear").addEventListener("click", () => {
    S.paint.fill(0);
    S.undo.length = 0;
    invalidate(2);
  });
  panel.appendChild(undoRow);

  const hr2 = document.createElement("div");
  hr2.className = "imphr";
  panel.appendChild(hr2);

  const calBox = document.createElement("div");
  calBox.className = "impcal";
  calBox.innerHTML =
    `<label class="f"><span>Known length of the drawn line</span>
      <input type="number" id="impCalCm" min="1" max="10000" step="1" placeholder="cm" value="${S.calCm || ""}"></label>
    <p class="hint" id="impCalHint">Pick <b>Calibrate</b>, drag along a dimension printed on the plan, then type that dimension here.</p>`;
  calBox.querySelector("#impCalCm").addEventListener("input", e => {
    S.calCm = Math.max(0, parseFloat(e.target.value) || 0);
    updateCalHint();
    invalidate(2);
  });
  panel.appendChild(calBox);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML = "<b>Door</b> punches a doorway-sized hole through a wall with one click — use it wherever the drawing shows a door as a symbol rather than a gap. Each one becomes an entry in <b>Doors &amp; openings</b>.";
  panel.appendChild(hint);
}

function buildDetBody(){
  const body = document.getElementById("impDetBody");
  body.innerHTML = "";
  if(S.det.mode === "fill"){
    const sw = document.createElement("div");
    sw.className = "impswatch";
    sw.innerHTML = `<i style="background:rgb(${S.det.color.join(",")})"></i><span>Wall colour — use <b>Pick colour</b> to resample</span>`;
    body.appendChild(sw);
    body.appendChild(slider("Colour tolerance", 2, 70, 1, S.det.tolerance, v => String(v), (v, drag) => {
      S.det.tolerance = v;
      invalidate(drag ? 1 : 2);
    }));
  } else {
    body.appendChild(slider("Ink threshold", 40, 230, 1, S.det.threshold, v => String(v), (v, drag) => {
      S.det.threshold = v;
      invalidate(drag ? 1 : 2);
    }));
  }
}

function setMode(m){
  if(S.det.mode === m){
    return;
  }
  if(m === "ink"){
    S.det = {mode:"ink", threshold: PlanImport.otsuThreshold(S.img), maxSat:70};
    S.closeR = Math.max(S.closeR, 5);
  } else {
    S.det = {mode:"fill", color:[110,105,95], tolerance:22};
  }
  [...panel.querySelector(".seg").children].forEach(c => c.setAttribute("aria-pressed", String(c.dataset.m === m)));
  buildDetBody();
  invalidate(2);
}

function updateCalHint(){
  const el = document.getElementById("impCalHint");
  const c = cmPerPx();
  if(!el){
    return;
  }
  if(!c){
    el.innerHTML = "Pick <b>Calibrate</b>, drag along a dimension printed on the plan, then type that dimension here.";
    return;
  }
  el.innerHTML = `Scale: <b>${c.toFixed(2)} cm/px</b> — the image spans ${Math.round(S.mw*c)} × ${Math.round(S.mh*c)} cm.`;
}

/* ============================================================
   POINTER: brush, colour pick, calibration
   ============================================================ */
let stroke = null;

function toMask(e){
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) * (cv.width / r.width);
  const y = (e.clientY - r.top) * (cv.height / r.height);
  return {x:(x - S.view.ox)/S.view.s, y:(y - S.view.oy)/S.view.s};
}

function stamp(cx, cy, val){
  const r = S.brush;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(S.mw-1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(S.mh-1, Math.ceil(cy + r));
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const dx = x - cx, dy = y - cy;
      if(dx*dx + dy*dy > r*r){
        continue;
      }
      const i = y*S.mw + x;
      if(S.paint[i] === val){
        continue;
      }
      stroke.idx.push(i);
      stroke.prev.push(S.paint[i]);
      S.paint[i] = val;
    }
  }
}

function stampLine(a, b, val){
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(d / Math.max(1, S.brush*0.5)));
  for(let i=0;i<=steps;i++){
    const t = i/steps;
    stamp(a.x + (b.x-a.x)*t, a.y + (b.y-a.y)*t, val);
  }
}

function undo(){
  const s = S.undo.pop();
  if(!s){
    return;
  }
  for(let i=0;i<s.idx.length;i++){
    S.paint[s.idx[i]] = s.prev[i];
  }
  invalidate(2);
}

cv.addEventListener("pointerdown", e => {
  if(!S){
    return;
  }
  const p = toMask(e);
  try{
    cv.setPointerCapture(e.pointerId);
  }catch{
    /* no capture available for this pointer; dragging still works */
  }
  if(S.tool === "pick"){
    const x = Math.round(p.x), y = Math.round(p.y);
    if(x < 0 || y < 0 || x >= S.mw || y >= S.mh){
      return;
    }
    const o = (y*S.mw + x)*4;
    S.det = {mode:"fill", color:[S.img.data[o], S.img.data[o+1], S.img.data[o+2]], tolerance: S.det.tolerance || 22};
    [...panel.querySelector(".seg").children].forEach(c => c.setAttribute("aria-pressed", String(c.dataset.m === "fill")));
    buildDetBody();
    invalidate(2);
    return;
  }
  if(S.tool === "cal"){
    S.cal = {x0:p.x, y0:p.y, x1:p.x, y1:p.y};
    stroke = {kind:"cal"};
    redraw();
    return;
  }
  if(S.tool === "door"){
    /* one click punches a door-width hole through the wall; the geometry
       pass then finds it as a gap and files it as an opening */
    const c = cmPerPx();
    stroke = {kind:"paint", idx:[], prev:[], val:2, last:p};
    const keep = S.brush;
    S.brush = c > 0 ? Math.max(3, (S.doorW * 0.5) / c) : S.brush;
    stamp(p.x, p.y, 2);
    S.brush = keep;
    endStroke();
    return;
  }
  stroke = {kind:"paint", idx:[], prev:[], val:S.tool === "brush" ? 1 : 2, last:p};
  stampLine(p, p, stroke.val);
  invalidate(1);
});

cv.addEventListener("pointermove", e => {
  if(!S || !stroke){
    return;
  }
  const p = toMask(e);
  if(stroke.kind === "cal"){
    S.cal.x1 = p.x;
    S.cal.y1 = p.y;
    redraw();
    return;
  }
  stampLine(stroke.last, p, stroke.val);
  stroke.last = p;
  invalidate(1);
});

function endStroke(){
  if(!stroke){
    return;
  }
  if(stroke.kind === "cal"){
    stroke = null;
    updateCalHint();
    const inp = document.getElementById("impCalCm");
    if(inp){
      inp.focus();
      inp.select();
    }
    invalidate(2);
    return;
  }
  if(stroke.idx.length){
    S.undo.push({idx:stroke.idx, prev:stroke.prev});
    if(S.undo.length > UNDO_LIMIT){
      S.undo.shift();
    }
  }
  stroke = null;
  invalidate(2);
}
cv.addEventListener("pointerup", endStroke);
cv.addEventListener("pointercancel", endStroke);

/* ============================================================
   MODAL PLUMBING
   ============================================================ */
function open(){
  dlg.hidden = false;
  document.body.style.overflow = "hidden";
  const nz = (typeof PLAN !== "undefined" && PLAN.nz) || 1;
  intoEl.hidden = nz < 2;
  for(const opt of floorSel.options){
    opt.textContent = (typeof floorName === "function" ? floorName(+opt.value) : opt.textContent) + " floor";
  }
  if(S){
    requestAnimationFrame(() => {
      layout();
      redraw();
    });
  }
}

function close(){
  dlg.hidden = true;
  document.body.style.overflow = "";
}

openBtn.addEventListener("click", open);
closeBtn.addEventListener("click", close);
cancelBtn.addEventListener("click", close);
dlg.addEventListener("pointerdown", e => {
  if(e.target === dlg){
    close();
  }
});
window.addEventListener("keydown", e => {
  if(e.key === "Escape" && !dlg.hidden){
    close();
  }
});

drop.addEventListener("click", () => fileInp.click());
fileInp.addEventListener("change", e => {
  if(e.target.files && e.target.files[0]){
    loadFile(e.target.files[0]);
  }
});
["dragenter","dragover"].forEach(t => dlg.addEventListener(t, e => {
  e.preventDefault();
  drop.classList.add("over");
}));
["dragleave","drop"].forEach(t => dlg.addEventListener(t, e => {
  e.preventDefault();
  drop.classList.remove("over");
}));
dlg.addEventListener("drop", e => {
  if(e.dataTransfer && e.dataTransfer.files[0]){
    loadFile(e.dataTransfer.files[0]);
  }
});
window.addEventListener("paste", e => {
  if(dlg.hidden || !e.clipboardData){
    return;
  }
  for(const it of e.clipboardData.items){
    if(it.type && it.type.startsWith("image/")){
      loadFile(it.getAsFile());
      return;
    }
  }
});

useBtn.addEventListener("click", () => {
  if(!S || !S.geo || !S.geo.rooms.length){
    return;
  }
  applyImportedPlan(S.geo, +(floorSel.value || 0));
  close();
});

window.addEventListener("resize", () => {
  if(!dlg.hidden && S){
    layout();
    redraw();
  }
});

})();
