"use strict";

/* ============================================================
   1. GEOMETRY  — traced from the supplied plan, in centimetres
   ============================================================ */
const BASE_PLAN = {
  W: 1320, H: 1066, wallT: 37,
  nz: 1,                     /* how many floors are modelled */
  floorH: 280,               /* floor-to-floor, cm — the vertical hop between levels */
  slab: "hollowblock",
  floorNames: ["Lower", "Upper"],
  src: ["vector", "vector"], /* per floor: "vector" rectangles, or an imported "raster" */
  masks: [null, null],
  /* Where the slab is missing: a stairwell, a light well, a double-height room.
     Shared by both floors, because it is the hole between them. */
  stairs: [],
  footprint: [
    {x:708, y:0,   w:612,  h:486, floor:0},
    {x:848, y:486, w:472,  h:106, floor:0},
    {x:0,   y:155, w:646,  h:331, floor:0},
    {x:0,   y:486, w:474,  h:106, floor:0},
    {x:0,   y:592, w:1320, h:474, floor:0}
  ],
  rooms: [
    {id:"A", name:"Room A", x:745, y:37,  w:538, h:412, area:22.06, floor:0},
    {id:"B", name:"Room B", x:37,  y:192, w:400, h:400, area:16.00, floor:0},
    {id:"C", name:"Room C", x:511, y:192, w:98,  h:255, area:2.50,  floor:0},
    {id:"D", name:"Room D", x:885, y:497, w:398, h:97,  area:3.86,  floor:0},
    {id:"E", name:"Room E", x:37,  y:629, w:474, h:400, area:18.95, floor:0},
    {id:"F", name:"Room F", x:550, y:629, w:733, h:400, area:29.30, floor:0}
  ],
  /* `lim` is how far the opening may slide along its own wall */
  openings: [
    {id:"o1", label:"A → entry",     x:708,  y:45,  w:37, h:95, axis:"v", type:"hollow", lim:[40,350],   floor:0},
    {id:"o2", label:"A → D",         x:1090, y:449, w:90, h:48, axis:"h", type:"hollow", lim:[888,1190], floor:0},
    {id:"o3", label:"C → courtyard", x:520,  y:447, w:80, h:39, axis:"h", type:"hollow", lim:[513,527],  floor:0},
    {id:"o4", label:"B → courtyard", x:437,  y:495, w:37, h:85, axis:"v", type:"hollow", lim:[489,505],  floor:0},
    {id:"o5", label:"D → courtyard", x:848,  y:505, w:37, h:80, axis:"v", type:"hollow", lim:[499,512],  floor:0},
    {id:"o6", label:"D → F",         x:950,  y:594, w:90, h:35, axis:"h", type:"open",   lim:[888,1190], floor:0},
    {id:"o7", label:"F → courtyard", x:615,  y:592, w:95, h:37, axis:"h", type:"open",   lim:[553,750],  floor:0},
    {id:"o8", label:"E → F",         x:511,  y:700, w:39, h:95, axis:"v", type:"hollow", lim:[632,931],  floor:0}
  ]
};
let PLAN = structuredClone(BASE_PLAN);

const FLOOR_OF = e => e.floor || 0;

/* ============================================================
   2. RF CONSTANTS
   ============================================================ */
const BAND = {
  "2.4": {K:40.2, nf:-92, label:"2.4 GHz", wallCap:60},
  "5":   {K:47.3, nf:-95, label:"5 GHz",   wallCap:70}
};

/* loss in dB per crossing of one 37 cm wall (whole-assembly values) */
const WALL_MATERIALS = [
  {id:"drywall",  name:"Drywall / stud partition",   d24:4,  d5:6},
  {id:"wood",     name:"Timber frame + board",       d24:6,  d5:9},
  {id:"hollow",   name:"Hollow clay brick, 37 cm",   d24:12, d5:20},
  {id:"solid",    name:"Solid brick, 37 cm",         d24:17, d5:29},
  {id:"block",    name:"Concrete block, 37 cm",      d24:20, d5:33},
  {id:"concrete", name:"Poured concrete, 37 cm",     d24:34, d5:58},
  {id:"rc",       name:"Reinforced concrete, 37 cm", d24:44, d5:76}
];

/* loss in dB for one crossing of the floor slab, whole assembly.
   Unlike walls this is a discrete obstacle, not a rate per metre: you either
   go through the slab or you do not. */
const SLAB_MATERIALS = [
  {id:"timber",      name:"Timber joists + boards", d24:12, d5:17},
  {id:"hollowblock", name:"Hollow-block slab",      d24:18, d5:28},
  {id:"concrete20",  name:"Concrete slab, 20 cm",   d24:25, d5:38},
  {id:"rc25",        name:"Reinforced concrete, 25 cm", d24:33, d5:50}
];

/* loss in dB per crossing of the opening */
const OPENING_TYPES = [
  {id:"open",   name:"Open doorway", d24:0,  d5:0},
  {id:"hollow", name:"Hollow door",  d24:3,  d5:4},
  {id:"solid",  name:"Solid door",   d24:6,  d5:8},
  {id:"glass",  name:"Glass / window", d24:2, d5:3},
  {id:"lowe",   name:"Low-E glazing", d24:15, d5:22},
  {id:"metal",  name:"Metal door",   d24:25, d5:30},
  {id:"sealed", name:"Sealed (wall)", d24:null, d5:null}
];

const MCS = [
  {i:0, snr:2,  r:6.5},  {i:1, snr:5,  r:13},   {i:2, snr:9,  r:19.5},
  {i:3, snr:11, r:26},   {i:4, snr:15, r:39},   {i:5, snr:18, r:52},
  {i:6, snr:20, r:58.5}, {i:7, snr:25, r:65},   {i:8, snr:29, r:78},
  {i:9, snr:31, r:86.7}, {i:10,snr:34, r:97.5}, {i:11,snr:37, r:108.3}
];
const BW_SCALE = {20:1, 40:2.08, 80:4.5};

const GRADES = [
  {min:-50, name:"Excellent", c:"#FCFDBF", ink:"#3A2A05"},
  {min:-60, name:"Very good", c:"#FEC287", ink:"#4A2606"},
  {min:-67, name:"Good",      c:"#F1605D", ink:"#FFF1EC"},
  {min:-75, name:"Fair",      c:"#B5367A", ink:"#FFECF6"},
  {min:-85, name:"Poor",      c:"#65156E", ink:"#F4E3F6"},
  {min:-999,name:"Dead",      c:"#1B0C40", ink:"#CFC7E8"}
];
function gradeOf(r){ for(const g of GRADES) if(r>=g.min) return g; return GRADES[GRADES.length-1]; }

/* magma-derived ramp: dark = weak, hot/bright = strong. Monotone in lightness. */
const RAMP = [
  [0.00,  9,  6, 28],[0.12, 40, 11, 84],[0.25, 85, 15,109],[0.38,132, 28,105],
  [0.50,181, 54, 122],[0.62,222, 73, 104],[0.74,246,120, 92],[0.86,254,176,120],
  [0.94,254,213,159],[1.00,252,253,191]
];
const RATE_RAMP = [
  [0.00, 12, 16, 20],[0.20, 12, 54, 62],[0.42, 14, 95,102],[0.62, 40,140,133],
  [0.80,108,186,164],[1.00,196,232,205]
];
function sampleRamp(ramp,t){
  t = t<0?0:t>1?1:t;
  for(let i=1;i<ramp.length;i++){
    if(t<=ramp[i][0]){
      const a=ramp[i-1], b=ramp[i];
      const u=(t-a[0])/(b[0]-a[0]||1);
      return [a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u, a[3]+(b[3]-a[3])*u];
    }
  }
  const l=ramp[ramp.length-1]; return [l[1],l[2],l[3]];
}
function rampCSS(ramp){
  return "linear-gradient(90deg,"+ramp.map(s=>`rgb(${s[1]|0},${s[2]|0},${s[3]|0}) ${(s[0]*100).toFixed(1)}%`).join(",")+")";
}

/* ============================================================
   3. STATE
   ============================================================ */
const AP_COLORS = ["#FF9E45","#4FD1C5","#F06AA8"];
let state = {
  band:"2.4", tx:20, gain:3, bw:40, ss:2,
  extMat:"hollow", intMat:"hollow", clutter:24,
  mode:"rssi", target:-67,
  contour:true, path:true, grid:false,
  aps:[{x:1014, y:243, f:0, id:0}],
  selAp:0,
  selStair:-1,
  stairMode:false
};

/* ============================================================
   4. RASTER
   ============================================================ */
const MARGIN = 120;
const rasterCache = new Map();
let geomVersion = 0;

function rasterKey(cell){ return cell+"|"+geomVersion; }

function buildRaster(cell){
  const key = rasterKey(cell);
  if(rasterCache.has(key)) return rasterCache.get(key);

  const nx = Math.ceil((PLAN.W + 2*MARGIN)/cell);
  const ny = Math.ceil((PLAN.H + 2*MARGIN)/cell);
  const nz = PLAN.nz || 1;
  const nxy = nx*ny;
  const n = nxy*nz;
  const kind = new Uint8Array(n);      // 0 outside, 1 room, 2 wall, 3 opening
  const opIdx = new Int16Array(n).fill(-1);
  const roomIdx = new Int16Array(n).fill(-1);

  for(let f=0;f<nz;f++){
    fillLayer(f, cell, nx, ny, f*nxy, kind, opIdx, roomIdx);
  }
  return finishRaster(cell, nx, ny, nz, nxy, n, kind, opIdx, roomIdx, key);
}

/* One floor's worth of cells, from that floor's own geometry. */
function fillLayer(f, cell, nx, ny, off, kind, opIdx, roomIdx){
  if((PLAN.src && PLAN.src[f]) === "raster" && PLAN.masks && PLAN.masks[f]){
    /* Imported plan: resample the mask. Coverage-weighted rather than
       nearest-neighbour, so a partition thinner than one solver cell still
       reads as wall at the 18 cm cell the best-spot search uses. */
    const M = PLAN.masks[f];
    const {mw, mh, cmPerPx, kind:mKind, roomIdx:mRoom, opIdx:mOp} = M;
    const ox = M.ox || 0, oy = M.oy || 0;
    const sub = Math.max(1, Math.min(6, Math.round(cell/cmPerPx/2)));
    const tot = sub*sub;
    const step = cell/sub;
    for(let j=0;j<ny;j++){
      const y0 = -MARGIN + j*cell;
      for(let i=0;i<nx;i++){
        const x0 = -MARGIN + i*cell;
        const k = off + j*nx + i;
        let c0=0, c1=0, c2=0, c3=0, ri=-1, oi=-1;
        for(let b=0;b<sub;b++){
          const my = Math.floor((y0 + (b+0.5)*step - oy)/cmPerPx);
          for(let a=0;a<sub;a++){
            const mx = Math.floor((x0 + (a+0.5)*step - ox)/cmPerPx);
            if(mx<0 || my<0 || mx>=mw || my>=mh){ c0++; continue; }
            const t = my*mw+mx, kk = mKind[t];
            if(kk===2) c2++;
            else if(kk===3){ c3++; if(oi<0) oi = mOp[t]; }
            else if(kk===1){ c1++; if(ri<0) ri = mRoom[t]; }
            else c0++;
          }
        }
        if(c2 >= tot*0.25 || (c2>=c1 && c2>=c0 && c2>=c3)) kind[k]=2;
        else if(c3>=c1 && c3>=c0){ kind[k]=3; opIdx[k]=oi; }
        else if(c1>=c0){ kind[k]=1; roomIdx[k]=ri; }
        else kind[k]=0;
      }
    }
    return;
  }

  const inRect = (x,y,r)=> x>=r.x && x<r.x+r.w && y>=r.y && y<r.y+r.h;
  const foots = PLAN.footprint.filter(r=>FLOOR_OF(r)===f);
  for(let j=0;j<ny;j++){
    const cy = -MARGIN + (j+0.5)*cell;
    for(let i=0;i<nx;i++){
      const cx = -MARGIN + (i+0.5)*cell;
      const k = off + j*nx + i;
      let foot=false;
      for(const r of foots) if(inRect(cx,cy,r)){foot=true;break;}
      if(!foot){ kind[k]=0; continue; }
      let ri=-1;
      for(let q=0;q<PLAN.rooms.length;q++){
        const r=PLAN.rooms[q];
        if(FLOOR_OF(r)===f && inRect(cx,cy,r)){ ri=q; break; }
      }
      if(ri>=0){ kind[k]=1; roomIdx[k]=ri; continue; }
      let oi=-1;
      for(let q=0;q<PLAN.openings.length;q++){
        const o=PLAN.openings[q];
        if(FLOOR_OF(o)===f && inRect(cx,cy,o)){ oi=q; break; }
      }
      if(oi>=0 && PLAN.openings[oi].type!=="sealed"){ kind[k]=3; opIdx[k]=oi; }
      else kind[k]=2;
    }
  }
}

function finishRaster(cell, nx, ny, nz, nxy, n, kind, opIdx, roomIdx, key){
  /* exterior-wall classification: BFS through wall cells from outdoors.
     Per floor — an outside wall is outside within its own storey. */
  const isExt = new Uint8Array(n);
  const extLim = Math.ceil((PLAN.wallT + cell*0.5)/cell);
  const dist = new Int16Array(nxy);
  const q = new Int32Array(nxy);
  for(let f=0;f<nz;f++){
    const off = f*nxy;
    dist.fill(32000);
    let qh=0, qt=0;
    for(let k=0;k<nxy;k++) if(kind[off+k]===0){ dist[k]=0; q[qt++]=k; }
    while(qh<qt){
      const k=q[qh++]; const d=dist[k];
      const i=k%nx, j=(k/nx)|0;
      for(let dj=-1;dj<=1;dj++) for(let di=-1;di<=1;di++){
        if(!di&&!dj) continue;
        const ii=i+di, jj=j+dj;
        if(ii<0||jj<0||ii>=nx||jj>=ny) continue;
        const kk=jj*nx+ii;
        const t=kind[off+kk];
        if(t!==2 && t!==3) continue;
        if(dist[kk]<=d+1) continue;
        dist[kk]=d+1; q[qt++]=kk;
      }
    }
    for(let k=0;k<nxy;k++) if(kind[off+k]===2 && dist[k]<=extLim) isExt[off+k]=1;
  }

  /* Vertical openness per column: where the slab is missing, signal moves
     between floors for free. That is the stairwell — and the open sky, which
     is why a window on one floor can talk to a window on the other. */
  const slabOpen = new Uint8Array(nxy);
  if(nz>1){
    const stairs = PLAN.stairs || [];
    for(let j=0;j<ny;j++){
      const cy = -MARGIN + (j+0.5)*cell;
      for(let i=0;i<nx;i++){
        const cx = -MARGIN + (i+0.5)*cell;
        const k = j*nx+i;
        let open = kind[k]===0 && kind[nxy+k]===0;
        if(!open){
          for(const st of stairs){
            if(cx>=st.x && cx<st.x+st.w && cy>=st.y && cy<st.y+st.h){ open=true; break; }
          }
        }
        slabOpen[k] = open?1:0;
      }
    }
  }

  const R = {cell,nx,ny,nz,nxy,n,kind,opIdx,roomIdx,isExt,slabOpen};
  if(rasterCache.size > 6) rasterCache.clear();
  rasterCache.set(key,R);
  return R;
}

/* The wall table is quoted per 37 cm assembly, so that — not the plan's own
   wall thickness — is what converts it to dB per metre. They are the same
   number on the sample plan; on an imported one they are not, and a 20 cm
   partition has to cost proportionally less than a 37 cm wall. */
const REF_WALL_T = 0.37;

function attenField(R, band){
  const bandKey = band==="2.4" ? "d24" : "d5";
  const tM = REF_WALL_T;
  const mat = id => WALL_MATERIALS.find(m=>m.id===id) || WALL_MATERIALS[2];
  const ext = mat(state.extMat)[bandKey]/tM;
  const int = mat(state.intMat)[bandKey]/tM;
  const a = new Float32Array(R.n);
  const opA = PLAN.openings.map(o=>{
    const t = OPENING_TYPES.find(t=>t.id===o.type) || OPENING_TYPES[0];
    if(t[bandKey]===null) return int;
    const depth = Math.max(0.05, Math.min(o.w,o.h)/100);
    return t[bandKey]/depth;
  });
  for(let k=0;k<R.n;k++){
    const kk = R.kind[k];
    if(kk===2) a[k] = R.isExt[k] ? ext : int;
    else if(kk===3) a[k] = opA[R.opIdx[k]] || 0;
    else a[k] = 0;
  }
  return a;
}

/* dB for one crossing of the floor slab */
function slabLoss(band){
  const bandKey = band==="2.4" ? "d24" : "d5";
  const m = SLAB_MATERIALS.find(m=>m.id===PLAN.slab) || SLAB_MATERIALS[1];
  return m[bandKey];
}

/* ============================================================
   5. SOLVER — least-loss path search (bucket-queue Dijkstra)
   ============================================================ */
/* Diffraction relief: a path that stretches beyond the straight line pays for the
   corners it turned. Saturating, per the Dominant Path / Geodesic Path findings. */
const DIFF_K = 34, DIFF_CAP = 22;

function solveAP(R, atten, apx, apy, apf, band, N){
  const {nx,ny,nz,nxy,n,cell} = R;
  const B = BAND[band];
  const cost = new Float32Array(n).fill(Infinity);
  const slen = new Float32Array(n);
  const wacc = new Float32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);

  let i0 = Math.floor((apx+MARGIN)/cell), j0 = Math.floor((apy+MARGIN)/cell);
  i0 = i0<0?0:i0>=nx?nx-1:i0; j0 = j0<0?0:j0>=ny?ny-1:j0;
  const f0 = apf<0?0:apf>=nz?nz-1:apf;
  const src = f0*nxy + j0*nx + i0;

  /* Dial's bucket queue. Buckets hold node indices with lazy deletion — a node
     may appear several times; only the entry matching its current cost runs. */
  const Q = 0.25, MAXC = 150;
  const NB = Math.ceil(MAXC/Q)+2;
  const base = B.K;
  const buckets = new Array(NB);
  const bucketOf = c => { const b=((c-base)/Q)|0; return b<0?0:b>=NB?NB-1:b; };
  const push = (k,c)=>{ const b=bucketOf(c); (buckets[b] || (buckets[b]=[])).push(k); };

  cost[src]=base; slen[src]=0; wacc[src]=0;
  push(src, base);

  const stepD = cell/100, diagD = stepD*Math.SQRT2;
  const vertD = (PLAN.floorH || 280)/100;
  const slabDb = nz>1 ? slabLoss(band) : 0;
  const LOG10E = 0.4342944819032518;
  const DI=[1,-1,0,0,1,1,-1,-1], DJ=[0,0,1,-1,1,-1,1,-1];

  for(let b=0;b<NB;b++){
    const arr = buckets[b];
    if(!arr) continue;
    for(let idx=0; idx<arr.length; idx++){
      const k = arr[idx];
      if(done[k] || bucketOf(cost[k])!==b) continue;
      done[k]=1;
      const kf = (k/nxy)|0, kp = k - kf*nxy;
      const ci=kp%nx, cj=(kp/nx)|0;
      const cc=cost[k], cs=slen[k], cw=wacc[k], ca=atten[k];
      for(let d=0;d<10;d++){
        let kk, ds, w;
        if(d<8){
          const ii=ci+DI[d], jj=cj+DJ[d];
          if(ii<0||jj<0||ii>=nx||jj>=ny) continue;
          kk = kf*nxy + jj*nx + ii;
          ds = d<4?stepD:diagD;
          w = (ca+atten[kk])*0.5*ds;
        } else {
          /* up or down a storey, through the slab unless it is open there */
          if(nz<2) break;
          const nf = d===8 ? kf+1 : kf-1;
          if(nf<0||nf>=nz) continue;
          kk = nf*nxy + kp;
          ds = vertD;
          w = R.slabOpen[kp] ? 0 : slabDb;
        }
        if(done[kk]) continue;
        const s2 = cs+ds;
        const mid = (cs+s2)*0.5;
        const spread = N*LOG10E*ds/(mid<1?1:mid);
        const c2 = cc+spread+w;
        if(c2-base>MAXC) continue;
        if(c2<cost[kk]){
          cost[kk]=c2; slen[kk]=s2; wacc[kk]=cw+w; prev[kk]=k;
          push(kk, c2);
        }
      }
    }
    buckets[b]=null;
  }

  /* exact recomposition + diffraction penalty */
  const rssi = new Float32Array(n).fill(-115);
  const eirp = state.tx + state.gain;
  const cap = B.wallCap;
  for(let f=0;f<nz;f++){
    const off = f*nxy;
    const dz = (f-f0)*vertD;
    for(let j=0;j<ny;j++){
      const cy = -MARGIN + (j+0.5)*cell;
      for(let i=0;i<nx;i++){
        const k=off + j*nx + i;
        if(cost[k]===Infinity) continue;
        const cx = -MARGIN + (i+0.5)*cell;
        const dx=(cx-apx)/100, dy=(cy-apy)/100;
        const dEu = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const sp = slen[k];
        const spread = N*Math.log10(sp<1?1:sp);
        const wl = wacc[k]>cap?cap:wacc[k];
        let pen = 0;
        if(dEu>0.35){
          const ratio = sp/dEu;
          pen = DIFF_K*(ratio-1);
          pen = pen<0?0:pen>DIFF_CAP?DIFF_CAP:pen;
        }
        const L = base + spread + wl + pen;
        const v = eirp - L;
        rssi[k] = v<-115?-115:v;
      }
    }
  }
  return {rssi, prev, slen};
}

let solveResult = null;

function solveAll(cell){
  const R = buildRaster(cell);
  const atten = attenField(R, state.band);
  const N = state.clutter;
  const per = state.aps.map(ap => solveAP(R, atten, ap.x, ap.y, ap.f||0, state.band, N));
  const best = new Float32Array(R.n).fill(-115);
  const owner = new Int8Array(R.n).fill(-1);
  for(let a=0;a<per.length;a++){
    const r=per[a].rssi;
    for(let k=0;k<R.n;k++) if(r[k]>best[k]){ best[k]=r[k]; owner[k]=a; }
  }
  return {R, rssi:best, owner, per};
}

/* ---- link budget helpers ---- */
function noiseFloor(){
  /* noise floor rises 3 dB per doubling of channel width */
  return BAND[state.band].nf + 10*Math.log10(state.bw/20);
}
function linkRate(rssi){
  const snr = rssi - noiseFloor();
  let best=null;
  for(const m of MCS) if(snr>=m.snr) best=m;
  if(!best) return {snr, mcs:null, phy:0, tcp:0};
  const phy = best.r * BW_SCALE[state.bw] * state.ss;
  return {snr, mcs:best.i, phy, tcp:phy*0.5};
}
const MAX_TCP = () => 108.3 * BW_SCALE[state.bw] * state.ss * 0.5;

/* ============================================================
   6. RENDER
   ============================================================ */
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
const scope = document.getElementById("scope");
let view = {s:1, ox:0, oy:0, dpr:1};
const off_ = document.createElement("canvas");
const offCtx = off_.getContext("2d");
const wallCv = document.createElement("canvas");
const wallCtx = wallCv.getContext("2d");

/* The solver always models MARGIN cm of outdoors around the plan — signal
   really does travel around the building. Side by side there is no room to
   show all of it, so the panels draw a slice and clip the rest. */
const viewMargin = () => (PLAN.nz||1) > 1 ? 60 : MARGIN;
const worldW = () => PLAN.W + 2*viewMargin();
const worldH = () => PLAN.H + 2*viewMargin();

const GAPW = 90;                       /* world cm between the two floor panels */
const panelsW = () => (PLAN.nz||1)*worldW() + ((PLAN.nz||1)-1)*GAPW;

function layout(){
  const twoUp = (PLAN.nz||1) > 1;
  /* Toggle the two-floor classes first: they widen the wrap and move the
     readout and legend into a bar above the canvas, so the measurements below
     have to be taken after the layout they cause. */
  scope.classList.toggle("two", twoUp);
  document.body.classList.toggle("two-floors", twoUp);
  const ro = document.getElementById("readout"), lg = document.getElementById("legend");
  const barH = twoUp ? Math.max(ro?ro.offsetHeight:0, lg?lg.offsetHeight:0, 60) + 22 : 0;

  const rect = scope.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  const cssW = Math.max(320, rect.width);
  const maxH = Math.max(340, (window.innerHeight||900) * (twoUp ? 0.80 : 0.76));
  const cssH = Math.max(220, Math.min(maxH-barH, Math.round(cssW * worldH()/panelsW())));
  cv.style.height = cssH+"px";
  cv.width = Math.round(cssW*dpr);
  cv.height = Math.round(cssH*dpr);
  wallCv.width = cv.width; wallCv.height = cv.height;
  view.dpr = dpr;
  const cw = cv.width, ch = cv.height;
  const vm = viewMargin();
  view.s = Math.min(cw/panelsW(), ch/worldH());
  view.ox = (cw - panelsW()*view.s)/2 + vm*view.s;
  view.oy = (ch - worldH()*view.s)/2 + vm*view.s;
  view.pan = [];
  for(let f=0;f<(PLAN.nz||1);f++) view.pan[f] = f*(worldW()+GAPW)*view.s;
}

const W2SX = x => x*view.s + view.ox;
const W2SY = y => y*view.s + view.oy;

/* screen → world, and which floor panel was hit */
function S2W(px,py){
  const r = cv.getBoundingClientRect();
  const x = (px-r.left)*(cv.width/r.width);
  const y = (py-r.top)*(cv.height/r.height);
  const nz = PLAN.nz||1;
  const pw = worldW()*view.s;
  const vm = viewMargin();
  let f = 0;
  for(let i=0;i<nz;i++){
    const left = view.pan[i] + view.ox - vm*view.s;
    if(x >= left) f = i;
    if(x >= left && x < left+pw) break;
  }
  return {x:(x - view.pan[f] - view.ox)/view.s, y:(y-view.oy)/view.s, f};
}

function draw(){
  if(!solveResult) return;
  const {R} = solveResult;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = "#0C0E10";
  ctx.fillRect(0,0,cv.width,cv.height);
  for(let f=0; f<R.nz; f++){
    drawFloor(f);
  }

  /* scale bar, once, under the first panel */
  ctx.setTransform(1,0,0,1,0,0);
  const barLen = 200*view.s;
  const bx = W2SX(0), by = W2SY(PLAN.H) + Math.min(62, viewMargin()*0.62)*view.s;
  ctx.strokeStyle="rgba(255,255,255,.55)"; ctx.lineWidth=1.4*view.dpr;
  ctx.beginPath();
  ctx.moveTo(bx,by-4*view.dpr); ctx.lineTo(bx,by+4*view.dpr);
  ctx.moveTo(bx,by); ctx.lineTo(bx+barLen,by);
  ctx.moveTo(bx+barLen,by-4*view.dpr); ctx.lineTo(bx+barLen,by+4*view.dpr);
  ctx.stroke();
  ctx.font=`500 ${10*view.dpr}px "IBM Plex Mono", monospace`;
  ctx.fillStyle="rgba(255,255,255,.6)"; ctx.textAlign="center";
  ctx.fillText("2 m", bx+barLen/2, by-9*view.dpr);
}

function drawFloor(f){
  const {R, rssi, owner} = solveResult;
  const w = cv.width, h = cv.height;
  const off = f*R.nxy;
  const panX = view.pan[f];
  const raster = (PLAN.src && PLAN.src[f]) === "raster" && PLAN.masks && PLAN.masks[f];

  ctx.setTransform(1,0,0,1,0,0);
  ctx.translate(panX, 0);
  ctx.save();
  const vm = viewMargin();
  ctx.beginPath();
  ctx.rect(W2SX(-vm), W2SY(-vm), worldW()*view.s, worldH()*view.s);
  ctx.clip();

  /* --- field --- */
  off_.width = R.nx; off_.height = R.ny;
  const img = offCtx.createImageData(R.nx, R.ny);
  const D = img.data;
  const mode = state.mode;
  const maxTcp = MAX_TCP();
  for(let k=0;k<R.nxy;k++){
    const v = rssi[off+k];
    let c;
    if(mode==="bands"){
      const g = gradeOf(v);
      const hx = g.c;
      c = [parseInt(hx.slice(1,3),16), parseInt(hx.slice(3,5),16), parseInt(hx.slice(5,7),16)];
    } else if(mode==="rate"){
      const lr = linkRate(v);
      c = sampleRamp(RATE_RAMP, lr.tcp/maxTcp);
    } else {
      c = sampleRamp(RAMP, (v+95)/62);
    }
    const o=k*4;
    D[o]=c[0]|0; D[o+1]=c[1]|0; D[o+2]=c[2]|0; D[o+3]=255;
  }
  offCtx.putImageData(img,0,0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = 0.94;
  const fx = W2SX(-MARGIN), fy = W2SY(-MARGIN);
  ctx.drawImage(off_, 0, 0, R.nx, R.ny, fx, fy, R.nx*R.cell*view.s, R.ny*R.cell*view.s);
  ctx.globalAlpha = 1;

  /* --- outside dim --- */
  if(!raster){
    ctx.save();
    ctx.beginPath();
    ctx.rect(W2SX(-vm), W2SY(-vm), worldW()*view.s, worldH()*view.s);
    for(const r of PLAN.footprint) if(FLOOR_OF(r)===f) ctx.rect(W2SX(r.x),W2SY(r.y),r.w*view.s,r.h*view.s);
    ctx.fillStyle="rgba(9,11,13,.52)";
    ctx.fill("evenodd");
    ctx.restore();
  }

  /* --- contours --- */
  if(state.contour){
    drawContour(R, rssi, off, state.target, "rgba(255,255,255,.92)", 2.0*view.dpr);
    drawContour(R, rssi, off, state.target-8, "rgba(255,255,255,.42)", 1.3*view.dpr);
  }

  /* --- grid --- */
  if(state.grid){
    ctx.strokeStyle="rgba(255,255,255,.10)"; ctx.lineWidth=1*view.dpr;
    ctx.beginPath();
    for(let x=0;x<=PLAN.W;x+=100){ ctx.moveTo(W2SX(x),W2SY(0)); ctx.lineTo(W2SX(x),W2SY(PLAN.H)); }
    for(let y=0;y<=PLAN.H;y+=100){ ctx.moveTo(W2SX(0),W2SY(y)); ctx.lineTo(W2SX(PLAN.W),W2SY(y)); }
    ctx.stroke();
  }

  /* --- walls --- */
  if(raster){
    const M = PLAN.masks[f];
    ctx.drawImage(M.overlay, W2SX(M.ox||0), W2SY(M.oy||0), M.mw*M.cmPerPx*view.s, M.mh*M.cmPerPx*view.s);
  } else {
    wallCtx.setTransform(1,0,0,1,panX,0);
    wallCtx.clearRect(-panX,0,w,h);
    wallCtx.save();
    wallCtx.beginPath();
    for(const r of PLAN.footprint) if(FLOOR_OF(r)===f) wallCtx.rect(W2SX(r.x),W2SY(r.y),r.w*view.s,r.h*view.s);
    wallCtx.clip();
    wallCtx.fillStyle="rgba(99,94,83,.94)";
    wallCtx.fillRect(-panX,0,w,h);
    wallCtx.globalCompositeOperation="destination-out";
    for(const r of PLAN.rooms) if(FLOOR_OF(r)===f) wallCtx.fillRect(W2SX(r.x),W2SY(r.y),r.w*view.s,r.h*view.s);
    for(const o of PLAN.openings) if(FLOOR_OF(o)===f && o.type!=="sealed") wallCtx.fillRect(W2SX(o.x),W2SY(o.y),o.w*view.s,o.h*view.s);
    wallCtx.globalCompositeOperation="source-over";
    wallCtx.restore();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(wallCv,0,0);
    ctx.setTransform(1,0,0,1,panX,0);

    ctx.lineWidth = 1.2*view.dpr;
    ctx.strokeStyle = "rgba(20,22,24,.85)";
    for(const r of PLAN.footprint) if(FLOOR_OF(r)===f) ctx.strokeRect(W2SX(r.x),W2SY(r.y),r.w*view.s,r.h*view.s);
    ctx.strokeStyle = "rgba(255,255,255,.16)";
    for(const r of PLAN.rooms) if(FLOOR_OF(r)===f) ctx.strokeRect(W2SX(r.x),W2SY(r.y),r.w*view.s,r.h*view.s);
  }

  /* --- openings --- */
  for(const o of PLAN.openings){
    if(FLOOR_OF(o)!==f) continue;
    const sealed = o.type==="sealed";
    ctx.strokeStyle = sealed ? "rgba(180,90,70,.8)" : "rgba(120,230,210,.85)";
    ctx.lineWidth = 2.2*view.dpr;
    ctx.beginPath();
    if(o.axis==="v"){
      const cx=W2SX(o.x+o.w/2);
      ctx.moveTo(cx, W2SY(o.y)); ctx.lineTo(cx, W2SY(o.y+o.h));
    } else {
      const cy=W2SY(o.y+o.h/2);
      ctx.moveTo(W2SX(o.x), cy); ctx.lineTo(W2SX(o.x+o.w), cy);
    }
    ctx.stroke();
  }

  /* --- stairwells: the hole between the floors, so it shows on both --- */
  if((PLAN.nz||1) > 1 || (PLAN.stairs||[]).length){
    (PLAN.stairs||[]).forEach((st,i)=>{
      const x=W2SX(st.x), y=W2SY(st.y), sw=st.w*view.s, sh=st.h*view.s;
      ctx.save();
      ctx.fillStyle = "rgba(255,158,69,.14)";
      ctx.fillRect(x,y,sw,sh);
      ctx.setLineDash([6*view.dpr, 4*view.dpr]);
      ctx.strokeStyle = i===state.selStair ? "rgba(255,190,120,.98)" : "rgba(255,158,69,.75)";
      ctx.lineWidth = (i===state.selStair?2.4:1.8)*view.dpr;
      ctx.strokeRect(x,y,sw,sh);
      ctx.setLineDash([]);
      /* treads, so it reads as stairs rather than as another room */
      ctx.strokeStyle="rgba(255,158,69,.4)";
      ctx.lineWidth=1*view.dpr;
      ctx.beginPath();
      const along = sw>sh;
      const steps = Math.max(2, Math.round((along?st.w:st.h)/28));
      for(let t=1;t<steps;t++){
        const u=t/steps;
        if(along){ ctx.moveTo(x+sw*u, y); ctx.lineTo(x+sw*u, y+sh); }
        else { ctx.moveTo(x, y+sh*u); ctx.lineTo(x+sw, y+sh*u); }
      }
      ctx.stroke();
      ctx.font=`600 ${9.5*view.dpr}px "IBM Plex Mono", monospace`;
      ctx.fillStyle="rgba(255,190,140,.95)";
      ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText("STAIRS", x+5*view.dpr, y+4*view.dpr);
      ctx.restore();
    });
  }
  if(stairDraw && stairDraw.f===f){
    const x=W2SX(Math.min(stairDraw.x0,stairDraw.x1)), y=W2SY(Math.min(stairDraw.y0,stairDraw.y1));
    const sw=Math.abs(stairDraw.x1-stairDraw.x0)*view.s, sh=Math.abs(stairDraw.y1-stairDraw.y0)*view.s;
    ctx.save();
    ctx.setLineDash([5*view.dpr,4*view.dpr]);
    ctx.strokeStyle="rgba(255,190,120,.95)"; ctx.lineWidth=2*view.dpr;
    ctx.strokeRect(x,y,sw,sh);
    ctx.restore();
  }

  /* --- room labels --- */
  ctx.textAlign="center"; ctx.textBaseline="middle";
  for(const r of PLAN.rooms){
    if(FLOOR_OF(r)!==f) continue;
    const cx=W2SX(r.lx!==undefined ? r.lx : r.x+r.w/2);
    const cy=W2SY(r.ly!==undefined ? r.ly : r.y + Math.min(r.h/2, 46));
    const st = roomStats.get(r.id);
    const l1 = r.name;
    const l2 = r.area.toFixed(2)+" m²" + (st?"   "+st.median.toFixed(0)+" dBm":"");
    const f1 = 11.5*view.dpr, f2 = 10*view.dpr;
    ctx.font = `600 ${f1}px "Archivo", sans-serif`;
    const w1 = ctx.measureText(l1).width;
    ctx.font = `500 ${f2}px "IBM Plex Mono", monospace`;
    const w2 = ctx.measureText(l2).width;
    const pw = Math.max(w1,w2) + 18*view.dpr, ph = 34*view.dpr;
    const rad = 6*view.dpr;
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(cx-pw/2, cy-ph/2, pw, ph, rad);
    else ctx.rect(cx-pw/2, cy-ph/2, pw, ph);
    ctx.fillStyle="rgba(12,14,16,.62)"; ctx.fill();
    ctx.strokeStyle="rgba(255,255,255,.12)"; ctx.lineWidth=1*view.dpr; ctx.stroke();
    ctx.font = `600 ${f1}px "Archivo", sans-serif`;
    ctx.fillStyle="rgba(255,255,255,.96)";
    ctx.fillText(l1, cx, cy - 7*view.dpr);
    ctx.font = `500 ${f2}px "IBM Plex Mono", monospace`;
    ctx.fillStyle="rgba(255,255,255,.72)";
    ctx.fillText(l2, cx, cy + 8*view.dpr);
  }

  /* --- hover path (only the leg that lies on this floor) --- */
  if(state.path && hover.on && hover.cell>=0 && hover.cell<R.n){
    const a = owner[hover.cell];
    if(a>=0){
      const prev = solveResult.per[a].prev;
      ctx.strokeStyle="rgba(255,255,255,.9)";
      ctx.lineWidth=1.8*view.dpr;
      ctx.setLineDash([5*view.dpr, 4*view.dpr]);
      const px = i => W2SX(-MARGIN + ((i%R.nx)+0.5)*R.cell);
      const py = i => W2SY(-MARGIN + ((((i%R.nxy)/R.nx)|0)+0.5)*R.cell);
      const fl = i => (i/R.nxy)|0;
      let k=hover.cell, guard=0;
      ctx.beginPath();
      let penDown=false;
      while(k>=0 && guard++<20000){
        const p=prev[k];
        if(p<0) break;
        if(fl(k)===f && fl(p)===f){
          if(!penDown){ ctx.moveTo(px(k),py(k)); penDown=true; }
          ctx.lineTo(px(p),py(p));
        } else {
          penDown=false;
          if(fl(k)===f || fl(p)===f){
            /* the storey change itself: mark it where it happens */
            const m = fl(k)===f ? k : p;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(px(m),py(m),5*view.dpr,0,7);
            ctx.stroke();
            ctx.beginPath();
          }
        }
        k=p;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* --- APs on this floor --- */
  state.aps.forEach((ap,i)=>{
    if((ap.f||0)!==f) return;
    const x=W2SX(ap.x), y=W2SY(ap.y);
    const col = AP_COLORS[i%AP_COLORS.length];
    const sel = i===state.selAp;
    ctx.beginPath(); ctx.arc(x,y,(sel?17:13)*view.dpr,0,7);
    ctx.fillStyle = col+"22"; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,(sel?9:7)*view.dpr,0,7);
    ctx.fillStyle=col; ctx.fill();
    ctx.lineWidth=2.2*view.dpr; ctx.strokeStyle="rgba(10,12,14,.9)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x,y,(sel?3:2.5)*view.dpr,0,7);
    ctx.fillStyle="rgba(10,12,14,.95)"; ctx.fill();
    if(state.aps.length>1){
      ctx.font=`600 ${10*view.dpr}px "IBM Plex Mono", monospace`;
      ctx.fillStyle=col; ctx.textAlign="center";
      ctx.shadowColor="rgba(0,0,0,.9)"; ctx.shadowBlur=4*view.dpr;
      ctx.fillText("AP"+(i+1), x, y-20*view.dpr);
      ctx.shadowBlur=0;
    }
  });

  /* --- floor badge --- */
  if(R.nz>1){
    const name = (PLAN.floorNames&&PLAN.floorNames[f]) || ("Floor "+(f+1));
    ctx.font=`600 ${11*view.dpr}px "IBM Plex Mono", monospace`;
    ctx.textAlign="left"; ctx.textBaseline="alphabetic";
    const tw = ctx.measureText(name.toUpperCase()).width;
    const bx2=W2SX(0), by2=W2SY(0)-16*view.dpr;
    ctx.fillStyle="rgba(12,14,16,.72)";
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(bx2-7*view.dpr, by2-14*view.dpr, tw+14*view.dpr, 20*view.dpr, 5*view.dpr);
    else ctx.rect(bx2-7*view.dpr, by2-14*view.dpr, tw+14*view.dpr, 20*view.dpr);
    ctx.fill();
    ctx.fillStyle="rgba(255,255,255,.82)";
    ctx.fillText(name.toUpperCase(), bx2, by2);
  }
  ctx.restore();
  ctx.setTransform(1,0,0,1,0,0);
}

/* marching squares, over one floor's slice */
function drawContour(R, g, off, level, color, lw){
  const {nx,ny,cell}=R;
  ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.beginPath();
  const gx = i => W2SX(-MARGIN + (i+0.5)*cell);
  const gy = j => W2SY(-MARGIN + (j+0.5)*cell);
  const lerp=(a,b)=> (level-a)/((b-a)||1e-6);
  for(let j=0;j<ny-1;j++){
    for(let i=0;i<nx-1;i++){
      const a=g[off+j*nx+i], b=g[off+j*nx+i+1], c=g[off+(j+1)*nx+i+1], d=g[off+(j+1)*nx+i];
      /* skip cells the search never reached — their edge is an artefact, not a contour */
      if(a<-110||b<-110||c<-110||d<-110) continue;
      let idx=0;
      if(a>level)idx|=8; if(b>level)idx|=4; if(c>level)idx|=2; if(d>level)idx|=1;
      if(idx===0||idx===15) continue;
      const T=()=>[gx(i+lerp(a,b)), gy(j)];
      const Rt=()=>[gx(i+1), gy(j+lerp(b,c))];
      const Bt=()=>[gx(i+lerp(d,c)), gy(j+1)];
      const L=()=>[gx(i), gy(j+lerp(a,d))];
      const seg=(p,q)=>{ ctx.moveTo(p[0],p[1]); ctx.lineTo(q[0],q[1]); };
      switch(idx){
        case 1: case 14: seg(L(),Bt()); break;
        case 2: case 13: seg(Bt(),Rt()); break;
        case 3: case 12: seg(L(),Rt()); break;
        case 4: case 11: seg(T(),Rt()); break;
        case 6: case 9:  seg(T(),Bt()); break;
        case 7: case 8:  seg(T(),L()); break;
        case 5:  seg(T(),L()); seg(Bt(),Rt()); break;
        case 10: seg(T(),Rt()); seg(L(),Bt()); break;
      }
    }
  }
  ctx.stroke();
}

/* ============================================================
   7. STATS
   ============================================================ */
let roomStats = new Map();
let overallCov = 0;
function computeStats(){
  const {R, rssi} = solveResult;
  roomStats = new Map();
  const buckets = PLAN.rooms.map(()=>[]);
  for(let k=0;k<R.n;k++){
    const ri=R.roomIdx[k];
    if(ri>=0) buckets[ri].push(rssi[k]);
  }
  PLAN.rooms.forEach((r,i)=>{
    const v = buckets[i];
    if(!v.length){ roomStats.set(r.id,{median:-115,min:-115,cov:0}); return; }
    v.sort((a,b)=>a-b);
    const median = v[(v.length/2)|0];
    const p5 = v[Math.floor(v.length*0.05)];
    const cov = v.filter(x=>x>=state.target).length / v.length;
    roomStats.set(r.id,{median,min:p5,cov});
  });
  let a=0,c=0;
  PLAN.rooms.forEach(r=>{ a+=r.area; c+=r.area*roomStats.get(r.id).cov; });
  overallCov = a? c/a : 0;
}

function renderTable(){
  const tb=document.getElementById("tbody");
  const tf=document.getElementById("tfoot");
  tb.innerHTML="";
  let totA=0, totCov=0, worst=null;
  PLAN.rooms.forEach((r,i)=>{
    const st=roomStats.get(r.id);
    const g=gradeOf(st.median);
    const lr=linkRate(st.median);
    totA+=r.area; totCov+=r.area*st.cov;
    if(!worst || st.median<worst.v) worst={v:st.median,name:r.name};
    const tr=document.createElement("tr");
    const covPct=(st.cov*100);
    const covCol = covPct>=95?"#2E9E6B":covPct>=70?"#C98A1B":"#C0503A";
    tr.innerHTML=`
      <td><div class="rn">${(PLAN.nz||1)>1?`<span class="fl" title="${floorName(FLOOR_OF(r))}">${floorName(FLOOR_OF(r)).slice(0,1).toUpperCase()}</span>`:""}<input class="roomname" data-i="${i}" value="${r.name.replace(/"/g,"&quot;")}" aria-label="Room name"></div></td>
      <td class="num">${r.area.toFixed(2)} m²</td>
      <td class="num"><span class="pill" style="border-color:${g.c}55;background:${g.c}22;color:var(--ink)">${st.median.toFixed(0)} dBm</span></td>
      <td class="num">${st.min.toFixed(0)} dBm</td>
      <td class="num" style="color:${covCol};font-weight:600">${covPct.toFixed(0)}%</td>
      <td><div class="bar"><i style="width:${covPct.toFixed(0)}%;background:${covCol}"></i></div></td>
      <td class="num">${lr.mcs===null?"—":Math.round(lr.tcp)+" Mb/s"}</td>`;
    tb.appendChild(tr);
  });
  const overall = totA? totCov/totA*100 : 0;
  tf.innerHTML=`<tr>
    <td style="font-weight:700;padding-left:19px">Whole floor</td>
    <td class="num" style="font-weight:600">${totA.toFixed(2)} m²</td>
    <td colspan="2" class="num" style="color:var(--ink-3)">weakest room: ${worst?worst.name:"—"}</td>
    <td class="num" style="font-weight:700">${overall.toFixed(0)}%</td>
    <td colspan="2" style="color:var(--ink-3);font-size:12px">above ${state.target} dBm</td>
  </tr>`;
  tb.querySelectorAll(".roomname").forEach(inp=>{
    inp.addEventListener("input",e=>{
      PLAN.rooms[+e.target.dataset.i].name = e.target.value || "Room";
      draw();
    });
  });
}

/* ============================================================
   8. UI WIRING
   ============================================================ */
function fillSelect(el, list, val){
  el.innerHTML = list.map(m=>`<option value="${m.id}"${m.id===val?" selected":""}>${m.name}</option>`).join("");
}
const bandKey = () => state.band==="2.4" ? "d24" : "d5";

function syncMatLabels(){
  const bk=bandKey();
  const e=WALL_MATERIALS.find(m=>m.id===state.extMat), i=WALL_MATERIALS.find(m=>m.id===state.intMat);
  document.getElementById("vExt").textContent = e[bk]+" dB / wall";
  document.getElementById("vInt").textContent = i[bk]+" dB / wall";
}

function renderApList(){
  const el=document.getElementById("apList");
  el.innerHTML="";
  state.aps.forEach((ap,i)=>{
    const d=document.createElement("div");
    d.className="aprow"+(i===state.selAp?" sel":"");
    d.innerHTML=`<span class="apdot" style="background:${AP_COLORS[i%3]}"></span>
      <span class="nm">${state.aps.length>1?"AP "+(i+1):"Router"}</span>
      <span class="co">${(ap.x/100).toFixed(2)}, ${(ap.y/100).toFixed(2)} m${(PLAN.nz||1)>1?" · "+floorName(ap.f||0):""}</span>
      ${state.aps.length>1?'<button class="x" title="Remove">×</button>':""}`;
    d.addEventListener("click",e=>{
      if(e.target.classList.contains("x")){
        state.aps.splice(i,1);
        state.selAp=Math.min(state.selAp,state.aps.length-1);
      } else state.selAp=i;
      renderApList(); recompute();
    });
    el.appendChild(d);
  });
  document.getElementById("apCount").textContent=state.aps.length;
  document.getElementById("addAp").disabled = state.aps.length>=3;
}

function renderOpList(){
  const el=document.getElementById("opList");
  el.innerHTML="";
  PLAN.openings.forEach((o,i)=>{
    const row=document.createElement("div");
    row.className="oprow";
    row.innerHTML=`<span class="lbl">${o.label}</span>
      <select data-i="${i}">${OPENING_TYPES.map(t=>`<option value="${t.id}"${t.id===o.type?" selected":""}>${t.name}</option>`).join("")}</select>`;
    row.querySelector("select").addEventListener("change",e=>{
      PLAN.openings[+e.target.dataset.i].type=e.target.value;
      geomVersion++; recompute();
    });
    el.appendChild(row);
  });
}

const floorName = f => (PLAN.floorNames && PLAN.floorNames[f]) || ("Floor "+(f+1));

/* ============================================================
   9. FLOORS & STAIRWELLS
   ============================================================ */
function setStairMode(on){
  state.stairMode = !!on;
  const b = document.getElementById("addStair");
  if(b){
    b.textContent = on ? "Cancel" : "Draw";
    b.classList.toggle("primary", !!on);
  }
  scope.classList.toggle("drawing", !!on);
}

function renderStairList(){
  const el = document.getElementById("stairList");
  if(!el) return;
  const st = PLAN.stairs || [];
  el.innerHTML = "";
  if(!st.length){
    el.innerHTML = `<p class="hint" style="margin:0">None yet — without one, every path between floors pays the full slab.</p>`;
    return;
  }
  st.forEach((r,i)=>{
    const row=document.createElement("div");
    row.className="oprow"+(i===state.selStair?" sel":"");
    row.innerHTML=`<span class="lbl">Stairwell ${i+1}</span>
      <span class="co mono">${Math.round(r.w)} × ${Math.round(r.h)} cm</span>
      <button class="x" title="Remove">×</button>`;
    row.addEventListener("click",e=>{
      if(e.target.classList.contains("x")){
        PLAN.stairs.splice(i,1);
        state.selStair=-1;
        geomVersion++;
        renderStairList();
        recompute();
      } else {
        state.selStair=i;
        renderStairList();
        draw();
      }
    });
    el.appendChild(row);
  });
}

function syncFloorUI(){
  const nz = PLAN.nz || 1;
  document.getElementById("floorCount").textContent = nz;
  document.getElementById("addFloor").hidden = nz > 1;
  document.getElementById("delFloor").hidden = nz < 2;
  document.getElementById("floorOnly").hidden = nz < 2;
  const m = SLAB_MATERIALS.find(m=>m.id===PLAN.slab) || SLAB_MATERIALS[1];
  const bk = state.band==="2.4" ? "d24" : "d5";
  const vs = document.getElementById("vSlab");
  if(vs) vs.textContent = m[bk]+" dB / floor";
  const vh = document.getElementById("vFloorH");
  if(vh) vh.textContent = (PLAN.floorH||280)+" cm";
  renderStairList();
}

/* Duplicate the ground floor as a starting point for the one above. An
   imported mask stores flat room indices, so those have to be remapped
   onto the copies rather than left pointing at the floor below. */
function addUpperFloor(){
  if((PLAN.nz||1) > 1) return;
  const roomBase = PLAN.rooms.length, opBase = PLAN.openings.length;
  const roomMap = new Map(), opMap = new Map();
  const newRooms = [], newOps = [];
  PLAN.rooms.forEach((r,i)=>{
    if(FLOOR_OF(r)!==0) return;
    roomMap.set(i, roomBase + newRooms.length);
    newRooms.push(Object.assign({}, r, {floor:1, id:r.id+"'"}));
  });
  PLAN.openings.forEach((o,i)=>{
    if(FLOOR_OF(o)!==0) return;
    opMap.set(i, opBase + newOps.length);
    newOps.push(Object.assign({}, o, {floor:1, id:o.id+"'"}));
  });
  const newFoot = PLAN.footprint.filter(r=>FLOOR_OF(r)===0).map(r=>Object.assign({},r,{floor:1}));
  PLAN.rooms = PLAN.rooms.concat(newRooms);
  PLAN.openings = PLAN.openings.concat(newOps);
  PLAN.footprint = PLAN.footprint.concat(newFoot);

  PLAN.src = [PLAN.src ? PLAN.src[0] : "vector", PLAN.src ? PLAN.src[0] : "vector"];
  if(PLAN.masks && PLAN.masks[0]){
    const M = PLAN.masks[0];
    const room = new Int16Array(M.roomIdx.length);
    const op = new Int16Array(M.opIdx.length);
    for(let i=0;i<room.length;i++){
      const r = M.roomIdx[i];
      room[i] = r>=0 && roomMap.has(r) ? roomMap.get(r) : -1;
      const o = M.opIdx[i];
      op[i] = o>=0 && opMap.has(o) ? opMap.get(o) : -1;
    }
    PLAN.masks = [M, {mw:M.mw, mh:M.mh, cmPerPx:M.cmPerPx, ox:M.ox||0, oy:M.oy||0,
                      kind:M.kind, roomIdx:room, opIdx:op, overlay:M.overlay}];
  } else {
    PLAN.masks = [null, null];
  }
  PLAN.nz = 2;
  if(!PLAN.stairs) PLAN.stairs = [];
  geomVersion++;
  rasterCache.clear();
  syncFloorUI(); updatePlanMeta(); renderOpList(); renderApList();
  layout(); recompute();
}

function removeUpperFloor(){
  if((PLAN.nz||1) < 2) return;
  const keepRoom = [], remap = new Map();
  PLAN.rooms.forEach((r,i)=>{
    if(FLOOR_OF(r)===0){ remap.set(i, keepRoom.length); keepRoom.push(r); }
  });
  const keepOp = [], oremap = new Map();
  PLAN.openings.forEach((o,i)=>{
    if(FLOOR_OF(o)===0){ oremap.set(i, keepOp.length); keepOp.push(o); }
  });
  PLAN.rooms = keepRoom;
  PLAN.openings = keepOp;
  PLAN.footprint = PLAN.footprint.filter(r=>FLOOR_OF(r)===0);
  if(PLAN.masks && PLAN.masks[0]){
    const M = PLAN.masks[0];
    for(let i=0;i<M.roomIdx.length;i++){
      const r=M.roomIdx[i]; M.roomIdx[i] = r>=0 && remap.has(r) ? remap.get(r) : -1;
      const o=M.opIdx[i];  M.opIdx[i]  = o>=0 && oremap.has(o) ? oremap.get(o) : -1;
    }
  }
  PLAN.masks = [PLAN.masks ? PLAN.masks[0] : null, null];
  PLAN.src = [PLAN.src ? PLAN.src[0] : "vector", "vector"];
  PLAN.nz = 1;
  state.aps.forEach(ap=>{ ap.f = 0; });
  geomVersion++;
  rasterCache.clear();
  syncFloorUI(); updatePlanMeta(); renderOpList(); renderApList();
  layout(); recompute();
}

function renderLegend(){
  const el=document.getElementById("legend");
  if(state.mode==="bands"){
    el.innerHTML=`<div class="ttl">Signal grade</div><div class="bands">`+
      GRADES.map((g,i)=>{
        const lo=g.min, hi=i===0?-30:GRADES[i-1].min;
        const rng = i===GRADES.length-1 ? "below −85" : `${lo} … ${hi}`;
        return `<div class="bandrow"><span class="bandsw" style="background:${g.c}"></span><span>${g.name}</span><span style="color:var(--scope-ink-2);margin-left:auto;padding-left:10px">${rng}</span></div>`;
      }).join("")+`</div>`;
  } else if(state.mode==="rate"){
    el.innerHTML=`<div class="ttl">Estimated TCP throughput</div>
      <div class="ramp" style="background:${rampCSS(RATE_RAMP)}"></div>
      <div class="rampx"><span>0</span><span>${Math.round(MAX_TCP()/2)}</span><span>${Math.round(MAX_TCP())} Mb/s</span></div>`;
  } else {
    el.innerHTML=`<div class="ttl">Received signal · ${BAND[state.band].label}</div>
      <div class="ramp" style="background:${rampCSS(RAMP)}"></div>
      <div class="rampx"><span>−95</span><span>−80</span><span>−65</span><span>−50</span><span>−33 dBm</span></div>`;
  }
}

/* ---- recompute pipeline ---- */
let pending=false;
function recompute(quick){
  if(pending) return;
  pending=true;
  requestAnimationFrame(()=>{
    pending=false;
    const t0=performance.now();
    solveResult = solveAll(quick?12:6);
    computeStats();
    const dt=performance.now()-t0;
    document.getElementById("solveInfo").textContent =
      `${solveResult.R.nx}×${solveResult.R.ny} cells · ${solveResult.R.cell} cm · solved in ${dt.toFixed(0)} ms`;
    draw();
    renderTable();
    renderApList();
    if(!hover.on) updateReadout(null);
  });
}

/* ---- pointer interaction ---- */
const hover={on:false, cell:-1, x:0, y:0, f:0};
let drag=null;
let stairDraw=null;                 /* the rectangle being dragged out right now */

function pickHandle(wx,wy,f){
  const tol = 26;
  for(let i=state.aps.length-1;i>=0;i--){
    const ap=state.aps[i];
    if((ap.f||0)!==f) continue;
    if(Math.hypot(ap.x-wx, ap.y-wy) < tol*1.6) return {kind:"ap", i};
  }
  const st = PLAN.stairs||[];
  for(let i=st.length-1;i>=0;i--){
    const r=st[i];
    if(wx>=r.x && wx<r.x+r.w && wy>=r.y && wy<r.y+r.h) return {kind:"stair", i};
  }
  if((PLAN.src && PLAN.src[f]) !== "raster"){
    for(let i=0;i<PLAN.openings.length;i++){
      const o=PLAN.openings[i];
      if(FLOOR_OF(o)!==f) continue;
      const cx=o.x+o.w/2, cy=o.y+o.h/2;
      if(Math.abs(cx-wx)<Math.max(o.w,tol)/2 && Math.abs(cy-wy)<Math.max(o.h,tol)/2) return {kind:"op", i};
    }
  }
  return null;
}

cv.addEventListener("pointerdown",e=>{
  const p=S2W(e.clientX,e.clientY);
  cv.setPointerCapture(e.pointerId);

  if(state.stairMode){
    stairDraw={f:p.f, x0:p.x, y0:p.y, x1:p.x, y1:p.y};
    drag={kind:"stairnew"};
    scope.classList.add("dragging");
    draw();
    return;
  }

  const hit=pickHandle(p.x,p.y,p.f);
  if(hit && hit.kind==="ap"){
    state.selAp=hit.i;
    drag={kind:"ap", i:hit.i, dx:state.aps[hit.i].x-p.x, dy:state.aps[hit.i].y-p.y};
  } else if(hit && hit.kind==="stair"){
    state.selStair=hit.i;
    const r=PLAN.stairs[hit.i];
    drag={kind:"stair", i:hit.i, dx:r.x-p.x, dy:r.y-p.y};
    renderStairList();
  } else if(hit && hit.kind==="op"){
    const o=PLAN.openings[hit.i];
    drag={kind:"op", i:hit.i, dx:o.x-p.x, dy:o.y-p.y};
  } else {
    const ap=state.aps[state.selAp];
    ap.x=p.x; ap.y=p.y; ap.f=p.f;
    drag={kind:"ap", i:state.selAp, dx:0, dy:0};
  }
  scope.classList.add("dragging");
  renderApList();
  recompute(true);
});

cv.addEventListener("pointermove",e=>{
  const p=S2W(e.clientX,e.clientY);
  if(drag){
    if(drag.kind==="stairnew"){
      stairDraw.x1=p.x; stairDraw.y1=p.y;
      draw();
      return;
    }
    if(drag.kind==="ap"){
      const ap=state.aps[drag.i];
      const vm=viewMargin();
      ap.x=Math.max(-vm, Math.min(PLAN.W+vm, p.x+drag.dx));
      ap.y=Math.max(-vm, Math.min(PLAN.H+vm, p.y+drag.dy));
      ap.f=p.f;                       /* drag it onto the other panel to move storey */
      recompute(true);
    } else if(drag.kind==="stair"){
      const r=PLAN.stairs[drag.i];
      r.x=Math.round(p.x+drag.dx);
      r.y=Math.round(p.y+drag.dy);
      geomVersion++;
      recompute(true);
    } else {
      const o=PLAN.openings[drag.i];
      const lo=o.lim?o.lim[0]:-1e6, hi=o.lim?o.lim[1]:1e6;
      const v = Math.round(Math.max(lo, Math.min(hi, (o.axis==="v"? p.y+drag.dy : p.x+drag.dx))));
      if(o.axis==="v") o.y=v; else o.x=v;
      geomVersion++;
      recompute(true);
    }
    return;
  }
  updateHover(p);
});

function endDrag(){
  if(!drag) return;
  if(drag.kind==="stairnew" && stairDraw){
    const x=Math.round(Math.min(stairDraw.x0,stairDraw.x1)), y=Math.round(Math.min(stairDraw.y0,stairDraw.y1));
    const w=Math.round(Math.abs(stairDraw.x1-stairDraw.x0)), h=Math.round(Math.abs(stairDraw.y1-stairDraw.y0));
    stairDraw=null;
    if(w>=25 && h>=25){
      PLAN.stairs.push({x,y,w,h});
      state.selStair=PLAN.stairs.length-1;
      geomVersion++;
      renderStairList();
    }
    setStairMode(false);
  }
  drag=null;
  scope.classList.remove("dragging");
  recompute(false);
}
cv.addEventListener("pointerup",endDrag);
cv.addEventListener("pointercancel",endDrag);
cv.addEventListener("pointerleave",()=>{ hover.on=false; updateReadout(null); draw(); });

function updateHover(p){
  if(!solveResult) return;
  const R=solveResult.R;
  const i=Math.floor((p.x+MARGIN)/R.cell), j=Math.floor((p.y+MARGIN)/R.cell);
  if(i<0||j<0||i>=R.nx||j>=R.ny||p.f>=R.nz){ hover.on=false; updateReadout(null); return; }
  hover.on=true; hover.f=p.f; hover.cell=p.f*R.nxy + j*R.nx + i; hover.x=p.x; hover.y=p.y;
  updateReadout(solveResult.rssi[hover.cell]);
  draw();
}

function updateReadout(v){
  const val=document.getElementById("roVal");
  const gr=document.getElementById("roGrade");
  const rest=document.getElementById("roRest");
  if(v===null||v===undefined){
    val.textContent=(overallCov*100).toFixed(0)+"%";
    gr.textContent="of floor above "+state.target+" dBm";
    gr.style.color="var(--scope-ink-2)";
    rest.innerHTML=`<span class="rk">Band</span> ${BAND[state.band].label} &nbsp; <span class="rk">EIRP</span> ${(state.tx+state.gain).toFixed(0)} dBm<br>`+
      `<span class="rk">Routers</span> ${state.aps.length}${(PLAN.nz||1)>1?" on "+floorName(state.aps[state.selAp].f||0):""}<br>`+
      `<span class="rk" style="color:var(--scope-ink-2)">tap or hover for a point reading</span>`;
    return;
  }
  const g=gradeOf(v), lr=linkRate(v);
  val.textContent=v.toFixed(1)+" dBm";
  gr.textContent=g.name; gr.style.color=g.c;
  const R=solveResult.R;
  const a=solveResult.owner[hover.cell];
  const sl=a>=0?solveResult.per[a].slen[hover.cell]:0;
  const ap=a>=0?state.aps[a]:null;
  const dzc = ap ? ((hover.f-(ap.f||0))*(PLAN.floorH||280)) : 0;
  const dEu=ap?Math.sqrt((ap.x-hover.x)**2+(ap.y-hover.y)**2+dzc*dzc)/100:0;
  const crossed = (PLAN.nz||1)>1 && ap && (ap.f||0)!==hover.f;
  rest.innerHTML=
    ((PLAN.nz||1)>1 ? `<span class="rk">Floor</span> ${floorName(hover.f)}${crossed?" — via the slab or the stairs":""}<br>` : "")+
    `<span class="rk">SNR</span> ${(lr.snr).toFixed(0)} dB &nbsp; <span class="rk">MCS</span> ${lr.mcs===null?"—":lr.mcs}<br>`+
    `<span class="rk">Speed</span> ${lr.mcs===null?"no link":Math.round(lr.tcp)+" Mb/s"}<br>`+
    `<span class="rk">Path</span> ${sl.toFixed(1)} m ${dEu>0.4?`(${(sl/dEu).toFixed(2)}× direct)`:""}`;
}

/* ---- controls ---- */
document.getElementById("bandSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  state.band=b.dataset.band;
  [...e.currentTarget.children].forEach(c=>c.setAttribute("aria-pressed", String(c===b)));
  const d=state.band==="2.4"?{tx:20,g:3}:{tx:23,g:4};
  state.tx=d.tx; state.gain=d.g;
  document.getElementById("tx").value=d.tx; document.getElementById("gain").value=d.g;
  document.getElementById("vTx").textContent=d.tx+" dBm";
  document.getElementById("vGain").textContent=d.g+" dBi";
  syncMatLabels(); syncFloorUI(); renderLegend(); recompute();
});
document.getElementById("modeSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b) return;
  state.mode=b.dataset.mode;
  [...e.currentTarget.children].forEach(c=>c.setAttribute("aria-pressed", String(c===b)));
  renderLegend(); draw();
});
const bindRange=(id,key,fmt,after)=>{
  const el=document.getElementById(id);
  el.addEventListener("input",()=>{
    state[key]=parseFloat(el.value);
    document.getElementById("v"+id[0].toUpperCase()+id.slice(1)).textContent=fmt(state[key]);
    (after||recompute)();
  });
};
bindRange("tx","tx",v=>v+" dBm");
bindRange("gain","gain",v=>v+" dBi");
bindRange("clutter","clutter",v=>"N = "+v);
bindRange("target","target",v=>"−"+Math.abs(v)+" dBm",()=>{ computeStats(); renderTable(); draw(); });

document.getElementById("bw").addEventListener("change",e=>{state.bw=+e.target.value; renderLegend(); computeStats(); renderTable(); draw();});
document.getElementById("ss").addEventListener("change",e=>{state.ss=+e.target.value; renderLegend(); renderTable(); draw();});
document.getElementById("extMat").addEventListener("change",e=>{state.extMat=e.target.value; syncMatLabels(); recompute();});
document.getElementById("intMat").addEventListener("change",e=>{state.intMat=e.target.value; syncMatLabels(); recompute();});
document.getElementById("showContour").addEventListener("change",e=>{state.contour=e.target.checked; draw();});
document.getElementById("showPath").addEventListener("change",e=>{state.path=e.target.checked; draw();});
document.getElementById("showGrid").addEventListener("change",e=>{state.grid=e.target.checked; draw();});

document.getElementById("addFloor").addEventListener("click",addUpperFloor);
document.getElementById("delFloor").addEventListener("click",removeUpperFloor);
document.getElementById("addStair").addEventListener("click",()=>setStairMode(!state.stairMode));
document.getElementById("floorH").addEventListener("input",e=>{
  PLAN.floorH=+e.target.value;
  document.getElementById("vFloorH").textContent=PLAN.floorH+" cm";
  geomVersion++; recompute();
});
document.getElementById("slabMat").addEventListener("change",e=>{
  PLAN.slab=e.target.value; syncFloorUI(); geomVersion++; recompute();
});
window.addEventListener("keydown",e=>{
  if(e.key==="Escape" && state.stairMode) setStairMode(false);
});

document.getElementById("addAp").addEventListener("click",()=>{
  if(state.aps.length>=3) return;
  /* seat a new node inside the plan at hand, not at the sample plan's coordinates */
  const f = state.aps.length ? (state.aps[state.selAp].f||0) : 0;
  const onF = PLAN.rooms.filter(r=>FLOOR_OF(r)===f);
  const seat = onF[onF.length>1 ? 1 : 0] || PLAN.rooms[0];
  const sx = seat && seat.lx!==undefined ? seat.lx : (seat ? seat.x+seat.w/2 : PLAN.W/2);
  const sy = seat && seat.ly!==undefined ? seat.ly : (seat ? seat.y+seat.h/2 : PLAN.H/2);
  state.aps.push({x:sx, y:sy, f, id:state.aps.length});
  state.selAp=state.aps.length-1;
  renderApList(); recompute();
});
document.getElementById("resetBtn").addEventListener("click",()=>{
  PLAN=structuredClone(BASE_PLAN);
  state.aps=[{x:1014,y:243,f:0,id:0}]; state.selAp=0; state.selStair=-1;
  setStairMode(false);
  geomVersion++; rasterCache.clear();
  syncFloorUI(); updatePlanMeta(); renderOpList(); renderApList(); layout(); recompute();
});
document.getElementById("exportBtn").addEventListener("click",e=>{
  /* the mask is megabytes of typed array — export what describes the plan */
  const plan = {
    W:PLAN.W, H:PLAN.H, wallT:PLAN.wallT, nz:PLAN.nz, floorH:PLAN.floorH, slab:PLAN.slab,
    src:PLAN.src, stairs:PLAN.stairs, footprint:PLAN.footprint,
    rooms:PLAN.rooms, openings:PLAN.openings,
    masks:(PLAN.masks||[]).map(m=>m?{mw:m.mw, mh:m.mh, cmPerPx:m.cmPerPx, ox:m.ox, oy:m.oy}:null)
  };
  const txt=JSON.stringify({plan, aps:state.aps},null,2);
  navigator.clipboard?.writeText(txt).then(
    ()=>{ e.target.textContent="Copied to clipboard"; setTimeout(()=>e.target.textContent="Export geometry",1600); },
    ()=>{ e.target.textContent="Copy blocked"; setTimeout(()=>e.target.textContent="Export geometry",1600); }
  );
});

/* ---- best-spot search ---- */
document.getElementById("bestBtn").addEventListener("click",()=>{
  const btn=document.getElementById("bestBtn");
  const hint=document.getElementById("bestHint");
  btn.disabled=true; btn.textContent="Searching…";
  const cell=18;
  const gen=geomVersion;          /* abandon the search if the plan changes under it */
  const R=buildRaster(cell);
  const atten=attenField(R,state.band);
  const cands=[];
  for(let f=0;f<R.nz;f++){
    for(let y=40;y<PLAN.H;y+=55) for(let x=40;x<PLAN.W;x+=55){
      const i=Math.floor((x+MARGIN)/cell), j=Math.floor((y+MARGIN)/cell);
      if(R.kind[f*R.nxy + j*R.nx + i]===1) cands.push({x,y,f});
    }
  }
  const others = state.aps.filter((_,i)=>i!==state.selAp);
  const otherSol = others.map(ap=>solveAP(R,atten,ap.x,ap.y,ap.f||0,state.band,state.clutter).rssi);
  const areas = PLAN.rooms.map(r=>r.area);
  let best=null, idx=0;
  const step=()=>{
    if(gen!==geomVersion){
      btn.disabled=false; btn.textContent="Find best spot";
      hint.textContent="Search cancelled — the plan changed.";
      return;
    }
    const t0=performance.now();
    while(idx<cands.length && performance.now()-t0<40){
      const c=cands[idx++];
      const r=solveAP(R,atten,c.x,c.y,c.f,state.band,state.clutter).rssi;
      const cnt=new Array(PLAN.rooms.length).fill(0), tot=new Array(PLAN.rooms.length).fill(0);
      let sum=0, cells=0;
      for(let k=0;k<R.n;k++){
        const ri=R.roomIdx[k]; if(ri<0) continue;
        let v=r[k];
        for(const o of otherSol) if(o[k]>v) v=o[k];
        tot[ri]++; if(v>=state.target) cnt[ri]++;
        sum+=v; cells++;
      }
      let cov=0, tot_a=0;
      for(let i=0;i<PLAN.rooms.length;i++){ if(!tot[i]) continue; cov+=areas[i]*(cnt[i]/tot[i]); tot_a+=areas[i]; }
      cov = cov/tot_a;
      const score = cov + (sum/cells)/5000;
      if(!best||score>best.score) best={score,cov,x:c.x,y:c.y,f:c.f};
    }
    hint.textContent=`Searching… ${Math.round(idx/cands.length*100)}%`;
    if(idx<cands.length){ setTimeout(step,0); return; }
    state.aps[state.selAp].x=best.x; state.aps[state.selAp].y=best.y; state.aps[state.selAp].f=best.f;
    btn.disabled=false; btn.textContent="Find best spot";
    recompute();
    setTimeout(()=>{
      const where = (PLAN.nz||1)>1 ? ` on the ${floorName(best.f).toLowerCase()} floor` : "";
      hint.textContent=`Best of ${cands.length} positions tested: ${(best.x/100).toFixed(2)}, ${(best.y/100).toFixed(2)} m${where} — puts ${(best.cov*100).toFixed(0)}% of floor area above ${state.target} dBm. Drag away and back to compare.`;
    },120);
  };
  setTimeout(step,20);
});

/* ============================================================
   10. IMPORTED PLANS
   An imported plan replaces the rectangle lists with a pixel mask.
   Everything downstream already runs on the raster, so the only
   things that need building here are the picture of the walls and
   the header metrics.
   ============================================================ */
function buildPlanOverlay(f){
  const M = PLAN.masks[f];
  const c = document.createElement("canvas");
  c.width = M.mw;
  c.height = M.mh;
  const cc = c.getContext("2d");
  const im = cc.createImageData(M.mw, M.mh);
  const D = im.data;
  for(let i=0;i<M.kind.length;i++){
    const k = M.kind[i], o = i*4;
    if(k===2){ D[o]=99; D[o+1]=94; D[o+2]=83; D[o+3]=240; }
    else if(k===0){ D[o]=9; D[o+1]=11; D[o+2]=13; D[o+3]=133; }
  }
  cc.putImageData(im,0,0);
  M.overlay = c;
}

/* wall bounding box of an imported mask, in its own pixels */
function maskWallBox(kind, mw, mh){
  let x0=mw, y0=mh, x1=-1, y1=-1;
  for(let i=0;i<kind.length;i++){
    if(kind[i]!==2) continue;
    const x=i%mw, y=(i/mw)|0;
    if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y;
  }
  return x1<0 ? {x0:0,y0:0,x1:mw-1,y1:mh-1} : {x0,y0,x1,y1};
}

/* where a floor's building sits, in world cm */
function floorExtent(f){
  if((PLAN.src&&PLAN.src[f])==="raster" && PLAN.masks[f]){
    const M=PLAN.masks[f], b=M.wb, c=M.cmPerPx;
    return {x0:(M.ox||0)+b.x0*c, y0:(M.oy||0)+b.y0*c, x1:(M.ox||0)+(b.x1+1)*c, y1:(M.oy||0)+(b.y1+1)*c};
  }
  const rs = PLAN.footprint.filter(r=>FLOOR_OF(r)===f);
  if(!rs.length) return null;
  return {
    x0: Math.min(...rs.map(r=>r.x)), y0: Math.min(...rs.map(r=>r.y)),
    x1: Math.max(...rs.map(r=>r.x+r.w)), y1: Math.max(...rs.map(r=>r.y+r.h))
  };
}

/* Remove one floor's geometry, keeping the other floor's mask indices valid. */
function dropFloorGeometry(f){
  const rMap=new Map(), oMap=new Map(), rooms=[], ops=[];
  PLAN.rooms.forEach((r,i)=>{ if(FLOOR_OF(r)!==f){ rMap.set(i, rooms.length); rooms.push(r); } });
  PLAN.openings.forEach((o,i)=>{ if(FLOOR_OF(o)!==f){ oMap.set(i, ops.length); ops.push(o); } });
  PLAN.rooms=rooms;
  PLAN.openings=ops;
  PLAN.footprint=PLAN.footprint.filter(r=>FLOOR_OF(r)!==f);
  (PLAN.masks||[]).forEach((M,g)=>{
    if(!M || g===f) return;
    for(let i=0;i<M.roomIdx.length;i++){
      const r=M.roomIdx[i];
      M.roomIdx[i] = r>=0 && rMap.has(r) ? rMap.get(r) : -1;
      const o=M.opIdx[i];
      M.opIdx[i] = o>=0 && oMap.has(o) ? oMap.get(o) : -1;
    }
  });
}

/* Keep every coordinate at or above zero — an upper floor aligned to a lower
   one can land at a negative offset, and the solver grid starts at -MARGIN. */
function normalizePlanOrigin(){
  let minX=0, minY=0;
  (PLAN.masks||[]).forEach((M,f)=>{
    if(M && (PLAN.src&&PLAN.src[f])==="raster"){
      minX=Math.min(minX, M.ox||0);
      minY=Math.min(minY, M.oy||0);
    }
  });
  PLAN.footprint.forEach(r=>{ minX=Math.min(minX,r.x); minY=Math.min(minY,r.y); });
  if(minX>=0 && minY>=0) return;
  const dx=-Math.min(0,minX), dy=-Math.min(0,minY);
  (PLAN.masks||[]).forEach(M=>{ if(M){ M.ox=(M.ox||0)+dx; M.oy=(M.oy||0)+dy; } });
  for(const arr of [PLAN.footprint, PLAN.rooms, PLAN.openings, PLAN.stairs||[]]){
    for(const r of arr){
      r.x+=dx; r.y+=dy;
      if(r.lx!==undefined){ r.lx+=dx; r.ly+=dy; }
      if(r.lim){ r.lim=[r.lim[0]+(r.axis==="v"?dy:dx), r.lim[1]+(r.axis==="v"?dy:dx)]; }
    }
  }
  state.aps.forEach(ap=>{ ap.x+=dx; ap.y+=dy; });
}

function refitPlanBounds(){
  let W=0, H=0;
  for(let f=0;f<(PLAN.nz||1);f++){
    if((PLAN.src&&PLAN.src[f])==="raster" && PLAN.masks[f]){
      const M=PLAN.masks[f];
      W=Math.max(W,(M.ox||0)+M.mw*M.cmPerPx);
      H=Math.max(H,(M.oy||0)+M.mh*M.cmPerPx);
    }
  }
  PLAN.footprint.forEach(r=>{ W=Math.max(W,r.x+r.w); H=Math.max(H,r.y+r.h); });
  PLAN.W=Math.round(W)||PLAN.W;
  PLAN.H=Math.round(H)||PLAN.H;
}

function updatePlanMeta(){
  const nz = PLAN.nz||1;
  document.getElementById("mArea").textContent = PLAN.rooms.reduce((s,r)=>s+r.area,0).toFixed(1)+" m²";
  document.getElementById("mWalls").textContent = PLAN.wallT+" cm";
  document.getElementById("mRooms").textContent = PLAN.rooms.length;
  document.getElementById("mEyebrow").textContent =
    `Indoor RF coverage · ${Math.round(PLAN.W)} × ${Math.round(PLAN.H)} cm${nz>1?" · 2 floors":""}`;
  const anyRaster = (PLAN.src||[]).some(x=>x==="raster");
  document.getElementById("opHint").innerHTML = anyRaster
    ? "Detected from gaps in the imported walls. Set what fills each one — an open doorway and a metal door are 25 dB apart."
    : "Openings are the main way signal reaches other rooms. Drag their handles on the plan to move them along a wall.";
}

function applyImportedPlan(geo, floorIdx){
  const f = Math.min(Math.max(0, floorIdx|0), (PLAN.nz||1)-1);
  const other = f===0 ? 1 : 0;
  const ref = (PLAN.nz||1)>1 ? floorExtent(other) : null;

  /* Work out the alignment offset first: the rooms and openings coming back
     from the importer are in mask pixels, and they have to be moved into world
     coordinates before anything else touches them. */
  const wb = maskWallBox(geo.kind, geo.w, geo.h);
  let ox = 0, oy = 0;
  if(ref){
    /* line the two storeys up on their outer walls — same building, so the
       exterior envelope is the one thing they are guaranteed to share */
    ox = ref.x0 - wb.x0*geo.cmPerPx;
    oy = ref.y0 - wb.y0*geo.cmPerPx;
  }

  dropFloorGeometry(f);
  const rBase = PLAN.rooms.length, oBase = PLAN.openings.length;
  const roomIdx = new Int16Array(geo.roomIdx.length);
  const opIdx = new Int16Array(geo.opIdx.length);
  for(let i=0;i<roomIdx.length;i++){
    roomIdx[i] = geo.roomIdx[i]>=0 ? rBase+geo.roomIdx[i] : -1;
    opIdx[i]   = geo.opIdx[i]  >=0 ? oBase+geo.opIdx[i]   : -1;
  }
  PLAN.rooms = PLAN.rooms.concat(geo.rooms.map(r=>Object.assign({}, r, {
    floor:f, x:r.x+ox, y:r.y+oy, lx:r.lx+ox, ly:r.ly+oy
  })));
  PLAN.openings = PLAN.openings.concat(geo.openings.map(o=>Object.assign({}, o, {
    floor:f, x:o.x+ox, y:o.y+oy
  })));

  PLAN.src = (PLAN.src||["vector","vector"]).slice();
  PLAN.src[f] = "raster";
  PLAN.masks = (PLAN.masks||[null,null]).slice();
  PLAN.masks[f] = {
    mw:geo.w, mh:geo.h, cmPerPx:geo.cmPerPx, ox, oy, wb,
    kind:geo.kind, roomIdx, opIdx
  };
  buildPlanOverlay(f);
  PLAN.wallT = Math.max(5, geo.wallT);

  normalizePlanOrigin();
  refitPlanBounds();

  const mine = PLAN.rooms.filter(r=>FLOOR_OF(r)===f);
  if(f===0 && (PLAN.nz||1)===1){
    const seat = mine[0];
    state.aps=[{x: seat?seat.lx:PLAN.W/2, y: seat?seat.ly:PLAN.H/2, f:0, id:0}];
    state.selAp=0;
  }
  state.aps.forEach(ap=>{
    ap.x=Math.max(0,Math.min(PLAN.W,ap.x));
    ap.y=Math.max(0,Math.min(PLAN.H,ap.y));
  });

  geomVersion++;
  rasterCache.clear();
  syncFloorUI(); updatePlanMeta(); renderOpList(); renderApList();
  document.getElementById("bestHint").textContent =
    `${floorName(f)} floor imported: ${mine.length} room${mine.length===1?"":"s"}, ` +
    `${PLAN.openings.filter(o=>FLOOR_OF(o)===f).length} openings, walls measured at ${PLAN.wallT} cm.` +
    ((PLAN.nz||1)>1 ? " Lined up with the other floor on its outer walls." : "");
  layout(); recompute();
}

/* ---- init ---- */
fillSelect(document.getElementById("extMat"), WALL_MATERIALS, state.extMat);
fillSelect(document.getElementById("intMat"), WALL_MATERIALS, state.intMat);
fillSelect(document.getElementById("slabMat"), SLAB_MATERIALS, PLAN.slab);
updatePlanMeta();
syncMatLabels(); syncFloorUI(); renderOpList(); renderLegend(); renderApList();

function boot(){ layout(); recompute(); }
window.addEventListener("resize",()=>{ layout(); draw(); });
if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ layout(); draw(); });
boot();
