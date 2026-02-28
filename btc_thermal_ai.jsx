// ══════════════════════════════════════════════════════════════════════════════
//  btc_thermal_ai.jsx — BTC On-Chain Thermal Dashboard
//  © Kizoka0x — auteur et éditeur exclusif
//  Source : btc_dashboard.json (btc_pipeline.py — refresh 30 min)
//  Compatible : Babel standalone + React 18 UMD
//
//  Logique de scoring inspirée des analyses on-chain :
//  - SOPR Ratio zones historiques CryptoQuant :
//    * Zone rouge capitulation : 0.4–1.0 (fond 2022 : 0.54, SMA90 0.65)
//    * Ligne intermédiaire : ~3.0
//    * Zone verte (top cycle) : 6.9–15.8
//  - MVRV : 0% percentile = bas de cycle extrême
//  - Mayer < 0.8 = oversold historique
//  - UTXO Zones réelles CQ: >10K=survalorisation, <10=sous-valo, <6=FLAG capitulation
// ══════════════════════════════════════════════════════════════════════════════

const { useState, useEffect, useCallback } = React;

// ─── PALETTES (0=capitulation … 9=euphorie) ──────────────────────────────────
const THERM = [
  { bg:"#1a0a0a", fg:"#ff4444", bd:"#3d0f0f" },
  { bg:"#2d0d0d", fg:"#ff6b6b", bd:"#5c1a1a" },
  { bg:"#4a1010", fg:"#ff8c8c", bd:"#7a1a1a" },
  { bg:"#7a1a1a", fg:"#ffb3b3", bd:"#a02020" },
  { bg:"#c0392b", fg:"#fff",    bd:"#e74c3c"  },
  { bg:"#7d4e00", fg:"#ffd166", bd:"#a56800"  },
  { bg:"#6b6000", fg:"#ffe566", bd:"#8c7d00"  },
  { bg:"#1a4a25", fg:"#69db7c", bd:"#27ae60"  },
  { bg:"#0f3320", fg:"#51cf66", bd:"#2ecc71"  },
  { bg:"#0a2018", fg:"#40c057", bd:"#27ae60"  },
];
const LVL = ["CAPIT.","BEAR EXT.","BEAR FORT","BEAR","PRESSION","NEUTRE","WATCH","POTENTIEL","ACCUM. LT","ACHAT LT"];
const SIG = [
  {bg:"rgba(192,57,43,.25)", fg:"#ff6b6b", bd:"rgba(192,57,43,.4)",  lb:"Bear Extrême"},
  {bg:"rgba(192,57,43,.25)", fg:"#ff6b6b", bd:"rgba(192,57,43,.4)",  lb:"Bear Extrême"},
  {bg:"rgba(231,76,60,.15)", fg:"#ffa8a8", bd:"rgba(231,76,60,.3)",  lb:"Bearish"     },
  {bg:"rgba(231,76,60,.15)", fg:"#ffa8a8", bd:"rgba(231,76,60,.3)",  lb:"Bearish"     },
  {bg:"rgba(243,156,18,.15)",fg:"#ffd166", bd:"rgba(243,156,18,.3)", lb:"Pression"    },
  {bg:"rgba(243,156,18,.15)",fg:"#ffe066", bd:"rgba(241,196,15,.3)", lb:"Neutre"      },
  {bg:"rgba(241,196,15,.15)",fg:"#ffe066", bd:"rgba(241,196,15,.3)", lb:"Watch"       },
  {bg:"rgba(46,204,113,.15)",fg:"#69db7c", bd:"rgba(46,204,113,.3)", lb:"Bullish LT"  },
  {bg:"rgba(39,174,96,.25)", fg:"#51cf66", bd:"rgba(39,174,96,.4)",  lb:"Bullish LT"  },
  {bg:"rgba(26,92,58,.4)",   fg:"#40c057", bd:"rgba(39,174,96,.5)",  lb:"Bull Extrême"},
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const clamp = (v,a,b) => Math.max(a,Math.min(b,Math.round(isNaN(v)?a:v)));
const safe  = (v,fb=0) => (v===undefined||v===null||isNaN(Number(v)))?fb:Number(v);
const f2    = v => safe(v).toFixed(2);
const f4    = v => safe(v).toFixed(4);
const f6    = v => safe(v).toFixed(6);
const fsign = (v,d=2) => (safe(v)>=0?"+":"")+safe(v).toFixed(d);
const pct3  = v => (safe(v)*100).toFixed(3)+"%";
const fM    = v => safe(v)>=1e9?(safe(v)/1e9).toFixed(2)+"B$":safe(v)>=1e6?(safe(v)/1e6).toFixed(1)+"M$":safe(v).toFixed(0)+"$";
const fSign2= (v)=>{const n=safe(v);return(n>=0?"+":"")+n.toFixed(2);};

// ─── FONCTIONS DE SCORING ─────────────────────────────────────────────────────
// Retournent { n,c,m,l } niveaux 0-9 : Maintenant / CT / MT / LT

// ETF proxy (retour 30j ×100, %)
const S_ETF = v =>
  v<=-30?{n:0,c:1,m:2,l:5}:v<=-20?{n:1,c:1,m:2,l:5}:v<=-10?{n:2,c:2,m:3,l:6}:
  v<=-3?{n:3,c:3,m:4,l:6}:v<=0?{n:4,c:4,m:5,l:7}:v<=5?{n:6,c:6,m:6,l:7}:
  v<=15?{n:7,c:7,m:7,l:8}:{n:9,c:8,m:8,l:8};

// USDT SMA30 (déviation proxy)
const S_USDT = v =>
  v<-1e9?{n:1,c:2,m:3,l:6}:v<-2e8?{n:2,c:2,m:3,l:6}:
  v<-3e7?{n:3,c:4,m:5,l:7}:v<=0?{n:4,c:5,m:5,l:7}:
  v<=1e8?{n:6,c:6,m:6,l:7}:{n:8,c:7,m:7,l:8};

// NTV sell count -2…+2
const S_NTV = s =>
  s>=2?{n:2,c:2,m:4,l:6}:s===1?{n:3,c:3,m:5,l:6}:s===0?{n:5,c:5,m:5,l:6}:
  s===-1?{n:7,c:7,m:6,l:7}:{n:8,c:8,m:7,l:7};

// Futures Power 30-70
const S_FUT = v =>
  v<=30?{n:1,c:1,m:2,l:5}:v<=38?{n:2,c:2,m:3,l:5}:v<=44?{n:2,c:2,m:3,l:6}:
  v<=50?{n:3,c:4,m:5,l:6}:v<=55?{n:6,c:6,m:6,l:7}:v<=65?{n:7,c:7,m:7,l:8}:
  {n:9,c:8,m:8,l:8};

// Bull/Bear 30j fraction
const S_BB = v =>
  v<=-0.30?{n:0,c:1,m:2,l:5}:v<=-0.20?{n:1,c:2,m:2,l:5}:v<=-0.10?{n:2,c:2,m:3,l:5}:
  v<=0?{n:3,c:3,m:4,l:5}:v<=0.05?{n:6,c:6,m:6,l:7}:v<=0.15?{n:7,c:7,m:7,l:8}:
  {n:9,c:8,m:8,l:8};

// SOPR Ratio — calibré sur zones CryptoQuant réelles
// Zones historiques : capitulation 2022 = 0.54 (SMA90=0.65), top = 6.9–15.8
// Notre proxy (prix/MA7) reste ~1.0 → seuils resserrés autour de 1
// Pour les vraies valeurs CQ : zone rouge 0.4-1.0, intermédiaire ~3, verte 6.9-15.8
const S_SOPR = v => {
  // Si valeur > 2 → probablement vraie valeur CryptoQuant
  if (v >= 6.9) return {n:9,c:8,m:7,l:4};   // top cycle — zone vente
  if (v >= 3.0) return {n:7,c:7,m:7,l:6};   // ligne intermédiaire bull
  if (v >= 1.5) return {n:6,c:6,m:6,l:6};
  if (v >= 1.05) return {n:6,c:6,m:6,l:6};
  if (v >= 0.995) return {n:4,c:4,m:5,l:6};
  if (v >= 0.970) return {n:3,c:3,m:4,l:7};
  if (v >= 0.700) return {n:2,c:3,m:4,l:8}; // zone rouge basse
  if (v >= 0.540) return {n:1,c:2,m:4,l:9}; // capitulation 2022
  return {n:0,c:2,m:5,l:9};                  // fond extrême (<0.54)
};

// LTH NUPL (0-1)
const S_LTH = v =>
  v<=0.05?{n:1,c:2,m:4,l:9}:v<=0.15?{n:2,c:3,m:4,l:8}:v<=0.30?{n:3,c:4,m:5,l:7}:
  v<=0.50?{n:5,c:5,m:5,l:6}:v<=0.70?{n:6,c:6,m:6,l:5}:v<=0.85?{n:7,c:7,m:7,l:4}:
  {n:8,c:8,m:6,l:3};

// STH NUPL (0-1)
const S_STH = v =>
  v<=0.05?{n:2,c:3,m:4,l:8}:v<=0.15?{n:3,c:3,m:4,l:7}:v<=0.30?{n:4,c:4,m:5,l:7}:
  v<=0.50?{n:5,c:5,m:5,l:6}:v<=0.70?{n:6,c:6,m:6,l:6}:v<=0.85?{n:7,c:7,m:7,l:5}:
  {n:8,c:8,m:7,l:4};

// UTXO ratio P/L réel (source BGeometrics/CryptoQuant)
// Zones réelles: <6=FLAG capitulation, <10=sous-valorisation, >10000=survalorisation
// -1 = indisponible → score neutre 5
const S_UTXO = v =>
  v===-1?{n:5,c:5,m:5,l:5}:                            // indisponible → neutre
  v<6?{n:1,c:2,m:4,l:9}:v<10?{n:2,c:3,m:5,l:8}:      // FLAG / sous-valorisé
  v<100?{n:4,c:5,m:5,l:7}:v<1000?{n:5,c:5,m:5,l:6}:  // normal / neutre
  v<10000?{n:6,c:5,m:5,l:5}:{n:8,c:7,m:6,l:4};        // haussier / survalorisation

// Cohorte (fraction retour)
const S_COH = v =>
  v<=-0.30?{n:0,c:1,m:2,l:5}:v<=-0.15?{n:1,c:2,m:2,l:5}:v<=-0.08?{n:2,c:2,m:3,l:6}:
  v<=0?{n:3,c:3,m:4,l:6}:v<=0.05?{n:6,c:6,m:6,l:7}:v<=0.15?{n:7,c:7,m:7,l:8}:
  {n:9,c:8,m:8,l:8};

// SOV ratio volatilité
const S_SOV = v =>
  v>=1.5?{n:8,c:7,m:7,l:7}:v>=1.3?{n:7,c:6,m:6,l:7}:v>=1.0?{n:5,c:5,m:5,l:6}:
  v>=0.8?{n:4,c:4,m:5,l:6}:{n:3,c:3,m:4,l:5};

// MVRV percentile 0-100
const S_MVRV = v =>
  v<=1?{n:0,c:3,m:5,l:9}:v<=5?{n:1,c:3,m:5,l:9}:v<=15?{n:2,c:4,m:5,l:8}:
  v<=30?{n:4,c:4,m:5,l:7}:v<=55?{n:5,c:5,m:5,l:6}:v<=80?{n:5,c:5,m:5,l:5}:
  v<=90?{n:3,c:3,m:4,l:4}:{n:1,c:2,m:3,l:3};

// Mayer Multiple
const S_MAYER = v =>
  v<=0.55?{n:1,c:3,m:5,l:9}:v<=0.70?{n:1,c:3,m:5,l:8}:v<=0.80?{n:2,c:3,m:5,l:8}:
  v<=1.00?{n:5,c:5,m:5,l:6}:v<=1.50?{n:5,c:5,m:5,l:5}:v<=2.40?{n:3,c:3,m:3,l:4}:
  {n:1,c:2,m:2,l:3};

// Sharpe annualisé
const S_SHARPE = v =>
  v<=-1.5?{n:0,c:3,m:5,l:9}:v<=-0.8?{n:1,c:3,m:5,l:8}:v<=-0.3?{n:2,c:4,m:5,l:7}:
  v<=0.0?{n:4,c:5,m:5,l:6}:v<=0.5?{n:6,c:6,m:6,l:6}:v<=1.0?{n:5,c:5,m:5,l:5}:
  {n:3,c:3,m:4,l:4};

// ─── COMPOSANTS ──────────────────────────────────────────────────────────────

function TCell({level,label}) {
  const t=THERM[clamp(level,0,9)];
  const lines=(label||LVL[clamp(level,0,9)]).split("\n");
  return (
    <td style={{padding:"5px 5px",textAlign:"center"}}>
      <div style={{display:"inline-flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
        width:84,height:46,borderRadius:6,background:t.bg,color:t.fg,border:`1px solid ${t.bd}`,
        fontFamily:"monospace",fontSize:8.5,fontWeight:700,lineHeight:1.25,letterSpacing:.4,textAlign:"center"}}>
        {lines.map((l,i)=><span key={i}>{l}</span>)}
      </div>
    </td>
  );
}

function Badge({level}) {
  const s=SIG[clamp(level,0,9)];
  return <span style={{display:"inline-block",padding:"2px 8px",borderRadius:20,fontSize:9,fontWeight:700,
    textTransform:"uppercase",letterSpacing:.8,background:s.bg,color:s.fg,border:`1px solid ${s.bd}`}}>{s.lb}</span>;
}

// Badge alerte rouge
function AlertR({active,on,off}) {
  if(!active) return <span style={{fontSize:9,color:"#4a5568",marginLeft:6}}>{off||""}</span>;
  return <span style={{display:"inline-block",padding:"1px 7px",borderRadius:4,marginLeft:6,fontSize:9,
    fontWeight:700,background:"rgba(231,76,60,.25)",color:"#ff6b6b",border:"1px solid rgba(231,76,60,.45)"}}>{on}</span>;
}
// Badge alerte verte
function AlertG({active,on,off}) {
  if(!active) return <span style={{fontSize:9,color:"#4a5568",marginLeft:6}}>{off||""}</span>;
  return <span style={{display:"inline-block",padding:"1px 7px",borderRadius:4,marginLeft:6,fontSize:9,
    fontWeight:700,background:"rgba(46,204,113,.2)",color:"#69db7c",border:"1px solid rgba(46,204,113,.4)"}}>{on}</span>;
}
// Badge neutre
function AlertN({val,color}) {
  return <span style={{fontFamily:"monospace",fontSize:10,color:color||"#c9d1d9",marginLeft:6}}>{val}</span>;
}

function SecRow({label}) {
  return (
    <tr>
      <td colSpan={7} style={{background:"rgba(88,166,255,.04)",borderTop:"1px solid rgba(88,166,255,.1)",
        borderBottom:"1px solid rgba(88,166,255,.1)",padding:"5px 14px"}}>
        <span style={{fontFamily:"monospace",fontSize:10,letterSpacing:2,color:"rgba(88,166,255,.7)",textTransform:"uppercase"}}>{label}</span>
      </td>
    </tr>
  );
}

function ScoreCard({label,value,sub,color,grad}) {
  return (
    <div style={{background:"#0d1117",border:"1px solid #1a2030",borderRadius:10,padding:"16px 18px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:grad}}/>
      <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:1.5,marginBottom:6}}>{label}</div>
      <div style={{fontFamily:"monospace",fontSize:24,fontWeight:700,color}}>{value}</div>
      <div style={{fontSize:12,color:"#4a5568",marginTop:4}}>{sub}</div>
    </div>
  );
}

// Ligne de sous-valeur dans une cellule indicateur
function SubVal({label,val,color,alert}) {
  const MUTED="#4a5568";
  return (
    <div style={{display:"flex",alignItems:"baseline",gap:5,fontSize:10,marginTop:2}}>
      <span style={{color:MUTED,whiteSpace:"nowrap"}}>{label}</span>
      <span style={{fontFamily:"monospace",color:color||"#c9d1d9"}}>{val}</span>
      {alert}
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────

function BTCThermalAI() {
  const [data,setData]=useState(null);
  const [status,setStatus]=useState("loading");
  const [errMsg,setErrMsg]=useState("");
  const [hist,setHist]=useState([]);
  const [showHist,setShowHist]=useState(false);

  const BG="#080c10",PANEL="#0d1117",BORDER="#1a2030",MUTED="#4a5568";

  const load=useCallback(async()=>{
    setStatus("loading");
    try {
      const res=await fetch("./btc_dashboard.json?t="+Date.now());
      if(!res.ok) throw new Error("HTTP "+res.status);
      const raw=await res.json();
      setData(raw);
      setStatus("ok");
      const prev=JSON.parse(localStorage.getItem("btc-kizoka-hist")||"[]");
      const next=[{ts:new Date().toLocaleString("fr-FR"),price:raw.btcPrice,mvrv:raw.mvrvPct,
        etf:raw.etf_30d_sum,score:raw.thermalScore},...prev].slice(0,30);
      localStorage.setItem("btc-kizoka-hist",JSON.stringify(next));
      setHist(next);
    } catch(e){setStatus("error");setErrMsg(e.message);}
  },[]);

  useEffect(()=>{
    load();
    setHist(JSON.parse(localStorage.getItem("btc-kizoka-hist")||"[]"));
    const id=setInterval(load,30*60*1000);
    return()=>clearInterval(id);
  },[]);

  if(status==="loading") return (
    <div style={{background:BG,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{fontSize:40,animation:"spin 1.5s linear infinite"}}>⬡</div>
      <div style={{fontFamily:"monospace",color:MUTED,fontSize:14}}>Chargement btc_dashboard.json…</div>
    </div>
  );
  if(status==="error") return (
    <div style={{background:BG,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14,padding:24}}>
      <div style={{fontSize:36,color:"#ff6b6b"}}>✗</div>
      <div style={{fontFamily:"monospace",color:"#ff6b6b",fontSize:14}}>Impossible de charger btc_dashboard.json</div>
      <div style={{color:MUTED,fontSize:12}}>{errMsg}</div>
      <button onClick={load} style={{background:"#1F3864",color:"#74c0fc",border:"1px solid #1F6FEB",borderRadius:6,padding:"8px 20px",fontFamily:"monospace",cursor:"pointer",fontSize:12}}>⟳ Réessayer</button>
    </div>
  );

  const G=(k,fb=0)=>safe(data[k],fb);
  const d=data;

  // ── Scores ────────────────────────────────────────────────────────────────
  const s={
    etf:   S_ETF(G("etf_30d_sum")),
    usdt:  S_USDT(G("usdt_sma30")),
    ntv:   S_NTV(G("ntv_sell_count")),
    fut:   S_FUT(G("futuresPower")),
    bb:    S_BB(G("bullBear30d")),
    sopr:  S_SOPR(G("soprRatio",1)),
    lth:   S_LTH(G("lthNupl")),
    sth:   S_STH(G("sthNupl")),
    utxo:  S_UTXO(G("utxoRatio",-1)),
    c10k:  S_COH(G("coh_10k_plus")),
    c1k:   S_COH(G("coh_1k_10k")),
    c100:  S_COH(G("coh_100_1k")),
    sov:   S_SOV(G("sov_btc_1k_10k",1)),
    mvrv:  S_MVRV(G("mvrvPct")),
    mayer: S_MAYER(G("mayerMultiple",1)),
    shrp:  S_SHARPE(G("sharpeShort")),
  };

  const allN=Object.values(s).map(x=>x.n);
  const avgScore=(allN.reduce((a,b)=>a+b,0)/allN.length).toFixed(1);
  const bearCount=allN.filter(v=>v<=4).length;
  const bullCount=allN.filter(v=>v>=7).length;
  const avgNum=parseFloat(avgScore);
  const avgColor=avgNum<4?"#ff6b6b":avgNum<6?"#ffe066":"#69db7c";
  const avgGrad=avgNum<4?"linear-gradient(90deg,#c0392b,#e74c3c)":avgNum<6?"linear-gradient(90deg,#f39c12,#f1c40f)":"linear-gradient(90deg,#27ae60,#2ecc71)";

  // ── Checklist BOTTOM ──────────────────────────────────────────────────────
  // Basée sur les analyses CryptoQuant (Darkfost, AxelAdler, GugaOnChain...)
  // Signal achat fort = déclenchement simultané SOPR Alert + UTXO Flag
  // + retour Futures Power > 50% + MVRV bas cycle + Mayer < 0.8
  const checksBot = [
    { ok: G("etf_30d_sum")    >=  0,       label: "ETF 30D Sum ≥ 0"                    },
    { ok: G("futuresPower")   >   52,       label: "Futures Power > 52%"                },
    { ok: G("usdt_sma30")     >   0,        label: "USDT SMA(30) positif"               },
    { ok: G("soprAlert")      === 1,        label: "SOPR Alert = 1 (capitulation LTH)"  },
    { ok: G("utxoFlag")       === 1,        label: "UTXO Flag = 1 (ratio P/L < 6 — capitulation CQ)"       },
    { ok: G("bullBear30d")    >   0,        label: "Bull/Bear 30j > 0"                  },
    { ok: G("mvrvPct")        <=  5,        label: "MVRV percentile ≤ 5%"               },
    { ok: G("mayerAlert")     === 1,        label: "Mayer Multiple < 0.80"              },
    { ok: G("sharpeShort")    <  -0.3,      label: "Sharpe négatif (low risk)"          },
    { ok: G("lthNupl")        <   0.20,     label: "LTH NUPL < 0.20 (bas cycle)"        },
  ];
  const scoreBot=checksBot.filter(c=>c.ok).length;
  const colorBot=scoreBot>=7?"#69db7c":scoreBot>=4?"#ffe066":"#ff6b6b";
  const gradBot=scoreBot>=7?"linear-gradient(90deg,#27ae60,#2ecc71)":scoreBot>=4?"linear-gradient(90deg,#f39c12,#f1c40f)":"linear-gradient(90deg,#c0392b,#e74c3c)";

  // ── Checklist TOP ─────────────────────────────────────────────────────────
  // Zones top historiques CryptoQuant :
  // SOPR > 6.9–15.8, MVRV percentile > 90%, Mayer > 2.4
  // LTH NUPL > 0.70 (distribution), Futures Power > 65 (euphorie)
  const checksTop = [
    { ok: G("etf_30d_sum")    >=  20,       label: "ETF 30D Sum ≥ +20%"                 },
    { ok: G("futuresPower")   >   65,       label: "Futures Power > 65 (euphorie)"      },
    { ok: G("usdt_sma30")     <  -2e8,      label: "USDT SMA(30) négatif (pression)"    },
    { ok: G("soprRatio")      >   3.0,      label: "SOPR Ratio > 3.0 (ligne médiane)"   },
    { ok: G("utxoRatio")      > 10000,      label: "UTXO Ratio > 10 000 (survalorisation CQ — zone vente)" },
    { ok: G("bullBear30d")    >   0.25,     label: "Bull/Bear 30j > +25%"               },
    { ok: G("mvrvPct")        >   85,       label: "MVRV percentile > 85%"              },
    { ok: G("mayerMultiple")  >   2.0,      label: "Mayer Multiple > 2.0 (euphorie)"    },
    { ok: G("sharpeShort")    >   1.0,      label: "Sharpe > 1.0 (rendement élevé)"     },
    { ok: G("lthNupl")        >   0.70,     label: "LTH NUPL > 0.70 (distribution)"     },
  ];
  const scoreTop=checksTop.filter(c=>c.ok).length;
  const colorTop=scoreTop>=7?"#ff6b6b":scoreTop>=4?"#ffa94d":"#69db7c";
  const gradTop=scoreTop>=7?"linear-gradient(90deg,#c0392b,#e74c3c)":scoreTop>=4?"linear-gradient(90deg,#f39c12,#f1c40f)":"linear-gradient(90deg,#27ae60,#2ecc71)";

  // ── Helpers affichage cohorte ─────────────────────────────────────────────
  const cohLbl=(v)=>v>0.05?"ACCUM.▲":v<-0.05?"DISTRIB.▼":"NEUTRE";
  const cohColor=(v)=>v>0.05?"#69db7c":v<-0.05?"#ff6b6b":"#ffe066";
  const ntvLbl=["Double Buy ▲▲","Buy ▲","Neutre","Sell ▼","Double Sell ▼▼"][G("ntv_sell_count")+2]||"?";

  // ── Lignes tableau (ordre exact des sections) ─────────────────────────────
  const rows = [

    // ── SECTION 1 : Flux & Liquidité ────────────────────────────────────────
    {
      sec:"── Flux & Liquidité",
      name:"Bitcoin: ETF Daily",
      sub_detail:<>
        <SubVal label="Total Netflow 30D Sum" val={fSign2(G("etf_30d_sum"))+"%"} color={G("etf_30d_sum")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="ETF Netflow USD" val={fM(G("etf_netflow_usd"))} color={G("etf_netflow_usd")<0?"#ff6b6b":"#69db7c"}/>
      </>,
      sc:s.etf, nowL:G("etf_30d_sum")<=-20?"FUITE\nMASS.":G("etf_30d_sum")<0?"SORTIE\nACTIVE":"POSITIF",hz:"CT/MT"
    },
    {
      sec:null,
      name:"Stablecoin USDT — Market Cap Change",
      sub_detail:<>
        <SubVal label="Daily MC change" val={fM(G("usdt_daily_mc"))} color={G("usdt_daily_mc")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="USDT SMA(30)" val={fM(G("usdt_sma30"))} color={G("usdt_sma30")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="60d MC change" val={fM(G("usdt_60d_change"))} color={G("usdt_60d_change")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="60d SMA(30)" val={fM(G("usdt_60d_sma30"))} color={G("usdt_60d_sma30")<0?"#ff6b6b":"#69db7c"}/>
      </>,
      sc:s.usdt, nowL:G("usdt_sma30")<-5e8?"CONTRACTION":G("usdt_sma30")<0?"NEUTRE−":"POSITIF",hz:"CT/MT"
    },
    {
      sec:null,
      name:"Net Taker Volume Binance (25h)",
      sub_detail:<>
        <SubVal label="NTV 25h" val={fM(G("ntv_25h"))} color={G("ntv_25h")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="Signal" val={ntvLbl} color={G("ntv_sell_count")>=1?"#ff6b6b":G("ntv_sell_count")<=-1?"#69db7c":"#ffe066"}/>
        <SubVal label="Light Buy" val={G("ntv_light_buy")?"ON":"—"} color={G("ntv_light_buy")?"#69db7c":MUTED}/>
        <SubVal label="Strong Buy" val={G("ntv_strong_buy")?"ON":"—"} color={G("ntv_strong_buy")?"#40c057":MUTED}/>
        <SubVal label="Light Sell" val={G("ntv_light_sell")?"ON":"—"} color={G("ntv_light_sell")?"#ffa94d":MUTED}/>
        <SubVal label="Strong Sell" val={G("ntv_strong_sell")?"ON":"—"} color={G("ntv_strong_sell")?"#ff6b6b":MUTED}/>
      </>,
      sc:s.ntv, nowL:G("ntv_sell_count")>=2?"DOUBLE\nSELL":G("ntv_sell_count")<=-2?"DOUBLE\nBUY":"NEUTRE",hz:"CT"
    },

    // ── SECTION 2 : Dérivés & Structure ─────────────────────────────────────
    {
      sec:"── Dérivés & Structure de marché",
      name:"Futures Power 30D Change",
      sub_detail:<>
        <SubVal label="Market Power %" val={f2(G("futuresPower"))+"%"} color={G("futuresPower")<50?"#ff6b6b":"#69db7c"}/>
        <SubVal label="Index" val={f4(G("futuresIndex"))} color="#c9d1d9"/>
        <SubVal label="Line (SMA7 Index)" val={f4(G("futuresLine"))} color="#74c0fc"/>
        <SubVal label="Index 30d Change" val={fsign(G("futures30dChange"),4)} color={G("futures30dChange")<0?"#ff6b6b":"#69db7c"}/>
      </>,
      sc:s.fut, nowL:G("futuresPower")<45?"BEARS\nDOMINENT":G("futuresPower")<50?"SOUS\n50%":"BULL\n>50%",hz:"CT/MT"
    },
    {
      sec:null,
      name:"Bull/Bear Cycle Indicator",
      sub_detail:<>
        <SubVal label="Bull-Bear 365d MA" val={fsign(G("bullBear365d"),4)} color={G("bullBear365d")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="Bull-Bear 30d MA" val={fsign(G("bullBear30d"),4)} color={G("bullBear30d")<0?"#ff6b6b":"#69db7c"}/>
        <SubVal label="Overheated Bull" val={G("bb_overheated_bull")?"✓":"—"} color={G("bb_overheated_bull")?"#ff4d6d":MUTED}/>
        <SubVal label="Bull" val={G("bb_bull")?"✓":"—"} color={G("bb_bull")?"#69db7c":MUTED}/>
        <SubVal label="Early Bull" val={G("bb_early_bull")?"✓":"—"} color={G("bb_early_bull")?"#a9e34b":MUTED}/>
        <SubVal label="Bear" val={G("bb_bear")?"✓":"—"} color={G("bb_bear")?"#ffa94d":MUTED}/>
        <SubVal label="Extreme Bear" val={G("bb_extreme_bear")?"✓":"—"} color={G("bb_extreme_bear")?"#ff6b6b":MUTED}/>
      </>,
      sc:s.bb, nowL:G("bullBear30d")<-0.20?"BEAR\nSTRUCT.":G("bullBear30d")<0?"BEAR\nACTIF":"BULL\nACTIF",hz:"CT/MT"
    },

    // ── SECTION 3 : Profitabilité & Holders ─────────────────────────────────
    {
      sec:"── Profitabilité & Comportement des holders",
      name:"LTH/STH SOPR Ratio",
      sub_detail:<>
        <SubVal label="Alert" val={G("soprAlert")===1?"= 1 🚨":"= 0"} color={G("soprAlert")===1?"#ff6b6b":"#69db7c"}
          alert={<AlertR active={G("soprAlert")===1} on="CAPITULATION LTH"/>}/>
        <SubVal label="SOPR Ratio" val={f4(G("soprRatio",1))} color={G("soprRatio",1)<1?"#ff6b6b":G("soprRatio",1)>3?"#69db7c":"#ffe066"}/>
        <SubVal label="SMA(90)" val={f4(G("soprSma90",1))} color="#74c0fc"/>
      </>,
      sc:s.sopr, nowL:G("soprAlert")===1?"ALERTE\nACTIVE":G("soprRatio",1)<0.97?"ZONE\nROUGE":G("soprRatio",1)<1?"SOUS 1":"OK",hz:"MT"
    },
    {
      sec:null,
      name:"BTC NUPL — aLTH / aSTH",
      sub_detail:<>
        <SubVal label="aLTH" val={f4(G("lthNupl"))} color={G("lthNupl")<0.15?"#ff6b6b":G("lthNupl")>0.5?"#69db7c":"#ffe066"}/>
        <SubVal label="aSTH" val={f4(G("sthNupl"))} color={G("sthNupl")<0.15?"#ff6b6b":G("sthNupl")>0.5?"#69db7c":"#ffe066"}/>
        <SubVal label="Average aNUPL" val={f4(G("nuplAvg"))} color={G("nuplAvg")<0.15?"#ff6b6b":"#c9d1d9"}/>
        <SubVal label="Line" val={f4(G("nuplLine"))} color="#74c0fc"/>
      </>,
      sc:s.lth, nowL:G("lthNupl")<0.10?"FOND\nLT":G("lthNupl")<0.25?"BAS\nCYCLE":"MOYEN",hz:"MT/LT"
    },
    {
      sec:null,
      name:"UTXO Block P/L Count Ratio",
      sub_detail:<>
        <SubVal label="Ratio P/L" val={G("utxoRatio")===-1?"N/A":G("utxoRatio")>=10000?G("utxoRatio").toFixed(0)+"K":f2(G("utxoRatio"))} color={G("utxoRatio")===-1?"#4a5568":G("utxoRatio")<6?"#ff4444":G("utxoRatio")<10?"#ffa94d":"#c9d1d9"}
          alert={<AlertR active={G("utxoFlag")===1} on="FLAG=1 🚨 (ratio<6)"/>}/>
        <SubVal label="Zone" val={G("utxoRatio")===-1?"N/A (proxy indispo)":G("utxoRatio")>=10000?"Survalorisation ⚠":G("utxoRatio")>=10?"Normal":G("utxoRatio")>=6?"Sous-valorisé 🟡":"FLAG < 6 🔴"} color={G("utxoRatio")===-1?"#4a5568":G("utxoRatio")>=10000?"#ff4444":G("utxoRatio")>=10?"#c9d1d9":G("utxoRatio")>=6?"#ffa94d":"#ff4444"}/>
        <SubVal label="Flag" val={G("utxoFlag")===1?"= 1 ⚡":"= 0"} color={G("utxoFlag")===1?"#ff4444":"#69db7c"}/>
      </>,
      sc:s.utxo, nowL:G("utxoFlag")===1?"FLAG\nACTIF":G("utxoRatio")===-1?"N/A":G("utxoRatio")<10?"SOUS\nVALO":G("utxoRatio")>=10000?"SUR\nVALO":"NORMAL",hz:"MT/LT"
    },
    {
      sec:null,
      name:"Accumulation vs Distribution — Cohortes (60D)",
      sub_detail:<>
        <SubVal label=">10k BTC" val={fsign(G("coh_10k_plus"),3)} color={cohColor(G("coh_10k_plus"))}/>
        <SubVal label="1k–10k BTC" val={fsign(G("coh_1k_10k"),3)} color={cohColor(G("coh_1k_10k"))}/>
        <SubVal label="100–1k BTC" val={fsign(G("coh_100_1k"),3)} color={cohColor(G("coh_100_1k"))}/>
        <SubVal label="10–100 BTC" val={fsign(G("coh_10_100"),3)} color={cohColor(G("coh_10_100"))}/>
        <SubVal label="1–10 BTC" val={fsign(G("coh_1_10"),3)} color={cohColor(G("coh_1_10"))}/>
        <SubVal label="0.1–1 BTC" val={fsign(G("coh_01_1"),3)} color={cohColor(G("coh_01_1"))}/>
        <SubVal label="0–0.1 BTC" val={fsign(G("coh_0_01"),3)} color={cohColor(G("coh_0_01"))}/>
      </>,
      sc:s.c10k, nowL:cohLbl(G("coh_10k_plus")),hz:"LT"
    },
    {
      sec:null,
      name:"Spent Output Value Bands",
      sub_detail:<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 10px",marginBottom:4}}>
          {[["0–1","sov_btc_0_1","sov_btc_0_1_sma7"],["1–10","sov_btc_1_10","sov_btc_1_10_sma7"],
            ["10–100","sov_btc_10_100","sov_btc_10_100_sma7"],["100–1k","sov_btc_100_1k","sov_btc_100_1k_sma7"],
            ["1k–10k","sov_btc_1k_10k","sov_btc_1k_10k_sma7"],[">10k","sov_btc_10k_inf","sov_btc_10k_inf_sma7"]
          ].map(([l,k,ks])=>(
            <div key={k} style={{fontSize:9,color:"#4a5568",marginBottom:2}}>
              <span style={{display:"block",color:"#6b7280"}}>{`btc_${l}`}</span>
              <span style={{fontFamily:"monospace",color:G(k,1)>1.3?"#ff6b6b":G(k,1)>1.1?"#ffa94d":"#c9d1d9"}}>{f4(G(k,1))}</span>
              <span style={{fontFamily:"monospace",color:"#4a5568",marginLeft:4,fontSize:8}}>s7:{f4(G(ks,1))}</span>
            </div>
          ))}
        </div>
        <SubVal label="Total SMA7" val={f4(G("sov_total_sma7",1))} color="#74c0fc"
          alert={<AlertR active={G("sov_signal")===1} on="⚡ MOUVEMENT MAJEUR"/>}/>
        <SubVal label="Avg Price (7j)" val={"$"+f2(G("sov_avg_price"))} color="#ffe066"/>
      </>,
      sc:s.sov, nowL:G("sov_signal")===1?"MOUVEMENT\nMAJEUR":G("sov_btc_1k_10k",1)>1.3?"ACTIVITÉ\nHAUTE":"NORMALE",hz:"MT/LT"
    },

    // ── SECTION 4 : Valorisation LT ─────────────────────────────────────────
    {
      sec:"── Valorisation & Risque Long Terme",
      name:"MVRV Percentile — Current Cycle",
      sub_detail:<>
        <SubVal label="MVRV (7-day)" val={f4(G("mvrv_7d"))} color="#c9d1d9"/>
        <SubVal label="Log-MVRV (7-day)" val={f4(G("mvrv_log_7d"))} color="#c9d1d9"/>
        <SubVal label="Z-Score (365d)" val={f4(G("mvrv_zscore_365d"))} color={G("mvrv_zscore_365d")<-1?"#69db7c":G("mvrv_zscore_365d")>2?"#ff6b6b":"#c9d1d9"}/>
        <SubVal label="Z-Score (4yr)" val={f4(G("mvrv_zscore_4yr"))} color="#74c0fc"/>
        <SubVal label="Percentile Cycle" val={f2(G("mvrvPct"))+"%" } color={G("mvrvPct")<=5?"#69db7c":G("mvrvPct")>=85?"#ff6b6b":"#c9d1d9"}
          alert={G("mvrv_low_signal")===1?<AlertG active={true} on="LOW SIGNAL ⬡"/>:G("mvrv_high_signal")===1?<AlertR active={true} on="HIGH SIGNAL ⚠"/>:null}/>
        <SubVal label="Z-Score" val={f4(G("mvrv_zscore"))} color="#c9d1d9"/>
        <div style={{fontSize:9,color:G("mvrv_low_signal")===1?"#69db7c":G("mvrv_high_signal")===1?"#ff6b6b":MUTED,marginTop:3,fontStyle:"italic"}}>{d.mvrv_zone||""}</div>
      </>,
      sc:s.mvrv, nowL:G("mvrvPct")<=2?"PLANCHER\n0%":G("mvrvPct")<=10?"ZONE\nACCUM.":"BAS\nCYCLE",hz:"LT"
    },
    {
      sec:null,
      name:"Mayer Multiple",
      sub_detail:<>
        <SubVal label="Mayer Multiple" val={f6(G("mayerMultiple",1))} color={G("mayerMultiple",1)<0.8?"#69db7c":G("mayerMultiple",1)>2.4?"#ff6b6b":"#c9d1d9"}
          alert={<AlertG active={G("mayerAlert")===1} on="🟢 OVERSOLD"/>}/>
        <SubVal label="SMA-200D" val={"$"+f2(G("mayer_sma200"))} color="#74c0fc"/>
        <SubVal label="Oversold (<0.80)" val={G("mayer_oversold")===1?"ACTIF":"—"} color={G("mayer_oversold")===1?"#69db7c":MUTED}/>
        <SubVal label="Overbought (>2.40)" val={G("mayer_overbought")===1?"ACTIF":"—"} color={G("mayer_overbought")===1?"#ffa94d":MUTED}/>
        <SubVal label="High Overbought (>3.5)" val={G("mayer_hi_overbought")===1?"ACTIF":"—"} color={G("mayer_hi_overbought")===1?"#ff4444":MUTED}/>
        <SubVal label="Alert" val={G("mayerAlert")===1?"= 1 ✓":"= 0"} color={G("mayerAlert")===1?"#69db7c":"#ff6b6b"}/>
      </>,
      sc:s.mayer, nowL:G("mayerMultiple",1)<=0.70?"OVERSOLD\nEXTRÊME":G("mayerMultiple",1)<=0.80?"OVERSOLD\nLT":"NORMAL",hz:"LT"
    },
    {
      sec:null,
      name:"Sharpe Ratio (short term)",
      sub_detail:<>
        <SubVal label="Sharpe Ratio" val={f6(G("sharpeShort"))} color={G("sharpeShort")<-0.3?"#69db7c":G("sharpeShort")>1?"#ff6b6b":"#c9d1d9"}
          alert={G("sharpeShort")<-0.3?<AlertG active={true} on="LOW RISK ZONE"/>:null}/>
        <div style={{fontSize:9,color:MUTED,marginTop:2,fontStyle:"italic"}}>4ème occurrence zone négative depuis 2012</div>
      </>,
      sc:s.shrp, nowL:G("sharpeShort")<=-0.8?"LOW\nRISK":G("sharpeShort")<=-0.3?"NÉGATIF":"NEUTRE",hz:"LT"
    },
  ];

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{background:BG,color:"#c9d1d9",fontFamily:"Arial,sans-serif",minHeight:"100vh",padding:"20px 22px",
      backgroundImage:"radial-gradient(ellipse at 20% 20%,rgba(88,166,255,.04) 0%,transparent 60%),radial-gradient(ellipse at 80% 80%,rgba(255,107,107,.03) 0%,transparent 60%)"}}>

      {/* ── HEADER ────────────────────────────────────────────────────────── */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,paddingBottom:16,borderBottom:`1px solid ${BORDER}`,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontFamily:"monospace",fontSize:20,fontWeight:700,color:"#fff",letterSpacing:-.5}}>⬡ BTC ON-CHAIN — TABLEAU THERMIQUE</div>
          <div style={{fontSize:12,color:MUTED,marginTop:3}}>
            Source :&nbsp;<code style={{color:"#74c0fc",background:"rgba(88,166,255,.1)",padding:"1px 6px",borderRadius:3,fontSize:11}}>Pipeline On-Chain propriétaire</code>
            &nbsp;·&nbsp;
            <code style={{color:"#69db7c",background:"rgba(46,204,113,.08)",padding:"1px 6px",borderRadius:3,fontSize:11}}>Données agrégées (Exchanges / On-chain)</code>
          </div>
          <div style={{fontSize:11,color:"#2ecc71",marginTop:3}}>✓ {d.updated||"—"} UTC</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
          <div style={{fontFamily:"monospace",fontSize:28,fontWeight:700,color:"#ffe066"}}>${(G("btcPrice")/1000).toFixed(2)}K</div>
          <div style={{fontSize:11,color:MUTED}}>Thermal Score :&nbsp;
            <span style={{color:avgColor,fontFamily:"monospace",fontWeight:700}}>{avgScore}/9</span></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={load} style={{background:"#1F3864",color:"#74c0fc",border:"1px solid #1F6FEB",borderRadius:6,padding:"6px 14px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>⟳ RECHARGER</button>
            <button onClick={()=>setShowHist(h=>!h)} style={{background:PANEL,color:"#c9d1d9",border:`1px solid ${BORDER}`,borderRadius:6,padding:"6px 14px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>📜 HISTORIQUE</button>
          </div>
        </div>
      </div>

      {/* ── HISTORIQUE ────────────────────────────────────────────────────── */}
      {showHist&&(
        <div style={{marginBottom:16,background:PANEL,border:`1px solid ${BORDER}`,borderRadius:10,overflow:"hidden"}}>
          <div style={{padding:"9px 16px",borderBottom:`1px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontFamily:"monospace",fontSize:10,color:"rgba(88,166,255,.7)",textTransform:"uppercase",letterSpacing:2}}>── Historique des sessions</span>
            <button onClick={()=>{localStorage.removeItem("btc-kizoka-hist");setHist([]);}} style={{background:"transparent",color:MUTED,border:`1px solid ${BORDER}`,borderRadius:4,padding:"3px 9px",fontSize:10,cursor:"pointer"}}>🗑 Effacer</button>
          </div>
          <div style={{padding:14,overflowX:"auto"}}>
            {hist.length===0?<div style={{color:MUTED,fontSize:12}}>Aucun historique</div>:
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,fontFamily:"monospace"}}>
                <thead><tr>{["Date","BTC","MVRV%","ETF 30D","Score"].map(h=><th key={h} style={{textAlign:"left",padding:"3px 10px",color:MUTED,fontSize:10,fontWeight:400}}>{h}</th>)}</tr></thead>
                <tbody>{hist.slice(0,10).map((h,i)=>(
                  <tr key={i} style={{borderTop:`1px solid rgba(255,255,255,.04)`}}>
                    <td style={{padding:"4px 10px",color:"#c9d1d9"}}>{h.ts}</td>
                    <td style={{padding:"4px 10px",color:"#ffe066"}}>${(safe(h.price)/1000).toFixed(2)}K</td>
                    <td style={{padding:"4px 10px",color:"#74c0fc"}}>{f2(h.mvrv)}%</td>
                    <td style={{padding:"4px 10px",color:safe(h.etf)<0?"#ff6b6b":"#69db7c"}}>{fSign2(h.etf)}%</td>
                    <td style={{padding:"4px 10px",color:"#ffe066"}}>{h.score?f2(h.score):"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            }
          </div>
        </div>
      )}

      {/* ── 2 SCORE CARDS (Signal CT/MT + Score Thermique uniquement) ──────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:18}}>
        <ScoreCard
          label="Signal CT/MT Global"
          value={bearCount>=allN.length*0.7?"BEARISH":bearCount>=allN.length*0.5?"MIXTE−":"MIXTE"}
          sub={`${bearCount}/${allN.length} indicateurs baissiers · ${bullCount} signaux LT bullish`}
          color="#ff6b6b"
          grad="linear-gradient(90deg,#c0392b,#e74c3c)"
        />
        <ScoreCard
          label="Score Thermique Moyen (0–9)"
          value={avgScore}
          sub={`${bearCount}/${allN.length} indicateurs · Bottom ${scoreBot}/10 · Top ${scoreTop}/10`}
          color={avgColor}
          grad={avgGrad}
        />
      </div>

      {/* ── LÉGENDE ───────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
        <span style={{fontSize:11,color:MUTED,textTransform:"uppercase",letterSpacing:1}}>Thermique →</span>
        <div style={{display:"flex",borderRadius:4,overflow:"hidden",height:16,flex:1,maxWidth:280}}>
          {["#1a0a0a","#3d0f0f","#7a1a1a","#c0392b","#e74c3c","#f39c12","#f1c40f","#2ecc71","#27ae60","#1a5c3a"].map((bg,i)=><div key={i} style={{flex:1,background:bg}}/>)}
        </div>
        <span style={{fontSize:11,color:MUTED}}>Capitulation → Euphorie</span>
      </div>

      {/* ── TABLE ─────────────────────────────────────────────────────────── */}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{borderBottom:`2px solid ${BORDER}`}}>
              {["Indicateur / Valeurs détaillées","Maintenant","CT (1–4 sem)","MT (1–3 mois)","LT (6–18 mois)","Signal","Hz"]
                .map((h,i)=>(
                  <th key={i} style={{fontFamily:"monospace",fontSize:9,textTransform:"uppercase",letterSpacing:1.5,color:MUTED,
                    padding:"10px 10px",textAlign:i===0?"left":"center",fontWeight:400,whiteSpace:"nowrap"}}>{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row,ri)=>(
              <React.Fragment key={ri}>
                {row.sec&&<SecRow label={row.sec}/>}
                <tr style={{borderBottom:`1px solid rgba(255,255,255,.04)`}}>
                  <td style={{padding:"10px 12px",verticalAlign:"top",minWidth:230}}>
                    <div style={{fontWeight:600,color:"#e6edf3",fontSize:12,marginBottom:4}}>{row.name}</div>
                    {row.sub_detail}
                  </td>
                  <TCell level={row.sc.n} label={row.nowL}/>
                  <TCell level={row.sc.c} label={LVL[clamp(row.sc.c,0,9)]}/>
                  <TCell level={row.sc.m} label={LVL[clamp(row.sc.m,0,9)]}/>
                  <TCell level={row.sc.l} label={LVL[clamp(row.sc.l,0,9)]}/>
                  <td style={{padding:"6px 8px",textAlign:"center"}}><Badge level={row.sc.n}/></td>
                  <td style={{padding:"6px 8px",textAlign:"center",fontSize:10,color:MUTED,whiteSpace:"nowrap"}}>{row.hz}</td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── ZONES PRIX ────────────────────────────────────────────────────── */}
      <div style={{marginTop:20,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {[
          {z:"$65–68K",p:"Probabilité bottom : faible",l:"⚠ Distribution active",c:"#e74c3c",a:"#c0392b"},
          {z:"$58–63K",p:"Support STH cost basis",     l:"⬇ CT probable",         c:"#ffa94d",a:"#f39c12"},
          {z:"$50–58K",p:"Cible scénario central",     l:"🎯 Bottom le + probable",c:"#ffe066",a:"#f1c40f"},
          {z:"$42–50K",p:"Si SOPR Alert + UTXO Flag",  l:"⚡ Capitulation extrême",c:"#da77f2",a:"#9b59b6"},
        ].map((z,i)=>(
          <div key={i} style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:8,padding:"13px 14px",position:"relative",overflow:"hidden"}}>
            <div style={{fontSize:15,fontFamily:"monospace",fontWeight:700,color:"#fff"}}>{z.z}</div>
            <div style={{fontSize:10,color:MUTED,marginTop:4}}>{z.p}</div>
            <div style={{fontSize:10,marginTop:8,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:z.c}}>{z.l}</div>
            <div style={{position:"absolute",bottom:0,left:0,right:0,height:3,background:z.a}}/>
          </div>
        ))}
      </div>

      {/* ── CARDS BOTTOM & TOP côte à côte ────────────────────────────────── */}
      <div style={{marginTop:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>

        {/* CARD BOTTOM */}
        <div style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:10,padding:16,borderLeft:"3px solid #58a6ff"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"rgba(88,166,255,.7)",textTransform:"uppercase",letterSpacing:2}}>
              ── Conditions pour Valider le Bottom
            </div>
            <span style={{fontFamily:"monospace",fontSize:14,fontWeight:700,color:colorBot,
              background:scoreBot>=7?"rgba(46,204,113,.15)":scoreBot>=4?"rgba(243,156,18,.15)":"rgba(231,76,60,.15)",
              border:`1px solid ${scoreBot>=7?"rgba(46,204,113,.3)":scoreBot>=4?"rgba(243,156,18,.3)":"rgba(231,76,60,.3)"}`,
              padding:"2px 10px",borderRadius:20}}>{scoreBot}/10</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
            {checksBot.map((c,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:11,padding:"3px 0"}}>
                <span style={{color:c.ok?"#2ecc71":"#e74c3c",fontSize:14,minWidth:14}}>{c.ok?"✓":"✗"}</span>
                <span style={{color:c.ok?"#69db7c":"#9ca3af"}}>{c.label}</span>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,fontSize:12}}>
            <span style={{fontWeight:700,color:"#ffd166"}}>Score : {scoreBot}/10 — </span>
            <span style={{color:"#718096"}}>
              {scoreBot>=7?"⚡ Signal d'achat fort — confirmer price action":
               scoreBot>=4?"⏳ Signaux LT actifs — attendre déclencheurs directionnels":
               "❌ Retournement non validé — patience"}
            </span>
          </div>
          <div style={{marginTop:8,fontSize:10,color:MUTED,fontStyle:"italic",borderTop:`1px solid rgba(255,255,255,.04)`,paddingTop:8}}>
            Signal fort historique = SOPR Alert=1 + UTXO Flag=1 simultanément<br/>
            Réf. capitulation 2022 : SOPR≈0.54, SMA90≈0.65, Mayer≈0.67
          </div>
        </div>

        {/* CARD TOP */}
        <div style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:10,padding:16,borderLeft:"3px solid #e74c3c"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"rgba(231,76,60,.7)",textTransform:"uppercase",letterSpacing:2}}>
              ── Conditions pour Valider le Top
            </div>
            <span style={{fontFamily:"monospace",fontSize:14,fontWeight:700,color:colorTop,
              background:scoreTop>=7?"rgba(231,76,60,.2)":scoreTop>=4?"rgba(243,156,18,.15)":"rgba(46,204,113,.12)",
              border:`1px solid ${scoreTop>=7?"rgba(231,76,60,.4)":scoreTop>=4?"rgba(243,156,18,.3)":"rgba(46,204,113,.3)"}`,
              padding:"2px 10px",borderRadius:20}}>{scoreTop}/10</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
            {checksTop.map((c,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:11,padding:"3px 0"}}>
                <span style={{color:c.ok?"#e74c3c":"#4a5568",fontSize:14,minWidth:14}}>{c.ok?"✓":"✗"}</span>
                <span style={{color:c.ok?"#ff6b6b":"#9ca3af"}}>{c.label}</span>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,fontSize:12}}>
            <span style={{fontWeight:700,color:"#ffd166"}}>Score : {scoreTop}/10 — </span>
            <span style={{color:"#718096"}}>
              {scoreTop>=7?"🔴 Signal de vente/prudence fort — distribution active":
               scoreTop>=4?"⚠ Signaux de sommet en formation — surveiller":
               "✅ Pas de signal de sommet — marché non en euphorie"}
            </span>
          </div>
          <div style={{marginTop:8,fontSize:10,color:MUTED,fontStyle:"italic",borderTop:`1px solid rgba(255,255,255,.04)`,paddingTop:8}}>
            Signal top historique = SOPR &gt; 6.9–15.8 + MVRV &gt; 85% + Mayer &gt; 2.4<br/>
            Réf. tops 2021 : SOPR≈15.8, MVRV≈95%, Mayer≈3.5
          </div>
        </div>

      </div>

      {/* ── FOOTER ────────────────────────────────────────────────────────── */}
      <div style={{marginTop:18,paddingTop:14,borderTop:`1px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:11,color:MUTED,fontStyle:"italic"}}>
          Site de Kizoka0x
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <a href="https://t.me/Kizoka0x" target="_blank" rel="noopener noreferrer"
            style={{display:"flex",alignItems:"center",gap:6,textDecoration:"none",
              background:"rgba(41,182,246,.12)",border:"1px solid rgba(41,182,246,.3)",
              borderRadius:6,padding:"5px 12px",color:"#29b6f6",fontSize:12,fontWeight:600}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#29b6f6" style={{flexShrink:0}}>
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.48 4.33 12.57c-.657-.204-.67-.657.136-.975l11.125-4.29c.548-.196 1.028.134.846.916h-.543z"/>
            </svg> @Kizoka0x
          </a>
          <span style={{fontSize:10,color:"#2d3748"}}>Ce tableau ne constitue pas un conseil financier.</span>
        </div>
      </div>

    </div>
  );
}

// ─── MOUNT ────────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<BTCThermalAI/>);
