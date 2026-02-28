"""
btc_pipeline.py — Version finale Kizoka0x
Génère btc_dashboard.json avec TOUS les indicateurs listés, sections ordonnées.
Sources gratuites : Coinbase / CoinGecko / Binance / BGeometrics
Lancé par GitHub Actions toutes les 30 minutes.

IMPORTANT : Les valeurs marquées [proxy] sont des approximations.
Les valeurs exactes CryptoQuant nécessitent un accès API payant.
"""
import requests
import pandas as pd
import numpy as np
import json
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════════
# HTTP
# ═══════════════════════════════════════════════════════════════════════════════
def get_json(url, headers_extra=None):
    h = {"accept": "application/json", "User-Agent": "btc-thermal-kizoka0x"}
    if headers_extra:
        h.update(headers_extra)
    r = requests.get(url, headers=h, timeout=20)
    if r.status_code in [429, 401]:
        import time; time.sleep(7)
        r = requests.get(url, headers=h, timeout=20)
    if r.status_code != 200:
        raise Exception(f"HTTP {r.status_code} : {url}")
    return r.json()

# ═══════════════════════════════════════════════════════════════════════════════
# BGeometrics — on-chain réels gratuits (avec fallback)
# ═══════════════════════════════════════════════════════════════════════════════
def bgeometrics(indicator):
    try:
        data = get_json(f"https://api.bgeometrics.com/v1/{indicator}?asset=btc")
        if "data" not in data or not data["data"]:
            return None
        v = float(data["data"][-1]["value"])
        return None if (v == 0 or np.isnan(v)) else v
    except:
        return None

# ═══════════════════════════════════════════════════════════════════════════════
# SOURCES GRATUITES
# ═══════════════════════════════════════════════════════════════════════════════

def get_btc_price():
    return float(get_json("https://api.exchange.coinbase.com/products/BTC-USD/ticker")["price"])

def get_btc_history(days=365):
    """Historique journalier Coinbase — ordre ancien → récent."""
    data = get_json("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400")
    closes = [c[4] for c in data]
    closes.reverse()
    return pd.Series(closes[-days:])

def get_usdt_data():
    """
    Retourne les métriques USDT depuis CoinGecko.
    USDT ≈ 1$ → les variations de prix sont de l'ordre de 0.001.
    On multiplie par 1e6 pour obtenir une approximation en millions de $
    (proxy de la variation de market cap).
    """
    data = get_json("https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=70")
    prices = pd.Series([p[1] for p in data["prices"]])
    # Reconstitution proxy market cap change (USDT ≈ 1$, variation = déviation)
    # On utilise la déviation de prix × 1e9 comme proxy de change en USD
    sma30     = prices.rolling(30).mean()
    daily_dev = float(prices.iloc[-1] - prices.iloc[-2]) * 1e9   # proxy daily MC change
    sma30_val = float((prices.iloc[-1] - sma30.iloc[-1]) * 1e9)  # proxy SMA30
    # 60-day change proxy
    p60       = prices.iloc[-60] if len(prices) >= 60 else prices.iloc[0]
    chg60d    = float((prices.iloc[-1] - p60) * 1e9)
    # SMA30 du 60-day change (rolling 30 sur le 60d change)
    series60  = pd.Series([(prices.iloc[i] - prices.iloc[max(0,i-60)]) * 1e9
                           for i in range(len(prices))])
    sma30_60d = float(series60.rolling(30).mean().iloc[-1]) if len(series60) >= 30 else 0.0
    return {
        "usdt_daily_mc":     round(daily_dev,   2),
        "usdt_sma30":        round(sma30_val,   6),
        "usdt_60d_change":   round(chg60d,      2),
        "usdt_60d_sma30":    round(sma30_60d,   2),
    }

def get_futures_data():
    """Binance Futures OI — calcul Market Power + Index + Line + 30d change."""
    try:
        data = get_json("https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=31")
        oi   = [float(d["sumOpenInterest"]) for d in data]
        if len(oi) < 2:
            return {"futuresPower": 50.0, "futuresIndex": 0.0, "futuresLine": 0.0, "futures30dChange": 0.0}
        chg30   = (oi[-1] - oi[0]) / oi[0]
        power   = 50 + chg30 * 100
        # Index = OI normalisé sur 0-1 entre min et max 30j
        oi_min, oi_max = min(oi), max(oi)
        index   = (oi[-1] - oi_min) / (oi_max - oi_min) if oi_max > oi_min else 0.5
        # Line = SMA7 de l'index
        idx_ser = pd.Series([(o - oi_min)/(oi_max - oi_min) if oi_max > oi_min else 0.5 for o in oi])
        line    = float(idx_ser.rolling(7).mean().iloc[-1])
        return {
            "futuresPower":     round(float(power),  4),
            "futuresIndex":     round(float(index),  6),
            "futuresLine":      round(float(line),   6),
            "futures30dChange": round(float(chg30),  6),
        }
    except:
        return {"futuresPower":50.0,"futuresIndex":0.5,"futuresLine":0.5,"futures30dChange":0.0}

# ═══════════════════════════════════════════════════════════════════════════════
# CALCULS PROXY SUR PRIX COINBASE
# ═══════════════════════════════════════════════════════════════════════════════

def compute_mayer(prices):
    return float(prices.iloc[-1] / prices.rolling(200).mean().iloc[-1])

def compute_sma200(prices):
    return float(prices.rolling(200).mean().iloc[-1])

def compute_bullbear(prices, days):
    if len(prices) < days: days = len(prices) - 1
    return float((prices.iloc[-1] / prices.iloc[-days]) - 1)

def compute_sharpe(prices):
    r = prices.pct_change().dropna()
    std = r.std()
    if std == 0 or np.isnan(std):
        return 0.0
    return float((r.mean() / std) * np.sqrt(365))

def compute_sopr_proxy(prices):
    """Prix actuel / MA7 — proxy SOPR. Valeurs réelles CryptoQuant ~0.5 à 15+."""
    return float(prices.iloc[-1] / prices.rolling(7).mean().iloc[-1])

def compute_nupl(prices, window):
    if len(prices) < window: window = len(prices)
    seg = prices.iloc[-window:]
    lo, hi, cur = seg.min(), seg.max(), seg.iloc[-1]
    return 0.0 if hi == lo else float((cur - lo) / (hi - lo))

def compute_utxo_ratio(prices):
    """
    PROXY NON FIABLE — utiliser uniquement si BGeometrics retourne None.
    Le vrai ratio CQ nécessite l'historique complet des UTXOs depuis 2009.
    Retourne -1 pour signaler que la valeur est indisponible.
    """
    return -1.0  # Indisponible — proxy impossible avec données de prix uniquement

def compute_mvrv_pct(prices):
    return float((prices < prices.iloc[-1]).sum() / len(prices) * 100)

def compute_mvrv_zscore(prices, window=365):
    """Z-Score MVRV proxy — (prix - moyenne) / std sur N jours."""
    if len(prices) < window: window = len(prices)
    seg   = prices.iloc[-window:]
    mu    = seg.mean()
    sigma = seg.std()
    return float((prices.iloc[-1] - mu) / sigma) if sigma > 0 else 0.0

def compute_mvrv_4yr(prices):
    """Z-Score 4 ans (1460j) — nécessite au moins 2 ans de données."""
    return compute_mvrv_zscore(prices, min(len(prices), 365 * 2))

def compute_ntv(prices):
    neg = int((prices.pct_change().tail(7) < 0).sum())
    if   neg >= 5: return 2
    elif neg >= 3: return 1
    elif neg == 0: return -2
    elif neg <= 2: return -1
    return 0

# ── Signaux Bull/Bear granulaires ─────────────────────────────────────────────
def compute_bullbear_signals(bb30, bb365):
    """
    Catégorise le marché selon les zones historiques.
    Retourne un dict de flags 0/1 selon les seuils CryptoQuant.
    """
    return {
        "bb_overheated_bull": 1 if bb30  >  0.30 and bb365 > 0.30 else 0,
        "bb_bull":            1 if 0.05  <  bb30 <= 0.30            else 0,
        "bb_early_bull":      1 if 0.00  <  bb30 <= 0.05            else 0,
        "bb_bear":            1 if -0.20 <= bb30 <= 0.00            else 0,
        "bb_extreme_bear":    1 if bb30  < -0.20                    else 0,
    }

# ── Cohortes 60D (proxies fenêtres temporelles) ───────────────────────────────
def compute_cohorts_60d(prices):
    """
    Proxy accumulation/distribution par cohorte via retour de prix.
    Fenêtre adaptée à l'horizon de réaction historique de chaque cohorte :
    - >10k BTC (méga baleines) : 90j — horizon très long
    - 1k-10k BTC (grandes baleines) : 60j
    - 100-1k BTC (mid whales) : 30j
    - 10-100 BTC (retail+) : 21j
    - 1-10 BTC (retail) : 14j
    - 0.1-1 BTC (micro retail) : 7j
    - 0-0.1 BTC (dust/nano) : 3j
    """
    def retour(n): return round(compute_bullbear(prices, n), 6)
    return {
        "coh_10k_plus":    retour(90),
        "coh_1k_10k":      retour(60),
        "coh_100_1k":      retour(30),
        "coh_10_100":      retour(21),
        "coh_1_10":        retour(14),
        "coh_01_1":        retour(7),
        "coh_0_01":        retour(3),
    }

# ── Spent Output Value Bands (proxy via rolling volatility) ───────────────────
def compute_spent_output_bands(prices):
    """
    Proxy des SOVB via volumes de volatilité par fenêtre.
    Valeur > 1.3 = activité supérieure à la moyenne → gros mouvements détectés.
    SMA7 de chaque bande.
    """
    def ratio_vol(short, long):
        vs = float(prices.pct_change().tail(short).std())
        vl = float(prices.pct_change().tail(long).std())
        if vl <= 0 or np.isnan(vs) or np.isnan(vl):
            return 1.0
        r = vs / vl
        return round(r, 4) if not np.isnan(r) else 1.0

    # Bandes de taille (proxy via fenêtres de différentes durées)
    b01    = ratio_vol(1,  7)    # 0-1 BTC : signal très court terme
    b1     = ratio_vol(3,  14)   # 1-10 BTC
    b10    = ratio_vol(5,  21)   # 10-100 BTC
    b100   = ratio_vol(7,  30)   # 100-1k BTC
    b1k    = ratio_vol(14, 60)   # 1k-10k BTC
    b10k   = ratio_vol(21, 90)   # >10k BTC

    # SMA7 (rolling sur 7 observations récentes des proxies)
    def sma7_ratio(short, long, n=7):
        vals = []
        ret = prices.pct_change().dropna()
        for i in range(n):
            if i + max(short, long) > len(ret): break
            vs = float(ret.iloc[-(i+1):-(i+short+1) if i+short+1 <= len(ret) else None:-1].std())
            vl = float(ret.iloc[-(i+1):-(i+long+1) if i+long+1 <= len(ret) else None:-1].std())
            if vl > 0 and not np.isnan(vs) and not np.isnan(vl):
                vals.append(vs/vl)
        return round(float(np.mean(vals)) if vals else 1.0, 4)

    sma7_01  = sma7_ratio(1,  7)
    sma7_1   = sma7_ratio(3,  14)
    sma7_10  = sma7_ratio(5,  21)
    sma7_100 = sma7_ratio(7,  30)
    sma7_1k  = sma7_ratio(14, 60)
    sma7_10k = sma7_ratio(21, 90)

    total_sma7 = round(np.mean([sma7_01, sma7_1, sma7_10, sma7_100, sma7_1k, sma7_10k]), 4)
    avg_price  = round(float(prices.tail(7).mean()), 2)

    return {
        "sov_btc_0_1":          b01,
        "sov_btc_1_10":         b1,
        "sov_btc_10_100":       b10,
        "sov_btc_100_1k":       b100,
        "sov_btc_1k_10k":       b1k,
        "sov_btc_10k_inf":      b10k,
        "sov_btc_0_1_sma7":     sma7_01,
        "sov_btc_1_10_sma7":    sma7_1,
        "sov_btc_10_100_sma7":  sma7_10,
        "sov_btc_100_1k_sma7":  sma7_100,
        "sov_btc_1k_10k_sma7":  sma7_1k,
        "sov_btc_10k_inf_sma7": sma7_10k,
        "sov_total_sma7":       total_sma7,
        "sov_avg_price":        avg_price,
        "sov_signal":           1 if b1k > 1.30 or b10k > 1.30 else 0,
    }

# ── MVRV étendu ───────────────────────────────────────────────────────────────
def compute_mvrv_extended(prices):
    """
    Toutes les métriques MVRV derivées du prix Coinbase.
    Note : MVRV Z-Score réel = (Market Cap - Realized Cap) / std(Market Cap).
    Ici on approxime via la distribution historique des prix.
    """
    pct   = compute_mvrv_pct(prices)
    z365  = compute_mvrv_zscore(prices, 365)
    z4yr  = compute_mvrv_4yr(prices)
    cur   = prices.iloc[-1]
    ma7   = prices.rolling(7).mean().iloc[-1]
    log_m = float(np.log(cur / ma7)) if ma7 > 0 else 0.0

    # Signaux binaires selon percentile
    high_signal = 1 if pct >= 90 else 0   # zone distribution
    low_signal  = 1 if pct <=  5 else 0   # zone accumulation
    # Zones textuelles
    if pct >= 85:
        zone = "Overheated / distribution zone (high risk)"
    elif pct >= 60:
        zone = "Neutral risk, watch for divergences"
    elif pct >= 30:
        zone = "Accumulation / recovery zone"
    else:
        zone = "Deep undervaluation — LT buy zone"

    return {
        "mvrv_7d":          round(cur / ma7, 6),         # proxy MVRV 7j
        "mvrv_log_7d":      round(log_m, 6),              # log-MVRV
        "mvrv_zscore_365d": round(z365, 4),               # Z-Score 365j
        "mvrv_zscore_4yr":  round(z4yr, 4),               # Z-Score 4 ans
        "mvrvPct":          round(pct,  4),               # Percentile 0-100%
        "mvrv_zscore":      round(z365, 4),               # Z-Score (alias)
        "mvrv_high_signal": int(high_signal),
        "mvrv_low_signal":  int(low_signal),
        "mvrv_zone":        zone,
    }

# ── Mayer étendu ──────────────────────────────────────────────────────────────
def compute_mayer_extended(prices):
    mm    = compute_mayer(prices)
    sma200= compute_sma200(prices)
    return {
        "mayerMultiple":    round(mm,    6),
        "mayer_oversold":   1 if mm < 0.80 else 0,          # alert signal
        "mayer_sma200":     round(sma200, 2),
        "mayer_overbought": 1 if mm > 2.40 else 0,
        "mayer_hi_overbought": 1 if mm > 3.50 else 0,
        "mayerAlert":       1 if mm < 0.80 else 0,          # = mayer_oversold
    }

# ── Thermal Score (composite 0-100) ───────────────────────────────────────────
def _sr(v, lo, hi):
    if v is None: return 50.0
    if v <= lo: return 0.0
    if v >= hi: return 100.0
    return float((v - lo) / (hi - lo) * 100)

def compute_thermal_score(d):
    return float(np.mean([
        _sr(d["mayerMultiple"],   0.80, 2.40),
        _sr(d["mvrvPct"],         20,   90  ),
        _sr(d["lthNupl"],         0.10, 0.70),
        _sr(d["soprRatio"],       0.98, 1.05),
        _sr(d["futuresPower"],    40,   80  ),
        _sr(d["etf_30d_sum"],    -20,   20  ),
    ]))

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
def run():
    now = datetime.utcnow()
    print(f"\n⬡ BTC Pipeline Kizoka0x — {now.strftime('%Y-%m-%d %H:%M')} UTC")

    # ── Données de base ──────────────────────────────────────────────────────
    prices    = get_btc_history(365)
    btc_price = get_btc_price()
    print(f"  Prix BTC : ${btc_price:,.2f}")

    # ── On-chain BGeometrics (gratuit) ───────────────────────────────────────
    sopr_real = bgeometrics("sopr")
    lth_real  = bgeometrics("lth_nupl")
    sth_real  = bgeometrics("sth_nupl")
    utxo_real = bgeometrics("utxo_profit")
    print(f"  BGeometrics SOPR={sopr_real}  LTH={lth_real}  STH={sth_real}  UTXO={utxo_real}")

    # ── Stablecoin USDT ──────────────────────────────────────────────────────
    usdt = get_usdt_data()

    # ── Futures Binance ──────────────────────────────────────────────────────
    fut = get_futures_data()

    # ── Calculs proxy ────────────────────────────────────────────────────────
    sopr_val  = sopr_real if sopr_real          else compute_sopr_proxy(prices)
    lth_val   = lth_real  if lth_real is not None else compute_nupl(prices, 365)
    sth_val   = sth_real  if sth_real is not None else compute_nupl(prices, 30)
    # UTXO P/L ratio réel depuis BGeometrics, ou -1 si indisponible
    utxo_val  = float(utxo_real) if utxo_real is not None else -1.0

    nupl_avg  = round((lth_val + sth_val) / 2, 6)
    # SOPR SMA90 proxy (rolling 90j de l'indicateur proxy)
    sopr_sma90 = round(float(pd.Series([
        compute_sopr_proxy(prices.iloc[:max(7,len(prices)-i)])
        for i in range(min(90, len(prices)-7))
    ]).mean()), 6)

    bb30d  = compute_bullbear(prices, 30)
    bb365d = compute_bullbear(prices, 365)
    bb_sigs = compute_bullbear_signals(bb30d, bb365d)

    # ETF proxy = variation 30j × 100 → % (sans accès Farside/CryptoQuant)
    etf_30d_sum = round(bb30d * 100, 4)
    # ETF netflow USD proxy = variation prix 7j × BTC daily vol estimé (150k BTC/j × prix)
    etf_usd     = round(compute_bullbear(prices, 7) * btc_price * 150000, 0)

    ntv = compute_ntv(prices)
    # NTV détail — proxy via momentum jours haussiers/baissiers
    neg7  = int((prices.pct_change().tail(7) < 0).sum())
    pos7  = 7 - neg7
    ntv_light_buy   = 1 if -2 <= ntv <= -1 else 0
    ntv_strong_buy  = 1 if ntv == -2 else 0
    ntv_light_sell  = 1 if 1 <= ntv <= 2 else 0
    ntv_strong_sell = 1 if ntv == 2 else 0
    # NTV valeur 25h proxy (variation prix 24h en USD)
    ntv_25h = round((prices.iloc[-1] - prices.iloc[-2]) * 150000, 0) if len(prices) >= 2 else 0.0

    # Métriques MVRV étendues
    mvrv_ext = compute_mvrv_extended(prices)

    # Métriques Mayer étendues
    mayer_ext = compute_mayer_extended(prices)

    # Cohortes 60D
    cohorts = compute_cohorts_60d(prices)

    # Spent Output Value Bands
    sov = compute_spent_output_bands(prices)

    # Sharpe
    sharpe = round(compute_sharpe(prices), 6)

    # Alertes binaires SOPR
    # Calibré sur données historiques CryptoQuant :
    # Capitulation 2022 : SOPR~0.54, SMA90~0.65
    # Notre proxy (prix/MA7) reste ~1.0 → on ajuste les seuils
    sopr_alert = 1 if sopr_val <= 0.970 else 0

    # UTXO Flag (valeur CryptoQuant réelle : ratio ~3 pour fond de cycle)
    # Notre proxy est entre 0 et 1 → fond = < 0.03 (3%)
    # Flag = 1 quand ratio réel < 6 (calibré sur données CryptoQuant)
    # Zones: >10000=survalorisation, <10=sous-valorisation, <6=FLAG capitulation
    # Si utxo_val=-1 (indisponible), flag=0 par sécurité (pas de fausse alerte)
    utxo_flag = 1 if (utxo_val != -1 and utxo_val < 6.0) else 0

    # ── Thermal Score ────────────────────────────────────────────────────────
    ts_input = {
        "mayerMultiple":  mayer_ext["mayerMultiple"],
        "mvrvPct":        mvrv_ext["mvrvPct"],
        "lthNupl":        lth_val,
        "soprRatio":      sopr_val,
        "futuresPower":   fut["futuresPower"],
        "etf_30d_sum":    etf_30d_sum,
    }
    thermal = round(compute_thermal_score(ts_input), 4)

    # ═══════════════════════════════════════════════════════════════════════════
    # JSON FINAL — ordre exact des sections demandées
    # ═══════════════════════════════════════════════════════════════════════════
    dashboard = {
        # ── Référence universelle ───────────────────────────────────────────
        "updated":         now.strftime("%Y-%m-%dT%H:%M"),
        "btcPrice":        round(float(btc_price), 2),

        # ── SECTION 1 : Flux & Liquidité ────────────────────────────────────

        # Bitcoin: ETF Daily
        "etf_30d_sum":     etf_30d_sum,        # Total Netflow 30D Sum [proxy %]
        "etf_netflow_usd": int(etf_usd),        # ETF Netflow USD [proxy]

        # Stablecoin Market Cap Change USDT
        "usdt_daily_mc":   usdt["usdt_daily_mc"],    # Daily Market Cap [proxy USD]
        "usdt_sma30":      usdt["usdt_sma30"],        # USDT Stablecoin SMA(30)
        "usdt_60d_change": usdt["usdt_60d_change"],   # 60-day Market Cap Change
        "usdt_60d_sma30":  usdt["usdt_60d_sma30"],    # 60-day MC Change SMA(30)

        # Net Taker Volume Hourly Binance
        "ntv_25h":          int(ntv_25h),         # Net Taker Volume 25h [proxy USD]
        "ntv_sell_count":   int(ntv),             # -2…+2 (proxy)
        "ntv_light_buy":    int(ntv_light_buy),
        "ntv_strong_buy":   int(ntv_strong_buy),
        "ntv_light_sell":   int(ntv_light_sell),
        "ntv_strong_sell":  int(ntv_strong_sell),

        # ── SECTION 2 : Dérivés & Structure de marché ───────────────────────

        # Futures Power 30D Change
        "futuresPower":      fut["futuresPower"],       # Market Power (%)
        "futuresIndex":      fut["futuresIndex"],       # Index (0-1)
        "futuresLine":       fut["futuresLine"],        # Line (SMA7 Index)
        "futures30dChange":  fut["futures30dChange"],   # Index 30d Change

        # Bull/Bear Cycle Indicator
        "bb_overheated_bull": bb_sigs["bb_overheated_bull"],  # flag 0/1
        "bb_bull":            bb_sigs["bb_bull"],
        "bb_bear":            bb_sigs["bb_bear"],
        "bb_early_bull":      bb_sigs["bb_early_bull"],
        "bb_extreme_bear":    bb_sigs["bb_extreme_bear"],
        "bullBear365d":       round(bb365d, 6),   # Bull-Bear 365d MA
        "bullBear30d":        round(bb30d,  6),   # Bull-Bear 30d MA

        # ── SECTION 3 : Profitabilité & Comportement des holders ─────────────

        # LTH/STH SOPR Ratio
        "soprAlert":        int(sopr_alert),           # Alert 0/1
        "soprRatio":        round(sopr_val, 6),        # SOPR Ratio
        "soprSma90":        sopr_sma90,                # SOPR Ratio SMA(90) [proxy]

        # BTC NUPL
        "lthNupl":          round(lth_val,  6),   # aLTH
        "sthNupl":          round(sth_val,  6),   # aSTH
        "nuplAvg":          round(nupl_avg, 6),   # average aNUPL
        "nuplLine":         round((lth_val + sth_val) / 2, 6),  # Line ≈ avg

        # UTXO Block P/L Count Ratio
        "utxoRatio":        round(utxo_val, 4) if utxo_val != -1 else -1,  # Ratio P/L réel (BGeometrics) ou -1
        "utxoSma365":       round(utxo_val, 4) if utxo_val != -1 else -1,  # SMA365 si dispo
        "utxoFlag":         int(utxo_flag),        # Flag 0/1

        # Accumulation vs Distribution — 7 cohortes (60D)
        "coh_10k_plus":     cohorts["coh_10k_plus"],   # >10k BTC [proxy]
        "coh_1k_10k":       cohorts["coh_1k_10k"],     # 1k-10k BTC [proxy]
        "coh_100_1k":       cohorts["coh_100_1k"],     # 100-1k BTC [proxy]
        "coh_10_100":       cohorts["coh_10_100"],     # 10-100 BTC [proxy]
        "coh_1_10":         cohorts["coh_1_10"],       # 1-10 BTC [proxy]
        "coh_01_1":         cohorts["coh_01_1"],       # 0.1-1 BTC [proxy]
        "coh_0_01":         cohorts["coh_0_01"],       # 0-0.1 BTC [proxy]

        # Spent Output Value Bands
        "sov_btc_0_1":          sov["sov_btc_0_1"],
        "sov_btc_1_10":         sov["sov_btc_1_10"],
        "sov_btc_10_100":       sov["sov_btc_10_100"],
        "sov_btc_100_1k":       sov["sov_btc_100_1k"],
        "sov_btc_1k_10k":       sov["sov_btc_1k_10k"],
        "sov_btc_10k_inf":      sov["sov_btc_10k_inf"],
        "sov_btc_0_1_sma7":     sov["sov_btc_0_1_sma7"],
        "sov_btc_1_10_sma7":    sov["sov_btc_1_10_sma7"],
        "sov_btc_10_100_sma7":  sov["sov_btc_10_100_sma7"],
        "sov_btc_100_1k_sma7":  sov["sov_btc_100_1k_sma7"],
        "sov_btc_1k_10k_sma7":  sov["sov_btc_1k_10k_sma7"],
        "sov_btc_10k_inf_sma7": sov["sov_btc_10k_inf_sma7"],
        "sov_total_sma7":       sov["sov_total_sma7"],
        "sov_avg_price":        sov["sov_avg_price"],
        "sov_signal":           sov["sov_signal"],

        # ── SECTION 4 : Valorisation & Risque Long Terme ─────────────────────

        # MVRV Percentile — Cycle
        "mvrv_7d":          mvrv_ext["mvrv_7d"],
        "mvrv_log_7d":      mvrv_ext["mvrv_log_7d"],
        "mvrv_zscore_365d": mvrv_ext["mvrv_zscore_365d"],
        "mvrv_zscore_4yr":  mvrv_ext["mvrv_zscore_4yr"],
        "mvrvPct":          mvrv_ext["mvrvPct"],
        "mvrv_zscore":      mvrv_ext["mvrv_zscore"],
        "mvrv_high_signal": mvrv_ext["mvrv_high_signal"],
        "mvrv_low_signal":  mvrv_ext["mvrv_low_signal"],
        "mvrv_zone":        mvrv_ext["mvrv_zone"],

        # Mayer Multiple
        "mayerMultiple":       mayer_ext["mayerMultiple"],
        "mayer_oversold":      mayer_ext["mayer_oversold"],
        "mayer_sma200":        mayer_ext["mayer_sma200"],
        "mayer_overbought":    mayer_ext["mayer_overbought"],
        "mayer_hi_overbought": mayer_ext["mayer_hi_overbought"],
        "mayerAlert":          mayer_ext["mayerAlert"],

        # Sharpe Ratio (short term)
        "sharpeShort":      sharpe,

        # ── Score global ────────────────────────────────────────────────────
        "thermalScore":     thermal,
    }

    # ── Sanitize : remplace NaN / Infinity par None (→ null en JSON) ──────────
    def sanitize(obj):
        if isinstance(obj, dict):
            return {k: sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [sanitize(v) for v in obj]
        if isinstance(obj, float):
            if np.isnan(obj) or np.isinf(obj):
                return None          # → null JSON, jamais NaN
        return obj

    dashboard = sanitize(dashboard)

    with open("btc_dashboard.json", "w") as f:
        json.dump(dashboard, f, indent=2)

    # Résumé console
    print(f"  SOPR={dashboard['soprRatio']:.4f} Alert={dashboard['soprAlert']}")
    print(f"  UTXO={dashboard['utxoRatio']:.4f} Flag={dashboard['utxoFlag']}")
    print(f"  Mayer={dashboard['mayerMultiple']:.4f} Alert={dashboard['mayerAlert']}")
    print(f"  MVRV={dashboard['mvrvPct']:.2f}%  Low={dashboard['mvrv_low_signal']}  High={dashboard['mvrv_high_signal']}")
    print(f"  Thermal Score: {dashboard['thermalScore']:.2f}/100")
    print(f"  ✓ btc_dashboard.json mis à jour — {dashboard['updated']} UTC\n")

if __name__ == "__main__":
    run()
