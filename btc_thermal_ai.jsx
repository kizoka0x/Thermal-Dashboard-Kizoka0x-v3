// ══════════════════════════════════════════════════════════════════════════════
//  btc_thermal_ai.jsx — BTC On-Chain Thermal Dashboard
//  © Kizoka0x — auteur et éditeur exclusif
//  Source : btc_dashboard.json (btc_pipeline.py — refresh 30 min)
//  Compatible : Babel standalone + React 18 UMD
//
//  Logique de scoring inspirée des analyses on-chain :
//  - SOPR Ratio zones réelles CryptoQuant :
//    * Zone rouge (capitulation) : 0.5–1.0 (fond 2022 : 0.54, SMA90 0.65)
//    * Ligne intermédiaire : 3.0
//    * Zone verte (top cycle) : 6.9–15.8
//  - Sharpe Ratio échelle CryptoQuant (×30) :
//    * Sous-valorisation : < -10 (fond 2022 = -29.35)
//    * Neutre : -3 à +10 / Survalorisation : > +40 (top 2021 = +56.40)
//  - LTH Supply in Profit Ratio (remplace UTXO) :
//    * < 0.50 = capitulation LTH (fond 2022 ~0.48)
//    * > 0.95 = distribution (top 2021 ~0.99)
//  - Dérivés enrichis : CVD, OI USD réel, Funding Rate (Binance futures)
//  - MVRV percentile : 0% = bas de cycle extrême, >85% = zone de vente
//  - Mayer < 0.8 = oversold historique (zone achat LT confirmée)
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

// LTH NUPL — étendu aux valeurs négatives (capitulation)
// Zones réelles CryptoQuant : <0 = capitulation, 0-0.25 = espoir, 0.25-0.5 = optimisme, >0.75 = euphorie
// Valeurs historiques bottom : -0.49 (2022), -0.55 (2018), -0.25 (2019)
const S_LTH = v =>
  v<=-0.40?{n:0,c:2,m:5,l:9}:v<=-0.20?{n:1,c:2,m:4,l:9}:v<=0?{n:2,c:3,m:4,l:8}:
  v<=0.15?{n:3,c:3,m:4,l:8}:v<=0.30?{n:4,c:4,m:5,l:7}:
  v<=0.50?{n:5,c:5,m:5,l:6}:v<=0.70?{n:6,c:6,m:6,l:5}:v<=0.85?{n:7,c:7,m:7,l:4}:
  {n:8,c:8,m:6,l:3};

// STH NUPL — étendu aux valeurs négatives (acheteurs récents sous l'eau)
// Capitulation STH : <-0.30 (fond 2022), normal bas cycle : -0.20 à 0
const S_STH = v =>
  v<=-0.40?{n:0,c:2,m:4,l:8}:v<=-0.20?{n:1,c:2,m:4,l:8}:v<=0?{n:2,c:3,m:4,l:7}:
  v<=0.15?{n:3,c:3,m:4,l:7}:v<=0.30?{n:4,c:4,m:5,l:7}:
  v<=0.50?{n:5,c:5,m:5,l:6}:v<=0.70?{n:6,c:6,m:6,l:6}:v<=0.85?{n:7,c:7,m:7,l:5}:
  {n:8,c:8,m:7,l:4};

// LTH Supply in Profit Ratio — remplace UTXO Block P/L Count
// Indicateur : fraction des LTH (holders > 155j) en profit sur leur coût moyen
// Zones calibrées CryptoQuant :
//   < 0.50 = capitulation LTH FLAG (fond 2022 ~0.48 / fond 2018 ~0.42)
//   0.50-0.65 = stress / bas cycle
//   0.65-0.80 = récupération
//   0.80-0.95 = bull confirmé
//   > 0.95    = distribution / top cycle (top 2021 ~0.99)
const S_LTH_SUPPLY = v =>
  v<=0.42?{n:0,c:2,m:4,l:9}:
  v<=0.48?{n:1,c:2,m:5,l:9}:
  v<=0.52?{n:1,c:3,m:5,l:9}:
  v<=0.60?{n:2,c:3,m:5,l:8}:
  v<=0.68?{n:3,c:4,m:5,l:7}:
  v<=0.75?{n:4,c:5,m:5,l:6}:
  v<=0.82?{n:5,c:5,m:5,l:5}:
  v<=0.90?{n:6,c:6,m:5,l:4}:
  v<=0.95?{n:7,c:7,m:5,l:3}:
  {n:8,c:8,m:4,l:2};

// Cohorte (fraction retour)
const S_COH = v =>
  v<=-0.30?{n:0,c:1,m:2,l:5}:v<=-0.15?{n:1,c:2,m:2,l:5}:v<=-0.08?{n:2,c:2,m:3,l:6}:
  v<=0?{n:3,c:3,m:4,l:6}:v<=0.05?{n:6,c:6,m:6,l:7}:v<=0.15?{n:7,c:7,m:7,l:8}:
  {n:9,c:8,m:8,l:8};

// SOV ratio volatilité — signal directionnel (activité whale)
// >1.3 = activité inhabituelle (peut être bullish OU bearish selon contexte)
// Score CT/MT intentionnellement neutre — indicateur de volume, pas de direction
const S_SOV = v =>
  v>=1.5?{n:5,c:5,m:6,l:6}:v>=1.3?{n:5,c:5,m:5,l:6}:v>=1.0?{n:5,c:5,m:5,l:5}:
  v>=0.8?{n:4,c:4,m:5,l:5}:{n:4,c:4,m:4,l:5};

// MVRV percentile 0-100
const S_MVRV = v =>
  v<=1?{n:0,c:3,m:5,l:9}:v<=5?{n:1,c:3,m:5,l:9}:v<=15?{n:2,c:4,m:5,l:8}:
  v<=30?{n:4,c:4,m:5,l:7}:v<=55?{n:5,c:5,m:5,l:6}:v<=80?{n:5,c:5,m:5,l:5}:
  v<=90?{n:3,c:3,m:4,l:4}:{n:1,c:2,m:3,l:3};

// Mayer Multiple — score LT : <0.8 = zone achat (bas), >2.4 = zone vente (haut)
// Logique : fond cycle = scores n bas / l très haut, sommet = inverse
// Note : entre 1.0–2.0 le score n remonte progressivement (récupération normale)
const S_MAYER = v =>
  v<=0.55?{n:1,c:2,m:4,l:9}:v<=0.70?{n:1,c:3,m:5,l:9}:v<=0.80?{n:2,c:3,m:5,l:8}:
  v<=1.00?{n:4,c:4,m:5,l:6}:v<=1.50?{n:5,c:5,m:5,l:5}:v<=2.00?{n:6,c:6,m:5,l:4}:
  v<=2.40?{n:7,c:6,m:5,l:3}:v<=3.00?{n:8,c:7,m:4,l:2}:{n:9,c:8,m:3,l:1};

// Sharpe Ratio — ÉCHELLE CALIBRÉE CRYPTOQUANT (valeurs ×30 vs brut)
// bottom 2022 = -29.35 / bottom 2018 ~-25 / top 2021 = +56.40 / top 2017 ~+45
// Zone sous-valorisation : < -10 jusqua -30 / survalorisation : +40 à +70
const S_SHARPE = v =>
  v<=-25?{n:0,c:2,m:5,l:9}:   // capitulation extrême (fond 2022)
  v<=-15?{n:1,c:2,m:4,l:9}:   // sous-valorisation forte
  v<=-10?{n:2,c:3,m:5,l:8}:   // sous-valorisation / zone achat LT
  v<=-3?{n:3,c:4,m:5,l:7}:
  v<=0?{n:4,c:5,m:5,l:6}:
  v<=10?{n:5,c:6,m:6,l:6}:
  v<=20?{n:6,c:6,m:6,l:5}:
  v<=40?{n:7,c:7,m:6,l:4}:
  v<=55?{n:8,c:8,m:5,l:3}:    // survalorisation (top 2021)
  {n:9,c:9,m:4,l:2};           // euphorie extrême

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
  const histRef=React.useRef([]);   // stockage en mémoire (session)

  const BG="#080c10",PANEL="#0d1117",BORDER="#1a2030",MUTED="#4a5568";

  const load=useCallback(async()=>{
    setStatus("loading");
    try {
      const res=await fetch("./btc_dashboard.json?t="+Date.now());
      if(!res.ok) throw new Error("HTTP "+res.status);
      const raw=await res.json();
      setData(raw);
      setStatus("ok");

      // Calcul du thermal score en JS pour la cohérence historique
      const _sr9=(v,lo,hi)=>v===null||v===undefined?4.5:Math.max(0,Math.min(9,(v-lo)/(hi-lo)*9));
      const _th=[
        _sr9(raw.mayerMultiple||1,   0.55,2.40),
        _sr9(raw.mvrvPct||0,         0.0, 90.0),
        _sr9(raw.lthNupl||0,        -0.50,0.70),
        _sr9(raw.sthNupl||0,        -0.50,0.70),
        _sr9(raw.soprRatio||1,       0.95,1.05),
        _sr9(raw.futuresPower||50,   35.0,80.0),
        _sr9(raw.etf_30d_sum||0,    -30.0,20.0),
        _sr9(raw.bullBear30d||0,    -0.30,0.30),
      ];
      const thScore = parseFloat((_th.reduce((a,b)=>a+b,0)/_th.length).toFixed(2));

      // Entrée historique enrichie
      const entry={
        ts:       new Date().toLocaleString("fr-FR"),
        price:    raw.btcPrice,
        mvrv:     raw.mvrvPct,
        etf:      raw.etf_30d_sum,
        score:    thScore,
        mayer:    raw.mayerMultiple,
        lthNupl:  raw.lthNupl,
        sthNupl:  raw.sthNupl,
        sopr:     raw.soprRatio,
        futPow:   raw.futuresPower,
        bb30:     raw.bullBear30d,
        scoreBot: [
          raw.etf_30d_sum>=0,
          raw.futuresPower>50,
          raw.usdt_sma30>0,
          raw.soprAlert===1,
          raw.lthSupplyFlag===1,
          raw.bullBear30d>0,
          raw.mvrvPct<=10,
          raw.mayerAlert===1,
          raw.sharpeShort<-10,
          raw.lthNupl<0.20,
        ].filter(Boolean).length,
      };

      // Stockage persistant via window.storage (si disponible), sinon mémoire seule
      let prev = histRef.current;
      if(window.storage){
        try {
          const stored = await window.storage.get("btc-kizoka-hist");
          if(stored) prev = JSON.parse(stored.value);
        } catch(_){}
      }
      const next=[entry,...prev].slice(0,50);
      histRef.current = next;
      setHist(next);
      if(window.storage){
        try { await window.storage.set("btc-kizoka-hist", JSON.stringify(next)); } catch(_){}
      }
    } catch(e){setStatus("error");setErrMsg(e.message);}
  },[]);

  useEffect(()=>{
    // Charger l'historique persisté au démarrage
    (async()=>{
      if(window.storage){
        try {
          const stored = await window.storage.get("btc-kizoka-hist");
          if(stored){ const h=JSON.parse(stored.value); histRef.current=h; setHist(h); }
        } catch(_){}
      }
    })();
    load();
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

  // ── Thermal Score recalculé côté JSX (cohérent avec pipeline corrigé) ─────
  // 8 indicateurs normalisés 0-9 : Mayer, MVRV%, LTH NUPL, STH NUPL, SOPR, Futures, ETF, BB30d
  const _sr9=(v,lo,hi)=>v===null||v===undefined?4.5:Math.max(0,Math.min(9,(v-lo)/(hi-lo)*9));
  const thermalComponents = [
    _sr9(G("mayerMultiple",1),    0.55,  2.40),
    _sr9(G("mvrvPct"),            0.0,   90.0),
    _sr9(G("lthNupl"),           -0.50,  0.70),
    _sr9(G("sthNupl"),           -0.50,  0.70),
    _sr9(G("soprRatio",1),        0.95,  1.05),
    _sr9(G("futuresPower"),       35.0,  80.0),
    _sr9(G("etf_30d_sum"),       -30.0,  20.0),
    _sr9(G("bullBear30d"),       -0.30,  0.30),
  ];
  const thermalScore = (thermalComponents.reduce((a,b)=>a+b,0)/thermalComponents.length);
  const thermalDisplay = thermalScore.toFixed(2);

  // ── Scores ────────────────────────────────────────────────────────────────
  const s={
    etf:        S_ETF(G("etf_30d_sum")),
    usdt:       S_USDT(G("usdt_sma30")),
    ntv:        S_NTV(G("ntv_sell_count")),
    fut:        S_FUT(G("futuresPower")),
    bb:         S_BB(G("bullBear30d")),
    sopr:       S_SOPR(G("soprRatio",1)),
    lth:        S_LTH(G("lthNupl")),
    sth:        S_STH(G("sthNupl")),
    lthSupply:  S_LTH_SUPPLY(G("lthSupplyRatio",0.5)),
    c10k:       S_COH(G("coh_10k_plus")),
    c1k:        S_COH(G("coh_1k_10k")),
    c100:       S_COH(G("coh_100_1k")),
    sov:        S_SOV(G("sov_btc_1k_10k",1)),
    mvrv:       S_MVRV(G("mvrvPct")),
    mayer:      S_MAYER(G("mayerMultiple",1)),
    shrp:       S_SHARPE(G("sharpeShort")),
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET_LOGIC — Moteur d'interprétation structuré
  // Architecture : 4 dimensions pondérées → régime → scénarios → narrative
  // Source : analyses CryptoQuant sessions 24/26 fév 2026
  // ══════════════════════════════════════════════════════════════════════════

  // Helpers thermique (scores tableau)
  const allN=Object.values(s).map(x=>x.n);
  const avgScore = thermalDisplay;
  const bearCount=allN.filter(v=>v<=4).length;
  const bullCount=allN.filter(v=>v>=7).length;
  const avgNum=thermalScore;
  const avgColor=avgNum<3?"#ff6b6b":avgNum<5?"#ffa94d":avgNum<6.5?"#ffe066":"#69db7c";
  const avgGrad=avgNum<3?"linear-gradient(90deg,#c0392b,#e74c3c)":avgNum<5?"linear-gradient(90deg,#e74c3c,#f39c12)":avgNum<6.5?"linear-gradient(90deg,#f39c12,#f1c40f)":"linear-gradient(90deg,#27ae60,#2ecc71)";

  // ── DIM 1 : FLUX & LIQUIDITÉ — ETF (w3) + USDT (w2) + NTV (w1) ───────────
  // Seuil ETF 0 = absolu (rapport 26 fév) | USDT SMA30 > 0 = carburant rechargé
  const D_FLUX = (()=>{
    const etf=G("etf_30d_sum"), usdt=G("usdt_sma30"), ntv=G("ntv_sell_count");
    const eS=etf>=0?10:etf>=-10?6:etf>=-20?3:etf>=-30?1:0;
    const uS=usdt>0?9:usdt>-3e7?6:usdt>-2e8?4:usdt>-1e9?2:0;
    const nS=ntv<=-2?10:ntv===-1?7:ntv===0?5:ntv===1?3:1;
    const score=Math.round(Math.max(0,Math.min(10,(eS*3+uS*2+nS)/6)));
    const regime=score>=8?"FLUX HAUSSIER":score>=6?"FLUX NEUTRE +":score>=4?"FLUX NEUTRE −":score>=2?"FLUX BAISSIER":"FUITE CAPITAUX";
    return{score,regime,etfPositif:etf>=0,usdtPositif:usdt>0,ntvAcheteur:ntv<=-1};
  })();

  // ── DIM 2 : STRUCTURE — Futures Power (w3) + BB30 (w2) + BB365 (w1) ──────
  // FP > 50% = ligne de partage absolue (rapport 26 fév)
  const D_STRUCT = (()=>{
    const fp=G("futuresPower"), bb30=G("bullBear30d"), bb365=G("bullBear365d");
    const fS=fp>=65?10:fp>=55?8:fp>=50?6:fp>=45?4:fp>=35?2:0;
    const bS=bb30>0.15?10:bb30>0?7:bb30>-0.10?5:bb30>-0.20?3:bb30>-0.30?1:0;
    const b3=bb365>0.05?10:bb365>0?7:bb365>-0.10?5:bb365>-0.20?3:0;
    const score=Math.round(Math.max(0,Math.min(10,(fS*3+bS*2+b3)/6)));
    const regime=score>=8?"STRUCTURE HAUSSIÈRE":score>=6?"NEUTRE / TRANSITION":score>=4?"PRESSION BAISSIÈRE":score>=2?"BEAR STRUCTUREL":"BEAR EXTRÊME";
    return{score,regime,fpHaussier:fp>=50,bbRetourne:bb30>0,structurelBull:bb365>0};
  })();

  // ── DIM 3 : PROFITABILITÉ — SOPR (w3) + LTH (w2) + STH (w2) + LTH Supply (w1) ─
  // SOPR zones réelles CQ : rouge 0.5-1.0 / intermédiaire 3 / verte 6.9-15.8
  // LTH Supply Ratio < 0.50 = capitulation LTH (fond 2022 ~0.48)
  const D_PROFIT = (()=>{
    const sopr=G("soprRatio",1), soprA=G("soprAlert");
    const lth=G("lthNupl"), sth=G("sthNupl"), lthSup=G("lthSupplyRatio",0.5);
    const sS=sopr>=6.9?10:sopr>=3?8:sopr>=1.05?6:sopr>=0.995?4:sopr>=0.97?3:sopr>=0.70?2:sopr>=0.54?1:0;
    const lS=lth>=0.50?10:lth>=0.25?7:lth>=0?4:lth>=-0.20?2:lth>=-0.40?1:0;
    const tS=sth>=0.30?10:sth>=0.10?7:sth>=0?4:sth>=-0.20?2:sth>=-0.40?1:0;
    const uS=lthSup>=0.95?9:lthSup>=0.82?7:lthSup>=0.68?5:lthSup>=0.52?3:lthSup>=0.48?2:1;
    const score=Math.round(Math.max(0,Math.min(10,(sS*3+lS*2+tS*2+uS)/8)));
    const regime=score>=8?"HOLDERS EN PROFIT":score>=6?"NEUTRE / ESPOIR":score>=4?"STRESS MODÉRÉ":score>=2?"PERTE GÉNÉRALISÉE":"CAPITULATION";
    return{score,regime,soprCapit:soprA===1,lthEnPerte:lth<0,sthEnPerte:sth<0,lthSupplyFlag:G("lthSupplyFlag")===1};
  })();

  // ── DIM 4 : VALORISATION LT — MVRV (w3) + Mayer (w2) + Sharpe (w2) + Z (w1)
  // Score 10 = fond cycle extrême (opportunité) | 0 = euphorie (danger)
  // Cluster MVRV+Mayer+Sharpe = 4ème occurrence depuis 2013 (rapport 26 fév)
  const D_VALUATION = (()=>{
    const mvrv=G("mvrvPct"), mayer=G("mayerMultiple",1);
    const shrp=G("sharpeShort"), mz=G("mvrv_zscore");
    const mS=mvrv<=1?10:mvrv<=5?9:mvrv<=15?8:mvrv<=30?6:mvrv<=55?4:mvrv<=80?2:0;
    const yS=mayer<=0.55?10:mayer<=0.70?9:mayer<=0.80?8:mayer<=1.00?5:mayer<=1.50?3:mayer<=2.40?1:0;
    const sS=shrp<=-1.5?10:shrp<=-0.8?8:shrp<=-0.3?7:shrp<=0?5:shrp<=0.5?3:shrp<=1.0?1:0;
    const zS=mz<=-3?10:mz<=-2?8:mz<=-1?6:mz<=0?4:mz<=1?2:mz<=2?1:0;
    const score=Math.round(Math.max(0,Math.min(10,(mS*3+yS*2+sS*2+zS)/8)));
    const mvrvOversold=mvrv<=5, mayerOversold=mayer<=0.80, sharpeLoRisk=shrp<=-0.3;
    const convergenceLT=mvrvOversold&&mayerOversold&&sharpeLoRisk;
    const zone=score>=9?"CAPITULATION EXTRÊME — Fond cycle historique":score>=7?"DEEP UNDERVALUATION — Zone achat LT":score>=5?"UNDERVALUATION — Bas de cycle":score>=3?"VALORISATION NORMALE":score>=1?"SURVALORISATION MODÉRÉE":"SURVALORISATION EXTRÊME — Top cycle";
    return{score,zone,mvrvOversold,mayerOversold,sharpeLoRisk,convergenceLT};
  })();

  // ── MOTEUR CENTRAL ────────────────────────────────────────────────────────
  const MARKET_LOGIC = (()=>{
    const {score:f,etfPositif,usdtPositif,ntvAcheteur}=D_FLUX;
    const {score:st,fpHaussier,bbRetourne,structurelBull}=D_STRUCT;
    const {score:pr,soprCapit,lthEnPerte,sthEnPerte,lthSupplyFlag:lthSupFl}=D_PROFIT;
    const {score:v,zone:valZone,convergenceLT,mvrvOversold,mayerOversold,sharpeLoRisk}=D_VALUATION;

    const ctmt = Math.max(0,Math.min(10,(f*4+st*4+pr*2)/10));
    const lt   = Math.max(0,Math.min(10,(v*5+pr*3+st*2)/10));
    const dualite = ctmt<=4 && lt>=6;

    const r_ct=
      ctmt>=8?{lb:"BULL FORT",col:"#51cf66",grad:"linear-gradient(90deg,#27ae60,#2ecc71)"}:
      ctmt>=6?{lb:"BULL MODÉRÉ",col:"#94d82d",grad:"linear-gradient(90deg,#5c940d,#94d82d)"}:
      ctmt>=5?{lb:"NEUTRE",col:"#ffe066",grad:"linear-gradient(90deg,#e67700,#ffe066)"}:
      ctmt>=3?{lb:"BEAR MODÉRÉ",col:"#ffa94d",grad:"linear-gradient(90deg,#e74c3c,#ffa94d)"}:
      ctmt>=1?{lb:"BEAR FORT",col:"#ff6b6b",grad:"linear-gradient(90deg,#c0392b,#e74c3c)"}:
              {lb:"BEAR EXTRÊME",col:"#ff4444",grad:"linear-gradient(90deg,#7d0000,#c0392b)"};

    const r_lt=
      lt>=8?{lb:"ACHAT LT FORT",col:"#51cf66",grad:"linear-gradient(90deg,#27ae60,#2ecc71)"}:
      lt>=6?{lb:"ZONE ACCUM.",col:"#69db7c",grad:"linear-gradient(90deg,#2ecc71,#69db7c)"}:
      lt>=4?{lb:"NEUTRE LT",col:"#ffe066",grad:"linear-gradient(90deg,#f39c12,#ffe066)"}:
      lt>=2?{lb:"RISQUE MODÉRÉ",col:"#ffa94d",grad:"linear-gradient(90deg,#e74c3c,#ffa94d)"}:
            {lb:"ZONE DE VENTE",col:"#ff6b6b",grad:"linear-gradient(90deg,#c0392b,#e74c3c)"};

    // Checklist Bottom pondérée — 3 niveaux
    // Alertes bottom = vraies zones capitulation (pas des seuils génériques)
    // SOPR Alert : zones rouge CQ réelle 0.5-1.0 (proxy: ≤ 0.970)
    // Sharpe : zone sous-valorisation CQ réelle < -10 (proxy ×30 : < -10)
    // LTH Supply : capitulation LTH < 0.50 (fond 2022 = 0.48)
    const checksBot=[
      {ok:G("etf_30d_sum")>=0,          label:"ETF 30D Sum ≥ 0",            cat:"CRITIQUE",w:3,ctx:"Institutionnels reviennent. Seuil absolu."},
      {ok:G("futuresPower")>50,          label:"Futures Power > 50%",        cat:"CRITIQUE",w:3,ctx:"Régime dérivés haussier. Ligne de partage absolue."},
      {ok:G("usdt_sma30")>0,             label:"USDT SMA(30) positif",       cat:"CRITIQUE",w:3,ctx:"Carburant stablecoin rechargé."},
      {ok:G("bullBear30d")>0,            label:"Bull/Bear 30j > 0",          cat:"HAUTE",   w:2,ctx:"Momentum CT retourné haussier."},
      {ok:G("soprAlert")===1,            label:"SOPR Alert (zone rouge <1)", cat:"HAUTE",   w:2,ctx:"LTH/STH SOPR en zone rouge CQ (0.5-1.0). Capitulation."},
      {ok:!sthEnPerte,                   label:"STH NUPL ≥ 0 (absorption)",  cat:"HAUTE",   w:2,ctx:"Acheteurs récents absorbent. Pré-retournement."},
      {ok:G("mvrvPct")<=10,              label:"MVRV Percentile ≤ 10%",      cat:"HAUTE",   w:2,ctx:"Deep undervaluation / capitulation cycle."},
      {ok:G("mayerAlert")===1,           label:"Mayer Multiple < 0.80",      cat:"LT",      w:1,ctx:"Oversold historique (2018/2020/2022)."},
      {ok:G("sharpeShort")<-10,          label:"Sharpe < -10 (sous-valo CQ)",cat:"LT",      w:1,ctx:"Zone sous-valorisation CQ réelle. Bottom 2022 = -29.35."},
      {ok:G("lthNupl")<0.20,             label:"LTH NUPL < 0.20",            cat:"LT",      w:1,ctx:"Holders LT proches coût de base."},
      {ok:G("lthSupplyFlag")===1,        label:"LTH Supply Ratio < 0.50",    cat:"LT",      w:1,ctx:"Capitulation LTH confirmée. Fond 2022 = 0.48."},
    ];
    const bWS=checksBot.reduce((a,c)=>a+(c.ok?c.w:0),0);
    const bWM=checksBot.reduce((a,c)=>a+c.w,0);
    const botPct=Math.round(bWS/bWM*100);
    const critiquesDone=checksBot.filter(c=>c.cat==="CRITIQUE"&&c.ok).length;

    // Checklist Top pondérée
    const checksTop=[
      {ok:G("etf_30d_sum")>=20,        label:"ETF 30D Sum ≥ +20%",              cat:"CRITIQUE",w:3},
      {ok:G("futuresPower")>65,        label:"Futures Power > 65% (euphorie)",  cat:"CRITIQUE",w:3},
      {ok:G("usdt_sma30")<-2e8,        label:"USDT SMA(30) négatif (pression)", cat:"CRITIQUE",w:3},
      {ok:G("soprRatio",1)>=6.9,       label:"SOPR Ratio ≥ 6.9 (zone verte CQ)",cat:"HAUTE",  w:2},
      {ok:G("bullBear30d")>0.25,       label:"Bull/Bear 30j > +25%",            cat:"HAUTE",   w:2},
      {ok:G("lthNupl")>0.70,           label:"LTH NUPL > 0.70 (distribution)",  cat:"HAUTE",   w:2},
      {ok:G("mvrvPct")>85,             label:"MVRV Percentile > 85%",           cat:"HAUTE",   w:2},
      {ok:G("mayerMultiple",1)>2.0,    label:"Mayer Multiple > 2.0",            cat:"LT",      w:1},
      {ok:G("sharpeShort")>40,         label:"Sharpe > +40 (survalor. CQ)",     cat:"LT",      w:1},
      {ok:G("sthNupl")>0.50,           label:"STH NUPL > 0.50 (euphorie)",      cat:"LT",      w:1},
      {ok:G("lthSupplyRatio",0)>0.95,  label:"LTH Supply Ratio > 0.95 (top)",   cat:"LT",      w:1},
      {ok:G("funding_rate",0)>0.05,    label:"Funding Rate > 0.05% (surlevier)",cat:"LT",      w:1},
    ];
    const tWS=checksTop.reduce((a,c)=>a+(c.ok?c.w:0),0);
    const tWM=checksTop.reduce((a,c)=>a+c.w,0);
    const topPct=Math.round(tWS/tWM*100);

    // Zones prix dynamiques (SMA200 comme ancre)
    const btc=G("btcPrice"), sma200=G("mayer_sma200");
    const zones=[
      {range:"$"+(btc/1000).toFixed(1)+"K",
       prob:critiquesDone===3?"BOTTOM VALIDÉ":critiquesDone===2?"Pré-retournement":"Distribution / Transition",
       label:etfPositif?"▶ Flux ETF stabilisé":"⚠ Flux baissiers actifs",
       col:"#e74c3c",accent:"#c0392b"},
      {range:"$"+Math.round(sma200*0.82/1000)+"–"+Math.round(sma200*0.90/1000)+"K",
       prob:"Support STH cost basis",
       label:sthEnPerte?"⬇ STH en perte — support probable":"⬇ Zone de test CT/MT",
       col:"#ffa94d",accent:"#f39c12"},
      {range:"$"+Math.round(sma200*0.72/1000)+"–"+Math.round(sma200*0.82/1000)+"K",
       prob:"Scénario central — prob ~"+(convergenceLT?Math.min(70,40+critiquesDone*10):Math.min(50,20+critiquesDone*10))+"%",
       label:"🎯 "+(convergenceLT?"Cluster oversold LT actif ici":"Mayer 0.72–0.82 × SMA200"),
       col:"#ffe066",accent:"#f1c40f"},
      {range:"$"+Math.round(sma200*0.55/1000)+"–"+Math.round(sma200*0.70/1000)+"K",
       prob:"Capitulation extrême",
       label:soprCapit&&lthSupFl?"⚡ SOPR Alert + LTH Supply Flag actifs!":"⚡ Si SOPR Alert=1 + LTH Supply Flag=1",
       col:"#da77f2",accent:"#9b59b6"},
    ];

    // Narrative dynamique factuelle
    const narrative=[];
    if(!fpHaussier&&!etfPositif){
      narrative.push("Bears en contrôle CT — Futures Power "+G("futuresPower").toFixed(1)+"% (sous 50%) + ETF 30D "+G("etf_30d_sum").toFixed(1)+"% (flux négatif).");
    } else if(fpHaussier&&etfPositif){
      narrative.push("Structure haussière CT — dérivés + flux institutionnels alignés.");
    } else {
      narrative.push("Divergence CT : "+(fpHaussier?"dérivés haussiers":"dérivés baissiers")+" vs "+(etfPositif?"ETF positif":"ETF négatif")+".");
    }
    if(lthEnPerte){
      narrative.push("LTH NUPL "+G("lthNupl").toFixed(3)+" — holders LT en perte. STH NUPL "+G("sthNupl").toFixed(3)+". Zone capitulation.");
    } else if(G("lthNupl")<0.20){
      narrative.push("LTH NUPL "+G("lthNupl").toFixed(3)+" — stress bas cycle. STH NUPL "+G("sthNupl").toFixed(3)+".");
    }
    if(convergenceLT){
      narrative.push("CLUSTER OVERSOLD LT — MVRV "+G("mvrvPct").toFixed(1)+"% + Mayer "+G("mayerMultiple",1).toFixed(3)+" + Sharpe "+G("sharpeShort").toFixed(2)+". 4ème occurrence depuis 2013.");
    }
    if(critiquesDone<3){
      const miss=checksBot.filter(c=>c.cat==="CRITIQUE"&&!c.ok).map(c=>c.label);
      narrative.push("Retournement non validé — critiques manquants : "+miss.join(" · ")+".");
    } else {
      narrative.push("BOTTOM STRUCTUREL VALIDÉ — 3 critiques déclenchés simultanément.");
    }

    const cBot=botPct>=80?"#69db7c":botPct>=50?"#ffe066":botPct>=30?"#ffa94d":"#ff6b6b";
    const gBot=botPct>=80?"linear-gradient(90deg,#27ae60,#2ecc71)":botPct>=50?"linear-gradient(90deg,#f39c12,#ffe066)":botPct>=30?"linear-gradient(90deg,#e74c3c,#ffa94d)":"linear-gradient(90deg,#7d0000,#c0392b)";
    const cTop=topPct>=70?"#ff6b6b":topPct>=40?"#ffa94d":"#69db7c";
    const gTop=topPct>=70?"linear-gradient(90deg,#c0392b,#e74c3c)":topPct>=40?"linear-gradient(90deg,#f39c12,#ffa94d)":"linear-gradient(90deg,#27ae60,#2ecc71)";

    return{ctmt_score:ctmt,lt_score:lt,regime_ctmt:r_ct,regime_lt:r_lt,dualite,
           checksBot,botPct,critiquesDone,checksTop,topPct,zones,narrative,
           colorBot:cBot,gradBot:gBot,colorTop:cTop,gradTop:gTop};
  })();

  const scoreBot=MARKET_LOGIC.botPct;
  const scoreTop=MARKET_LOGIC.topPct;
  const checksBot=MARKET_LOGIC.checksBot;
  const checksTop=MARKET_LOGIC.checksTop;
  const colorBot=MARKET_LOGIC.colorBot;
  const gradBot=MARKET_LOGIC.gradBot;
  const colorTop=MARKET_LOGIC.colorTop;
  const gradTop=MARKET_LOGIC.gradTop;

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
      name:"Open Interest (OI) — Binance Futures BTCUSDT",
      sub_detail:<>
        <SubVal label="OI USD" val={(G("oi_usd",0)).toFixed(2)+"B$"} color={G("oi_usd",0)<10?"#ff6b6b":G("oi_usd",0)<18?"#ffe066":"#69db7c"}/>
        <SubVal label="OI chg 7j" val={fSign2(G("oi_usd_chg7d",0))+"%"} color={G("oi_usd_chg7d",0)<0?"#ff6b6b":"#69db7c"}/>
        <div style={{fontSize:8,color:"#4a5568",marginTop:3,fontStyle:"italic"}}>
          {G("oi_usd_chg7d",0)<-15?"OI en forte baisse — purge de levier":G("oi_usd_chg7d",0)<0?"OI baisse — delevier modéré":G("oi_usd_chg7d",0)<15?"OI stable/hausse — levier neutre":"OI en hausse forte — accumulation levier"}
        </div>
      </>,
      sc:S_FUT(G("futuresPower")), nowL:G("oi_usd_chg7d",0)<-10?"PURGE\nLEVIER":G("oi_usd_chg7d",0)<0?"DÉLEV.":"NORMAL",hz:"CT"
    },
    {
      sec:null,
      name:"CVD — Cumulative Volume Delta Binance Futures",
      sub_detail:<>
        <SubVal label="CVD 7j" val={(G("cvd_7d",0)>0?"+":"")+G("cvd_7d",0).toFixed(3)+"B$"} color={G("cvd_7d",0)<0?"#ff6b6b":G("cvd_7d",0)>0?"#69db7c":"#ffe066"}
          alert={G("cvd_signal",0)===-1?<AlertR active={true} on="SELLERS ACTIFS"/>:G("cvd_signal",0)===1?<AlertG active={true} on="BUYERS ACTIFS"/>:null}/>
        <SubVal label="CVD 30j" val={(G("cvd_30d",0)>0?"+":"")+G("cvd_30d",0).toFixed(3)+"B$"} color={G("cvd_30d",0)<0?"#ff6b6b":"#69db7c"}/>
        <div style={{fontSize:8,color:"#4a5568",marginTop:3,fontStyle:"italic"}}>
          CVD &gt; 0 = pression d'achat nette (takers buy &gt; sell) — Binance futures 1j
        </div>
      </>,
      sc:G("cvd_7d",0)<0?S_NTV(1):S_NTV(-1), nowL:G("cvd_7d",0)<0?"CVD\nNÉGATIF":"CVD\nPOSITIF",hz:"CT"
    },
    {
      sec:null,
      name:"Funding Rate — Binance BTCUSDT Perp",
      sub_detail:<>
        <SubVal label="Funding Rate" val={(G("funding_rate",0)*100).toFixed(4)+"%"} color={G("funding_rate",0)>0.05?"#ff6b6b":G("funding_rate",0)<-0.01?"#ffa94d":"#69db7c"}
          alert={G("funding_signal",0)===1?<AlertR active={true} on="SURLEVIER 🔺"/>:G("funding_signal",0)===-1?<AlertR active={true} on="FEAR FUNDING 🔻"/>:null}/>
        <SubVal label="SMA8 (~3j)" val={(G("funding_sma8",0)*100).toFixed(4)+"%"} color={G("funding_sma8",0)>0.05?"#ff6b6b":G("funding_sma8",0)<0?"#ffa94d":"#c9d1d9"}/>
        <div style={{fontSize:8,color:"#4a5568",marginTop:3,fontStyle:"italic"}}>
          {G("funding_rate",0)>0.05?"Surlevier — longs paient shorts. Correction imminente possible.":
           G("funding_rate",0)<-0.01?"Funding négatif — shorts en surpoids. Couverture haussière possible.":
           "Funding neutre (0–0.05%) — levier équilibré."}
        </div>
      </>,
      sc:G("funding_signal",0)===1?{n:8,c:8,m:6,l:4}:G("funding_signal",0)===-1?{n:2,c:3,m:5,l:7}:{n:5,c:5,m:5,l:6},
      nowL:G("funding_signal",0)===1?"SURLEVIER":G("funding_signal",0)===-1?"FEAR\nFUND.":"NEUTRE",hz:"CT"
    },
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
      name:"LTH/STH SOPR Ratio — Zones CryptoQuant",
      sub_detail:<>
        <SubVal label="Alert" val={G("soprAlert")===1?"= 1 🚨":"= 0"} color={G("soprAlert")===1?"#ff6b6b":"#69db7c"}
          alert={<AlertR active={G("soprAlert")===1} on="ZONE ROUGE CQ (<1.0)"/>}/>
        <SubVal label="SOPR Ratio" val={f4(G("soprRatio",1))} color={G("soprRatio",1)<1?"#ff4444":G("soprRatio",1)<3?"#ffa94d":G("soprRatio",1)>=6.9?"#40c057":"#69db7c"}/>
        <SubVal label="SMA(90)" val={f4(G("soprSma90",1))} color="#74c0fc"/>
        <div style={{fontSize:8,color:G("soprRatio",1)<1?"#ff4444":G("soprRatio",1)>=6.9?"#69db7c":"#4a5568",marginTop:3,fontStyle:"italic"}}>
          {G("soprRatio",1)<0.7?"🔴 Capitulation extrême (fond 2022: 0.54, SMA90: 0.65)":
           G("soprRatio",1)<1?"🔴 Zone rouge CQ (0.5–1.0) — LTH/STH en perte":
           G("soprRatio",1)<3?"🟡 Sous ligne intermédiaire (3.0)":
           G("soprRatio",1)<6.9?"🟢 Au-dessus ligne intermédiaire":
           "🟢 Zone verte CQ (6.9–15.8) — top cycle"}
        </div>
      </>,
      sc:s.sopr, nowL:G("soprAlert")===1?"ZONE\nROUGE":G("soprRatio",1)<1?"SOUS 1\n<3":G("soprRatio",1)>=6.9?"ZONE\nVERTE":"OK",hz:"MT"
    },
    {
      sec:null,
      name:"BTC NUPL — aLTH / aSTH",
      sub_detail:<>
        <SubVal label="aLTH NUPL" val={fsign(G("lthNupl"),4)} color={G("lthNupl")<-0.30?"#ff4444":G("lthNupl")<0?"#ff6b6b":G("lthNupl")<0.20?"#ffa94d":G("lthNupl")>0.5?"#69db7c":"#ffe066"}/>
        <SubVal label="aSTH NUPL" val={fsign(G("sthNupl"),4)} color={G("sthNupl")<-0.30?"#ff4444":G("sthNupl")<0?"#ff6b6b":G("sthNupl")<0.15?"#ffa94d":G("sthNupl")>0.5?"#69db7c":"#ffe066"}/>
        <SubVal label="Average aNUPL" val={fsign(G("nuplAvg"),4)} color={G("nuplAvg")<0?"#ff6b6b":"#c9d1d9"}/>
        <SubVal label="Line" val={fsign(G("nuplLine"),4)} color="#74c0fc"/>
        <div style={{fontSize:9,color:G("lthNupl")<0?"#ff6b6b":"#4a5568",marginTop:3,fontStyle:"italic"}}>
          {G("lthNupl")<-0.35?"LTH en capitulation profonde":G("lthNupl")<0?"LTH en perte (capitulation)":G("lthNupl")<0.25?"Zone espoir (bas cycle)":"Zone optimisme"}
        </div>
      </>,
      sc:s.lth, nowL:G("lthNupl")<=-0.40?"CAPIT.\nLTH":G("lthNupl")<0?"LTH\nEN PERTE":G("lthNupl")<0.20?"BAS\nCYCLE":"MOYEN",hz:"MT/LT"
    },
    {
      sec:null,
      name:"LTH Supply in Profit Ratio",
      sub_detail:<>
        <SubVal label="Ratio" val={f4(G("lthSupplyRatio",0.5))} color={G("lthSupplyRatio",0.5)<0.50?"#ff4444":G("lthSupplyRatio",0.5)<0.65?"#ffa94d":G("lthSupplyRatio",0.5)>0.90?"#ff6b6b":"#69db7c"}
          alert={<AlertR active={G("lthSupplyFlag")===1} on="CAPITULATION LTH 🚨"/>}/>
        <SubVal label="Zone" val={
          G("lthSupplyRatio",0.5)<=0.48?"Capitulation extrême 🔴":
          G("lthSupplyRatio",0.5)<=0.52?"FLAG Capitulation 🔴":
          G("lthSupplyRatio",0.5)<=0.65?"Stress / bas cycle 🟡":
          G("lthSupplyRatio",0.5)<=0.80?"Récupération":"Bull confirmé ✅"
        } color={G("lthSupplyRatio",0.5)<0.50?"#ff4444":G("lthSupplyRatio",0.5)<0.65?"#ffa94d":G("lthSupplyRatio",0.5)>0.90?"#ff6b6b":"#69db7c"}/>
        <SubVal label="Flag" val={G("lthSupplyFlag")===1?"= 1 ⚡":"= 0"} color={G("lthSupplyFlag")===1?"#ff4444":"#69db7c"}/>
        <div style={{fontSize:8,color:"#4a5568",marginTop:3,fontStyle:"italic"}}>Proxy: mvrvPct×0.6 + lthNupl_norm×0.4 — fond 2022≈0.48 / top 2021≈0.99</div>
      </>,
      sc:s.lthSupply, nowL:G("lthSupplyFlag")===1?"FLAG\nCAPITUL.":G("lthSupplyRatio",0.5)<=0.65?"STRESS\nBAS CY.":G("lthSupplyRatio",0.5)<=0.82?"RÉCUP.":"BULL",hz:"MT/LT"
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
      name:"Sharpe Ratio — Calibré CryptoQuant",
      sub_detail:<>
        <SubVal label="Sharpe Ratio (CQ scale)" val={f2(G("sharpeShort"))} color={G("sharpeShort")<-10?"#69db7c":G("sharpeShort")>40?"#ff6b6b":"#c9d1d9"}
          alert={G("sharpeShort")<-10?<AlertG active={true} on="SOUS-VALO CQ"/>:G("sharpeShort")>40?<AlertR active={true} on="SURVALORISATION"/>:null}/>
        <SubVal label="Zone" val={
          G("sharpeShort")<-25?"Capitulation extrême 🔴 (fond 2022=-29.35)":
          G("sharpeShort")<-10?"Sous-valorisation 🟢 (<-10 CQ)":
          G("sharpeShort")<0?"Neutre négatif":
          G("sharpeShort")<40?"Bull modéré":
          "Survalorisation 🔴 (top 2021=+56.40)"
        } color={G("sharpeShort")<-10?"#69db7c":G("sharpeShort")>40?"#ff6b6b":"#c9d1d9"}/>
        <div style={{fontSize:8,color:"#4a5568",marginTop:3,fontStyle:"italic"}}>Zones CQ : sous-valo &lt;-10 | neutre -3→+10 | sur-valo &gt;+40</div>
      </>,
      sc:s.shrp, nowL:G("sharpeShort")<=-25?"CAPIT.\nEXTR.":G("sharpeShort")<=-10?"SOUS\nVALO":G("sharpeShort")<=0?"NEUTRE":"BULL",hz:"LT"
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
            <span style={{fontFamily:"monospace",fontSize:10,color:"rgba(88,166,255,.7)",textTransform:"uppercase",letterSpacing:2}}>── Historique des sessions (50 dernières)</span>
            <button onClick={async()=>{
              histRef.current=[];setHist([]);
              if(window.storage){try{await window.storage.delete("btc-kizoka-hist");}catch(_){}}
            }} style={{background:"transparent",color:MUTED,border:`1px solid ${BORDER}`,borderRadius:4,padding:"3px 9px",fontSize:10,cursor:"pointer"}}>🗑 Effacer</button>
          </div>
          <div style={{padding:14,overflowX:"auto"}}>
            {hist.length===0?<div style={{color:MUTED,fontSize:12}}>Aucun historique — les données s'accumulent à chaque refresh (30min)</div>:
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
                <thead>
                  <tr>{["Date/Heure","Prix BTC","MVRV%","Mayer","LTH NUPL","STH NUPL","SOPR","Futures%","Bull/Bear 30j","ETF 30D","Score/9","Bot/10"]
                    .map(h=><th key={h} style={{textAlign:"left",padding:"4px 8px",color:MUTED,fontSize:9,fontWeight:400,whiteSpace:"nowrap",borderBottom:`1px solid ${BORDER}`}}>{h}</th>)}</tr>
                </thead>
                <tbody>{hist.map((h,i)=>{
                  const sc=safe(h.score);
                  const scColor=sc<3?"#ff6b6b":sc<5?"#ffa94d":sc<6.5?"#ffe066":"#69db7c";
                  const bot=safe(h.scoreBot,0);
                  const botColor=bot>=7?"#69db7c":bot>=4?"#ffe066":"#ff6b6b";
                  return (
                  <tr key={i} style={{borderTop:`1px solid rgba(255,255,255,.03)`,opacity:i===0?1:0.85-i*0.01}}>
                    <td style={{padding:"4px 8px",color:"#6b7280",whiteSpace:"nowrap"}}>{h.ts}</td>
                    <td style={{padding:"4px 8px",color:"#ffe066",fontWeight:700}}>${(safe(h.price)/1000).toFixed(2)}K</td>
                    <td style={{padding:"4px 8px",color:safe(h.mvrv)<=5?"#69db7c":safe(h.mvrv)>=85?"#ff6b6b":"#74c0fc"}}>{f2(h.mvrv)}%</td>
                    <td style={{padding:"4px 8px",color:safe(h.mayer)<0.8?"#69db7c":safe(h.mayer)>2.4?"#ff6b6b":"#c9d1d9"}}>{safe(h.mayer).toFixed(4)}</td>
                    <td style={{padding:"4px 8px",color:safe(h.lthNupl)<0?"#ff6b6b":safe(h.lthNupl)<0.2?"#ffa94d":"#69db7c"}}>{fsign(safe(h.lthNupl),4)}</td>
                    <td style={{padding:"4px 8px",color:safe(h.sthNupl)<0?"#ff6b6b":safe(h.sthNupl)<0.15?"#ffa94d":"#69db7c"}}>{fsign(safe(h.sthNupl),4)}</td>
                    <td style={{padding:"4px 8px",color:safe(h.sopr,1)<0.97?"#ff6b6b":safe(h.sopr,1)>1.05?"#69db7c":"#c9d1d9"}}>{safe(h.sopr,1).toFixed(4)}</td>
                    <td style={{padding:"4px 8px",color:safe(h.futPow)<50?"#ff6b6b":"#69db7c"}}>{safe(h.futPow).toFixed(1)}%</td>
                    <td style={{padding:"4px 8px",color:safe(h.bb30)<0?"#ff6b6b":"#69db7c"}}>{fsign(safe(h.bb30),4)}</td>
                    <td style={{padding:"4px 8px",color:safe(h.etf)<0?"#ff6b6b":"#69db7c"}}>{fSign2(h.etf)}%</td>
                    <td style={{padding:"4px 8px",color:scColor,fontWeight:700}}>{sc.toFixed(2)}</td>
                    <td style={{padding:"4px 8px",color:botColor,fontWeight:700}}>{bot}/10</td>
                  </tr>
                  );
                })}</tbody>
              </table>
            }
          </div>
        </div>
      )}

      {/* ── 4 SCORE CARDS — Moteur MARKET_LOGIC ──────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10,marginBottom:14}}>
        <ScoreCard
          label="Signal CT/MT"
          value={MARKET_LOGIC.regime_ctmt.lb}
          sub={`Flux ${D_FLUX.score}/10 · Struct ${D_STRUCT.score}/10 · Profit ${D_PROFIT.score}/10`}
          color={MARKET_LOGIC.regime_ctmt.col}
          grad={MARKET_LOGIC.regime_ctmt.grad}
        />
        <ScoreCard
          label="Signal LT"
          value={MARKET_LOGIC.regime_lt.lb}
          sub={`Valuation ${D_VALUATION.score}/10 · ${D_VALUATION.zone.split("—")[0].trim()}`}
          color={MARKET_LOGIC.regime_lt.col}
          grad={MARKET_LOGIC.regime_lt.grad}
        />
        <ScoreCard
          label="Score Thermique (0–9)"
          value={avgScore}
          sub={`${bearCount}/${allN.length} bear · Bottom ${scoreBot}% · Top ${scoreTop}%`}
          color={avgColor}
          grad={avgGrad}
        />
        <ScoreCard
          label={MARKET_LOGIC.dualite?"⚡ DUALITÉ BEAR CT / OVERSOLD LT":"Contexte Global"}
          value={MARKET_LOGIC.dualite?"TRANSITION":"STABLE"}
          sub={MARKET_LOGIC.dualite?"Bear CT + Cluster LT — phase accumulation progressive":"Lectures CT et LT cohérentes"}
          color={MARKET_LOGIC.dualite?"#da77f2":"#74c0fc"}
          grad={MARKET_LOGIC.dualite?"linear-gradient(90deg,#6a0dad,#9b59b6)":"linear-gradient(90deg,#1a5276,#2980b9)"}
        />
      </div>
      {/* ── NARRATIVE ─────────────────────────────────────────────────────── */}
      <div style={{background:"rgba(88,166,255,.04)",border:"1px solid rgba(88,166,255,.1)",borderRadius:8,padding:"10px 14px",marginBottom:14}}>
        <div style={{fontFamily:"monospace",fontSize:9,color:"rgba(88,166,255,.6)",textTransform:"uppercase",letterSpacing:2,marginBottom:7}}>── Interprétation dynamique</div>
        {MARKET_LOGIC.narrative.map((line,i)=>(
          <div key={i} style={{fontSize:11,color:i===MARKET_LOGIC.narrative.length-1?(MARKET_LOGIC.critiquesDone>=3?"#69db7c":"#ffa94d"):"#c9d1d9",marginBottom:4,lineHeight:1.4,paddingLeft:10,borderLeft:"2px solid "+(i===0?"rgba(88,166,255,.3)":i===1?"rgba(255,107,107,.3)":i===2?"rgba(218,119,242,.3)":"rgba(255,166,77,.3)")}}>
            {line}
          </div>
        ))}
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

      {/* ── ZONES PRIX — MARKET_LOGIC (ancrage SMA200) ──────────────────────── */}
      <div style={{marginTop:20,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {MARKET_LOGIC.zones.map((z,i)=>(
          <div key={i} style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:8,padding:"13px 14px",position:"relative",overflow:"hidden"}}>
            <div style={{fontSize:9,fontFamily:"monospace",color:"rgba(255,255,255,.35)",textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>
              {["ZONE ACTUELLE","SUPPORT STH","SCÉNARIO CENTRAL","CAPITULATION EXTRÊME"][i]}
            </div>
            <div style={{fontSize:16,fontFamily:"monospace",fontWeight:700,color:"#fff"}}>{z.range}</div>
            <div style={{fontSize:10,color:MUTED,marginTop:3}}>{z.prob}</div>
            <div style={{fontSize:10,marginTop:8,fontWeight:700,textTransform:"uppercase",letterSpacing:.8,color:z.col}}>{z.label}</div>
            <div style={{position:"absolute",bottom:0,left:0,right:0,height:3,background:z.accent}}/>
          </div>
        ))}
      </div>

      {/* ── CARDS BOTTOM & TOP — scoring pondéré 3 niveaux ─────────────────── */}
      <div style={{marginTop:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>

        {/* CARD BOTTOM */}
        <div style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:10,padding:16,borderLeft:"3px solid #58a6ff"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"rgba(88,166,255,.7)",textTransform:"uppercase",letterSpacing:2}}>
              ── Validation Bottom
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:10,color:MUTED}}>Critiques {MARKET_LOGIC.critiquesDone}/3</span>
              <span style={{fontFamily:"monospace",fontSize:14,fontWeight:700,color:colorBot,
                background:scoreBot>=70?"rgba(46,204,113,.15)":scoreBot>=40?"rgba(243,156,18,.15)":"rgba(231,76,60,.15)",
                border:`1px solid ${scoreBot>=70?"rgba(46,204,113,.3)":scoreBot>=40?"rgba(243,156,18,.3)":"rgba(231,76,60,.3)"}`,
                padding:"2px 10px",borderRadius:20}}>{scoreBot}%</span>
            </div>
          </div>
          {/* Barre de progression pondérée */}
          <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:2,marginBottom:10,overflow:"hidden"}}>
            <div style={{height:"100%",width:scoreBot+"%",background:colorBot,borderRadius:2,transition:"width .5s"}}/>
          </div>
          {/* Conditions par catégorie */}
          {["CRITIQUE","HAUTE","LT"].map(cat=>(
            <div key={cat} style={{marginBottom:7}}>
              <div style={{fontSize:8,fontFamily:"monospace",color:cat==="CRITIQUE"?"#ff6b6b":cat==="HAUTE"?"#ffa94d":"#69db7c",
                textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>
                ─ {cat}{cat==="CRITIQUE"?" (retournement impossible sans ces 3)":cat==="HAUTE"?" (déclencheurs)":"  (valorisation oversold)"}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 8px"}}>
                {checksBot.filter(c=>c.cat===cat).map((c,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,fontSize:10.5,padding:"2px 0"}}>
                    <span style={{color:c.ok?"#2ecc71":"#e74c3c",fontSize:13,minWidth:13,lineHeight:"16px"}}>{c.ok?"✓":"✗"}</span>
                    <span style={{color:c.ok?"#c9d1d9":"#6b7280",lineHeight:1.3}}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,fontSize:11.5}}>
            <span style={{fontWeight:700,color:"#ffd166"}}>
              {MARKET_LOGIC.critiquesDone===3?"✅ BOTTOM STRUCTUREL VALIDÉ":
               MARKET_LOGIC.critiquesDone===2?"⚡ Pré-retournement — 1 critique manquant":
               MARKET_LOGIC.critiquesDone===1?"⏳ 1 critique validé — distribution active":
               "❌ 0 critique — Bear CT non résolu"} —{" "}
            </span>
            <span style={{color:"#718096",fontSize:10.5}}>
              {scoreBot>=70?"Signal d'achat fort — confirmer price action":
               scoreBot>=45?"Signaux LT actifs — attendre déclencheurs CT (ETF · FP · USDT)":
               scoreBot>=25?"Zone oversold — accumulation progressive (DCA)":
               "Prématuré — attendre retournement structure CT"}
            </span>
          </div>
          <div style={{marginTop:6,fontSize:9.5,color:"#4a5568",fontStyle:"italic",borderTop:`1px solid rgba(255,255,255,.04)`,paddingTop:7}}>
            Manquants CT : {checksBot.filter(c=>!c.ok&&c.cat==="CRITIQUE").map(c=>c.label).join(" · ")||"Tous ✓"}<br/>
            Réf. capitulation 2022 : SOPR≈0.54, SMA90≈0.65, Mayer≈0.67, LTH NUPL≈−0.49, Sharpe≈−29.35, LTH Supply≈0.48
          </div>
        </div>

        {/* CARD TOP */}
        <div style={{background:PANEL,border:`1px solid ${BORDER}`,borderRadius:10,padding:16,borderLeft:"3px solid #e74c3c"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"rgba(231,76,60,.7)",textTransform:"uppercase",letterSpacing:2}}>
              ── Validation Top
            </div>
            <span style={{fontFamily:"monospace",fontSize:14,fontWeight:700,color:colorTop,
              background:scoreTop>=70?"rgba(231,76,60,.2)":scoreTop>=40?"rgba(243,156,18,.15)":"rgba(46,204,113,.12)",
              border:`1px solid ${scoreTop>=70?"rgba(231,76,60,.4)":scoreTop>=40?"rgba(243,156,18,.3)":"rgba(46,204,113,.3)"}`,
              padding:"2px 10px",borderRadius:20}}>{scoreTop}%</span>
          </div>
          <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:2,marginBottom:10,overflow:"hidden"}}>
            <div style={{height:"100%",width:scoreTop+"%",background:colorTop,borderRadius:2,transition:"width .5s"}}/>
          </div>
          {["CRITIQUE","HAUTE","LT"].map(cat=>(
            <div key={cat} style={{marginBottom:7}}>
              <div style={{fontSize:8,fontFamily:"monospace",color:cat==="CRITIQUE"?"#ff6b6b":cat==="HAUTE"?"#ffa94d":"#69db7c",
                textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>
                ─ {cat}{cat==="CRITIQUE"?" (distribution structurelle)":cat==="HAUTE"?" (euphorie)":"  (overvaluation)"}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 8px"}}>
                {checksTop.filter(c=>c.cat===cat).map((c,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,fontSize:10.5,padding:"2px 0"}}>
                    <span style={{color:c.ok?"#e74c3c":"#4a5568",fontSize:13,minWidth:13,lineHeight:"16px"}}>{c.ok?"✓":"✗"}</span>
                    <span style={{color:c.ok?"#ff6b6b":"#6b7280",lineHeight:1.3}}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,fontSize:11.5}}>
            <span style={{fontWeight:700,color:"#ffd166"}}>
              {scoreTop>=70?"🔴 Top structurel — distribution en cours":
               scoreTop>=40?"⚠ Signaux de sommet — prudence":
               "✅ Pas de sommet — valorisation oversold LT"} —{" "}
            </span>
            <span style={{color:"#718096",fontSize:10.5}}>
              {scoreTop>=70?"Réduire exposition — zone de vente historique":
               scoreTop>=40?"Surveiller SOPR + MVRV 90%+ pour confirmation":
               "Bottom scenario prioritaire sur top scenario"}
            </span>
          </div>
          <div style={{marginTop:6,fontSize:9.5,color:"#4a5568",fontStyle:"italic",borderTop:`1px solid rgba(255,255,255,.04)`,paddingTop:7}}>
            Actifs : {checksTop.filter(c=>c.ok).map(c=>c.label).join(" · ")||"Aucun signal top"}<br/>
            Réf. tops 2021 : SOPR≈15.8 (zone verte CQ), MVRV≈95%, Mayer≈3.5, LTH NUPL≈0.85, Sharpe≈+56.40, LTH Supply≈0.99
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
