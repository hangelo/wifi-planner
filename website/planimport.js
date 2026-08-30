/* ============================================================
   planimport.js — floor-plan raster → wall mask → solver geometry

   Pure computation: takes ImageData in, returns typed arrays and
   plain objects out. No DOM, no rendering, no app state.
   ============================================================ */
"use strict";

const PlanImport = (function(){

const INF = 1e20;

/* ============================================================
   1. DISTANCE TRANSFORM
   5x5 chamfer (1, sqrt2, sqrt5) — two sequential passes, max
   error about 2% of the true Euclidean distance. The exact
   Felzenszwalb transform costs ~8x more here because its column
   pass strides across the whole buffer, and this runs eight
   times per parameter change; 2% on a disk radius is invisible
   and the interactivity is not.

   Everything else in this file — erosion, dilation, wall
   thickness, label anchors — is built on top of it.
   ============================================================ */
const D1 = 1, D2 = Math.SQRT2, D5 = Math.sqrt(5);
const FAR = 1e9;

/* Distance from every pixel to the nearest seed (seed[i] truthy).
   Runs on a buffer padded by 2, so the kernel needs no bounds tests at all;
   the padding stays at FAR, which also means the area outside the image is
   never a seed — a wall running off the edge of the crop keeps its full
   thickness instead of being eroded from the outside in. */
function distTransform(seed, w, h){
  const pw = w + 4, ph = h + 4;
  const d = new Float32Array(pw * ph).fill(FAR);
  for(let y=0;y<h;y++){
    const src = y*w, dst = (y+2)*pw + 2;
    for(let x=0;x<w;x++){
      if(seed[src+x]){
        d[dst+x] = 0;
      }
    }
  }
  for(let y=2;y<ph-2;y++){
    const o = y*pw;
    for(let x=2;x<pw-2;x++){
      const i = o + x;
      let v = d[i], t;
      if(v === 0){
        continue;
      }
      const p2 = i - 2*pw, p1 = i - pw;
      t = d[p2-1] + D5; if(t < v){ v = t; }
      t = d[p2+1] + D5; if(t < v){ v = t; }
      t = d[p1-2] + D5; if(t < v){ v = t; }
      t = d[p1-1] + D2; if(t < v){ v = t; }
      t = d[p1]   + D1; if(t < v){ v = t; }
      t = d[p1+1] + D2; if(t < v){ v = t; }
      t = d[p1+2] + D5; if(t < v){ v = t; }
      t = d[i-1]  + D1; if(t < v){ v = t; }
      d[i] = v;
    }
  }
  for(let y=ph-3;y>=2;y--){
    const o = y*pw;
    for(let x=pw-3;x>=2;x--){
      const i = o + x;
      let v = d[i], t;
      if(v === 0){
        continue;
      }
      const n2 = i + 2*pw, n1 = i + pw;
      t = d[n2-1] + D5; if(t < v){ v = t; }
      t = d[n2+1] + D5; if(t < v){ v = t; }
      t = d[n1-2] + D5; if(t < v){ v = t; }
      t = d[n1-1] + D2; if(t < v){ v = t; }
      t = d[n1]   + D1; if(t < v){ v = t; }
      t = d[n1+1] + D2; if(t < v){ v = t; }
      t = d[n1+2] + D5; if(t < v){ v = t; }
      t = d[i+1]  + D1; if(t < v){ v = t; }
      d[i] = v;
    }
  }
  const out = new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const b = (y+2)*pw + 2;
    out.set(d.subarray(b, b + w), y*w);
  }
  return out;
}

/* ============================================================
   2. MORPHOLOGY (disk structuring elements, via the transform)
   ============================================================ */
function dilate(mask, w, h, r){
  if(r <= 0){
    return mask.slice();
  }
  const n = w*h;
  const d = distTransform(mask, w, h);
  const out = new Uint8Array(n);
  for(let i=0;i<n;i++){
    if(d[i] <= r){
      out[i] = 1;
    }
  }
  return out;
}

/* Note: the area outside the image is not treated as background, so a wall
   running off the edge of the crop is not nibbled away from that side. */
function erode(mask, w, h, r){
  if(r <= 0){
    return mask.slice();
  }
  const n = w*h;
  const bg = new Uint8Array(n);
  for(let i=0;i<n;i++){
    bg[i] = mask[i] ? 0 : 1;
  }
  const d = distTransform(bg, w, h);
  const out = new Uint8Array(n);
  for(let i=0;i<n;i++){
    if(mask[i] && d[i] > r){
      out[i] = 1;
    }
  }
  return out;
}

function closing(mask, w, h, r){
  return erode(dilate(mask, w, h, r), w, h, r);
}

function opening(mask, w, h, r){
  return dilate(erode(mask, w, h, r), w, h, r);
}

/* ============================================================
   3. CONNECTED COMPONENTS + FLOOD FILL
   ============================================================ */
function labelCC(mask, w, h, conn){
  const n = w*h;
  const lab = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const comps = [];
  const eight = conn === 8;
  for(let s=0;s<n;s++){
    if(!mask[s] || lab[s] >= 0){
      continue;
    }
    const id = comps.length;
    const c = {size:0, x0:w, y0:h, x1:-1, y1:-1};
    let sp = 0;
    stack[sp++] = s;
    lab[s] = id;
    while(sp > 0){
      const k = stack[--sp];
      const x = k % w, y = (k / w) | 0;
      c.size++;
      c.x0 = Math.min(c.x0, x);
      c.y0 = Math.min(c.y0, y);
      c.x1 = Math.max(c.x1, x);
      c.y1 = Math.max(c.y1, y);
      for(let dy=-1;dy<=1;dy++){
        for(let dx=-1;dx<=1;dx++){
          if(dx === 0 && dy === 0){
            continue;
          }
          if(!eight && dx !== 0 && dy !== 0){
            continue;
          }
          const xx = x + dx, yy = y + dy;
          if(xx < 0 || yy < 0 || xx >= w || yy >= h){
            continue;
          }
          const kk = yy*w + xx;
          if(mask[kk] && lab[kk] < 0){
            lab[kk] = id;
            stack[sp++] = kk;
          }
        }
      }
    }
    comps.push(c);
  }
  return {lab, comps};
}

/* 4-connected fill inwards from every image edge, over pixels where !block */
function floodOutside(block, w, h){
  const n = w*h;
  const out = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  const push = k => {
    if(!block[k] && !out[k]){
      out[k] = 1;
      q[qt++] = k;
    }
  };
  for(let x=0;x<w;x++){
    push(x);
    push((h-1)*w + x);
  }
  for(let y=0;y<h;y++){
    push(y*w);
    push(y*w + w - 1);
  }
  while(qh < qt){
    const k = q[qh++];
    const x = k % w, y = (k / w) | 0;
    if(x > 0){
      push(k-1);
    }
    if(x < w-1){
      push(k+1);
    }
    if(y > 0){
      push(k-w);
    }
    if(y < h-1){
      push(k+w);
    }
  }
  return out;
}

/* ============================================================
   4. COLOUR
   ============================================================ */
/* "redmean" weighted RGB distance — cheap, and close enough to perceptual
   for deciding whether a pixel belongs to a flat fill colour. */
function colorDist2(r1,g1,b1, r2,g2,b2){
  const rm = (r1 + r2) * 0.5;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return (2 + rm/256)*dr*dr + 4*dg*dg + (2 + (255-rm)/256)*db*db;
}

const lumaOf = (r,g,b) => 0.299*r + 0.587*g + 0.114*b;
const satOf  = (r,g,b) => Math.max(r,g,b) - Math.min(r,g,b);

/* tolerance 0..100 → squared colour distance cut-off */
function tolToDist2(tol){
  const d = (tol/100) * 210;
  return d*d;
}

/* ============================================================
   5. SEGMENTATION — two detectors
   ============================================================ */
/* Flat-fill plans: walls are a solid block of one colour. */
function segmentFill(px, n, color, tol){
  const m = new Uint8Array(n);
  const lim = tolToDist2(tol);
  const [cr,cg,cb] = color;
  for(let i=0;i<n;i++){
    const o = i*4;
    if(px[o+3] < 128){
      continue;
    }
    if(colorDist2(px[o], px[o+1], px[o+2], cr, cg, cb) <= lim){
      m[i] = 1;
    }
  }
  return m;
}

/* CAD plans: walls are hatching and outlines drawn in dark ink. Saturated
   pixels are excluded so coloured annotation text is never taken for wall. */
function segmentInk(px, n, thr, maxSat){
  const m = new Uint8Array(n);
  for(let i=0;i<n;i++){
    const o = i*4;
    if(px[o+3] < 128){
      continue;
    }
    const r = px[o], g = px[o+1], b = px[o+2];
    if(lumaOf(r,g,b) < thr && satOf(r,g,b) <= maxSat){
      m[i] = 1;
    }
  }
  return m;
}

function segment(imgData, opts){
  const n = imgData.width * imgData.height;
  if(opts.mode === "ink"){
    return segmentInk(imgData.data, n, opts.threshold, opts.maxSat);
  }
  return segmentFill(imgData.data, n, opts.color, opts.tolerance);
}

/* Otsu on the luminance histogram, ignoring saturated pixels. */
function otsuThreshold(imgData){
  const px = imgData.data;
  const n = imgData.width * imgData.height;
  const hist = new Float64Array(256);
  let total = 0;
  for(let i=0;i<n;i++){
    const o = i*4;
    if(px[o+3] < 128){
      continue;
    }
    if(satOf(px[o], px[o+1], px[o+2]) > 70){
      continue;
    }
    hist[Math.round(lumaOf(px[o], px[o+1], px[o+2]))]++;
    total++;
  }
  if(!total){
    return 128;
  }
  let sum = 0;
  for(let t=0;t<256;t++){
    sum += t * hist[t];
  }
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for(let t=0;t<256;t++){
    wB += hist[t];
    if(!wB){
      continue;
    }
    const wF = total - wB;
    if(!wF){
      break;
    }
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if(between > best){
      best = between;
      thr = t;
    }
  }
  return thr;
}

/* ------------------------------------------------------------
   Auto-detect: which detector, and for fill mode, which colour.

   Walls are the thin connected structure in a floor plan; room
   fills are fat blobs and the paper is the border-touching
   background. Score candidate fill colours by thinness —
   area / mean-distance-to-own-edge² — and fall back to ink
   when no candidate looks like a wall.
   ------------------------------------------------------------ */
function autoDetect(imgData){
  const w = imgData.width, h = imgData.height, n = w*h;
  const px = imgData.data;
  const bins = 32768;                       // 5 bits per channel
  const cnt = new Int32Array(bins);
  const sr = new Float64Array(bins), sg = new Float64Array(bins), sb = new Float64Array(bins);
  const bord = new Int32Array(bins);
  const bx = Math.max(2, Math.round(w*0.02)), by = Math.max(2, Math.round(h*0.02));
  let seen = 0;
  for(let y=0;y<h;y++){
    const edgeRow = y < by || y >= h - by;
    for(let x=0;x<w;x++){
      const i = y*w + x, o = i*4;
      if(px[o+3] < 128){
        continue;
      }
      const r = px[o], g = px[o+1], b = px[o+2];
      const k = ((r>>3)<<10) | ((g>>3)<<5) | (b>>3);
      cnt[k]++;
      sr[k] += r; sg[k] += g; sb[k] += b;
      if(edgeRow || x < bx || x >= w - bx){
        bord[k]++;
      }
      seen++;
    }
  }
  if(!seen){
    return {mode:"ink", threshold:128, maxSat:70};
  }

  /* the commonest colour is the paper; a wall has to be clearly darker than
     it, or faint grid lines win on thinness and get taken for walls */
  let bgBin = 0;
  for(let k=1;k<bins;k++){
    if(cnt[k] > cnt[bgBin]){
      bgBin = k;
    }
  }
  const bgLum = cnt[bgBin] ? lumaOf(sr[bgBin]/cnt[bgBin], sg[bgBin]/cnt[bgBin], sb[bgBin]/cnt[bgBin]) : 255;

  const cand = [];
  for(let k=0;k<bins;k++){
    const c = cnt[k];
    if(c < seen*0.01){
      continue;
    }
    const r = sr[k]/c, g = sg[k]/c, b = sb[k]/c;
    if(lumaOf(r,g,b) > bgLum - 45){
      continue;                             // paper, or an ink too faint to be wall
    }
    if(satOf(r,g,b) > 70){
      continue;                             // annotation colour
    }
    if(bord[k] / c > 0.25){
      continue;                             // background field
    }
    cand.push({k, c, color:[r,g,b]});
  }
  cand.sort((a,b) => b.c - a.c);

  let best = null;
  for(const cd of cand.slice(0, 6)){
    const m = segmentFill(px, n, cd.color, 22);
    let area = 0;
    for(let i=0;i<n;i++){
      area += m[i];
    }
    const cov = area / seen;
    if(cov < 0.02 || cov > 0.5){
      continue;
    }
    const bg = new Uint8Array(n);
    for(let i=0;i<n;i++){
      bg[i] = m[i] ? 0 : 1;
    }
    const d = distTransform(bg, w, h);
    let acc = 0;
    for(let i=0;i<n;i++){
      if(m[i]){
        acc += d[i];
      }
    }
    const meanDT = acc / Math.max(1, area);
    const thinness = area / (4*meanDT*meanDT + 1);
    if(!best || thinness > best.thinness){
      best = {thinness, color:cd.color, cov};
    }
  }

  if(best && best.thinness > 40){
    return {mode:"fill", color:best.color.map(Math.round), tolerance:22};
  }
  return {mode:"ink", threshold:otsuThreshold(imgData), maxSat:70};
}

/* ============================================================
   6. CLEAN-UP
   close() first, to weld hatching into a solid band; open()
   second, to delete dimension lines, leaders and text — which
   survive the close as the thin things they started as.
   ============================================================ */
function cleanup(raw, w, h, o){
  let m = raw;
  if(o.closeR > 0){
    m = closing(m, w, h, o.closeR);
  }
  if(o.openR > 0){
    m = opening(m, w, h, o.openR);
  }
  const {lab, comps} = labelCC(m, w, h, 8);
  let biggest = 0;
  for(const c of comps){
    biggest = Math.max(biggest, c.size);
  }
  const floor = Math.max(o.minArea, biggest * 0.05);
  const keep = comps.map(c => c.size >= floor);
  const out = new Uint8Array(w*h);
  for(let i=0;i<out.length;i++){
    const L = lab[i];
    if(L >= 0 && keep[L]){
      out[i] = 1;
    }
  }
  return out;
}

/* Distance-to-edge across a band of thickness t is roughly uniform on
   [0, t/2], so its 75th percentile lands at 0.75·t/2 — scale back up.
   A percentile rather than the maximum, because wall junctions carry
   distances far larger than any wall is thick. */
function wallThickness(wall, w, h, cmPerPx){
  const n = w*h;
  const bg = new Uint8Array(n);
  for(let i=0;i<n;i++){
    bg[i] = wall[i] ? 0 : 1;
  }
  const d = distTransform(bg, w, h);
  const vals = [];
  const stride = Math.max(1, Math.floor(n / 200000));
  for(let i=0;i<n;i+=stride){
    if(wall[i]){
      vals.push(d[i]);
    }
  }
  if(!vals.length){
    return 0;
  }
  vals.sort((a,b) => a - b);
  const p = vals[Math.min(vals.length-1, Math.floor(vals.length*0.75))];
  return (8/3) * p * cmPerPx;
}

/* ============================================================
   7. GEOMETRY EXTRACTION
   ------------------------------------------------------------
   Rooms and doorways fall out of one observation: erode the free
   space by half a door width and every doorway pinches shut,
   while every room survives as a core. Grow the cores back and
   the seam where two of them meet lies exactly across the
   doorway that separates them.

   This replaces trying to seal the plan with one closing radius.
   That could not work: a 97 cm box room is narrower than a 100 cm
   door, so no single radius both closes every door and spares
   every room.

   Nothing here relies on the wall outline being unbroken. A front
   door is a hole in the exterior wall, and the outdoors is simply
   whichever region reaches the edge of the image — a hole in the
   wall makes a seam, not a leak.
   ============================================================ */
function buildGeometry(wall, w, h, cmPerPx, opts){
  const o = Object.assign({doorCm:90, minRoomM2:0.5}, opts || {});
  const n = w*h;
  const pxM2 = (cmPerPx * cmPerPx) / 10000;
  const wallT = wallThickness(wall, w, h, cmPerPx) || 20;

  const nw = new Uint8Array(n);           /* free space, indoors and out */
  for(let i=0;i<n;i++){
    nw[i] = wall[i] ? 0 : 1;
  }

  const rDoor = Math.max(1, (o.doorCm * 0.5) / cmPerPx);
  const core = erode(nw, w, h, rDoor);
  const ccc = labelCC(core, w, h, 4);

  /* grow every core back through the free space; each pixel joins its nearest */
  const owner = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  for(let i=0;i<n;i++){
    if(core[i]){
      owner[i] = ccc.lab[i];
      q[qt++] = i;
    }
  }
  while(qh < qt){
    const k = q[qh++];
    const x = k % w, y = (k / w) | 0, L = owner[k];
    if(x > 0 && nw[k-1] && owner[k-1] < 0){
      owner[k-1] = L;
      q[qt++] = k-1;
    }
    if(x < w-1 && nw[k+1] && owner[k+1] < 0){
      owner[k+1] = L;
      q[qt++] = k+1;
    }
    if(y > 0 && nw[k-w] && owner[k-w] < 0){
      owner[k-w] = L;
      q[qt++] = k-w;
    }
    if(y < h-1 && nw[k+w] && owner[k+w] < 0){
      owner[k+w] = L;
      q[qt++] = k+w;
    }
  }

  /* free space too narrow anywhere to hold a core keeps its own identity */
  const rest = new Uint8Array(n);
  let any = false;
  for(let i=0;i<n;i++){
    if(nw[i] && owner[i] < 0){
      rest[i] = 1;
      any = true;
    }
  }
  if(any){
    const rcc = labelCC(rest, w, h, 4);
    const base = ccc.comps.length;
    for(let i=0;i<n;i++){
      if(rest[i]){
        owner[i] = base + rcc.lab[i];
      }
    }
  }

  /* the seam between two owners runs across a doorway; thicken it to the
     wall it pierces, and that is the door void */
  const seam = new Uint8Array(n);
  for(let i=0;i<n;i++){
    if(!nw[i]){
      continue;
    }
    const x = i % w, y = (i / w) | 0, L = owner[i];
    if((x > 0 && nw[i-1] && owner[i-1] !== L) ||
       (x < w-1 && nw[i+1] && owner[i+1] !== L) ||
       (y > 0 && nw[i-w] && owner[i-w] !== L) ||
       (y < h-1 && nw[i+w] && owner[i+w] !== L)){
      seam[i] = 1;
    }
  }
  const band = dilate(seam, w, h, Math.max(1, (wallT * 0.55) / cmPerPx));
  const cand = new Uint8Array(n);
  for(let i=0;i<n;i++){
    cand[i] = (band[i] && nw[i]) ? 1 : 0;
  }
  const dcc = labelCC(cand, w, h, 8);

  /* A doorway is no deeper than the wall it pierces and no wider than a door.
     A wide arch or an open-plan join fails both and stays free space. */
  const maxDepthPx = (wallT * 2.2) / cmPerPx;
  const maxAreaPx = (o.doorCm * wallT * 2.5) / (cmPerPx * cmPerPx);
  const doorOf = new Int32Array(dcc.comps.length).fill(-1);
  let doorCount = 0;
  dcc.comps.forEach((c, L) => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if(Math.min(bw, bh) <= maxDepthPx && c.size <= maxAreaPx){
      doorOf[L] = doorCount++;
    }
  });

  const isDoor = new Uint8Array(n);
  for(let i=0;i<n;i++){
    const L = dcc.lab[i];
    if(L >= 0 && doorOf[L] >= 0){
      isDoor[i] = 1;
    }
  }

  /* regions, with the doorways cut: whatever reaches the edge is outdoors */
  const space = new Uint8Array(n);
  for(let i=0;i<n;i++){
    space[i] = (nw[i] && !isDoor[i]) ? 1 : 0;
  }
  const scc = labelCC(space, w, h, 4);
  const outdoor = new Uint8Array(scc.comps.length);
  const markEdge = k => {
    const L = scc.lab[k];
    if(L >= 0){
      outdoor[L] = 1;
    }
  };
  for(let x=0;x<w;x++){
    markEdge(x);
    markEdge((h-1)*w + x);
  }
  for(let y=0;y<h;y++){
    markEdge(y*w);
    markEdge(y*w + w - 1);
  }

  /* ---- kind, with raw region ids ---- */
  const kind = new Uint8Array(n);
  const roomIdx = new Int16Array(n).fill(-1);
  const opIdx = new Int16Array(n).fill(-1);
  for(let i=0;i<n;i++){
    if(wall[i]){
      kind[i] = 2;
    } else if(isDoor[i]){
      kind[i] = 3;
      opIdx[i] = doorOf[dcc.lab[i]];
    } else {
      const L = scc.lab[i];
      if(L >= 0 && !outdoor[L]){
        kind[i] = 1;
        roomIdx[i] = L;
      } else {
        kind[i] = 0;
      }
    }
  }

  /* ---- room areas, minimum size, ordering ---- */
  const rawCount = scc.comps.length;
  const px = new Int32Array(rawCount);
  for(let i=0;i<n;i++){
    if(kind[i] === 1 && roomIdx[i] >= 0){
      px[roomIdx[i]]++;
    }
  }
  const keep = [];
  for(let r=0;r<rawCount;r++){
    if(px[r] > 0 && px[r] * pxM2 >= o.minRoomM2){
      keep.push(r);
    }
  }
  keep.sort((a,b) => px[b] - px[a]);
  const remap = new Int32Array(rawCount).fill(-1);
  keep.forEach((r, i) => {
    remap[r] = i;
  });
  for(let i=0;i<n;i++){
    if(kind[i] !== 1){
      continue;
    }
    const r = roomIdx[i] < 0 ? -1 : remap[roomIdx[i]];
    if(r < 0){
      kind[i] = 2;                 /* a speck too small to be a room is wall */
      roomIdx[i] = -1;
    } else {
      roomIdx[i] = r;
    }
  }

  const rooms = keep.map((r, i) => ({
    id: "R" + (i+1),
    name: "Room " + String.fromCharCode(65 + (i % 26)),
    area: 0,
    x: 0, y: 0, w: 0, h: 0,
    lx: 0, ly: 0
  }));

  /* bounding boxes, and the point furthest from any wall — where an L-shaped
     room wants its caption rather than at the centre of its box */
  const seed = new Uint8Array(n);
  for(let i=0;i<n;i++){
    seed[i] = kind[i] === 1 ? 0 : 1;
  }
  const adist = distTransform(seed, w, h);
  const bx0 = new Int32Array(rooms.length).fill(w), by0 = new Int32Array(rooms.length).fill(h);
  const bx1 = new Int32Array(rooms.length).fill(-1), by1 = new Int32Array(rooms.length).fill(-1);
  const bestD = new Float64Array(rooms.length).fill(-1);
  for(let i=0;i<n;i++){
    const r = kind[i] === 1 ? roomIdx[i] : -1;
    if(r < 0){
      continue;
    }
    const x = i % w, y = (i / w) | 0;
    rooms[r].area++;
    bx0[r] = Math.min(bx0[r], x);
    by0[r] = Math.min(by0[r], y);
    bx1[r] = Math.max(bx1[r], x);
    by1[r] = Math.max(by1[r], y);
    if(adist[i] > bestD[r]){
      bestD[r] = adist[i];
      rooms[r].lx = (x + 0.5) * cmPerPx;
      rooms[r].ly = (y + 0.5) * cmPerPx;
    }
  }
  rooms.forEach((r, i) => {
    r.area *= pxM2;
    r.x = bx0[i] * cmPerPx;
    r.y = by0[i] * cmPerPx;
    r.w = (bx1[i] - bx0[i] + 1) * cmPerPx;
    r.h = (by1[i] - by0[i] + 1) * cmPerPx;
  });

  /* ---- openings, named from the rooms they actually join ---- */
  const side = dcc.comps.map(() => new Map());
  for(let i=0;i<n;i++){
    if(kind[i] !== 3){
      continue;
    }
    const L = dcc.lab[i];
    const x = i % w, y = (i / w) | 0;
    for(let s=0;s<4;s++){
      const xx = x + (s === 0 ? -1 : s === 1 ? 1 : 0);
      const yy = y + (s === 2 ? -1 : s === 3 ? 1 : 0);
      if(xx < 0 || yy < 0 || xx >= w || yy >= h){
        continue;
      }
      const kk = yy*w + xx;
      if(kind[kk] === 2 || kind[kk] === 3){
        continue;
      }
      const rid = kind[kk] === 1 ? roomIdx[kk] : -1;
      side[L].set(rid, (side[L].get(rid) || 0) + 1);
    }
  }
  /* A door has to join two different regions, and at least one of them has to
     be indoors. The free space around the building can pinch at a corner and
     leave a seam in open air; that is not a door, it is the garden. */
  const nameOf = rid => rid < 0 || !rooms[rid] ? "outside" : rooms[rid].name;
  const finalOf = new Int32Array(dcc.comps.length).fill(-1);
  const openings = [];
  dcc.comps.forEach((c, L) => {
    if(doorOf[L] < 0){
      return;
    }
    const ids = [...side[L].entries()].sort((a,b) => b[1] - a[1]).slice(0,2).map(e => e[0]);
    if(ids.length < 2 || (ids[0] < 0 && ids[1] < 0)){
      return;
    }
    const bw = (c.x1 - c.x0 + 1) * cmPerPx, bh = (c.y1 - c.y0 + 1) * cmPerPx;
    finalOf[L] = openings.length;
    openings.push({
      id: "d" + (openings.length + 1),
      label: nameOf(ids[0]) + " → " + nameOf(ids[1]),
      type: ids.includes(-1) ? "solid" : "open",
      axis: bh > bw ? "v" : "h",
      x: c.x0 * cmPerPx, y: c.y0 * cmPerPx, w: bw, h: bh,
      lim: null
    });
  });

  /* whatever was rejected here goes back to the space it sat in */
  for(let i=0;i<n;i++){
    if(kind[i] !== 3){
      continue;
    }
    const f = finalOf[dcc.lab[i]];
    if(f >= 0){
      opIdx[i] = f;
      continue;
    }
    const ids = [...side[dcc.lab[i]].entries()].sort((a,b) => b[1] - a[1]);
    const rid = ids.length ? ids[0][0] : -1;
    opIdx[i] = -1;
    if(rid >= 0){
      kind[i] = 1;
      roomIdx[i] = rid;
    } else {
      kind[i] = 0;
    }
  }

  return {
    kind, roomIdx, opIdx, rooms, openings,
    w, h, cmPerPx,
    wallT: Math.round(wallT),
    area: rooms.reduce((s,r) => s + r.area, 0)
  };
}

return {
  distTransform, dilate, erode, closing, opening, labelCC, floodOutside,
  segment, segmentFill, segmentInk, autoDetect, otsuThreshold,
  cleanup, wallThickness, buildGeometry, colorDist2
};

})();
