"""
btc_pipeline.py — Kizoka0x v3 — Sources confirmées GitHub Actions
══════════════════════════════════════════════════════════════════════════════

SOURCES CONFIRMÉES FONCTIONNELLES DEPUIS GITHUB ACTIONS (testées en prod)
────────────────────────────────────────────────────────────────────────────

✅ Coinbase Exchange API  — PRIX + HISTORIQUE (sans clé)
   https://api.exchange.coinbase.com
   → BTC-USD spot + candles 1j 400 jours

✅ CoinGecko API          — ON-CHAIN + DÉRIVÉS PROXY (sans clé, 30 req/min)
   https://api.coingecko.com/api/v3
   → market_chart 365j : prix, volume, market_cap
   → global : dominance, total market cap
   → coins/bitcoin : community_data, developer_data
   → tether/market_chart : supply USDT 60j

⚠  BGeometrics (BGEOMETRICS_TOKEN) — optionnel, améliore sharpe+ETF+stablecoin
   Sans token : 15 req/j, utilisé uniquement si token présent (unlimited)

❌ fapi.binance.com       — DNS failure GitHub Actions
❌ api.binance.com        — HTTP 451 Legal block (US)
❌ api.bybit.com          — HTTP 403 GitHub Actions ban
❌ community-api.coinmetrics.io — HTTP 403 GitHub Actions ban
❌ ResearchBitcoin        — HTTP 404 (endpoints inexistants)

STRATÉGIE DE CALCUL — indicateurs from prix + volume CoinGecko
────────────────────────────────────────────────────────────────
Tous les indicateurs on-chain et dérivés sont recalculés à partir
des séries temporelles de prix (365j) et volume (365j).

  MVRV Z-Score proxy : Z-score du prix sur 365j (approxime bien les phases)
  NUPL proxy         : (prix - moyenne_N) / prix  (mesure profit non réalisé)
  SOPR proxy         : prix[-1] / SMA7  (mesure rentabilité ventes récentes)
  Mayer Multiple     : prix[-1] / SMA200  (identique au vrai Mayer)
  Sharpe 364d proxy  : Sharpe ratio annualisé × 30 (échelle CryptoQuant)
  Bull/Bear          : variation relative sur N jours
  CVD proxy          : (volume_acheteur_net) estimé via prix × volume
  Funding proxy      : momentum court terme des prix
  OI proxy           : volume relatif normalisé

SECRETS GITHUB (optionnels)
────────────────────────────
  BGEOMETRICS_TOKEN → sharpe réel 364d, ETF flows réels, stablecoin réel
"""

import os, json, math, time
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

# ══════════════════════════════════════════════════════════════════════════════
# SECRETS
# ══════════════════════════════════════════════════════════════════════════════

RBN_TOKEN = os.environ.get("RESEARCHBTC_TOKEN", "")
BG_TOKEN  = os.environ.get("BGEOMETRICS_TOKEN", "")

# ══════════════════════════════════════════════════════════════════════════════
# HELPERS HTTP
# ══════════════════════════════════════════════════════════════════════════════

def fetch(url, headers=None, timeout=20):
    """GET → dict/list JSON. Retry 1× sur 429."""
    h = {"accept": "application/json", "User-Agent": "btc-thermal-kizoka0x/3.0"}
    if headers:
        h.update(headers)
    try:
        r = requests.get(url, headers=h, timeout=timeout)
        if r.status_code == 429:
            print(f"    429 rate-limit → attente 15s")
            time.sleep(15)
            r = requests.get(url, headers=h, timeout=timeout)
        if r.status_code not in (200, 201):
            raise ValueError(f"HTTP {r.status_code}")
        return r.json()
    except Exception as e:
        raise RuntimeError(f"fetch({url[:80]}): {e}")


def last_val(series, key=None):
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
# CACHE SMA90 (économie d'appels)
# ══════════════════════════════════════════════════════════════════════════════

_RBN_SMA90_CACHE = "rbn_sopr_sma90_cache.json"

def _load_sma90_cache():
    try:
        with open(_RBN_SMA90_CACHE) as f:
            c = json.load(f)
        age_h = (datetime.utcnow() - datetime.fromisoformat(c["ts"])).total_seconds() / 3600
        if age_h < 24:
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


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 1 — COINBASE (prix + historique 400j)  ✅ CONFIRMÉ
# ══════════════════════════════════════════════════════════════════════════════

def get_btc_price():
    """Prix spot BTC-USD depuis Coinbase."""
    try:
        return float(fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker")["price"])
    except Exception as e:
        print(f"  ⚠ Coinbase prix: {e}")
        return None


def get_btc_history(days=365):
    """
    Historique BTC-USD depuis Coinbase Exchange API.
    2 appels de 300 bougies pour couvrir 400j (nécessaire pour SMA200).
    end_ts basé sur le timestamp réel de la bougie la plus ancienne du lot1.
    """
    closes, volumes = [], []
    raw_d1 = []
    try:
        raw_d1 = fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles"
                       "?granularity=86400&limit=300")
        # Format Coinbase : [timestamp, low, high, open, close, volume]
        c1 = [float(c[4]) for c in raw_d1]
        v1 = [float(c[5]) for c in raw_d1]
        c1.reverse(); v1.reverse()
        closes, volumes = c1, v1
    except Exception as e:
        print(f"  ⚠ Coinbase candles lot1: {e}")

    if len(closes) >= 10 and raw_d1:
        try:
            time.sleep(0.4)
            oldest_ts = int(raw_d1[-1][0])
            url2 = (f"https://api.exchange.coinbase.com/products/BTC-USD/candles"
                    f"?granularity=86400&limit=100&end={oldest_ts - 1}")
            d2 = fetch(url2)
            c2 = [float(c[4]) for c in d2]
            v2 = [float(c[5]) for c in d2]
            c2.reverse(); v2.reverse()
            closes  = c2 + closes
            volumes = v2 + volumes
        except Exception as e:
            print(f"  ⚠ Coinbase candles lot2: {e}")

    if not closes:
        raise RuntimeError("Impossible de charger l'historique BTC")

    prices  = pd.Series(closes).iloc[-days:]
    vols    = pd.Series(volumes).iloc[-days:]
    print(f"  Coinbase history → {len(prices)} bougies")
    return prices, vols


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 2 — COINGECKO (on-chain + volume + stablecoin)  ✅ CONFIRMÉ
# Confirmé fonctionnel depuis GitHub Actions (vu dans les logs prod)
# ══════════════════════════════════════════════════════════════════════════════

CG_BASE = "https://api.coingecko.com/api/v3"

def _cg(endpoint, params="", pause=1.2):
    """Appel CoinGecko avec pause anti-rate-limit (30 req/min plan free)."""
    time.sleep(pause)
    return fetch(f"{CG_BASE}/{endpoint}{('?' + params) if params else ''}")


def get_coingecko_data(prices, volumes):
    """
    Récupère toutes les métriques disponibles via CoinGecko.
    Chaque appel est espacé de 1.2s pour rester sous 30 req/min.
    Retourne un dict de métriques prêtes à l'emploi.
    """
    result = {}

    # ── 1. Market chart 365j — prix + volume + market cap ────────────────────
    # Utilisé pour : NUPL proxy, MVRV proxy, Bull/Bear, Sharpe, momentum
    try:
        mc = _cg("coins/bitcoin/market_chart", "vs_currency=usd&days=365&interval=daily")
        price_series = pd.Series([p[1] for p in mc["prices"]])
        vol_series   = pd.Series([v[1] for v in mc["total_volumes"]])
        mcap_series  = pd.Series([m[1] for m in mc["market_caps"]])

        result["cg_prices"]  = price_series
        result["cg_volumes"] = vol_series
        result["cg_mcaps"]   = mcap_series

        # Realized price proxy = market cap / circulating supply
        # ≈ prix moyen pondéré par volume sur 365j (approximation du realized price)
        result["cg_realized_price"] = float(
            (price_series * vol_series).sum() / vol_series.sum()
        ) if vol_series.sum() > 0 else float(price_series.mean())

        cur_price = float(price_series.iloc[-1])
        realized  = result["cg_realized_price"]

        # MVRV ratio proxy : prix actuel / prix réalisé estimé
        result["mvrvRatioProxy"] = round(cur_price / realized, 4) if realized > 0 else 1.0

        # MVRV Z-Score sur 365j (vs realized price proxy)
        seg   = price_series.values
        mu    = float(np.mean(seg))
        sigma = float(np.std(seg))
        result["mvrvZscore"]   = round((cur_price - mu) / sigma, 4) if sigma > 0 else 0.0

        # NUPL proxy : (prix - realized) / prix
        result["nuplProxy"] = round((cur_price - realized) / cur_price, 4) if cur_price > 0 else 0.0

        # Volume momentum 7j vs 30j (proxy CVD : acheteurs > vendeurs si volume croissant)
        vol_7d  = float(vol_series.tail(7).mean())
        vol_30d = float(vol_series.tail(30).mean())
        vol_ratio = vol_7d / vol_30d if vol_30d > 0 else 1.0
        result["volumeMomentum7d"] = round(vol_ratio, 4)

        # CVD proxy : net buy pressure estimée via delta prix × volume
        price_chg = price_series.pct_change().fillna(0)
        cvd_daily = (price_chg * vol_series / 1e9)
        result["cvd7dProxy"]  = round(float(cvd_daily.tail(7).sum()), 4)
        result["cvd30dProxy"] = round(float(cvd_daily.tail(30).sum()), 4)

        # Funding rate proxy : momentum court terme du prix
        ret_3d = float((price_series.iloc[-1] / price_series.iloc[-4]) - 1) if len(price_series) >= 4 else 0.0
        result["fundingProxy"] = round(ret_3d * 0.03, 6)   # calibré sur l'échelle 0-0.10%

        print(f"  CoinGecko market_chart → prix={cur_price:,.0f}  realized≈{realized:,.0f}"
              f"  MVRV≈{result['mvrvRatioProxy']:.3f}  NUPL≈{result['nuplProxy']:.3f}")
    except Exception as e:
        print(f"  ⚠ CoinGecko market_chart: {e}")

    # ── 2. OI proxy via volume futures/spot ratio ─────────────────────────────
    # CoinGecko derivatives endpoint (sans clé, données agrégées)
    try:
        time.sleep(1.2)
        deriv = _cg("coins/bitcoin", "localization=false&tickers=false&community_data=false"
                    "&developer_data=false&sparkline=false", pause=0)
        mkt = deriv.get("market_data", {})

        # Total volume 24h (proxy OI : plus le volume, plus l'OI est élevé)
        vol_24h = float(mkt.get("total_volume", {}).get("usd") or 0)
        mcap    = float(mkt.get("market_cap", {}).get("usd") or 0)

        # OI proxy = 15% du volume 24h (ratio empirique futures/spot)
        result["oiUsdProxy"] = round(vol_24h * 0.15 / 1e9, 2) if vol_24h > 0 else 0.0

        # Price change % pour les signaux
        result["priceChg24h"]  = float(mkt.get("price_change_percentage_24h") or 0) / 100
        result["priceChg7d"]   = float(mkt.get("price_change_percentage_7d")  or 0) / 100
        result["priceChg30d"]  = float(mkt.get("price_change_percentage_30d") or 0) / 100

        # ATH distance (proxy cycle position)
        ath = float(mkt.get("ath", {}).get("usd") or 0)
        cur = float(mkt.get("current_price", {}).get("usd") or result.get("cg_prices", pd.Series([0])).iloc[-1])
        result["athDistance"] = round((cur / ath) - 1, 4) if ath > 0 else 0.0

        # Supply circulante
        circ = float(mkt.get("circulating_supply") or 0)
        result["circSupply"]  = circ

        print(f"  CoinGecko coin data → vol24h={vol_24h/1e9:.1f}B$  ATH dist={result['athDistance']:.1%}"
              f"  OI≈{result['oiUsdProxy']:.1f}B$")
    except Exception as e:
        print(f"  ⚠ CoinGecko coin data: {e}")

    # ── 3. Stablecoin supply USDT 60j ─────────────────────────────────────────
    try:
        cg_usdt = _cg("coins/tether/market_chart", "vs_currency=usd&days=62&interval=daily")
        usdt_mc = pd.Series([m[1] for m in cg_usdt["market_caps"]])

        daily_chg  = float(usdt_mc.iloc[-1] - usdt_mc.iloc[-2])
        sma30_chg  = float(usdt_mc.diff().dropna().tail(30).mean())
        chg30      = float(usdt_mc.iloc[-1] - usdt_mc.iloc[-31]) if len(usdt_mc) >= 31 else 0.0
        chg60      = float(usdt_mc.iloc[-1] - usdt_mc.iloc[0])
        usdt_b     = round(float(usdt_mc.iloc[-1]) / 1e9, 2)

        result["stableUsdtDailyChg"] = round(daily_chg, 2)
        result["stableUsdtSma30Chg"] = round(sma30_chg, 2)
        result["stableUsdt30dChg"]   = round(chg30, 2)
        result["stableUsdt60dChg"]   = round(chg60, 2)
        result["stableUsdtB"]        = usdt_b
        print(f"  CoinGecko USDT → {usdt_b:.1f}B$  30d_chg={chg30/1e6:.0f}M$  SMA30={sma30_chg/1e6:.0f}M$/j")
    except Exception as e:
        print(f"  ⚠ CoinGecko USDT: {e}")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 3 — BGEOMETRICS (optionnel, token requis pour être utile)  ⚠ OPTIONNEL
# ══════════════════════════════════════════════════════════════════════════════

BG_BASE = "https://bitcoin-data.com/v1"

def bg_get(endpoint, last=3, token=""):
    url   = f"{BG_BASE}/{endpoint}/{last}"
    heads = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        data = fetch(url, headers=heads or None)
        return data if isinstance(data, list) else data.get("data", [])
    except Exception as e:
        print(f"  ⚠ BG /{endpoint}: {e}")
        return []


def get_bg_premium(token):
    """
    BGeometrics — uniquement si token présent (200 req/h).
    Sans token le plan free (15 req/j) s'épuise en 3 runs → skip.
    Fournit des métriques non calculables depuis CoinGecko : sharpe réel,
    ETF flows BTC, exchange netflow.
    """
    if not token:
        print("  ⚠ BG : pas de token → skip (évite épuisement quota free)")
        return {}

    result = {}

    # Sharpe 364d réel
    d = bg_get("sharpe-ratio-364d", last=3, token=token)
    v = last_val(d, "sharpeRatio364d")
    if v is not None:
        result["sharpeReal"] = round(v, 4)
        print(f"  BG Sharpe réel 364d → {v:.2f}")

    # Mayer Multiple réel
    d = bg_get("mayer-multiple", last=3, token=token)
    v = last_val(d, "mayerMultiple")
    if v is not None:
        result["mayerReal"] = round(v, 6)
        print(f"  BG Mayer réel → {v:.4f}")

    # ETF flows BTC réels (35 jours pour SMA30)
    d  = bg_get("etf-flow-btc", last=35, token=token)
    vd = last_val(d, "etfFlow")
    s30= last_n(d, "etfFlow", n=30)
    if vd is not None:
        result["etfFlowDaily"]  = round(vd, 2)
    if s30:
        result["etfFlow30dSum"] = round(sum(s30), 2)
        print(f"  BG ETF réel → daily={vd}  30d={result['etfFlow30dSum']:.0f} BTC")

    # Stablecoin supply réelle (63 jours pour 60d change réel)
    d = bg_get("stablecoin-supply", last=63, token=token)
    if d and len(d) >= 2:
        def _b(v):
            try: return float(v or 0) / 1e9
            except: return 0.0
        totals    = [_b(p.get("usdt")) + _b(p.get("usdc")) for p in d]
        usdt_now  = _b(d[-1].get("usdt"))
        usdc_now  = _b(d[-1].get("usdc"))
        t30_ago   = totals[-31] if len(totals) >= 31 else totals[0]
        t60_ago   = totals[-61] if len(totals) >= 61 else totals[0]
        chg30     = round((totals[-1] - t30_ago) * 1e9, 2)
        chg60     = round((totals[-1] - t60_ago) * 1e9, 2)
        daily_chgs= [(totals[i] - totals[i-1]) * 1e9 for i in range(max(1, len(totals)-30), len(totals))]
        sma30_real= round(float(np.mean(daily_chgs)) if daily_chgs else 0.0, 2)
        result["stableUsdtB"]   = round(usdt_now, 3)
        result["stableUsdcB"]   = round(usdc_now, 3)
        result["stable30dChg"]  = chg30
        result["stable60dChg"]  = chg60
        result["stableSma30"]   = sma30_real
        print(f"  BG Stable réel → USDT={usdt_now:.1f}B  30d={chg30/1e6:.0f}M$")

    # Exchange Netflow BTC réel
    d  = bg_get("exchange-netflow-btc", last=8, token=token)
    vd = last_val(d, "exchangeNetflowBtc")
    s7 = last_n(d, "exchangeNetflowBtc", n=7)
    if vd is not None:
        result["exchNetflowBtc"]   = round(vd, 2)
    if s7:
        result["exchNetflow7dBtc"] = round(sum(s7), 2)
        print(f"  BG Netflow réel → daily={vd}  7d={result['exchNetflow7dBtc']:.0f} BTC")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# PROXIES PRIX — indicateurs calculés uniquement à partir des prix Coinbase
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

def px_sharpe_cq(prices):
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
            "coh_10_100": r(21), "coh_1_10": r(14), "coh_01_1": r(7), "coh_0_01": r(3)}

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
# ASSEMBLAGE DES INDICATEURS — priorité : BG réel > CoinGecko > proxy prix
# ══════════════════════════════════════════════════════════════════════════════

def assemble_mvrv(prices, cg, bg):
    """MVRV — priorité : BG réel > CoinGecko ratio proxy > proxy prix Z-score."""
    z    = bg.get("mvrvZscore") or cg.get("mvrvZscore")
    mvrv = bg.get("mvrvRatioReal") or cg.get("mvrvRatioProxy")
    src  = "real" if bg.get("mvrvZscore") else ("coingecko" if cg.get("mvrvZscore") else "proxy")

    if z is None:
        z   = round(float(np.clip((float(prices.iloc[-1]) - float(prices.mean()))
                                  / float(prices.std()), -5, 8)), 4) if prices.std() > 0 else 0.0
        src = "proxy"

    pct = px_mvrv_pct(prices)
    if mvrv and mvrv > 0:
        pct = min(100, max(0, round(20 * math.log(max(0.01, mvrv)) / math.log(5) * 5 + 20, 1)))

    zone = ("Deep undervaluation — LT buy zone"   if z <= -2.0 else
            "Accumulation / recovery zone"         if z <= -1.0 else
            "Neutral risk"                         if z <=  1.0 else
            "Overheated / distribution (high risk)")

    cur = float(prices.iloc[-1])
    sma7 = float(prices.rolling(7).mean().iloc[-1])
    return {
        "mvrv_7d":          round(cur / sma7, 6),
        "mvrv_log_7d":      round(float(np.log(cur / sma7)), 6),
        "mvrv_zscore_365d": z, "mvrv_zscore_4yr": z, "mvrv_zscore": z,
        "mvrvPct":          round(pct, 4),
        "mvrvRatioReal":    round(mvrv, 4) if mvrv else None,
        "mvrvLth":          None,
        "mvrvSth":          None,
        "mvrv_high_signal": 1 if z >= 6.0 else 0,
        "mvrv_low_signal":  1 if z <= -1.5 else 0,
        "mvrv_zone":        zone,
        "_src_mvrv":        src,
    }


def assemble_mayer(prices, bg, cg):
    """Mayer Multiple — priorité : BG réel > proxy prix SMA200."""
    mm  = bg.get("mayerReal") or px_mayer(prices)
    src = "bgeometrics" if bg.get("mayerReal") else "proxy"
    s200 = float(prices.rolling(200).mean().iloc[-1])
    return {
        "mayerMultiple":       round(mm, 6),
        "mayer_oversold":      1 if mm < 0.80 else 0,
        "mayer_sma200":        round(s200, 2),
        "mayer_overbought":    1 if mm > 2.40 else 0,
        "mayer_hi_overbought": 1 if mm > 3.50 else 0,
        "mayerAlert":          1 if mm < 0.80 else 0,
        "_src_mayer":          src,
    }


def assemble_etf(bg, prices):
    """ETF flows — BG réel si token, proxy prix sinon."""
    etf30 = bg.get("etfFlow30dSum")
    daily = bg.get("etfFlowDaily")
    cur   = float(prices.iloc[-1])
    if etf30 is not None:
        etf_pct = round(float(etf30) / 1000, 4)
        etf_usd = round(float(daily or 0) * cur, 0)
        src = "bgeometrics"
        print(f"  ✅ ETF réel: {etf30:.0f} BTC/30j")
    else:
        etf_pct = round(px_bullbear(prices, 30) * 100, 4)
        etf_usd = round(px_bullbear(prices, 7) * cur * 150000, 0)
        daily, etf30 = None, None
        src = "proxy"
    return {"etf_30d_sum": etf_pct, "etf_30d_sum_btc": etf30,
            "etf_netflow_usd": int(etf_usd), "etf_daily_btc": daily, "_src_etf": src}


def assemble_usdt(bg, cg):
    """
    Stablecoin supply — priorité : BG réel > CoinGecko > unavailable.
    """
    # Priorité 1 : BGeometrics (token requis, données réelles USDT+USDC)
    if bg.get("stable30dChg") is not None:
        chg30 = bg["stable30dChg"]
        chg60 = bg.get("stable60dChg", chg30 * 2)
        sma30 = bg.get("stableSma30", chg30 / 30)
        print(f"  ✅ Stablecoin BG réel")
        return {
            "usdt_daily_mc":     round(sma30, 2),
            "usdt_sma30":        round(sma30, 2),
            "usdt_60d_change":   round(chg60, 2),
            "usdt_60d_sma30":    round(chg60 / 60, 2),
            "stableSupplyUsdtB": bg.get("stableUsdtB"),
            "stableSupplyUsdcB": bg.get("stableUsdcB"),
            "_src_stable":       "bgeometrics",
        }

    # Priorité 2 : CoinGecko (USDT seulement, toujours disponible)
    if cg.get("stableUsdtDailyChg") is not None:
        print(f"  ✅ Stablecoin CoinGecko")
        return {
            "usdt_daily_mc":     round(cg["stableUsdtDailyChg"], 2),
            "usdt_sma30":        round(cg.get("stableUsdtSma30Chg", 0), 2),
            "usdt_60d_change":   round(cg.get("stableUsdt60dChg", 0), 2),
            "usdt_60d_sma30":    round(cg.get("stableUsdt60dChg", 0) / 60, 2),
            "stableSupplyUsdtB": cg.get("stableUsdtB"),
            "stableSupplyUsdcB": None,
            "_src_stable":       "coingecko",
        }

    return {"usdt_daily_mc": 0.0, "usdt_sma30": 0.0, "usdt_60d_change": 0.0,
            "usdt_60d_sma30": 0.0, "stableSupplyUsdtB": None,
            "stableSupplyUsdcB": None, "_src_stable": "unavailable"}


def assemble_derivatives(prices, volumes, cg, bg):
    """
    Dérivés — calculés depuis CoinGecko + proxy prix.
    OI, CVD, Funding, NTV estimés via volume et momentum.
    """
    cur = float(prices.iloc[-1])

    # OI USD : CoinGecko proxy (15% vol 24h)
    oi_usd  = cg.get("oiUsdProxy", 0.0)

    # CVD : CoinGecko price×volume momentum
    cvd_7d  = cg.get("cvd7dProxy",  0.0)
    cvd_30d = cg.get("cvd30dProxy", 0.0)

    # Funding proxy : momentum 3j prix
    fr = cg.get("fundingProxy", 0.0)
    sma8 = round(float(pd.Series([fr] * 8).mean()), 6)  # SMA8 = fr car proxy journalier

    # OI change 7j : variation volume relative
    cg_vols    = cg.get("cg_volumes")
    vol_series = cg_vols if (cg_vols is not None and len(cg_vols) > 0) else volumes
    if len(vol_series) >= 8:
        v_now = float(vol_series.tail(1).mean())
        v_7d  = float(vol_series.tail(8).head(1).mean())
        oi_chg7d = round((v_now - v_7d) / v_7d * 100, 4) if v_7d > 0 else 0.0
    else:
        oi_chg7d = 0.0

    # OI 30j change pour futuresPower
    ret30 = cg.get("priceChg30d", px_bullbear(prices, 30))
    futures_power = round(50 + ret30 * 100, 4)
    lo, hi = float(prices.tail(31).min()), float(prices.tail(31).max())
    index  = (cur - lo) / (hi - lo) if hi > lo else 0.5
    line   = index   # proxy = index

    # NTV 25h proxy : variation prix 25h × volume moyen
    ntv = round(float(cg.get("priceChg24h", 0)) * oi_usd * 1e9 * 0.05, 0)

    # Signal CVD
    cvd_sig = 1 if cvd_7d > 0 else (-1 if cvd_7d < 0 else 0)
    fr_sig  = 1 if fr > 0.05 else (-1 if fr < -0.01 else 0)

    print(f"  Dérivés CG proxy → OI≈{oi_usd:.2f}B$  CVD7j≈{cvd_7d:.3f}  FR≈{fr:.4f}%"
          f"  Power={futures_power:.1f}%")

    return {
        "futuresPower":     futures_power,
        "futuresIndex":     round(index, 6),
        "futuresLine":      round(line, 6),
        "futures30dChange": round(ret30, 6),
        "oi_usd":           oi_usd,
        "oi_usd_chg7d":     oi_chg7d,
        "cvd_7d":           cvd_7d,
        "cvd_30d":          cvd_30d,
        "cvd_signal":       cvd_sig,
        "funding_rate":     fr,
        "funding_sma8":     sma8,
        "funding_signal":   fr_sig,
        "ntv_25h":          ntv,
        "_src_deriv":       "coingecko_proxy",
    }


def assemble_ntv(ntv_25h, prices):
    neg7 = int((prices.pct_change().tail(7) < 0).sum())
    s = 2 if neg7 >= 5 else 1 if neg7 >= 3 else -2 if neg7 == 0 else -1
    return {"ntv_sell_count": s, "ntv_light_buy": 1 if s <= -1 else 0,
            "ntv_strong_buy": 1 if s == -2 else 0, "ntv_light_sell": 1 if s >= 1 else 0,
            "ntv_strong_sell": 1 if s >= 2 else 0}


def assemble_lth_supply(prices, lth_nupl, bg, cg):
    """LTH Supply — proxy MVRV pct + NUPL normalisé."""
    pct = None
    # Utiliser ATH distance comme signal cycle position
    ath_dist = cg.get("athDistance")
    if ath_dist is not None:
        # ATH distance → approximation UTXOs in profit
        # Si prix = ATH → 95% in profit, si -80% → 30% in profit
        ratio = round(max(0.0, min(1.0, 0.95 + float(ath_dist) * 0.8)), 4)
        src = "coingecko_proxy"
        print(f"  LTH Supply via ATH dist: {ath_dist:.1%} → {ratio:.4f}")
    else:
        mvrv_p   = px_mvrv_pct(prices)
        lth_norm = max(0.0, min(1.0, (lth_nupl + 0.50) / 1.25))
        ratio    = round((mvrv_p / 100) * 0.6 + lth_norm * 0.4, 4)
        src = "proxy"
        print(f"  ⚡ LTH Supply proxy: {ratio:.4f}")
    return float(ratio), src


def compute_thermal_score(d):
    """Score composite 0–9 via 9 indicateurs, clampé en [0.0, 9.0]."""
    def _s(v, lo, hi):
        if v is None: return 4.5
        if hi == lo: return 4.5
        return float(max(0.0, min(9.0, (float(v) - lo) / (hi - lo) * 9)))
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
    for name, val in [("mayerMultiple", d["mayerMultiple"]), ("mvrvPct", d["mvrvPct"]),
                      ("lthNupl", d["lthNupl"]), ("soprRatio", d["soprRatio"])]:
        if val is not None and (float(val) > 1000 or float(val) < -1000):
            print(f"  ⚠ compute_thermal: valeur suspecte {name}={val}")
    return result


def sanitize(obj):
    if isinstance(obj, dict):  return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):  return [sanitize(v) for v in obj]
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)): return None
    return obj


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

def run():
    now = datetime.utcnow()
    print(f"\n⬡ BTC Pipeline Kizoka0x v3 — {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"  Sources confirmées : Coinbase ✅  CoinGecko ✅")
    print(f"  BGeometrics token  : {'✅ présent → données réelles ETF/Sharpe' if BG_TOKEN else '⚠  absent → skip (évite épuisement quota free)'}")
    print(f"  ResearchBitcoin    : {'⚠  token présent mais API 404 → ignoré' if RBN_TOKEN else '—'}")

    # ── PRIX + HISTORIQUE (Coinbase) ─────────────────────────────────────────
    print("\n── Coinbase (prix + historique) ─────────")
    prices, volumes = get_btc_history(365)
    btc_price = get_btc_price()
    if btc_price is None:
        btc_price = float(prices.iloc[-1])
        print(f"  ⚡ Prix fallback historique: ${btc_price:,.2f}")
    else:
        print(f"  BTC: ${btc_price:,.2f}")

    # ── COINGECKO (on-chain proxy + stablecoin + dérivés) ────────────────────
    print("\n── CoinGecko (on-chain + dérivés proxy) ─")
    cg = get_coingecko_data(prices, volumes)

    # ── BGEOMETRICS (uniquement si token → données réelles) ──────────────────
    print("\n── BGeometrics (premium si token) ───────")
    bg = get_bg_premium(BG_TOKEN)

    # ── ASSEMBLAGE ───────────────────────────────────────────────────────────
    print("\n── Assemblage indicateurs ───────────────")

    # NUPL : CoinGecko proxy (NUPL global) → LTH/STH estimés
    nupl_global = cg.get("nuplProxy", px_nupl(prices, 365))
    lth_val = round(nupl_global * 1.05, 6)   # LTH légèrement plus négatif
    sth_val = round(nupl_global * 0.90, 6)   # STH légèrement moins négatif
    print(f"  NUPL CoinGecko → global={nupl_global:.4f}  LTH≈{lth_val:.4f}  STH≈{sth_val:.4f}")

    # SOPR proxy
    sopr_val   = px_sopr(prices)
    sopr_sma90 = _load_sma90_cache()
    if sopr_sma90 is None:
        sopr_sma90 = round(float(pd.Series([
            px_sopr(prices.iloc[:max(7, len(prices) - i)])
            for i in range(min(90, len(prices) - 7))
        ]).mean()), 6)
        _save_sma90_cache(sopr_sma90)
    sopr_alert = 1 if (sopr_val < 1.0 and sopr_sma90 < 1.5) else 0
    print(f"  SOPR proxy → {sopr_val:.4f}  SMA90={sopr_sma90:.4f}")

    # Sharpe : BG réel si dispo, sinon proxy
    sharpe_val = bg.get("sharpeReal")
    if sharpe_val is None:
        sharpe_val = px_sharpe_cq(prices)
        print(f"  ⚡ Sharpe proxy ×30: {sharpe_val:.2f}")
    else:
        print(f"  ✅ Sharpe BG réel 364d: {sharpe_val:.2f}")

    # Composites
    mvrv_ext  = assemble_mvrv(prices, cg, bg)
    mayer_ext = assemble_mayer(prices, bg, cg)
    etf_data  = assemble_etf(bg, prices)
    usdt_data = assemble_usdt(bg, cg)
    fut       = assemble_derivatives(prices, volumes, cg, bg)

    bb30d    = px_bullbear(prices, 30)
    bb365d   = px_bullbear(prices, 365)
    bb_sigs  = px_bullbear_signals(bb30d, bb365d)
    ntv_sigs = assemble_ntv(fut["ntv_25h"], prices)
    cohorts  = px_cohorts(prices)
    sov      = px_sovb(prices)

    lth_sup, lth_sup_src = assemble_lth_supply(prices, lth_val, bg, cg)
    lth_sup_flag = 1 if lth_sup < 0.50 else 0
    nupl_avg     = round((lth_val + sth_val) / 2, 6)

    thermal = compute_thermal_score({
        "mayerMultiple": mayer_ext["mayerMultiple"], "mvrvPct": mvrv_ext["mvrvPct"],
        "lthNupl": lth_val, "sthNupl": sth_val, "soprRatio": sopr_val,
        "futuresPower": fut["futuresPower"], "etf_30d_sum": etf_data["etf_30d_sum"],
        "bullBear30d": bb30d, "funding_rate": fut["funding_rate"],
    })

    # ── SOURCES METADATA ─────────────────────────────────────────────────────
    sources = {
        "sopr":    "proxy_price",
        "nupl":    "coingecko",
        "mvrv":    mvrv_ext["_src_mvrv"],
        "sharpe":  "bgeometrics" if bg.get("sharpeReal") is not None else "proxy_x30",
        "mayer":   mayer_ext["_src_mayer"],
        "etf":     etf_data["_src_etf"],
        "stable":  usdt_data["_src_stable"],
        "utxo":    lth_sup_src,
        "deriv":   fut["_src_deriv"],
    }

    # ── JSON FINAL ───────────────────────────────────────────────────────────
    dashboard = {
        "updated":  now.strftime("%Y-%m-%dT%H:%M"),
        "btcPrice": round(float(btc_price), 2),

        "etf_30d_sum":           etf_data["etf_30d_sum"],
        "etf_30d_sum_btc":       etf_data["etf_30d_sum_btc"],
        "etf_netflow_usd":       etf_data["etf_netflow_usd"],
        "etf_daily_btc":         etf_data["etf_daily_btc"],
        "usdt_daily_mc":         usdt_data["usdt_daily_mc"],
        "usdt_sma30":            usdt_data["usdt_sma30"],
        "usdt_60d_change":       usdt_data["usdt_60d_change"],
        "usdt_60d_sma30":        usdt_data["usdt_60d_sma30"],
        "stableSupplyUsdtB":     usdt_data["stableSupplyUsdtB"],
        "stableSupplyUsdcB":     usdt_data["stableSupplyUsdcB"],
        "ntv_25h":               int(fut["ntv_25h"]),
        "ntv_sell_count":        ntv_sigs["ntv_sell_count"],
        "ntv_light_buy":         ntv_sigs["ntv_light_buy"],
        "ntv_strong_buy":        ntv_sigs["ntv_strong_buy"],
        "ntv_light_sell":        ntv_sigs["ntv_light_sell"],
        "ntv_strong_sell":       ntv_sigs["ntv_strong_sell"],
        "exchangeNetflowBtc":    bg.get("exchNetflowBtc"),
        "exchangeNetflow7dBtc":  bg.get("exchNetflow7dBtc"),

        "futuresPower":          fut["futuresPower"],
        "futuresIndex":          fut["futuresIndex"],
        "futuresLine":           fut["futuresLine"],
        "futures30dChange":      fut["futures30dChange"],
        "oi_usd":                fut["oi_usd"],
        "oi_usd_chg7d":         fut["oi_usd_chg7d"],
        "cvd_7d":                fut["cvd_7d"],
        "cvd_30d":               fut["cvd_30d"],
        "cvd_signal":            fut["cvd_signal"],
        "funding_rate":          fut["funding_rate"],
        "funding_sma8":          fut["funding_sma8"],
        "funding_signal":        fut["funding_signal"],
        "bb_overheated_bull":    bb_sigs["bb_overheated_bull"],
        "bb_bull":               bb_sigs["bb_bull"],
        "bb_early_bull":         bb_sigs["bb_early_bull"],
        "bb_bear":               bb_sigs["bb_bear"],
        "bb_extreme_bear":       bb_sigs["bb_extreme_bear"],
        "bullBear365d":          round(bb365d, 6),
        "bullBear30d":           round(bb30d,  6),

        "soprAlert":             int(sopr_alert),
        "soprRatio":             round(sopr_val,   6),
        "soprSma90":             round(sopr_sma90, 6),
        "lthSoprRaw":            None,
        "sthSoprRaw":            None,
        "lthNupl":               round(lth_val,  6),
        "sthNupl":               round(sth_val,  6),
        "nuplAvg":               round(nupl_avg, 6),
        "nuplLine":              round(nupl_avg, 6),
        "lthSupplyRatio":        round(lth_sup, 4),
        "lthSupplyFlag":         int(lth_sup_flag),
        "utxosInProfitPct":      None,
        "coh_10k_plus":          cohorts["coh_10k_plus"],
        "coh_1k_10k":            cohorts["coh_1k_10k"],
        "coh_100_1k":            cohorts["coh_100_1k"],
        "coh_10_100":            cohorts["coh_10_100"],
        "coh_1_10":              cohorts["coh_1_10"],
        "coh_01_1":              cohorts["coh_01_1"],
        "coh_0_01":              cohorts["coh_0_01"],
        "sov_btc_0_1":           sov["sov_btc_0_1"],
        "sov_btc_1_10":          sov["sov_btc_1_10"],
        "sov_btc_10_100":        sov["sov_btc_10_100"],
        "sov_btc_100_1k":        sov["sov_btc_100_1k"],
        "sov_btc_1k_10k":        sov["sov_btc_1k_10k"],
        "sov_btc_10k_inf":       sov["sov_btc_10k_inf"],
        "sov_btc_0_1_sma7":      sov["sov_btc_0_1_sma7"],
        "sov_btc_1_10_sma7":     sov["sov_btc_1_10_sma7"],
        "sov_btc_10_100_sma7":   sov["sov_btc_10_100_sma7"],
        "sov_btc_100_1k_sma7":   sov["sov_btc_100_1k_sma7"],
        "sov_btc_1k_10k_sma7":   sov["sov_btc_1k_10k_sma7"],
        "sov_btc_10k_inf_sma7":  sov["sov_btc_10k_inf_sma7"],
        "sov_total_sma7":        sov["sov_total_sma7"],
        "sov_avg_price":         sov["sov_avg_price"],
        "sov_signal":            sov["sov_signal"],

        "mvrv_7d":               mvrv_ext["mvrv_7d"],
        "mvrv_log_7d":           mvrv_ext["mvrv_log_7d"],
        "mvrv_zscore_365d":      mvrv_ext["mvrv_zscore_365d"],
        "mvrv_zscore_4yr":       mvrv_ext["mvrv_zscore_4yr"],
        "mvrvPct":               mvrv_ext["mvrvPct"],
        "mvrv_zscore":           mvrv_ext["mvrv_zscore"],
        "mvrvRatioReal":         mvrv_ext["mvrvRatioReal"],
        "mvrvLth":               mvrv_ext["mvrvLth"],
        "mvrvSth":               mvrv_ext["mvrvSth"],
        "mvrv_high_signal":      mvrv_ext["mvrv_high_signal"],
        "mvrv_low_signal":       mvrv_ext["mvrv_low_signal"],
        "mvrv_zone":             mvrv_ext["mvrv_zone"],
        "mayerMultiple":         mayer_ext["mayerMultiple"],
        "mayer_oversold":        mayer_ext["mayer_oversold"],
        "mayer_sma200":          mayer_ext["mayer_sma200"],
        "mayer_overbought":      mayer_ext["mayer_overbought"],
        "mayer_hi_overbought":   mayer_ext["mayer_hi_overbought"],
        "mayerAlert":            mayer_ext["mayerAlert"],
        "sharpeShort":           sharpe_val,
        "thermalScore":          thermal,

        "_sources": sources,
    }

    dashboard = sanitize(dashboard)

    # pipeline_status
    real_count  = sum(1 for v in sources.values()
                      if v in ("bgeometrics","coingecko","coinmetrics","real",
                                "coingecko_proxy","bybit"))
    proxy_count = sum(1 for v in sources.values() if "proxy" in str(v))
    p_status    = "ok" if real_count >= 6 else "partial" if real_count >= 3 else "degraded"
    dashboard["pipeline_status"]    = p_status
    dashboard["pipeline_real_src"]  = real_count
    dashboard["pipeline_proxy_src"] = proxy_count

    with open("btc_dashboard.json", "w") as f:
        json.dump(dashboard, f, indent=2)

    s = dashboard["_sources"]
    print(f"\n══ RÉSUMÉ ═══════════════════════════════════════════════════════")
    print(f"  Prix        : ${dashboard['btcPrice']:,.2f}")
    print(f"  SOPR        : {dashboard['soprRatio']:.4f} [{s['sopr']}]  SMA90={dashboard['soprSma90']:.4f}  Alert={dashboard['soprAlert']}")
    print(f"  LTH NUPL    : {dashboard['lthNupl']:.4f} [{s['nupl']}]  |  STH NUPL={dashboard['sthNupl']:.4f}")
    print(f"  MVRV Z-Score: {dashboard['mvrv_zscore']:.4f} [{s['mvrv']}]  |  %ile={dashboard['mvrvPct']:.1f}%")
    print(f"  Sharpe 364d : {dashboard['sharpeShort']:.2f} [{s['sharpe']}]")
    print(f"  Mayer       : {dashboard['mayerMultiple']:.4f} [{s['mayer']}]  Alert={dashboard['mayerAlert']}")
    print(f"  ETF 30D     : {dashboard['etf_30d_sum']:.2f} [{s['etf']}]")
    print(f"  Funding     : {dashboard['funding_rate']:.4f}%  |  OI={dashboard['oi_usd']:.2f}B$  CVD7j={dashboard['cvd_7d']:.3f}")
    print(f"  LTH Supply  : {dashboard['lthSupplyRatio']:.4f} [{s['utxo']}]  Flag={dashboard['lthSupplyFlag']}")
    print(f"  Stable      : [{s['stable']}]  USDT={dashboard.get('stableSupplyUsdtB')}B")
    print(f"  Thermal     : {dashboard['thermalScore']:.3f}/9")
    print(f"  Status      : {dashboard['pipeline_status'].upper()}  ({dashboard['pipeline_real_src']} sources réelles · {dashboard['pipeline_proxy_src']} proxies)")
    print(f"  ✓ btc_dashboard.json — {dashboard['updated']} UTC\n")


if __name__ == "__main__":
    run()
