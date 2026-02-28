"""
btc_utxo_diagnostic.py — Kizoka0x
═══════════════════════════════════════════════════════════════════════
Diagnostic BGeometrics : trouve les bons endpoints pour UTXO P/L.
Lance UNE SEULE FOIS via GitHub Actions (workflow_dispatch).
Résultat complet dans les logs GitHub Actions.
═══════════════════════════════════════════════════════════════════════
"""
import requests
import time
import json

HEADERS = {"accept": "application/json", "User-Agent": "btc-thermal-kizoka0x"}
BASE    = "https://api.bgeometrics.com/v1"
TIMEOUT = 15

# ── Tous les endpoints à tester ─────────────────────────────────────────────
ENDPOINTS = [
    # ── Noms exacts issus de la SQL CryptoQuant ──────────────────────────────
    "utxo_block_profit_count",       # AVG(m.utxo_block_profit_count)
    "utxo_block_loss_count",         # AVG(m.utxo_block_loss_count)
    # ── Variantes naming convention BGeometrics ───────────────────────────────
    "utxo_profit_count",
    "utxo_loss_count",
    "utxo_profit",
    "utxo_loss",
    "utxo_profit_ratio",
    "utxo_pl_ratio",
    "utxo_count_ratio",
    "utxo_profit_loss_ratio",
    "utxo_profit_loss",
    "utxo_in_profit",
    "utxo_in_loss",
    "supply_in_profit",
    "supply_profit_count",
    "supply_loss_count",
    "percent_supply_in_profit",
    "utxo_realized_price",
    "realized_price",
    "nupl",
    "mvrv",
    # ── Endpoints connus fonctionnels (baseline pour vérifier que l'API répond)
    "sopr",
    "lth_nupl",
    "sth_nupl",
]

# ────────────────────────────────────────────────────────────────────────────

def probe(endpoint):
    """
    Teste un endpoint BGeometrics.
    Retourne un dict avec: status, valeur_derniere, date_derniere, nb_points, erreur
    """
    url = f"{BASE}/{endpoint}?asset=btc"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        status = r.status_code

        if status == 200:
            data = r.json()
            if "data" in data and data["data"]:
                pts   = data["data"]
                last  = pts[-1]
                val   = last.get("value", "?")
                date_ = last.get("date", last.get("timestamp", "?"))
                return {
                    "status":   200,
                    "ok":       True,
                    "val":      val,
                    "date":     date_,
                    "nb_pts":   len(pts),
                    "err":      None,
                    "raw_keys": list(last.keys()),
                }
            else:
                return {
                    "status":   200,
                    "ok":       False,
                    "val":      None,
                    "date":     None,
                    "nb_pts":   0,
                    "err":      f"Empty data — top-level keys: {list(data.keys())}",
                    "raw_keys": [],
                }
        else:
            return {
                "status": status,
                "ok":     False,
                "val":    None,
                "date":   None,
                "nb_pts": 0,
                "err":    f"HTTP {status}",
                "raw_keys": [],
            }

    except Exception as e:
        return {
            "status":   None,
            "ok":       False,
            "val":      None,
            "date":     None,
            "nb_pts":   0,
            "err":      str(e)[:120],
            "raw_keys": [],
        }


def run():
    print()
    print("═" * 70)
    print("  BGeometrics UTXO Diagnostic — Kizoka0x")
    print("═" * 70)
    print(f"  Base URL : {BASE}")
    print(f"  Endpoints testés : {len(ENDPOINTS)}")
    print("═" * 70)
    print()

    ok_endpoints   = []
    fail_endpoints = []

    for ep in ENDPOINTS:
        time.sleep(0.4)   # éviter rate limit
        res = probe(ep)

        if res["ok"]:
            ok_endpoints.append((ep, res))
            status_str = f"✓ HTTP 200"
            val_str    = f"val={res['val']}"
            date_str   = f"date={res['date']}"
            pts_str    = f"({res['nb_pts']} points)"
            keys_str   = f"keys={res['raw_keys']}"
            print(f"  {status_str:12} | {ep:<35} | {val_str:<25} | {date_str:<20} | {pts_str} | {keys_str}")
        else:
            fail_endpoints.append((ep, res))
            err_str = res["err"] or f"HTTP {res['status']}"
            print(f"  ✗ FAIL      | {ep:<35} | {err_str}")

    # ── Résumé ──────────────────────────────────────────────────────────────
    print()
    print("═" * 70)
    print(f"  RÉSUMÉ : {len(ok_endpoints)} OK / {len(fail_endpoints)} FAIL")
    print("═" * 70)

    if ok_endpoints:
        print()
        print("  ENDPOINTS DISPONIBLES :")
        for ep, res in ok_endpoints:
            print(f"    → \"{ep}\"  val={res['val']}  date={res['date']}")

        # ── Tentative de calcul du ratio si profit ET loss disponibles ────────
        print()
        print("  RECHERCHE DU RATIO profit_count / loss_count :")
        profit_ep = None
        loss_ep   = None

        for ep, res in ok_endpoints:
            name = ep.lower()
            if any(x in name for x in ["profit"]) and "loss" not in name:
                profit_ep = (ep, res["val"])
            if any(x in name for x in ["loss"]) and "profit" not in name:
                loss_ep = (ep, res["val"])

        if profit_ep and loss_ep:
            try:
                ratio = float(profit_ep[1]) / float(loss_ep[1])
                print(f"    profit endpoint : \"{profit_ep[0]}\"  val={profit_ep[1]}")
                print(f"    loss   endpoint : \"{loss_ep[0]}\"   val={loss_ep[1]}")
                print(f"    RATIO CALCULÉ   : {ratio:.4f}")
                print()
                if ratio < 6:
                    print(f"    ⚡ FLAG = 1  (ratio < 6 — capitulation)")
                elif ratio < 10:
                    print(f"    🟡 Sous-valorisation (ratio < 10)")
                elif ratio > 10000:
                    print(f"    🔴 Survalorisation (ratio > 10 000)")
                else:
                    print(f"    ✓  Zone normale (6 ≤ ratio ≤ 10 000)")
            except Exception as e:
                print(f"    ✗ Impossible de calculer le ratio : {e}")
        else:
            print(f"    ✗ Endpoints profit et/ou loss non trouvés parmi les résultats OK")
            print(f"       → Vérifier manuellement les endpoints disponibles ci-dessus")
    else:
        print()
        print("  ✗ AUCUN ENDPOINT DISPONIBLE")
        print("    → BGeometrics API inaccessible ou tous les endpoints sont invalides")
        print("    → Fallback: utiliser Option 2 (mvrvPct comme proxy)")

    print()
    print("═" * 70)
    print("  Fin du diagnostic")
    print("═" * 70)
    print()


if __name__ == "__main__":
    run()
