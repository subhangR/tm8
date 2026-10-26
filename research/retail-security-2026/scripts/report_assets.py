"""Shared presentation assets for the annual and period builders: site CSS/JS, PDF CSS, cover CSS, static globe SVG."""
import math
from report_common import CAT
PCAT = {"cyber":"#0369a1","ot":"#be123c","physical":"#b45309","fraud":"#4d7c0f","geopolitical":"#c2410c","regulatory":"#6d28d9","enforcement":"#0f766e","market":"#475569"}

SITE_CSS = r'''
:root{color-scheme:dark;--bg:#070b14;--bg2:#0b1220;--panel:#0f172a;--line:rgba(148,163,184,.16);--txt:#e5e7eb;--txt1:#e2e8f0;--txt2:#cbd5e1;--strong:#fff;--muted:#94a3b8;--amber:#f5b942;--amber-fill:#f5b942;--teal:#2dd4bf;--sky:#38bdf8;--rose:#fb7185;--on-fill:#06111c;--cat-cyber:#38bdf8;--cat-ot:#fb7185;--cat-physical:#f5b942;--cat-fraud:#a3e635;--cat-geopolitical:#f97316;--cat-regulatory:#a78bfa;--cat-enforcement:#2dd4bf;--cat-market:#94a3b8;--body-bg:radial-gradient(1200px 600px at 20% -10%,#14213d 0%,transparent 60%),radial-gradient(900px 500px at 100% 0%,#1a1033 0%,transparent 55%),#070b14;--hero-glow:conic-gradient(from 200deg,rgba(56,189,248,.12),rgba(245,185,66,.1),rgba(251,113,133,.08),transparent 70%);--grad:linear-gradient(90deg,#f5b942,#fb7185 50%,#38bdf8);--card:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));--card2:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.02));--card3:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));--tile:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));--quote:linear-gradient(180deg,rgba(56,189,248,.06),rgba(255,255,255,.02));--card-shadow:none;--toc-bg:rgba(7,11,20,.85);--globe-bg:#050913;--globe-halo:rgba(56,189,248,.08);--track:rgba(148,163,184,.12);--track-shadow:inset 0 2px 4px rgba(0,0,0,.5);--shadow:0 12px 30px rgba(0,0,0,.35);--sev-off:rgba(148,163,184,.25);--cx-bg:rgba(148,163,184,.15);--hover-row:rgba(56,189,248,.08)}
html[data-theme=light]{color-scheme:light;--bg:#f5f7fb;--bg2:#eef2f7;--panel:#fff;--line:rgba(15,23,42,.13);--txt:#1e293b;--txt1:#1e293b;--txt2:#334155;--strong:#0f172a;--muted:#5b6778;--amber:#b45309;--teal:#0f766e;--sky:#0369a1;--rose:#be123c;--cat-cyber:#0369a1;--cat-ot:#be123c;--cat-physical:#b45309;--cat-fraud:#4d7c0f;--cat-geopolitical:#c2410c;--cat-regulatory:#6d28d9;--cat-enforcement:#0f766e;--cat-market:#475569;--body-bg:radial-gradient(1200px 600px at 20% -10%,#dbeafe 0%,transparent 60%),radial-gradient(900px 500px at 100% 0%,#ede9fe 0%,transparent 55%),#f5f7fb;--hero-glow:conic-gradient(from 200deg,rgba(3,105,161,.10),rgba(180,83,9,.08),rgba(190,18,60,.06),transparent 70%);--grad:linear-gradient(90deg,#b45309,#be123c 50%,#0369a1);--card:linear-gradient(180deg,#fff,#f8fafc);--card2:linear-gradient(160deg,#fff,#f8fafc);--card3:linear-gradient(180deg,#fff,#f8fafc);--tile:linear-gradient(180deg,#fff,#f8fafc);--quote:linear-gradient(180deg,#f0f9ff,#fff);--card-shadow:0 1px 2px rgba(15,23,42,.05),0 6px 18px rgba(15,23,42,.06);--toc-bg:rgba(245,247,251,.9);--globe-bg:#e9f1fa;--globe-halo:rgba(3,105,161,.08);--track:rgba(15,23,42,.08);--track-shadow:inset 0 1px 2px rgba(15,23,42,.15);--shadow:0 12px 30px rgba(15,23,42,.14);--sev-off:rgba(15,23,42,.14);--cx-bg:rgba(15,23,42,.08);--hover-row:rgba(3,105,161,.07)}
.chv{display:block}html:not([data-theme=light]) .chv.l,html[data-theme=light] .chv.d{display:none}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--body-bg);color:var(--txt);font-family:Inter,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;line-height:1.5;font-size:15px;transition:background-color .25s,color .25s}
a{color:var(--sky)}.wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.hero{padding:64px 0 28px;border-bottom:1px solid var(--line);position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;inset:-40% -10% auto auto;width:60%;height:140%;background:var(--hero-glow);filter:blur(40px);pointer-events:none}
.eyebrow{display:inline-flex;gap:8px;align-items:center;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);border:1px solid rgba(245,185,66,.35);padding:6px 12px;border-radius:999px;background:rgba(245,185,66,.06)}
h1{font-size:clamp(34px,5vw,58px);line-height:1.05;margin:18px 0 10px;letter-spacing:-.02em}h1 small{display:block;font-size:clamp(16px,2vw,22px);font-weight:500;color:var(--muted);letter-spacing:0;margin-top:10px}
.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{max-width:820px;font-size:17px;color:var(--txt2)}.lede2{max-width:900px;font-size:16px;color:var(--txt2);border-left:3px solid var(--amber);padding-left:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:26px 0 18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;transform-style:preserve-3d;transition:transform .3s;box-shadow:var(--card-shadow)}
.stat:hover{transform:perspective(600px) rotateX(6deg) translateY(-2px)}.stat b{display:block;font-size:30px;letter-spacing:-.02em;color:var(--strong)}.stat span{display:block;font-size:13px;color:var(--txt2)}.stat i{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:4px}
.toc{display:flex;flex-wrap:wrap;gap:6px;position:sticky;top:0;z-index:5;padding:10px 0;background:var(--toc-bg);backdrop-filter:blur(8px);align-items:center}.toc a{font-size:12.5px;color:var(--txt2);text-decoration:none;border:1px solid var(--line);padding:5px 10px;border-radius:999px}.toc a:hover{border-color:var(--amber);color:var(--amber)}
.theme{margin-left:auto;font:inherit;font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:7px;background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:999px;padding:5px 12px;cursor:pointer;box-shadow:var(--card-shadow)}.theme:hover{border-color:var(--amber);color:var(--amber)}.theme svg{width:15px;height:15px}
.sec{padding:44px 0;border-bottom:1px solid var(--line)}.kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--teal)}h2{font-size:clamp(24px,3vw,34px);margin:6px 0 18px;letter-spacing:-.02em}
h3.sub{display:flex;gap:10px;align-items:center;font-size:18px;margin:30px 0 12px;flex-wrap:wrap}h3.sub .srcs{font-weight:400}h3.rh small{display:block;width:100%;font-weight:400;color:var(--muted);font-size:13px;margin-top:4px}
.rbadge{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--amber-fill),#f97316);color:#111;font-weight:800;font-size:14px}
.muted{color:var(--muted);font-size:13.5px}
.ic{vertical-align:-3px}
.globe-grid{display:grid;grid-template-columns:minmax(320px,1.1fr) minmax(300px,.9fr);gap:22px;align-items:start}@media(max-width:900px){.globe-grid{grid-template-columns:1fr}}
.globe-box{position:relative;background:radial-gradient(circle at 50% 45%,var(--globe-halo),transparent 60%),var(--globe-bg);border:1px solid var(--line);border-radius:18px;padding:10px;box-shadow:var(--card-shadow)}
#globe{width:100%;aspect-ratio:1/1;display:block;cursor:grab;touch-action:none;border-radius:12px}#globe:active{cursor:grabbing}
.globe-hint{font-size:12px;color:var(--muted);text-align:center;padding:8px 0 2px}.mini{font:inherit;font-size:11.5px;background:transparent;color:var(--sky);border:1px solid var(--line);border-radius:999px;padding:3px 9px;cursor:pointer}.mini:hover{border-color:var(--sky)}
.globe-side{display:flex;flex-direction:column;gap:12px}
.filters{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;box-shadow:var(--card-shadow)}.fh{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:6px 0 6px}.fl{display:flex;flex-wrap:wrap;gap:6px 12px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer}.lg i{width:10px;height:10px;border-radius:50%;display:inline-block}.lg input{accent-color:var(--amber)}
.detail{background:linear-gradient(180deg,rgba(245,185,66,.08),transparent 70%),var(--panel);border:1px solid rgba(245,185,66,.35);border-radius:14px;padding:14px;min-height:150px;box-shadow:var(--card-shadow)}.detail .dh{font-weight:700;font-size:16px;margin-bottom:6px}.detail .meta{margin:6px 0}.detail p{margin:6px 0;font-size:13.5px}.detail .srcl{margin:8px 0 0;padding:0;list-style:none;font-size:12.5px}.detail .srcl li{margin:3px 0}
.glist{list-style:none;margin:0;padding:0;max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.glist li{padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer;display:flex;gap:8px;align-items:center}.glist li:hover,.glist li.on{background:var(--hover-row)}.glist i{width:9px;height:9px;border-radius:50%;flex:none}.glist small{color:var(--muted);margin-left:auto;white-space:nowrap}
.tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;perspective:1200px}
.tcard{display:grid;grid-template-columns:54px 1fr;gap:10px;background:var(--card2);border:1px solid var(--line);border-radius:16px;padding:16px;transition:transform .35s,border-color .35s;transform-style:preserve-3d;box-shadow:var(--card-shadow)}
.tcard:hover{transform:rotateY(-4deg) rotateX(3deg) translateZ(10px);border-color:rgba(245,185,66,.5)}.tcard .rank{font-size:34px;font-weight:800;color:var(--amber);letter-spacing:-.04em;line-height:1}.tcard h3{margin:0 0 4px;font-size:16px}.tcard .trend{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--rose)}.tcard p{font-size:13.5px;color:var(--txt2);margin:6px 0}.tcard .links{display:flex;flex-wrap:wrap;gap:6px}.ilink{font-size:11.5px;color:var(--sky);text-decoration:none;border:1px solid var(--line);padding:2px 8px;border-radius:999px}
.rtable{display:grid;gap:10px}.rrow{display:grid;grid-template-columns:40px 150px 1fr;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px;box-shadow:var(--card-shadow)}.rrow .rr{font-size:22px;font-weight:800;color:var(--amber)}.rrow .rn{font-weight:700}.rbar{height:16px;background:var(--track);border-radius:8px;overflow:hidden;box-shadow:var(--track-shadow)}.rfill{height:100%;background:linear-gradient(90deg,#2dd4bf,#38bdf8 50%,#f5b942);border-radius:8px;position:relative;box-shadow:0 1px 0 rgba(255,255,255,.3) inset}.rfill span{position:absolute;right:8px;top:-1px;font-size:11px;font-weight:700;color:#06111c}.rwhy{grid-column:2/4;font-size:13px;color:var(--muted)}
.strip{display:flex;gap:8px;overflow-x:auto;padding:6px 0 10px}.sp{flex:0 0 150px;background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--amber);border-radius:10px;padding:8px 10px;font-size:12.5px;box-shadow:var(--card-shadow)}.sp b{display:block;color:var(--amber);margin-bottom:2px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0}@media(max-width:900px){.two{grid-template-columns:1fr}}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:var(--card-shadow)}.panel h4{margin:0 0 8px}.cap{font-size:12px;color:var(--muted);margin-top:6px}.three-d{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:10px 0}.tile{background:var(--tile);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:var(--card-shadow)}.tile b{display:block;font-size:24px;color:var(--strong);letter-spacing:-.02em}.tile span{display:block;font-size:13px;color:var(--txt2);margin:4px 0 6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.card.inc{background:var(--card3);border:1px solid var(--line);border-left:3px solid var(--c);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px;transition:transform .25s,box-shadow .25s;box-shadow:var(--card-shadow)}.card.inc:hover{transform:translateY(-3px);box-shadow:var(--shadow)}.card.inc:target{outline:2px solid var(--amber)}
.card header{display:flex;gap:8px;align-items:flex-start}.card h4{margin:0;font-size:15px;line-height:1.3}.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--txt2)}
.sev{display:inline-flex;gap:2px}.sev i{width:7px;height:7px;border-radius:2px;background:var(--sev-off);display:inline-block}.sev i.on{background:var(--rose)}
.st{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:4px}.st.ok{background:rgba(45,212,191,.15);color:var(--teal)}.st.cl{background:rgba(251,113,133,.15);color:var(--rose)}.st.cx{background:var(--cx-bg);color:var(--txt2)}
.type{margin:0;font-size:13px;color:var(--txt2)}.sum{margin:0;font-size:13.5px;color:var(--txt1)}.card footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto}
.srcs{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center}.src{font-size:10.5px;font-weight:700;color:var(--on-fill);background:var(--amber-fill);border-radius:4px;padding:1px 5px;text-decoration:none}.src:hover{background:var(--strong);color:var(--bg)}.srcidx{font-size:10.5px;color:var(--muted);text-decoration:none}
.fly{font:inherit;font-size:11.5px;background:transparent;border:1px solid var(--line);color:var(--sky);border-radius:999px;padding:3px 9px;cursor:pointer;display:inline-flex;gap:4px;align-items:center}.fly:hover{border-color:var(--sky)}
.tl-filter{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}.tf{font:inherit;font-size:12.5px;background:transparent;color:var(--txt2);border:1px solid var(--line);border-radius:999px;padding:5px 11px;cursor:pointer}.tf.on{background:var(--amber-fill);color:#111;border-color:var(--amber-fill)}
.tl{position:relative;padding-left:18px;border-left:2px solid rgba(245,185,66,.35)}.tm h3{margin:18px 0 8px;font-size:16px;color:var(--amber)}.tm ul{list-style:none;margin:0;padding:0}.tm li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--line);font-size:13.5px}.tm li a{color:var(--txt);text-decoration:none}.tm li a:hover{color:var(--sky)}.td{font-variant-numeric:tabular-nums;color:var(--muted);width:22px}.dot{width:9px;height:9px;border-radius:50%;display:inline-block}.tr{color:var(--muted);font-size:12.5px}.tm li.hide{display:none}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}.tbl th{text-align:left;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:8px;border-bottom:1px solid var(--line)}.tbl td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}.tbl small{color:var(--muted)}
.vgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.vcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:var(--card-shadow)}.vcard h4{margin:0}.vseg{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);margin:2px 0 6px}.vcard p{font-size:13px;color:var(--txt2);margin:0 0 8px}
.qgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.q{margin:0;background:var(--quote);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:var(--card-shadow)}.q p{margin:0 0 8px;font-size:14px;color:var(--txt1)}.q footer{font-size:12px;color:var(--muted)}
.steps{padding-left:18px;font-size:13.5px;color:var(--txt2)}.steps li{margin:6px 0}.lims{font-size:13.5px;color:var(--txt2)}.lims li{margin:6px 0}
.ev{list-style:none;margin:0;padding:0;columns:2;column-gap:28px}@media(max-width:900px){.ev{columns:1}}.ev li{break-inside:avoid;display:grid;grid-template-columns:44px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px}.ev li:target{background:rgba(245,185,66,.12)}.sn{font-weight:700;color:var(--amber)}.ev a{color:var(--txt1);text-decoration:none}.ev a:hover{color:var(--sky)}.so{grid-column:2;color:var(--muted);font-size:11.5px}
footer.end{padding:30px 0 60px;color:var(--muted);font-size:12.5px}
'''

SITE_JS = r'''
const CATD=%(catd)s, CATL=%(catl)s, GEO=%(geo)s, INC=%(inc)s;
const THEMES={
 dark:{glow:'rgba(56,189,248,0.28)',glow0:'rgba(56,189,248,0)',oc0:'#17406b',oc1:'#0b2242',oc2:'#050c18',grat:'rgba(148,163,184,0.13)',land:'rgba(45,212,191,0.20)',coast:'rgba(125,235,215,0.55)',sh0:'rgba(255,255,255,0.07)',sh1:'rgba(0,0,0,0.62)',rim:'rgba(56,189,248,0.35)',mk:'rgba(255,255,255,0.85)',sel:'#ffffff',tip:'rgba(7,11,20,0.92)',tipTxt:'#ffffff',cat:CATD},
 light:{glow:'rgba(3,105,161,0.18)',glow0:'rgba(3,105,161,0)',oc0:'#eaf4ff',oc1:'#c7e0f7',oc2:'#8fbfe6',grat:'rgba(15,23,42,0.13)',land:'rgba(15,118,110,0.16)',coast:'rgba(15,118,110,0.7)',sh0:'rgba(255,255,255,0.5)',sh1:'rgba(15,23,42,0.25)',rim:'rgba(3,105,161,0.4)',mk:'rgba(255,255,255,0.95)',sel:'#0f172a',tip:'rgba(255,255,255,0.96)',tipTxt:'#0f172a',cat:CATL}};
let TH=THEMES[document.documentElement.dataset.theme==='light'?'light':'dark'];
const DEG=Math.PI/180;
(function(){
 const cv=document.getElementById('globe'), ctx=cv.getContext('2d'); let dpr=1,W=0,H=0,R=0,CX=0,CY=0;
 let yaw=-50*DEG, pitch=26*DEG, zoom=1, auto=true, drag=null, hover=null, sel=null, tgt=null, t0=performance.now();
 function resize(){dpr=window.devicePixelRatio||1;const s=cv.clientWidth||600;cv.width=s*dpr;cv.height=s*dpr;W=H=s;R=s*0.455;CX=CY=s/2;ctx.setTransform(dpr,0,0,dpr,0,0);}
 window.addEventListener('resize',resize); resize();
 function proj(lon,lat){const p=lat*DEG,l=lon*DEG+yaw;const x=Math.cos(p)*Math.sin(l),y=Math.sin(p),z=Math.cos(p)*Math.cos(l);const y2=y*Math.cos(pitch)-z*Math.sin(pitch);const z2=y*Math.sin(pitch)+z*Math.cos(pitch);return [CX+x*R*zoom,CY-y2*R*zoom,z2];}
 function filt(){const reg=new Set([...document.querySelectorAll('.freg:checked')].map(e=>e.value));const cat=new Set([...document.querySelectorAll('.fcat:checked')].map(e=>e.value));const st=new Set([...document.querySelectorAll('.fst:checked')].map(e=>e.value));return INC.filter(i=>reg.has(i.region)&&cat.has(i.cat)&&st.has(i.status));}
 let VIS=filt();
 function pathLine(pts){ctx.beginPath();let pen=false;for(const q of pts){const [x,y,z]=proj(q[0],q[1]);if(z>0){if(pen)ctx.lineTo(x,y);else{ctx.moveTo(x,y);pen=true;}}else pen=false;}ctx.stroke();}
 function ring(r){let any=false,pen=false;ctx.beginPath();for(const q of r){const [x,y,z]=proj(q[0],q[1]);if(z>-0.01){if(pen)ctx.lineTo(x,y);else{ctx.moveTo(x,y);pen=true;}any=true;}else pen=false;}if(any)ctx.stroke();
   ctx.beginPath();let first=true;for(const q of r){const [x,y,z]=proj(q[0],q[1]);if(z>-0.01){if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y);}}if(!first){ctx.closePath();ctx.fill();}}
 let MK=[];
 function draw(ts){
  if(tgt){yaw+=(tgt.yaw-yaw)*0.08;pitch+=(tgt.pitch-pitch)*0.08;if(Math.abs(tgt.yaw-yaw)<0.002&&Math.abs(tgt.pitch-pitch)<0.002)tgt=null;}
  else if(auto&&!drag&&!hover)yaw+=0.0022;
  const r=R*zoom;ctx.clearRect(0,0,W,H);
  let g=ctx.createRadialGradient(CX,CY,r*0.92,CX,CY,r*1.16);g.addColorStop(0,TH.glow);g.addColorStop(1,TH.glow0);ctx.fillStyle=g;ctx.beginPath();ctx.arc(CX,CY,r*1.16,0,7);ctx.fill();
  g=ctx.createRadialGradient(CX-r*0.35,CY-r*0.35,r*0.05,CX,CY,r);g.addColorStop(0,TH.oc0);g.addColorStop(0.6,TH.oc1);g.addColorStop(1,TH.oc2);ctx.fillStyle=g;ctx.beginPath();ctx.arc(CX,CY,r,0,7);ctx.fill();
  ctx.save();ctx.beginPath();ctx.arc(CX,CY,r,0,7);ctx.clip();
  ctx.strokeStyle=TH.grat;ctx.lineWidth=0.6;
  for(let la=-60;la<=60;la+=30){const p=[];for(let i=0;i<=72;i++)p.push([i*5-180,la]);pathLine(p);}
  for(let lo=-180;lo<180;lo+=30){const p=[];for(let i=0;i<=36;i++)p.push([lo,i*5-90]);pathLine(p);}
  ctx.fillStyle=TH.land;ctx.strokeStyle=TH.coast;ctx.lineWidth=0.7;
  for(const c of GEO)for(const rr of c.r)ring(rr);
  g=ctx.createRadialGradient(CX-r*0.42,CY-r*0.42,r*0.15,CX,CY,r*1.02);g.addColorStop(0,TH.sh0);g.addColorStop(0.55,'rgba(0,0,0,0)');g.addColorStop(1,TH.sh1);ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  ctx.restore();
  ctx.strokeStyle=TH.rim;ctx.lineWidth=1;ctx.beginPath();ctx.arc(CX,CY,r,0,7);ctx.stroke();
  MK=[];for(const i of VIS){const [x,y,z]=proj(i.lon,i.lat);if(z>0.02)MK.push({i,x,y,z});}MK.sort((a,b)=>a.z-b.z);
  const tt=(ts-t0)/1000;
  for(const m of MK){const s=(2.6+m.i.sev*1.5)*(0.55+0.45*m.z)*Math.min(zoom,1.4);const c=TH.cat[m.i.cat];
   const gg=ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,s*2.8);gg.addColorStop(0,c+'99');gg.addColorStop(1,c+'00');ctx.fillStyle=gg;ctx.beginPath();ctx.arc(m.x,m.y,s*2.8,0,7);ctx.fill();
   ctx.beginPath();ctx.arc(m.x,m.y,s,0,7);ctx.fillStyle=c;ctx.fill();ctx.strokeStyle=TH.mk;ctx.lineWidth=1;ctx.stroke();
   if(m.i.status==='claimed'){ctx.setLineDash([2,2]);ctx.strokeStyle=c;ctx.beginPath();ctx.arc(m.x,m.y,s+3,0,7);ctx.stroke();ctx.setLineDash([]);}
   if(sel===m.i.id){const pr=s+5+3*Math.sin(tt*4);ctx.strokeStyle=TH.sel;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(m.x,m.y,pr,0,7);ctx.stroke();}
  }
  if(hover){ctx.font='600 12px Inter,system-ui,sans-serif';const tx=hover.i.name;const w=ctx.measureText(tx).width+16;let x=hover.x+12,y=hover.y-30;if(x+w>W)x=hover.x-w-12;ctx.fillStyle=TH.tip;ctx.strokeStyle=TH.cat[hover.i.cat];ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(x,y,w,22,6);ctx.fill();ctx.stroke();ctx.fillStyle=TH.tipTxt;ctx.fillText(tx,x+8,y+15);}
  requestAnimationFrame(draw);
 }
 function pick(px,py){let best=null,bd=14;for(const m of MK){const d=Math.hypot(m.x-px,m.y-py);if(d<bd){bd=d;best=m;}}return best;}
 function pos(e){const b=cv.getBoundingClientRect();return [(e.clientX-b.left)*(W/b.width),(e.clientY-b.top)*(H/b.height)];}
 cv.addEventListener('pointerdown',e=>{const [x,y]=pos(e);drag={x,y,yaw,pitch,moved:false};cv.setPointerCapture(e.pointerId);});
 cv.addEventListener('pointermove',e=>{const [x,y]=pos(e);if(drag){const dx=x-drag.x,dy=y-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;yaw=drag.yaw+dx*0.0065/zoom;pitch=Math.max(-1.45,Math.min(1.45,drag.pitch+dy*0.0065/zoom));tgt=null;}else{hover=pick(x,y);cv.style.cursor=hover?'pointer':'grab';}});
 cv.addEventListener('pointerup',e=>{const [x,y]=pos(e);if(drag&&!drag.moved){const m=pick(x,y);if(m)select(m.i.id,false);}drag=null;});
 cv.addEventListener('pointerleave',()=>{hover=null;});
 cv.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.8,Math.min(2.4,zoom*(e.deltaY<0?1.1:0.9)));},{passive:false});
 document.getElementById('autoBtn').addEventListener('click',e=>{auto=!auto;e.target.textContent=auto?'pause rotation':'resume rotation';});
 document.getElementById('meBtn').addEventListener('click',()=>{tgt={yaw:-50*DEG,pitch:26*DEG};});
 function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
 window.select=function(id,fly){const i=INC.find(x=>x.id===id);if(!i)return;sel=id;auto=false;document.getElementById('autoBtn').textContent='resume rotation';if(fly!==false)tgt={yaw:-i.lon*DEG,pitch:i.lat*DEG};
  const st={confirmed:'<span class="st ok">confirmed</span>',claimed:'<span class="st cl">claim, unverified</span>',context:'<span class="st cx">statistic / policy</span>'}[i.status];
  const dots='<span class="sev">'+[0,1,2,3,4].map(k=>'<i class="'+(k<i.sev?'on':'')+'"></i>').join('')+'</span>';
  document.getElementById('detail').innerHTML='<div class="dh" style="color:var(--cat-'+i.cat+')">'+esc(i.name)+'</div><div class="meta"><span class="chip">'+esc(i.date)+'</span><span class="chip">'+esc(i.country)+' · '+esc(i.region)+'</span>'+dots+st+'</div><p><b>'+esc(i.type)+'</b> — '+esc(i.impact)+'</p><p>'+esc(i.summary)+'</p><ul class="srcl">'+i.src.map(s=>'<li><a class="src" href="'+esc(s[2])+'" target="_blank" rel="noopener">S'+s[0]+'</a> <a href="'+esc(s[2])+'" target="_blank" rel="noopener">'+esc(s[1])+'</a> <span class="muted">'+esc(s[3])+'</span></li>').join('')+'</ul><p><a href="#inc-'+esc(i.id)+'">Open the full card ↓</a></p>';
  [...document.querySelectorAll('#list li')].forEach(li=>li.classList.toggle('on',li.dataset.id===id));};
 function list(){VIS=filt();const ul=document.getElementById('list');const items=[...VIS].sort((a,b)=>b.sev-a.sev||a.date.localeCompare(b.date));ul.innerHTML=items.map(i=>'<li data-id="'+i.id+'"><i style="background:var(--cat-'+i.cat+')"></i><span>'+esc(i.name)+'</span><small>'+esc(i.country)+'</small></li>').join('');document.getElementById('cnt').textContent='('+items.length+')';[...ul.children].forEach(li=>li.addEventListener('click',()=>select(li.dataset.id)));}
 document.querySelectorAll('.freg,.fcat,.fst').forEach(e=>e.addEventListener('change',list));list();
 document.querySelectorAll('.fly').forEach(b=>b.addEventListener('click',()=>{select(b.dataset.id);document.getElementById('globe-sec').scrollIntoView({behavior:'smooth'});}));
 requestAnimationFrame(draw);
})();
(function(){const io=new IntersectionObserver(es=>{es.forEach(en=>{if(!en.isIntersecting)return;const b=en.target,n=+b.dataset.n,t0=performance.now();const d=1400;(function step(t){const p=Math.min(1,(t-t0)/d),v=Math.round(n*(1-Math.pow(1-p,3)));b.textContent=v.toLocaleString('en-US');if(p<1)requestAnimationFrame(step);})(t0);io.unobserve(b);});},{threshold:.4});document.querySelectorAll('.stat b[data-n]').forEach(b=>io.observe(b));})();
(function(){const bs=document.querySelectorAll('.tf');bs.forEach(b=>b.addEventListener('click',()=>{bs.forEach(x=>x.classList.remove('on'));b.classList.add('on');const r=b.dataset.r;document.querySelectorAll('.tm li').forEach(li=>li.classList.toggle('hide',r!=='all'&&li.dataset.region!==r));document.querySelectorAll('.tm').forEach(m=>{m.style.display=[...m.querySelectorAll('li')].some(li=>!li.classList.contains('hide'))?'':'none';});}));})();
(function(){const root=document.documentElement,btn=document.getElementById('themeBtn');if(!btn)return;const mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: light)'):null;
 const SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
 const MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
 function paint(){const t=root.dataset.theme==='light'?'light':'dark';TH=THEMES[t];btn.innerHTML=(t==='light'?MOON+'<span>Dark mode</span>':SUN+'<span>Light mode</span>');btn.title=t==='light'?'Switch to the dark theme':'Switch to the light theme';btn.setAttribute('aria-pressed',t==='light'?'true':'false');}
 btn.addEventListener('click',()=>{const t=root.dataset.theme==='light'?'dark':'light';root.dataset.theme=t;try{localStorage.setItem('rs26-theme',t)}catch(e){}paint();});
 if(mq&&mq.addEventListener)mq.addEventListener('change',e=>{let s=null;try{s=localStorage.getItem('rs26-theme')}catch(x){}if(s!=='light'&&s!=='dark'){root.dataset.theme=e.matches?'light':'dark';paint();}});
 paint();})();
'''

PDF_CSS = r'''
@page{size:A4}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:Inter,"Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif;color:#0f172a;font-size:9.4pt;line-height:1.42;-webkit-print-color-adjust:exact;print-color-adjust:exact}
a{color:#0369a1;text-decoration:none}
.mk{color:#fff;font-size:1pt;position:absolute}
.sec{break-before:page;position:relative}.sec.first{break-before:auto}
.kicker{font-size:7.5pt;letter-spacing:.16em;text-transform:uppercase;color:#0f766e;margin-top:2mm}
h1{font-size:20pt;margin:1mm 0 3mm;letter-spacing:-.02em;display:flex;align-items:baseline;gap:4mm;border-bottom:2px solid #0f172a;padding-bottom:2mm}h1 .num{font-size:11pt;color:#b45309;font-weight:800;letter-spacing:.05em}
h2{font-size:12.5pt;margin:5mm 0 2mm;letter-spacing:-.01em;color:#0f172a;break-after:avoid}h3{font-size:10.5pt;margin:4mm 0 1.5mm;break-after:avoid}
.lede{font-size:10pt;color:#334155;border-left:3px solid #b45309;padding-left:3mm;margin:2mm 0 3mm}
.cites{display:inline-flex;flex-wrap:wrap;gap:1.2mm;vertical-align:baseline;margin-left:1mm}.cites a{font-size:6.6pt;font-weight:700;color:#1e293b;background:#fde68a;border-radius:2px;padding:0 1.2mm;line-height:1.5}
.tiles{display:grid;gap:2.5mm;margin:2mm 0 3mm}.tiles.six{grid-template-columns:repeat(6,1fr)}.tiles.four{grid-template-columns:repeat(4,1fr)}
.tile{border:1px solid #e2e8f0;border-radius:2mm;padding:2.5mm;background:linear-gradient(180deg,#f8fafc,#fff);break-inside:avoid}.tile b{display:block;font-size:14pt;letter-spacing:-.02em;color:#0f172a}.tile span{display:block;font-size:7.6pt;color:#475569;margin:.5mm 0 1mm}
.findings{padding-left:5mm;margin:1mm 0}.findings li{margin:0 0 2.2mm;font-size:9.2pt}.findings li b{color:#0f172a}
.tbl{width:100%;border-collapse:collapse;font-size:8.4pt;margin:1mm 0 3mm}.tbl th{text-align:left;font-size:7pt;letter-spacing:.1em;text-transform:uppercase;color:#64748b;padding:1.5mm 1.5mm;border-bottom:1.5px solid #0f172a}.tbl td{padding:1.5mm;border-bottom:1px solid #e2e8f0;vertical-align:top}.tbl tr{break-inside:avoid}.tbl thead{display:table-header-group}
.tbl .rk{font-weight:800;color:#b45309;font-size:11pt}.tbl .trend{color:#be123c;font-size:7.4pt;text-transform:uppercase;letter-spacing:.06em}.small{font-size:7.4pt;color:#64748b}.tbl .c{text-align:center}.tbl .d{white-space:nowrap;color:#64748b;font-variant-numeric:tabular-nums}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm}.act{display:grid;grid-template-columns:8mm 1fr;gap:2mm;border:1px solid #e2e8f0;border-radius:2mm;padding:2.5mm;font-size:8.6pt;break-inside:avoid}.an{font-size:14pt;font-weight:800;color:#b45309;line-height:1}
.howto{margin-top:3mm;background:#f1f5f9;border-radius:2mm;padding:3mm;font-size:8.4pt;color:#334155;break-inside:avoid}
.globes{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4mm;margin:2mm 0}.globes figure{margin:0;text-align:center}.gl svg{width:100%;height:auto}.globes figcaption{font-size:7.6pt;color:#64748b;margin-top:1mm}
.legend{display:flex;flex-wrap:wrap;gap:1.5mm 4mm;font-size:7.4pt;color:#475569;margin:1mm 0 3mm;justify-content:center}.legend i{display:inline-block;width:2.2mm;height:2.2mm;border-radius:50%;margin-right:1mm;vertical-align:middle}.legend i.dash{border:1px dashed #475569;background:none}
.two{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:2mm 0 3mm}.panel{border:1px solid #e2e8f0;border-radius:2mm;padding:3mm;break-inside:avoid}.panel svg{width:100%;height:auto}.cap{font-size:7.2pt;color:#64748b;margin-top:1mm}.donuts{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin-top:2mm}
.matrix td,.matrix th{text-align:center;padding:1.2mm}.matrix td:first-child{text-align:left}
.strip{display:grid;grid-template-columns:repeat(7,1fr);gap:1.5mm;margin:1mm 0 3mm}.sp{border-top:2px solid #b45309;background:#fffbeb;padding:1.5mm;font-size:7.2pt;border-radius:0 0 1.5mm 1.5mm;break-inside:avoid}.sp b{display:block;color:#b45309}
.score{display:grid;grid-template-columns:18mm 18mm 18mm 1fr;gap:3mm;align-items:center;border:1px solid #e2e8f0;border-radius:2mm;padding:2.5mm;margin:0 0 3mm;background:#f8fafc;font-size:8pt}.score b{display:block;font-size:14pt;letter-spacing:-.02em}.score span{color:#64748b;font-size:7.2pt}.sc-cats{font-size:7.8pt}.sc-top{grid-column:1/5;font-size:8pt;color:#334155}.sc-top span{color:#64748b}
.pcg{display:grid;grid-template-columns:1fr 1fr;gap:3mm}.pc{border:1px solid #e2e8f0;border-left:2.5px solid var(--c);border-radius:1.5mm;padding:2.5mm;break-inside:avoid;font-size:8.4pt}.pch{display:flex;gap:1.5mm;align-items:flex-start}.pch b{font-size:9.4pt;line-height:1.25}.pcm{display:flex;flex-wrap:wrap;gap:1mm 2.5mm;font-size:7.2pt;color:#475569;margin:1mm 0;align-items:center}.pct{font-size:8pt;color:#334155}.pc p{margin:1mm 0;color:#1e293b}.pcf{margin-top:1mm}
.sev{display:inline-flex;gap:.5mm}.sev i{width:1.8mm;height:1.8mm;background:#e2e8f0;display:inline-block;border-radius:.4mm}.sev i.on{background:#be123c}
.st{font-size:6.4pt;letter-spacing:.06em;text-transform:uppercase;padding:.2mm 1.2mm;border-radius:.8mm}.st.ok{background:#ccfbf1;color:#0f766e}.st.cl{background:#ffe4e6;color:#be123c}.st.cx{background:#e2e8f0;color:#334155}
.figrow{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:2mm 0 3mm}.figrow.one{grid-template-columns:1fr;max-width:100mm}.shot{margin:0;break-inside:avoid}.shot img{width:100%;height:auto;border:1px solid #cbd5e1;border-radius:1.5mm;display:block}.shot figcaption{font-size:7.2pt;color:#475569;margin-top:1mm}
.tl td b{font-size:8.6pt}.dot{display:inline-block;width:2mm;height:2mm;border-radius:50%;vertical-align:middle}
.vgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3mm}.vc{border:1px solid #e2e8f0;border-radius:1.5mm;padding:2.5mm;font-size:8.2pt;break-inside:avoid}.vc b{font-size:9.2pt}.vseg{font-size:6.8pt;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;margin:.5mm 0 1mm}.vc p{margin:0 0 1mm;color:#334155}
.qgrid{display:grid;grid-template-columns:1fr 1fr;gap:3mm}.q{margin:0;border:1px solid #e2e8f0;border-radius:1.5mm;padding:2.5mm;background:#f8fafc;break-inside:avoid;font-size:8.4pt}.q p{margin:0 0 1mm;color:#1e293b}.q footer{font-size:7.4pt;color:#64748b}
.steps{padding-left:5mm;font-size:8.4pt;color:#334155}.steps li{margin:1mm 0}.lims{font-size:8.2pt;color:#334155;padding-left:5mm}.lims li{margin:1mm 0}
.ev{list-style:none;margin:0;padding:0;columns:2;column-gap:6mm}.ev li{break-inside:avoid;display:grid;grid-template-columns:9mm 1fr;gap:1.5mm;padding:1.2mm 0;border-bottom:1px solid #e2e8f0;font-size:7.4pt}.sn{font-weight:800;color:#b45309}.ev a{color:#0f172a}.so{color:#64748b;font-size:6.8pt}.url{color:#0369a1;font-size:6.2pt;word-break:break-all;line-height:1.25}
.toc{columns:2;column-gap:8mm;margin:3mm 0 4mm}.toc div{display:flex;justify-content:space-between;gap:2mm;font-size:9.4pt;padding:1.2mm 0;border-bottom:1px dotted #cbd5e1;break-inside:avoid}.toc .n{color:#b45309;font-weight:800;margin-right:2mm}.toc .p{color:#64748b;font-variant-numeric:tabular-nums}.toc .k{display:block;font-size:7.2pt;color:#64748b}
'''

COVER_CSS = r'''
@page{size:A4;margin:0}html,body{margin:0;padding:0}
body{font-family:Inter,"Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif;color:#e5e7eb;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{width:210mm;height:296mm;position:relative;overflow:hidden;background:radial-gradient(900px 500px at 15% 0%,#14213d 0%,transparent 60%),radial-gradient(700px 500px at 100% 10%,#1a1033 0%,transparent 55%),#070b14;padding:22mm 18mm}
.eyebrow{display:inline-block;font-size:8pt;letter-spacing:.16em;text-transform:uppercase;color:#f5b942;border:1px solid rgba(245,185,66,.4);padding:2mm 4mm;border-radius:99px}
h1{font-size:40pt;line-height:1.02;margin:10mm 0 4mm;letter-spacing:-.02em;color:#fff}h1 .y{background:linear-gradient(90deg,#f5b942,#fb7185 50%,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:15pt;color:#cbd5e1;max-width:120mm;line-height:1.3}
.lede{font-size:10.5pt;color:#94a3b8;max-width:118mm;margin-top:6mm}
.globe{position:absolute;right:-36mm;top:82mm;width:170mm;opacity:.95}
.stats{position:absolute;left:18mm;right:18mm;bottom:30mm;display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}
.stat{border:1px solid rgba(148,163,184,.2);border-radius:3mm;padding:3.5mm;background:rgba(255,255,255,.04)}.stat b{display:block;font-size:20pt;color:#fff;letter-spacing:-.02em}.stat span{display:block;font-size:8pt;color:#cbd5e1}
.foot{position:absolute;left:18mm;right:18mm;bottom:14mm;display:flex;justify-content:space-between;font-size:8pt;color:#64748b;border-top:1px solid rgba(148,163,184,.2);padding-top:3mm}
'''

def globe_svg(geo, incs, clon, clat, size=420, dark=False, uid="g"):
    """Static orthographic globe (SVG) with incident markers; geo = build/geo_s.json["countries"]."""
    yaw = -math.radians(clon); pitch = math.radians(clat); R = size*0.47; cx = cy = size/2
    def proj(lon, lat):
        p = math.radians(lat); l = math.radians(lon) + yaw
        x = math.cos(p)*math.sin(l); y = math.sin(p); z = math.cos(p)*math.cos(l)
        y2 = y*math.cos(pitch) - z*math.sin(pitch); z2 = y*math.sin(pitch) + z*math.cos(pitch)
        return cx + x*R, cy - y2*R, z2
    ocean = ("#17406b","#0b2242","#050c18") if dark else ("#dbeafe","#bfdbfe","#93c5fd")
    land_fill = "rgba(45,212,191,0.22)" if dark else "#e2e8f0"; land_stroke = "rgba(125,235,215,0.6)" if dark else "#64748b"
    grat = "rgba(148,163,184,0.16)" if dark else "rgba(15,23,42,0.08)"
    out = [f'<svg viewBox="0 0 {size} {size}" xmlns="http://www.w3.org/2000/svg" style="display:block">',
           f'<defs><clipPath id="{uid}c"><circle cx="{cx}" cy="{cy}" r="{R}"/></clipPath>',
           f'<radialGradient id="{uid}o" cx="35%" cy="32%" r="80%"><stop offset="0" stop-color="{ocean[0]}"/><stop offset=".6" stop-color="{ocean[1]}"/><stop offset="1" stop-color="{ocean[2]}"/></radialGradient>',
           f'<radialGradient id="{uid}r" cx="38%" cy="36%" r="70%"><stop offset="0" stop-color="rgba(255,255,255,0.10)"/><stop offset=".6" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,{0.55 if dark else 0.22})"/></radialGradient></defs>']
    if dark: out.append(f'<circle cx="{cx}" cy="{cy}" r="{R*1.08}" fill="rgba(56,189,248,0.10)"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="url(#{uid}o)"/><g clip-path="url(#{uid}c)">')
    def seg_path(pts):
        d = []; pen = False
        for lon, lat in pts:
            x, y, z = proj(lon, lat)
            if z > 0:
                d.append(('L' if pen else 'M') + f'{x:.1f} {y:.1f}'); pen = True
            else: pen = False
        return " ".join(d)
    gp = []
    for la in range(-60, 61, 30): gp.append(seg_path([(i*5-180, la) for i in range(73)]))
    for lo in range(-180, 180, 30): gp.append(seg_path([(lo, i*5-90) for i in range(37)]))
    out.append(f'<path d="{" ".join(gp)}" fill="none" stroke="{grat}" stroke-width="0.7"/>')
    paths = []
    for c in geo:
        for ring in c['rings']:
            d = []; first = True
            for lon, lat in ring:
                x, y, z = proj(lon, lat)
                if z > -0.01:
                    d.append(('M' if first else 'L') + f'{x:.1f} {y:.1f}'); first = False
            if d: paths.append(" ".join(d) + " Z")
    out.append(f'<path d="{" ".join(paths)}" fill="{land_fill}" stroke="{land_stroke}" stroke-width="0.6" stroke-linejoin="round"/>')
    out.append(f'<rect x="0" y="0" width="{size}" height="{size}" fill="url(#{uid}r)"/></g>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{"rgba(56,189,248,0.5)" if dark else "#94a3b8"}" stroke-width="1"/>')
    mk = []
    for i in incs:
        x, y, z = proj(i['lon'], i['lat'])
        if z > 0.03: mk.append((z, x, y, i))
    mk.sort(key=lambda t: t[0])
    for z, x, y, i in mk:
        col = CAT[i['cat']][1] if dark else PCAT[i['cat']]
        r = (1.6 + i['sev']*0.9) * (0.6 + 0.4*z) * size/420
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r*2.2:.1f}" fill="{col}" opacity="0.18"/>')
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{col}" stroke="#fff" stroke-width="0.8"/>')
        if i['status']=='claimed': out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r+2:.1f}" fill="none" stroke="{col}" stroke-width="0.7" stroke-dasharray="1.5,1.5"/>')
    out.append('</svg>')
    return "".join(out)
