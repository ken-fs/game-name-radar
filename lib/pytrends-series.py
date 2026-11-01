#!/usr/bin/env python3
"""免费 pytrends 拉 Google Trends 日度序列（fresh-recheck.mjs 调用）。

stdin : {"terms": [...], "geo": "US", "timeframe": "today 3-m"}
stdout: {term: {"dates": [YYYY-MM-DD...], "values": [int...]}} 或 {term: {"error": "..."}}
单词单查（不和别的词同批归一化）：同一条序列内部算倍数才成立。
注意：不要给 TrendReq 传 retries/backoff_factor —— 新版 urllib3 会报 method_whitelist。
"""
import json
import random
import sys
import time

from pytrends.request import TrendReq


def main():
    req = json.load(sys.stdin)
    terms = req.get("terms", [])
    geo = req.get("geo", "US")
    tf = req.get("timeframe", "today 3-m")
    py = TrendReq(hl="en-US", tz=-480, timeout=(10, 30))
    out = {}
    for i, t in enumerate(terms):
        for attempt in range(3):
            try:
                py.build_payload([t], timeframe=tf, geo=geo)
                df = py.interest_over_time()
                if df is None or df.empty or t not in df:
                    out[t] = {"dates": [], "values": []}
                else:
                    out[t] = {
                        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
                        "values": [int(v) for v in df[t].tolist()],
                    }
                break
            except Exception as e:  # 429 / 网络：退避后重试，最终失败记 error（次日重试）
                out[t] = {"error": str(e)[:200]}
                time.sleep(15 * (attempt + 1))
        sys.stderr.write(f"[pytrends] {i + 1}/{len(terms)} {t}\n")
        time.sleep(random.uniform(2.5, 5))
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
