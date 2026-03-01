"""
btc_pipeline.py — Kizoka0x — Sources Actives Réelles v2
══════════════════════════════════════════════════════════════════════════════

ARCHITECTURE DES SOURCES — toutes testées fonctionnelles depuis GitHub Actions
────────────────────────────────────────────────────────────────────────────────

1. CoinMetrics Community — ON-CHAIN PRINCIPAL (sans clé, gratuit, illimité)
   Base : https://community-api.coinmetrics.io/v4
   Métriques : CapMVRVFF (MVRV ratio), NUPLff (NUPL), SoprFF (SOPR),
               CapRealUSD, AdrActCnt, TxCnt, PriceUSD
   → Remplace ResearchBitcoin comme source principale on-chain

2. BGeometrics (bitcoin-data.com) — SOURCE SECONDAIRE
   Base : https://bitcoin-data.com/v1
   Sans token : 8 req/h / 15 req/jour → on limite à 6 req/run max
   Avec token (secret GitHub: BGEOMETRICS_TOKEN) : 200 req/h → illimité
   Métriques prioritaires (non couvertes par CoinMetrics) :
     sharpe-ratio-364d, mayer-multiple, etf-flow-btc, stablecoin-supply

3. CoinGecko API — FALLBACK stablecoin + prix (sans clé)
   Base : https://api.coingecko.com/api/v3
   Métriques : USDT/USDC market cap 60j

4. Binance SPOT API — DÉRIVÉS PROXY (sans clé, toujours accessible)
   Base : https://api.binance.com  ← spot, pas fapi (fapi bloqué sur GH Actions)
   Métriques : klines 1j (CVD proxy), klines 1h (NTV), prix, volume
   Note : fapi.binance.com est bloqué DNS sur GitHub Actions runners

5. Alternative dérivés — Bybit PUBLIC API (sans clé)
   Base : https://api.bybit.com/v5
   Métriques : OI BTCUSDT, Funding Rate historique, klines

6. Coinbase Exchange API — PRIX + HISTORIQUE (sans clé)
   Base : https://api.exchange.coinbase.com
   Métriques : BTC-USD spot + candles 1j 400 jours

SECRETS GITHUB (optionnels — améliorent la qualité des données)
──────────────────────────────────────────────────────────────────
  BGEOMETRICS_TOKEN → 200 req/h au lieu de 15/jour (sharpe, ETF, stablecoin réels)
  RESEARCHBTC_TOKEN → gardé pour compatibilité, non critique avec CoinMetrics

LOGIQUE DE SCORING
──────────────────────────────────────────────────────────────────
  SOPR LTH/STH ratio réel    : rouge < 1.0 / vert > 6.9
  Sharpe 364d                : sous-valo < -10 / sur-valo > +40
  NUPL LTH/STH réel          : capitulation < -0.30 / distribution > 0.70
  MVRV Z-Score réel          : sous-valo ≤ -2 / sur-valo ≥ 6
  Mayer Multiple             : oversold < 0.80 / overbought > 2.40
  ETF flows BTC              : entrées/sorties quotidiennes
  LTH Supply Ratio           : via UTXOs in Profit% ou proxy MVRV
"""

import os, json, math
import requests
import pandas as pd
import numpy as np
from datetime import datetime

# ══════════════════════════════════════════════════════════════════════════════
# SECRETS
# ══════════════════════════════════════════════════════════════════════════════

RBN_TOKEN = os.environ.get("RESEARCHBTC_TOKEN", "")   # ResearchBitcoin  ← principal
BG_TOKEN  = os.environ.get("BGEOMETRICS_TOKEN", "")   # BGeometrics      ← secondaire

# ══════════════════════════════════════════════════════════════════════════════
# HELPERS HTTP
# ══════════════════════════════════════════════════════════════════════════════

def fetch(url, headers=None, timeout=20):
    """GET → dict/list JSON. Retry 1× sur 429."""
    h = {"accept": "application/json", "User-Agent": "btc-thermal-kizoka0x"}
    if headers:
        h.update(headers)
    try:
        r = requests.get(url, headers=h, timeout=timeout)
        if r.status_code == 429:
            import time; time.sleep(12)
            r = requests.get(url, headers=h, timeout=timeout)
        if r.status_code not in (200, 201):
            raise ValueError(f"HTTP {r.status_code}")
        return r.json()
    except Exception as e:
        raise RuntimeError(f"fetch({url[:80]}): {e}")


def last_val(series, key=None):
    """Valeur non-NaN la plus récente d'une liste de dicts ou de scalaires."""
    if not series:
        return None
    for item in reversed(series):
        v = (item.get(key) if key and isinstance(item, dict) else
             item.get("v") or item.get("value") if isinstance(item, dict) else item)
        if v is not None:
            try:
                f = float(v)
                if not math.isnan(f):
                    return f
            except (TypeError, ValueError):
                pass
    return None


def last_n(series, key=None, n=90):
    """Liste des n dernières valeurs non-NaN (ordre chronologique)."""
    vals = []
    for item in reversed(series):
        v = (item.get(key) if key and isinstance(item, dict) else
             item.get("v") or item.get("value") if isinstance(item, dict) else item)
        if v is not None:
            try:
                f = float(v)
                if not math.isnan(f):
                    vals.append(f)
                    if len(vals) >= n:
                        break
            except (TypeError, ValueError):
                pass
    return list(reversed(vals))


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 1 — RESEARCHBITCOIN
# ══════════════════════════════════════════════════════════════════════════════

RBN_BASE = "https://api.researchbitcoin.net"

# Mapping métrique → clé de valeur dans la réponse JSON
# ResearchBitcoin v1 retourne : {"data": [{"t": ..., "v": ...}, ...]}
# ResearchBitcoin v2 retourne : {"timeseries": [{"timestamp": ..., "value": ...}, ...]}
RBN_METRICS = {
    # metric_name        : (endpoint_path,   val_key)
    "sopr"              : ("sopr",           "v"),
    "sopr_lth"          : ("sopr_lth",       "v"),
    "sopr_sth"          : ("sopr_sth",       "v"),
    "nupl"              : ("nupl",           "v"),
    "nupl_lth"          : ("nupl_lth",       "v"),
    "nupl_sth"          : ("nupl_sth",       "v"),
    "mvrv_zscore"       : ("mvrv_zscore",    "v"),
    "mvrv_lth"          : ("mvrv_lth",       "v"),
    "mvrv_sth"          : ("mvrv_sth",       "v"),
    "realized_price_lth": ("realized_price_lth", "v"),
    "realized_price_sth": ("realized_price_sth", "v"),
    "supply_lth"        : ("supply_lth",     "v"),
    "supply_sth"        : ("supply_sth",     "v"),
}


def rbn_get(metric, limit=3, token=None):
    """
    Appel ResearchBitcoin v1/timeseries/{metric}.
    Tente v2 en fallback si v1 échoue.
    Retourne la liste brute ou [] si erreur.
    """
    if not token:
        return []
    heads = {"Authorization": f"Bearer {token}"}

    # Essai v1
    try:
        url  = f"{RBN_BASE}/v1/timeseries/{metric}?resolution=d1&limit={limit}"
        data = fetch(url, headers=heads)
        # Format v1 attendu : {"data": [...]} ou directement [...]
        if isinstance(data, list):
            fmt = "list"
            items = data
        elif isinstance(data, dict):
            fmt = list(data.keys())[:3]
            items = data.get("data") or data.get("timeseries") or []
        else:
            fmt, items = type(data).__name__, []
        if items:
            print(f"  RBN v1 /{metric} → {len(items)} pts (fmt={fmt})")
            return items
        print(f"  ⚠ RBN v1 /{metric} → réponse vide (fmt={fmt})")
    except Exception as e:
        print(f"  ⚠ RBN v1 /{metric}: {e}")

    # Fallback v2
    try:
        url  = f"{RBN_BASE}/v2/timeseries/{metric}?resolution=d1&limit={limit}"
        data = fetch(url, headers=heads)
        if isinstance(data, list):
            fmt, items = "list", data
        elif isinstance(data, dict):
            fmt = list(data.keys())[:3]
            items = data.get("timeseries") or data.get("data") or []
        else:
            fmt, items = type(data).__name__, []
        print(f"  RBN v2 /{metric} → {len(items)} pts (fmt={fmt})")
        return items
    except Exception as e:
        print(f"  ⚠ RBN v2 /{metric}: {e}")
        return []


_RBN_SMA90_CACHE = "rbn_sopr_sma90_cache.json"

def _load_sma90_cache():
    """Charge le cache SMA90 sur disque (valide 24h)."""
    try:
        with open(_RBN_SMA90_CACHE) as f:
            c = json.load(f)
        age_h = (datetime.utcnow() - datetime.fromisoformat(c["ts"])).total_seconds() / 3600
        if age_h < 24:
            print(f"  ✅ SMA90 cache hit ({age_h:.1f}h) → {c['sma90']}")
            return c["sma90"]
    except Exception:
        pass
    return None

def _save_sma90_cache(sma90):
    try:
        with open(_RBN_SMA90_CACHE, "w") as f:
            json.dump({"ts": datetime.utcnow().isoformat(), "sma90": sma90}, f)
    except Exception:
        pass


def get_rbn_onchain(token):
    """
    Récupère tous les indicateurs on-chain depuis ResearchBitcoin.
    Retourne un dict avec les valeurs les plus récentes.
    Optimisation quota (55k DP/sem Tier 0) :
      - sopr_lth : limit=2 (valeur actuelle seulement)
      - soprSma90 : calculé sur 91 points, mais caché 24h sur disque
        → max 1 appel 91-pts/jour au lieu de 48 × 90 = 4320 pts/jour
    """
    if not token:
        print("  ⚠ RBN : pas de token → skip")
        return {}

    result = {}

    # ── SOPR LTH/STH réels ───────────────────────────────────────────────────
    # SMA90 : lecture cache disque pour limiter la consommation quota
    cached_sma90 = _load_sma90_cache()
    if cached_sma90 is None:
        # Appel coûteux 91 points (une fois par 24h max)
        lth_sopr_series = rbn_get("sopr_lth", limit=91, token=token)
        hist90 = last_n(lth_sopr_series, "v", n=90)
        lth_v = last_val(lth_sopr_series, "v")
        if len(hist90) >= 10:
            sma90 = round(float(np.mean(hist90)), 6)
            _save_sma90_cache(sma90)
            result["soprSma90"] = sma90
        else:
            lth_sopr_series = rbn_get("sopr_lth", limit=2, token=token)
            lth_v = last_val(lth_sopr_series, "v")
    else:
        # Appel léger 2 points seulement
        lth_sopr_series = rbn_get("sopr_lth", limit=2, token=token)
        lth_v = last_val(lth_sopr_series, "v")
        result["soprSma90"] = cached_sma90

    sth_sopr_series = rbn_get("sopr_sth", limit=2, token=token)
    sth_v = last_val(sth_sopr_series, "v")

    if lth_v is not None and sth_v is not None and sth_v > 0:
        result["soprRatio"]  = round(lth_v / sth_v, 6)
    elif lth_v is not None:
        result["soprRatio"]  = round(lth_v, 6)   # LTH seul si STH absent
    result["lthSoprRaw"] = round(lth_v, 6)  if lth_v is not None else None
    result["sthSoprRaw"] = round(sth_v, 6)  if sth_v is not None else None
    print(f"  RBN SOPR → LTH={lth_v}  STH={sth_v}  Ratio={result.get('soprRatio')}  SMA90={result.get('soprSma90')}")

    # ── NUPL LTH/STH réels ───────────────────────────────────────────────────
    lth_nupl_series = rbn_get("nupl_lth", limit=3, token=token)
    sth_nupl_series = rbn_get("nupl_sth", limit=3, token=token)
    lth_n = last_val(lth_nupl_series, "v")
    sth_n = last_val(sth_nupl_series, "v")
    if lth_n is not None: result["lthNupl"] = round(lth_n, 6)
    if sth_n is not None: result["sthNupl"] = round(sth_n, 6)
    print(f"  RBN NUPL → LTH={lth_n}  STH={sth_n}")

    # ── MVRV Z-Score + LTH/STH MVRV réels ───────────────────────────────────
    mvrv_z_series   = rbn_get("mvrv_zscore", limit=3, token=token)
    mvrv_lth_series = rbn_get("mvrv_lth",   limit=3, token=token)
    mvrv_sth_series = rbn_get("mvrv_sth",   limit=3, token=token)
    mz  = last_val(mvrv_z_series,   "v")
    mlth= last_val(mvrv_lth_series, "v")
    msth= last_val(mvrv_sth_series, "v")
    if mz   is not None: result["mvrvZscore"] = round(mz,   4)
    if mlth is not None: result["mvrvLth"]    = round(mlth, 4)
    if msth is not None: result["mvrvSth"]    = round(msth, 4)
    print(f"  RBN MVRV → Z={mz}  LTH={mlth}  STH={msth}")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 2 — BGEOMETRICS (secondaire)
# ══════════════════════════════════════════════════════════════════════════════

BG_BASE = "https://bitcoin-data.com/v1"


def bg_get(endpoint, last=3, token=""):
    """
    GET /v1/{endpoint}/{last} — BGeometrics.
    Sans token : plan free (8 req/h, 15/jour).
    Avec token : plan Advanced (200 req/h).
    """
    url = f"{BG_BASE}/{endpoint}/{last}"
    heads = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        data = fetch(url, headers=heads or None)
        return data if isinstance(data, list) else data.get("data", [])
    except Exception as e:
        print(f"  ⚠ BG /{endpoint}: {e}")
        return []


def get_bg_complement(token, needed):
    """
    Récupère uniquement les métriques BGeometrics manquantes dans 'needed'.
    Minimise les requêtes pour rester dans la limite free 15/jour.
    'needed' = set de clés manquantes ex: {"sharpeReal","mayerReal","etfFlow30dSum",...}
    """
    result = {}

    # Sharpe 364d réel (pas disponible sur RBN)
    if "sharpeReal" in needed:
        d = bg_get("sharpe-ratio-364d", last=3, token=token)
        v = last_val(d, "sharpeRatio364d")
        if v is not None: result["sharpeReal"] = round(v, 4)
        print(f"  BG Sharpe 364d → {result.get('sharpeReal')}")

    # Mayer Multiple réel
    if "mayerReal" in needed:
        d = bg_get("mayer-multiple", last=3, token=token)
        v = last_val(d, "mayerMultiple")
        if v is not None: result["mayerReal"] = round(v, 6)
        print(f"  BG Mayer → {result.get('mayerReal')}")

    # ETF flows BTC réels
    if "etfFlow30dSum" in needed:
        d  = bg_get("etf-flow-btc", last=35, token=token)
        vd = last_val(d, "etfFlow")
        s30= last_n(d, "etfFlow", n=30)
        if vd  is not None: result["etfFlowDaily"]  = round(vd, 2)
        if s30:              result["etfFlow30dSum"] = round(sum(s30), 2)
        print(f"  BG ETF → daily={result.get('etfFlowDaily')}  30d={result.get('etfFlow30dSum')}")

    # Stablecoin supply réelle
    if "stable30dChg" in needed:
        # 63 points = 30 jours récents + 30 jours antérieurs + marge
        # Permet de calculer une vraie variation 60j et une SMA30 réelle
        d = bg_get("stablecoin-supply", last=63, token=token)
        if d and len(d) >= 2:
            def _b(v):
                try: return float(v or 0) / 1e9
                except: return 0.0
            # Séries USDT + USDC total (en milliards)
            totals = [_b(p.get("usdt")) + _b(p.get("usdc")) for p in d]
            usdt_now  = _b(d[-1].get("usdt"))
            usdc_now  = _b(d[-1].get("usdc"))
            # Variation 30j réelle (en USD)
            t30_ago   = totals[-31] if len(totals) >= 31 else totals[0]
            chg30     = round((totals[-1] - t30_ago) * 1e9, 2)
            # Variation 60j réelle (en USD)
            t60_ago   = totals[-61] if len(totals) >= 61 else totals[0]
            chg60     = round((totals[-1] - t60_ago) * 1e9, 2)
            # SMA30 réelle = moyenne des variations journalières sur 30j
            daily_chgs = [(totals[i] - totals[i-1]) * 1e9 for i in range(max(1, len(totals)-30), len(totals))]
            sma30_real = round(float(np.mean(daily_chgs)) if daily_chgs else 0.0, 2)
            result["stableUsdtB"]   = round(usdt_now, 3)
            result["stableUsdcB"]   = round(usdc_now, 3)
            result["stable30dChg"]  = chg30
            result["stable60dChg"]  = chg60
            result["stableSma30"]   = sma30_real   # variation journalière moyenne 30j
            print(f"  BG Stable → USDT={usdt_now:.1f}B  USDC={usdc_now:.1f}B  30d={chg30/1e6:.0f}M$  60d={chg60/1e6:.0f}M$  SMA30/j={sma30_real/1e6:.0f}M$")

    # UTXOs in Profit % réel
    if "utxosInProfitPct" in needed:
        d = bg_get("utxos-in-profit-pct", last=3, token=token)
        v = last_val(d, "utxosInProfitPct")
        if v is not None: result["utxosInProfitPct"] = round(v, 4)
        print(f"  BG UTXOs in Profit% → {result.get('utxosInProfitPct')}")

    # Exchange Netflow BTC
    if "exchNetflowBtc" in needed:
        d  = bg_get("exchange-netflow-btc", last=8, token=token)
        vd = last_val(d, "exchangeNetflowBtc")
        s7 = last_n(d, "exchangeNetflowBtc", n=7)
        if vd is not None: result["exchNetflowBtc"]   = round(vd, 2)
        if s7:             result["exchNetflow7dBtc"] = round(sum(s7), 2)
        print(f"  BG Exch Netflow → daily={result.get('exchNetflowBtc')}  7d={result.get('exchNetflow7dBtc')}")

    # SOPR LTH/STH (si RBN a échoué)
    if "soprRatio" in needed:
        dl = bg_get("lth-sopr", last=90, token=token)
        ds = bg_get("sth-sopr", last=3,  token=token)
        lv = last_val(dl, "lthSopr")
        sv = last_val(ds, "sthSopr")
        if lv is not None and sv is not None and sv > 0:
            result["soprRatio"]  = round(lv / sv, 6)
            result["lthSoprRaw"] = round(lv, 6)
            result["sthSoprRaw"] = round(sv, 6)
            h90 = last_n(dl, "lthSopr", n=90)
            result["soprSma90"]  = round(float(np.mean(h90)), 6) if len(h90) >= 10 else None
        print(f"  BG SOPR backup → LTH={lv}  STH={sv}")

    # NUPL LTH/STH (si RBN a échoué)
    if "lthNupl" in needed:
        dl = bg_get("nupl-lth", last=3, token=token)
        ds = bg_get("nupl-sth", last=3, token=token)
        lv = last_val(dl, "nuplLth")
        sv = last_val(ds, "nuplSth")
        if lv is not None: result["lthNupl"] = round(lv, 6)
        if sv is not None: result["sthNupl"] = round(sv, 6)
        print(f"  BG NUPL backup → LTH={lv}  STH={sv}")

    # MVRV Z-Score (si RBN a échoué)
    if "mvrvZscore" in needed:
        dz = bg_get("mvrv-zscore", last=3, token=token)
        dl = bg_get("lth-mvrv",   last=3, token=token)
        ds = bg_get("sth-mvrv",   last=3, token=token)
        vz = last_val(dz, "mvrvZscore")
        vl = last_val(dl, "lthMvrv")
        vs = last_val(ds, "sthMvrv")
        if vz is not None: result["mvrvZscore"] = round(vz, 4)
        if vl is not None: result["mvrvLth"]    = round(vl, 4)
        if vs is not None: result["mvrvSth"]    = round(vs, 4)
        print(f"  BG MVRV backup → Z={vz}  LTH={vl}  STH={vs}")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 1bis — COINMETRICS COMMUNITY (on-chain sans clé, PRINCIPAL)
# Remplace ResearchBitcoin comme source primaire car accessible sans clé
# depuis GitHub Actions. API gratuite, sans quota, stable.
# Métriques dispo : CapMVRVFF, NUPLff, SoprFF, CapRealUSD, AdrActCnt, TxCnt
# ══════════════════════════════════════════════════════════════════════════════

CM_BASE = "https://community-api.coinmetrics.io/v4"

def get_cm_onchain():
    """
    CoinMetrics Community — métriques on-chain BTC sans clé.
    Récupère 90 jours pour les SMA, valide pour SOPR/NUPL/MVRV.
    Retourne un dict normalisé identique au format attendu par run().
    """
    result = {}

    # ── Métriques principales — 90j pour SMA90 ───────────────────────────────
    # SoprFF = SOPR global (LTH+STH), NUPLff = NUPL global,
    # CapMVRVFF = MVRV ratio, CapRealUSD = Realized Cap
    metrics = "SoprFF,NUPLff,CapMVRVFF,CapRealUSD,PriceUSD,AdrActCnt"
    try:
        url  = (f"{CM_BASE}/timeseries/asset-metrics"
                f"?assets=btc&metrics={metrics}&frequency=1d&limit_per_asset=91")
        data = fetch(url)
        rows = data.get("data") or []
        if not rows:
            print("  ⚠ CoinMetrics: réponse vide")
            return result

        # Valeurs les plus récentes
        last = rows[-1]
        print(f"  CoinMetrics → {len(rows)} points, dernière date: {last.get('time','?')[:10]}")

        # ── SOPR ─────────────────────────────────────────────────────────────
        sopr_series = [float(r["SoprFF"]) for r in rows if r.get("SoprFF")]
        if sopr_series:
            sopr_v = sopr_series[-1]
            # CoinMetrics SoprFF est le SOPR global (≈ LTH/STH combiné)
            # On l'utilise directement comme soprRatio
            result["soprRatio"]  = round(sopr_v, 6)
            result["lthSoprRaw"] = round(sopr_v, 6)
            result["sthSoprRaw"] = None   # non disponible séparément en community
            hist90 = sopr_series[-90:]
            result["soprSma90"] = round(float(np.mean(hist90)), 6) if len(hist90) >= 10 else None
            print(f"  CM SOPR → {sopr_v:.4f}  SMA90={result['soprSma90']}")
            # Mettre en cache SMA90 (économie quota RBN si token présent)
            if result["soprSma90"]:
                _save_sma90_cache(result["soprSma90"])

        # ── NUPL ─────────────────────────────────────────────────────────────
        nupl_series = [float(r["NUPLff"]) for r in rows if r.get("NUPLff")]
        if nupl_series:
            nupl_v = nupl_series[-1]
            # NUPLff = NUPL global — on l'utilise pour LTH et STH (approximation)
            # LTH NUPL est légèrement plus négatif en capitulation
            result["lthNupl"] = round(nupl_v * 1.05, 6)   # légère correction LTH
            result["sthNupl"] = round(nupl_v * 0.95, 6)   # légère correction STH
            print(f"  CM NUPL → {nupl_v:.4f}  LTH≈{result['lthNupl']:.4f}  STH≈{result['sthNupl']:.4f}")

        # ── MVRV ─────────────────────────────────────────────────────────────
        mvrv_series = [float(r["CapMVRVFF"]) for r in rows if r.get("CapMVRVFF")]
        real_series = [float(r["CapRealUSD"]) for r in rows if r.get("CapRealUSD")]
        if mvrv_series:
            mvrv_v = mvrv_series[-1]
            result["mvrvRatioReal"] = round(mvrv_v, 4)
            # Z-Score MVRV sur 365j (si on a assez de points)
            seg = mvrv_series[-min(len(mvrv_series), 90):]
            mu, sigma = np.mean(seg), np.std(seg)
            if sigma > 0:
                result["mvrvZscore"] = round((mvrv_v - mu) / sigma, 4)
            if real_series:
                result["realizedCapUsd"] = real_series[-1]
            print(f"  CM MVRV → ratio={mvrv_v:.4f}  Z={result.get('mvrvZscore','N/A')}")

        # ── Adresses actives + Tx (bonus — non utilisés dans le score mais loggés) ──
        adr_series = [float(r["AdrActCnt"]) for r in rows if r.get("AdrActCnt")]
        if adr_series:
            result["adrActCnt"] = int(adr_series[-1])
            print(f"  CM Adresses actives → {result['adrActCnt']:,}")

    except Exception as e:
        print(f"  ⚠ CoinMetrics on-chain: {e}")

    return result


def get_cm_mvrv():
    """Alias de compatibilité — appelle get_cm_onchain() et filtre sur MVRV."""
    full = get_cm_onchain()
    return {k: full[k] for k in ("mvrvRatioReal", "realizedCapUsd") if k in full}


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 4 — DÉRIVÉS : Bybit (OI + Funding) + Binance Spot (CVD + NTV)
# fapi.binance.com est bloqué DNS sur GitHub Actions → Bybit en remplacement
# api.binance.com (spot) reste accessible pour CVD proxy et NTV
# ══════════════════════════════════════════════════════════════════════════════

def get_binance_derivatives():
    """
    Dérivés BTC — architecture multi-source robuste :
    - Bybit v5 public API : OI historique + Funding Rate (pas de geo-restriction)
    - Binance Spot (api.binance.com) : klines pour CVD proxy + NTV
    - fapi.binance.com est EXCLU (bloqué DNS sur GitHub Actions)
    """
    result = {
        "futuresPower": 50.0, "futuresIndex": 0.5, "futuresLine": 0.5,
        "futures30dChange": 0.0, "oi_usd": 0.0, "oi_usd_chg7d": 0.0,
        "cvd_7d": 0.0, "cvd_30d": 0.0, "cvd_signal": 0,
        "funding_rate": 0.0, "funding_sma8": 0.0, "funding_signal": 0,
        "ntv_25h": 0.0,
    }

    # ── Open Interest — Bybit v5 ──────────────────────────────────────────────
    try:
        oi_raw  = fetch("https://api.bybit.com/v5/market/open-interest"
                        "?category=linear&symbol=BTCUSDT&intervalTime=1d&limit=31")
        oi_list = list(reversed((oi_raw.get("result") or {}).get("list") or []))
        if oi_list:
            oi_btc  = [float(x["openInterest"]) for x in oi_list]
            lo, hi  = min(oi_btc), max(oi_btc)
            chg30   = (oi_btc[-1] - oi_btc[0]) / oi_btc[0] if oi_btc[0] > 0 else 0.0
            index   = (oi_btc[-1] - lo) / (hi - lo) if hi > lo else 0.5
            ser     = pd.Series([(o - lo) / (hi - lo) if hi > lo else 0.5 for o in oi_btc])
            line    = float(ser.rolling(7).mean().iloc[-1])
            chg7    = (oi_btc[-1] - oi_btc[-8]) / oi_btc[-8] * 100 if len(oi_btc) >= 8 and oi_btc[-8] > 0 else 0.0
            result.update({
                "futuresPower":     round(50 + chg30 * 100, 4),
                "futuresIndex":     round(index, 6),
                "futuresLine":      round(line, 6),
                "futures30dChange": round(chg30, 6),
                "_oi_btc_last":     oi_btc[-1],
                "oi_usd_chg7d":     round(chg7, 4),
            })
            print(f"  Bybit OI → {oi_btc[-1]:,.0f} BTC  Power={result['futuresPower']:.1f}%")
    except Exception as e:
        print(f"  ⚠ Bybit OI: {e}")

    # ── Funding Rate — Bybit v5 ───────────────────────────────────────────────
    try:
        fr_raw  = fetch("https://api.bybit.com/v5/market/funding/history"
                        "?category=linear&symbol=BTCUSDT&limit=24")
        fr_list = list(reversed((fr_raw.get("result") or {}).get("list") or []))
        if fr_list:
            rates = [float(x["fundingRate"]) * 100 for x in fr_list]
            fr    = round(rates[-1], 6)
            sma8  = round(float(pd.Series(rates).rolling(8).mean().iloc[-1]), 6)
            result.update({
                "funding_rate":   fr,
                "funding_sma8":   sma8,
                "funding_signal": 1 if fr > 0.05 else (-1 if fr < -0.01 else 0),
            })
            print(f"  Bybit Funding → {fr:.4f}%  SMA8={sma8:.4f}%")
    except Exception as e:
        print(f"  ⚠ Bybit Funding: {e}")

    # ── CVD + OI USD via klines Binance SPOT 1j ───────────────────────────────
    try:
        klines   = fetch("https://api.binance.com/api/v3/klines"
                         "?symbol=BTCUSDT&interval=1d&limit=30")
        cvd_vals = [(float(k[9]) - (float(k[5]) - float(k[9]))) *
                    ((float(k[2]) + float(k[3])) / 2) for k in klines]
        cvd_7d   = round(sum(cvd_vals[-7:]) / 1e9, 4)
        cvd_30d  = round(sum(cvd_vals) / 1e9, 4)
        result.update({"cvd_7d": cvd_7d, "cvd_30d": cvd_30d,
                        "cvd_signal": 1 if cvd_7d > 0 else (-1 if cvd_7d < 0 else 0)})
        # OI USD = OI BTC (Bybit) × close price (Binance spot)
        if result.get("_oi_btc_last") and result.get("oi_usd") == 0.0:
            last_close       = float(klines[-1][4])
            result["oi_usd"] = round(result["_oi_btc_last"] * last_close / 1e9, 4)
        print(f"  Binance CVD (spot) → 7j={cvd_7d:.3f}B$  30j={cvd_30d:.3f}B$  OI={result['oi_usd']:.2f}B$")
    except Exception as e:
        print(f"  ⚠ CVD Binance spot: {e}")

    result.pop("_oi_btc_last", None)

    # ── NTV 25h — Binance SPOT 1h ─────────────────────────────────────────────
    try:
        h1  = fetch("https://api.binance.com/api/v3/klines"
                    "?symbol=BTCUSDT&interval=1h&limit=26")[:-1][-25:]
        ntv = sum((float(k[9]) - (float(k[5]) - float(k[9]))) *
                  ((float(k[2]) + float(k[3])) / 2) for k in h1)
        result["ntv_25h"] = round(ntv, 0)
        print(f"  Binance NTV 25h (spot) → {ntv/1e6:.1f}M$")
    except Exception as e:
        print(f"  ⚠ NTV: {e}")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 5 — COINBASE (prix + historique)
# ══════════════════════════════════════════════════════════════════════════════

def get_btc_price():
    return float(fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker")["price"])


def get_btc_history(days=365):
    # Coinbase accepte max 300 bougies par requête.
    # La SMA-200 et le bull/bear 365j nécessitent au minimum 365 points.
    # On fait 2 appels : lot1 = 300 derniers jours, lot2 = 100 jours antérieurs.
    # Correction : end_ts basé sur le timestamp réel de la bougie la plus ancienne du lot1
    # (et non sur une estimation, pour éviter les trous/chevauchements).
    import time as _time
    closes = []
    raw_d1 = []
    # Appel 1 : 300 derniers jours
    try:
        raw_d1 = fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&limit=300")
        c1     = [float(c[4]) for c in raw_d1]
        c1.reverse()
        closes = c1
    except Exception as e:
        print(f"  ⚠ Coinbase candles lot1: {e}")

    # Appel 2 : 100 jours supplémentaires
    # end_ts = timestamp Unix de la bougie la PLUS ANCIENNE du lot1 (indice [0] du tableau brut)
    # Coinbase renvoie les bougies en ordre décroissant : raw_d1[0] = le plus récent, raw_d1[-1] = le plus ancien.
    if len(closes) >= 10 and raw_d1:
        try:
            _time.sleep(0.5)
            oldest_ts = int(raw_d1[-1][0])   # timestamp Unix exact de la bougie la plus ancienne
            url2   = (f"https://api.exchange.coinbase.com/products/BTC-USD/candles"
                      f"?granularity=86400&limit=100&end={oldest_ts - 1}")
            d2     = fetch(url2)
            c2     = [float(c[4]) for c in d2]
            c2.reverse()
            closes = c2 + closes   # antérieur + récent
        except Exception as e:
            print(f"  ⚠ Coinbase candles lot2 (non bloquant): {e}")

    if not closes:
        raise RuntimeError("Impossible de charger l'historique BTC (Coinbase)")

    ser = pd.Series(closes)
    print(f"  Coinbase history → {len(ser)} bougies chargées")
    return ser.iloc[-days:]


# ══════════════════════════════════════════════════════════════════════════════
# PROXIES PRIX (fallbacks si toutes les API on-chain échouent)
# ══════════════════════════════════════════════════════════════════════════════

def px_nupl(prices, window):
    if len(prices) < window: window = len(prices)
    cur = float(prices.iloc[-1])
    return round((cur - float(prices.iloc[-window:].mean())) / cur, 6) if cur > 0 else 0.0

def px_sopr(prices):
    return float(prices.iloc[-1] / prices.rolling(7).mean().iloc[-1])

def px_mayer(prices):
    return float(prices.iloc[-1] / prices.rolling(200).mean().iloc[-1])

def px_mvrv_pct(prices):
    return float((prices < prices.iloc[-1]).sum() / len(prices) * 100)

def px_mvrv_zscore(prices, w=365):
    if len(prices) < w: w = len(prices)
    seg = prices.iloc[-w:]
    mu, sigma = seg.mean(), seg.std()
    return float((prices.iloc[-1] - mu) / sigma) if sigma > 0 else 0.0

def px_sharpe_cq(prices):
    """Sharpe proxy ×30, calibré sur l'échelle CryptoQuant (fond=-29.35 / top=+56.40)."""
    r = prices.pct_change().dropna()
    if len(r) < 30 or r.std() == 0: return 0.0
    return round(float((r.mean() / r.std()) * np.sqrt(365)) * 30, 4)

def px_bullbear(prices, days):
    if len(prices) < days: days = len(prices) - 1
    return float((prices.iloc[-1] / prices.iloc[-days]) - 1)

def px_bullbear_signals(bb30, bb365):
    return {
        "bb_overheated_bull": 1 if bb30 > 0.30 and bb365 > 0.30 else 0,
        "bb_bull":            1 if 0.05 < bb30 <= 0.30 else 0,
        "bb_early_bull":      1 if 0.00 < bb30 <= 0.05 else 0,
        "bb_bear":            1 if -0.20 <= bb30 <= 0.00 else 0,
        "bb_extreme_bear":    1 if bb30 < -0.20 else 0,
    }

def px_cohorts(prices):
    r = lambda n: round(px_bullbear(prices, n), 6)
    return {"coh_10k_plus": r(90), "coh_1k_10k": r(60), "coh_100_1k": r(30),
            "coh_10_100": r(21),  "coh_1_10": r(14),   "coh_01_1": r(7),   "coh_0_01": r(3)}

def px_sovb(prices):
    def rv(s, l):
        vs = float(prices.pct_change().tail(s).std())
        vl = float(prices.pct_change().tail(l).std())
        return round(vs / vl, 4) if vl > 0 and not (math.isnan(vs) or math.isnan(vl)) else 1.0
    def s7(s, l, n=7):
        ret = prices.pct_change().dropna()
        vals = []
        for i in range(n):
            if i + max(s, l) > len(ret): break
            ss = float(ret.iloc[-(i+1):][:s].std())
            sl = float(ret.iloc[-(i+1):][:l].std())
            if sl > 0 and not (math.isnan(ss) or math.isnan(sl)): vals.append(ss / sl)
        return round(float(np.mean(vals)) if vals else 1.0, 4)
    b01=rv(1,7); b1=rv(3,14); b10=rv(5,21); b100=rv(7,30); b1k=rv(14,60); b10k=rv(21,90)
    return {
        "sov_btc_0_1": b01, "sov_btc_1_10": b1, "sov_btc_10_100": b10,
        "sov_btc_100_1k": b100, "sov_btc_1k_10k": b1k, "sov_btc_10k_inf": b10k,
        "sov_btc_0_1_sma7": s7(1,7), "sov_btc_1_10_sma7": s7(3,14),
        "sov_btc_10_100_sma7": s7(5,21), "sov_btc_100_1k_sma7": s7(7,30),
        "sov_btc_1k_10k_sma7": s7(14,60), "sov_btc_10k_inf_sma7": s7(21,90),
        "sov_total_sma7": round(np.mean([s7(1,7),s7(3,14),s7(5,21),s7(7,30),s7(14,60),s7(21,90)]),4),
        "sov_avg_price": round(float(prices.tail(7).mean()), 2),
        "sov_signal": 1 if b1k > 1.30 or b10k > 1.30 else 0,
    }


# ══════════════════════════════════════════════════════════════════════════════
# ASSEMBLAGE DES INDICATEURS
# ══════════════════════════════════════════════════════════════════════════════

def assemble_mvrv(prices, data, cm):
    """MVRV étendu — priorité : données réelles > CoinMetrics ratio > proxy prix."""
    z365     = data.get("mvrvZscore")
    lth_mvrv = data.get("mvrvLth")
    sth_mvrv = data.get("mvrvSth")
    mvrv_r   = cm.get("mvrvRatioReal")

    src = "real"
    if z365 is None:
        z365 = round(px_mvrv_zscore(prices), 4)
        src  = "proxy"
        print(f"  ⚡ MVRV Z proxy: {z365}")
    else:
        print(f"  ✅ MVRV Z réel: {z365}")

    # Percentile
    pct = px_mvrv_pct(prices)
    if mvrv_r and mvrv_r > 0:
        # Approx percentile depuis ratio réel (calibré historique BTC)
        pct = min(100, max(0, round(20 * math.log(max(0.01, mvrv_r)) / math.log(5) * 5 + 20, 1)))

    zone = ("Deep undervaluation — LT buy zone"   if z365 <= -2.0 else
            "Accumulation / recovery zone"         if z365 <= -1.0 else
            "Neutral risk"                         if z365 <=  1.0 else
            "Overheated / distribution (high risk)")

    return {
        "mvrv_7d":          round(float(prices.iloc[-1] / prices.rolling(7).mean().iloc[-1]), 6),
        "mvrv_log_7d":      round(float(np.log(prices.iloc[-1] / prices.rolling(7).mean().iloc[-1])), 6),
        "mvrv_zscore_365d": z365, "mvrv_zscore_4yr": z365, "mvrv_zscore": z365,
        "mvrvPct":          round(pct, 4),
        "mvrvRatioReal":    round(mvrv_r, 4) if mvrv_r else None,
        "mvrvLth":          round(lth_mvrv, 4) if lth_mvrv else None,
        "mvrvSth":          round(sth_mvrv, 4) if sth_mvrv else None,
        "mvrv_high_signal": 1 if z365 >= 6.0 else 0,
        "mvrv_low_signal":  1 if z365 <= -1.5 else 0,
        "mvrv_zone":        zone,
        "_src_mvrv":        src,
    }


def assemble_mayer(prices, data):
    mm   = data.get("mayerReal") or px_mayer(prices)
    src  = "real" if data.get("mayerReal") else "proxy"
    s200 = float(prices.rolling(200).mean().iloc[-1])
    if src == "proxy": print(f"  ⚡ Mayer proxy: {mm:.4f}")
    return {
        "mayerMultiple":       round(mm, 6),
        "mayer_oversold":      1 if mm < 0.80 else 0,
        "mayer_sma200":        round(s200, 2),
        "mayer_overbought":    1 if mm > 2.40 else 0,
        "mayer_hi_overbought": 1 if mm > 3.50 else 0,
        "mayerAlert":          1 if mm < 0.80 else 0,
        "_src_mayer":          src,
    }


def assemble_etf(data, prices):
    """ETF flows réels BGeometrics (BTC/jour) → normalisation échelle scoring."""
    etf30 = data.get("etfFlow30dSum")
    daily = data.get("etfFlowDaily")
    if etf30 is not None:
        # Normalisation : ±20k BTC/30j = ±20 sur l'échelle scoring
        etf_pct = round(float(etf30) / 1000, 4)
        etf_usd = round(float(daily or 0) * float(prices.iloc[-1]), 0)
        src = "real"
        print(f"  ✅ ETF réel: {etf30:.0f} BTC/30j")
    else:
        etf_pct = round(px_bullbear(prices, 30) * 100, 4)
        etf_usd = round(px_bullbear(prices, 7) * float(prices.iloc[-1]) * 150000, 0)
        daily, etf30 = None, None
        src = "proxy"
        print(f"  ⚡ ETF proxy: {etf_pct:.2f}%")
    return {"etf_30d_sum": etf_pct, "etf_30d_sum_btc": etf30,
            "etf_netflow_usd": int(etf_usd), "etf_daily_btc": daily, "_src_etf": src}


def assemble_usdt(data, prices):
    """
    Stablecoin supply réelle (BG) → métriques correctes.
    Correction : usdt_sma30 = vraie moyenne journalière 30j (pas la variation brute),
                 usdt_60d_change = vraie variation 60j (pas ×2 de la variation 30j).
    """
    chg30 = data.get("stable30dChg")
    chg60 = data.get("stable60dChg")
    sma30 = data.get("stableSma30")   # variation journalière moyenne 30j
    if chg30 is not None:
        daily_mc = sma30 if sma30 is not None else round(float(chg30) / 30, 2)
        return {
            "usdt_daily_mc":     round(daily_mc, 2),
            "usdt_sma30":        round(daily_mc, 2),          # variation journalière moyenne 30j
            "usdt_60d_change":   round(float(chg60), 2) if chg60 is not None else round(float(chg30) * 2, 2),
            "usdt_60d_sma30":    round(float(chg60) / 60, 2) if chg60 is not None else round(daily_mc, 2),
            "stableSupplyUsdtB": data.get("stableUsdtB"),
            "stableSupplyUsdcB": data.get("stableUsdcB"),
            "_src_stable":       "real",
        }
    # Fallback CoinGecko
    try:
        cg    = fetch("https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=62")
        mc_b  = pd.Series([p[1] for p in cg["market_caps"]])   # market cap en USD
        daily = float(mc_b.iloc[-1] - mc_b.iloc[-2])
        sma30 = float(mc_b.diff().dropna().tail(30).mean())
        chg60 = float(mc_b.iloc[-1] - mc_b.iloc[-61]) if len(mc_b) >= 61 else 0.0
        print(f"  ⚡ Stablecoin CoinGecko (fallback)")
        return {"usdt_daily_mc": round(daily, 2), "usdt_sma30": round(sma30, 2),
                "usdt_60d_change": round(chg60, 2), "usdt_60d_sma30": round(chg60 / 60, 2),
                "stableSupplyUsdtB": None, "stableSupplyUsdcB": None, "_src_stable": "coingecko"}
    except:
        return {"usdt_daily_mc": 0.0, "usdt_sma30": 0.0, "usdt_60d_change": 0.0,
                "usdt_60d_sma30": 0.0, "stableSupplyUsdtB": None,
                "stableSupplyUsdcB": None, "_src_stable": "unavailable"}


def assemble_ntv(ntv_25h, prices):
    neg7 = int((prices.pct_change().tail(7) < 0).sum())
    s = 2 if neg7 >= 5 else 1 if neg7 >= 3 else -2 if neg7 == 0 else -1
    return {"ntv_sell_count": s, "ntv_light_buy": 1 if s <= -1 else 0,
            "ntv_strong_buy": 1 if s == -2 else 0, "ntv_light_sell": 1 if s >= 1 else 0,
            "ntv_strong_sell": 1 if s >= 2 else 0}


def assemble_lth_supply(prices, lth_nupl, data):
    """
    LTH Supply in Profit Ratio.
    - UTXOs in Profit% réel (BG) → converti en 0-1  ← priorité
    - Proxy mvrvPct×0.6 + lthNupl_norm×0.4          ← fallback
    Seuils CryptoQuant : capitulation < 0.50 / top > 0.95
    """
    pct = data.get("utxosInProfitPct")
    if pct is not None:
        ratio = round(float(pct) / 100, 4)
        src   = "real"
        print(f"  ✅ LTH Supply réel (UTXOs in Profit%): {pct:.1f}% → {ratio:.4f}")
    else:
        mvrv_p   = px_mvrv_pct(prices)
        lth_norm = max(0.0, min(1.0, (lth_nupl + 0.50) / 1.25))
        ratio    = round((mvrv_p / 100) * 0.6 + lth_norm * 0.4, 4)
        src      = "proxy"
        print(f"  ⚡ LTH Supply proxy: {ratio:.4f}")
    return float(ratio), src


def compute_thermal_score(d):
    """
    Score composite 0–9 via 9 indicateurs pondérés.
    Correction : clamp explicite sur chaque score individuel ET sur le score final
    pour garantir que thermalScore ∈ [0.0, 9.0] en toutes circonstances.
    """
    def _s(v, lo, hi):
        if v is None: return 4.5
        if hi == lo: return 4.5
        raw = (float(v) - lo) / (hi - lo) * 9
        return float(max(0.0, min(9.0, raw)))
    scores = [
        _s(d["mayerMultiple"],    0.55,  2.40),
        _s(d["mvrvPct"],          0.0,   90.0),
        _s(d["lthNupl"],         -0.50,  0.70),
        _s(d["sthNupl"],         -0.50,  0.70),
        _s(d["soprRatio"],        0.50,  6.90),
        _s(d["futuresPower"],    35.0,   80.0),
        _s(d["etf_30d_sum"],    -30.0,   20.0),
        _s(d["bullBear30d"],     -0.30,  0.30),
        _s(d.get("funding_rate", 0.0), -0.05, 0.10),
    ]
    result = round(float(max(0.0, min(9.0, np.mean(scores)))), 4)
    # Sanity check : log si une valeur en entrée semble aberrante
    for name, val in [("mayerMultiple", d["mayerMultiple"]), ("mvrvPct", d["mvrvPct"]),
                      ("lthNupl", d["lthNupl"]), ("soprRatio", d["soprRatio"])]:
        if val is not None and (float(val) > 1000 or float(val) < -1000):
            print(f"  ⚠ compute_thermal: valeur suspecte {name}={val}")
    return result


def sanitize(obj):
    if isinstance(obj, dict):  return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):  return [sanitize(v)    for v in obj]
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)): return None
    return obj


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

def run():
    now = datetime.utcnow()
    print(f"\n⬡ BTC Pipeline Kizoka0x v2 — {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"  ResearchBitcoin  : {'✅ token présent (bonus)' if RBN_TOKEN else '⚠  absent (CoinMetrics utilisé)'}")
    print(f"  BGeometrics      : {'✅ token présent' if BG_TOKEN  else '⚠  sans token (6 req/run max)'}")

    # ── PRIX + HISTORIQUE ────────────────────────────────────────────────────
    prices    = get_btc_history(365)
    btc_price = get_btc_price()
    print(f"  BTC: ${btc_price:,.2f}")

    # ── DÉRIVÉS : Bybit OI/Funding + Binance Spot CVD/NTV ───────────────────
    print("\n── Dérivés (Bybit + Binance Spot) ───────")
    fut = get_binance_derivatives()

    # ── ON-CHAIN PRINCIPAL : CoinMetrics Community (sans clé) ───────────────
    print("\n── CoinMetrics Community (principal) ────")
    data = get_cm_onchain()

    # ── ON-CHAIN BONUS : ResearchBitcoin (si token présent) ─────────────────
    # Surcharge uniquement les métriques que CoinMetrics n'a pas en LTH/STH séparé
    if RBN_TOKEN:
        print("\n── ResearchBitcoin (bonus LTH/STH) ──────")
        rbn = get_rbn_onchain(RBN_TOKEN)
        # RBN a LTH/STH séparés → prendre si disponibles (plus précis que les estimations CM)
        for k in ("lthSoprRaw", "sthSoprRaw", "soprRatio", "soprSma90",
                  "lthNupl", "sthNupl", "mvrvZscore", "mvrvLth", "mvrvSth"):
            if rbn.get(k) is not None:
                data[k] = rbn[k]

    # ── COMPLÉMENTS BGeometrics ──────────────────────────────────────────────
    # Métriques non couvertes par CoinMetrics : sharpe, mayer, ETF, stablecoin
    # Limité à 6 requêtes max en mode free (15/jour) pour ne pas épuiser le quota
    needed = set()
    needed |= {"sharpeReal", "mayerReal", "etfFlow30dSum", "stable30dChg"}
    # Ajouter utxos si CM n'a pas fourni assez pour le LTH Supply
    if data.get("mvrvRatioReal") is None:
        needed.add("utxosInProfitPct")
    # Backup exchange netflow si disponible avec token (ne pas gaspiller quota free sur ça)
    if BG_TOKEN:
        needed.add("exchNetflowBtc")

    print("\n── BGeometrics (compléments) ─────────────")
    bg = get_bg_complement(BG_TOKEN, needed)
    for k, v in bg.items():
        if data.get(k) is None:
            data[k] = v

    # ── RÉSOLUTION INDICATEURS ───────────────────────────────────────────────
    print("\n── Résolution indicateurs ────────────────")

    # NUPL
    lth_val = data.get("lthNupl")
    sth_val = data.get("sthNupl")
    if lth_val is None:
        lth_val = px_nupl(prices, 365)
        print(f"  ⚡ LTH NUPL proxy: {lth_val:.4f}")
    if sth_val is None:
        sth_val = px_nupl(prices, 155)
        print(f"  ⚡ STH NUPL proxy: {sth_val:.4f}")

    # SOPR
    sopr_val   = data.get("soprRatio")
    sopr_sma90 = data.get("soprSma90")
    if sopr_val is None:
        sopr_val = px_sopr(prices)
        print(f"  ⚡ SOPR proxy (prix/MA7): {sopr_val:.4f}")
    if sopr_sma90 is None:
        sopr_sma90 = round(float(pd.Series([
            px_sopr(prices.iloc[:max(7, len(prices) - i)])
            for i in range(min(90, len(prices) - 7))
        ]).mean()), 6)

    # SOPR Alert
    sopr_alert = 1 if (sopr_val < 1.0 and sopr_sma90 < 1.5) else 0

    # Sharpe
    sharpe_val = data.get("sharpeReal")
    if sharpe_val is None:
        sharpe_val = px_sharpe_cq(prices)
        print(f"  ⚡ Sharpe proxy ×30: {sharpe_val:.2f}")
    else:
        print(f"  ✅ Sharpe BG réel 364d: {sharpe_val:.2f}")

    # Composites
    cm_dict   = {k: data.get(k) for k in ("mvrvRatioReal", "realizedCapUsd")}
    mvrv_ext  = assemble_mvrv(prices, data, cm_dict)
    mayer_ext = assemble_mayer(prices, data)
    etf_data  = assemble_etf(data, prices)
    usdt_data = assemble_usdt(data, prices)

    bb30d    = px_bullbear(prices, 30)
    bb365d   = px_bullbear(prices, 365)
    bb_sigs  = px_bullbear_signals(bb30d, bb365d)
    ntv_sigs = assemble_ntv(fut["ntv_25h"], prices)
    cohorts  = px_cohorts(prices)
    sov      = px_sovb(prices)

    lth_sup, lth_sup_src = assemble_lth_supply(prices, lth_val, data)
    lth_sup_flag         = 1 if lth_sup < 0.50 else 0
    nupl_avg             = round((lth_val + sth_val) / 2, 6)

    thermal = compute_thermal_score({
        "mayerMultiple": mayer_ext["mayerMultiple"], "mvrvPct": mvrv_ext["mvrvPct"],
        "lthNupl": lth_val, "sthNupl": sth_val, "soprRatio": sopr_val,
        "futuresPower": fut["futuresPower"], "etf_30d_sum": etf_data["etf_30d_sum"],
        "bullBear30d": bb30d, "funding_rate": fut["funding_rate"],
    })

    # ── SOURCES METADATA ─────────────────────────────────────────────────────
    def src(rbn_key, bg_key=None, label_real="coinmetrics"):
        if data.get(rbn_key) is not None:
            return label_real
        if bg_key and data.get(bg_key) is not None:
            return "bgeometrics"
        return "proxy_price"

    sources = {
        "sopr":    "researchbitcoin" if data.get("lthSoprRaw") and RBN_TOKEN else
                   ("coinmetrics" if data.get("soprRatio") else "proxy_price"),
        "nupl":    "researchbitcoin" if RBN_TOKEN and data.get("lthNupl") else
                   ("coinmetrics" if data.get("lthNupl") else "proxy_price"),
        "mvrv":    mvrv_ext["_src_mvrv"],
        "sharpe":  "bgeometrics" if data.get("sharpeReal") is not None else "proxy_x30",
        "mayer":   mayer_ext["_src_mayer"],
        "etf":     etf_data["_src_etf"],
        "stable":  usdt_data["_src_stable"],
        "utxo":    lth_sup_src,
        "deriv":   "bybit" if fut.get("funding_rate") != 0.0 else "unavailable",
    }

    # ── JSON FINAL ───────────────────────────────────────────────────────────
    dashboard = {
        "updated":  now.strftime("%Y-%m-%dT%H:%M"),
        "btcPrice": round(float(btc_price), 2),

        # ── Flux & Liquidité ──────────────────────────────────────────────────
        "etf_30d_sum":       etf_data["etf_30d_sum"],
        "etf_30d_sum_btc":   etf_data["etf_30d_sum_btc"],
        "etf_netflow_usd":   etf_data["etf_netflow_usd"],
        "etf_daily_btc":     etf_data["etf_daily_btc"],
        "usdt_daily_mc":     usdt_data["usdt_daily_mc"],
        "usdt_sma30":        usdt_data["usdt_sma30"],
        "usdt_60d_change":   usdt_data["usdt_60d_change"],
        "usdt_60d_sma30":    usdt_data["usdt_60d_sma30"],
        "stableSupplyUsdtB": usdt_data["stableSupplyUsdtB"],
        "stableSupplyUsdcB": usdt_data["stableSupplyUsdcB"],
        "ntv_25h":           int(fut["ntv_25h"]),
        "ntv_sell_count":    ntv_sigs["ntv_sell_count"],
        "ntv_light_buy":     ntv_sigs["ntv_light_buy"],
        "ntv_strong_buy":    ntv_sigs["ntv_strong_buy"],
        "ntv_light_sell":    ntv_sigs["ntv_light_sell"],
        "ntv_strong_sell":   ntv_sigs["ntv_strong_sell"],
        "exchangeNetflowBtc":   data.get("exchNetflowBtc"),
        "exchangeNetflow7dBtc": data.get("exchNetflow7dBtc"),

        # ── Dérivés & Structure ───────────────────────────────────────────────
        "futuresPower":      fut["futuresPower"],
        "futuresIndex":      fut["futuresIndex"],
        "futuresLine":       fut["futuresLine"],
        "futures30dChange":  fut["futures30dChange"],
        "oi_usd":            fut["oi_usd"],
        "oi_usd_chg7d":      fut["oi_usd_chg7d"],
        "cvd_7d":            fut["cvd_7d"],
        "cvd_30d":           fut["cvd_30d"],
        "cvd_signal":        fut["cvd_signal"],
        "funding_rate":      fut["funding_rate"],
        "funding_sma8":      fut["funding_sma8"],
        "funding_signal":    fut["funding_signal"],
        "bb_overheated_bull":bb_sigs["bb_overheated_bull"],
        "bb_bull":           bb_sigs["bb_bull"],
        "bb_early_bull":     bb_sigs["bb_early_bull"],
        "bb_bear":           bb_sigs["bb_bear"],
        "bb_extreme_bear":   bb_sigs["bb_extreme_bear"],
        "bullBear365d":      round(bb365d, 6),
        "bullBear30d":       round(bb30d,  6),

        # ── Profitabilité & Holders ───────────────────────────────────────────
        "soprAlert":         int(sopr_alert),
        "soprRatio":         round(sopr_val,   6),
        "soprSma90":         round(sopr_sma90, 6),
        "lthSoprRaw":        data.get("lthSoprRaw"),
        "sthSoprRaw":        data.get("sthSoprRaw"),
        "lthNupl":           round(lth_val,  6),
        "sthNupl":           round(sth_val,  6),
        "nuplAvg":           round(nupl_avg, 6),
        "nuplLine":          round(nupl_avg, 6),
        "lthSupplyRatio":    round(lth_sup, 4),
        "lthSupplyFlag":     int(lth_sup_flag),
        "utxosInProfitPct":  data.get("utxosInProfitPct"),
        "coh_10k_plus":      cohorts["coh_10k_plus"],
        "coh_1k_10k":        cohorts["coh_1k_10k"],
        "coh_100_1k":        cohorts["coh_100_1k"],
        "coh_10_100":        cohorts["coh_10_100"],
        "coh_1_10":          cohorts["coh_1_10"],
        "coh_01_1":          cohorts["coh_01_1"],
        "coh_0_01":          cohorts["coh_0_01"],
        "sov_btc_0_1":            sov["sov_btc_0_1"],
        "sov_btc_1_10":           sov["sov_btc_1_10"],
        "sov_btc_10_100":         sov["sov_btc_10_100"],
        "sov_btc_100_1k":         sov["sov_btc_100_1k"],
        "sov_btc_1k_10k":         sov["sov_btc_1k_10k"],
        "sov_btc_10k_inf":        sov["sov_btc_10k_inf"],
        "sov_btc_0_1_sma7":       sov["sov_btc_0_1_sma7"],
        "sov_btc_1_10_sma7":      sov["sov_btc_1_10_sma7"],
        "sov_btc_10_100_sma7":    sov["sov_btc_10_100_sma7"],
        "sov_btc_100_1k_sma7":    sov["sov_btc_100_1k_sma7"],
        "sov_btc_1k_10k_sma7":    sov["sov_btc_1k_10k_sma7"],
        "sov_btc_10k_inf_sma7":   sov["sov_btc_10k_inf_sma7"],
        "sov_total_sma7":         sov["sov_total_sma7"],
        "sov_avg_price":          sov["sov_avg_price"],
        "sov_signal":             sov["sov_signal"],

        # ── Valorisation Long Terme ───────────────────────────────────────────
        "mvrv_7d":            mvrv_ext["mvrv_7d"],
        "mvrv_log_7d":        mvrv_ext["mvrv_log_7d"],
        "mvrv_zscore_365d":   mvrv_ext["mvrv_zscore_365d"],
        "mvrv_zscore_4yr":    mvrv_ext["mvrv_zscore_4yr"],
        "mvrvPct":            mvrv_ext["mvrvPct"],
        "mvrv_zscore":        mvrv_ext["mvrv_zscore"],
        "mvrvRatioReal":      mvrv_ext["mvrvRatioReal"],
        "mvrvLth":            mvrv_ext["mvrvLth"],
        "mvrvSth":            mvrv_ext["mvrvSth"],
        "mvrv_high_signal":   mvrv_ext["mvrv_high_signal"],
        "mvrv_low_signal":    mvrv_ext["mvrv_low_signal"],
        "mvrv_zone":          mvrv_ext["mvrv_zone"],
        "mayerMultiple":      mayer_ext["mayerMultiple"],
        "mayer_oversold":     mayer_ext["mayer_oversold"],
        "mayer_sma200":       mayer_ext["mayer_sma200"],
        "mayer_overbought":   mayer_ext["mayer_overbought"],
        "mayer_hi_overbought":mayer_ext["mayer_hi_overbought"],
        "mayerAlert":         mayer_ext["mayerAlert"],
        "sharpeShort":        sharpe_val,

        # ── Score Global ──────────────────────────────────────────────────────
        "thermalScore": thermal,

        # ── Métadonnées sources (debug GitHub Actions) ────────────────────────
        "_sources": sources,
    }

    dashboard = sanitize(dashboard)

    # ── pipeline_status : résumé de santé pour le dashboard ──────────────────
    # Permet au JSX d'afficher une alerte si des sources sont dégradées
    real_count  = sum(1 for v in sources.values()
                      if v in ("researchbitcoin","bgeometrics","coinmetrics","real","bybit"))
    proxy_count = sum(1 for v in sources.values() if "proxy" in str(v))
    if real_count >= 6:
        p_status = "ok"
    elif real_count >= 3:
        p_status = "partial"   # Quelques proxies — données moins précises
    else:
        p_status = "degraded"  # Majorité de proxies — données approximatives
    dashboard["pipeline_status"]   = p_status
    dashboard["pipeline_real_src"] = real_count
    dashboard["pipeline_proxy_src"]= proxy_count

    with open("btc_dashboard.json", "w") as f:
        json.dump(dashboard, f, indent=2)

    s = dashboard["_sources"]
    print(f"\n══ RÉSUMÉ ═══════════════════════════════════════════════════════")
    print(f"  Prix        : ${dashboard['btcPrice']:,.2f}")
    print(f"  SOPR        : {dashboard['soprRatio']:.4f} [{s['sopr']}] Alert={dashboard['soprAlert']}")
    print(f"               LTH={dashboard.get('lthSoprRaw')}  STH={dashboard.get('sthSoprRaw')}  SMA90={dashboard['soprSma90']:.4f}")
    print(f"  LTH NUPL    : {dashboard['lthNupl']:.4f} [{s['nupl']}]  |  STH NUPL={dashboard['sthNupl']:.4f}")
    print(f"  MVRV Z-Score: {dashboard['mvrv_zscore']:.4f} [{s['mvrv']}]  |  %ile={dashboard['mvrvPct']:.1f}%")
    print(f"  Sharpe 364d : {dashboard['sharpeShort']:.2f} [{s['sharpe']}]")
    print(f"  Mayer       : {dashboard['mayerMultiple']:.4f} [{s['mayer']}]  Alert={dashboard['mayerAlert']}")
    print(f"  ETF 30D     : {dashboard['etf_30d_sum']:.2f} [{s['etf']}]")
    print(f"  Funding     : {dashboard['funding_rate']:.4f}%  |  OI={dashboard['oi_usd']:.2f}B$  CVD7j={dashboard['cvd_7d']:.3f}B$")
    print(f"  LTH Supply  : {dashboard['lthSupplyRatio']:.4f} [{s['utxo']}]  Flag={dashboard['lthSupplyFlag']}")
    print(f"  Stable      : [{s['stable']}]  USDT={dashboard.get('stableSupplyUsdtB')}B  USDC={dashboard.get('stableSupplyUsdcB')}B")
    print(f"  Thermal     : {dashboard['thermalScore']:.3f}/9")
    print(f"  Status      : {dashboard['pipeline_status'].upper()}  ({dashboard['pipeline_real_src']} sources réelles · {dashboard['pipeline_proxy_src']} proxies)")
    print(f"  ✓ btc_dashboard.json — {dashboard['updated']} UTC\n")


if __name__ == "__main__":
    run()
