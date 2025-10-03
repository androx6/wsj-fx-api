// WSJ FX API – Vercel Serverless Function
// GET  /api/fx?date=YYYY-MM-DD&symbols=EURUSD,GBPUSD,CADUSD
// POST /api/fx  { "date":"YYYY-MM-DD", "symbols":["EURUSD","GBPUSD", ...] }
// Returns: { resolvedDate, items: [{symbol, status, close?, source_url, error?}] }

module.exports = async (req, res) => {
  try {
    // --- Parse input (GET or POST) ---
    let date, symbols;
    if (req.method === "GET") {
      date = req.query.date;
      const s = req.query.symbols || "";
      symbols = s.split(",").map(v => String(v).trim()).filter(Boolean);
    } else if (req.method === "POST") {
      date = req.body?.date;
      symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    } else {
      return res.status(405).json({ error: "Use GET or POST" });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    if (!symbols || symbols.length === 0) {
      return res.status(400).json({ error: "symbols[] required" });
    }

    // --- Helpers ---
    const toNYDate = (iso) => {
      // Keep as ISO; we’ll only do weekend adjust here
      return iso;
    };
    const priorBizIfWeekend = (iso) => {
      const d = new Date(iso + "T00:00:00-04:00"); // NY offset is fine for daily
      const wd = d.getDay(); // 0 Sun .. 6 Sat
      if (wd === 6) d.setDate(d.getDate() - 1);
      if (wd === 0) d.setDate(d.getDate() - 2);
      return d.toISOString().slice(0,10);
    };
    const mmddyyyy = (iso) => {
      const d = new Date(iso + "T00:00:00Z");
      const mm = String(d.getUTCMonth() + 1).padStart(2,"0");
      const dd = String(d.getUTCDate()).padStart(2,"0");
      const yyyy = d.getUTCFullYear();
      return `${mm}/${dd}/${yyyy}`;
    };
    const mmddyy = (iso) => {
      const d = new Date(iso + "T00:00:00Z");
      const mm = String(d.getUTCMonth() + 1).padStart(2,"0");
      const dd = String(d.getUTCDate()).padStart(2,"0");
      const yy = String(d.getUTCFullYear()).slice(-2);
      return `${mm}/${dd}/${yy}`;
    };

    const iso = priorBizIfWeekend(toNYDate(date));
    const d_mdy = mmddyyyy(iso);
    const d_mdy_short = mmddyy(iso);

    // --- Fetch one symbol from WSJ CSV ---
    async function fetchWSJ(symbolRaw) {
      const symbol = String(symbolRaw).toUpperCase().trim();
      if (!/^[A-Z]{6}$/.test(symbol)) {
        return { symbol, status: "error", error: "invalid symbol" };
      }
      // Strict: XXXUSD only (no reciprocals)
      if (!symbol.endsWith("USD")) {
        return { symbol, status: "error", error: "not XXXUSD (reciprocals disabled)" };
      }

      const url = `https://www.wsj.com/market-data/quotes/FX/${symbol}/historical-prices/download?startDate=${encodeURIComponent(d_mdy)}&endDate=${encodeURIComponent(d_mdy)}&num_rows=50`;

      try {
        const r = await fetch(url, {
          headers: {
            "Accept": "text/csv",
            "User-Agent": "Mozilla/5.0",
            "Referer": `https://www.wsj.com/market-data/quotes/FX/${symbol}/historical-prices`
          }
        });
        if (!r.ok) {
          return { symbol, status: "error", error: `HTTP ${r.status}`, source_url: url };
        }

        const text = (await r.text()).trim();
        const lines = text.split(/\r?\n/).filter(Boolean);
        // Find row for mm/dd/yy or mm/dd/yyyy
        const row = lines.find(line => line.startsWith(d_mdy_short + ",") || line.startsWith(d_mdy + ","));
        if (!row) {
          return { symbol, status: "error", error: "date row missing", source_url: url };
        }
        const cols = row.split(",");
        // Close column is index 4 in "Date,Open,High,Low,Close,Volume"
        const close = cols[4];
        if (!close || isNaN(parseFloat(close))) {
          return { symbol, status: "error", error: "close parse failed", source_url: url };
        }
        return { symbol, status: "ok", close, source_url: url };
      } catch (e) {
        return { symbol, status: "error", error: String(e), source_url: url };
      }
    }

    // --- Run all in parallel (Vercel handles concurrency nicely) ---
    const items = await Promise.all(
      symbols.map(s => fetchWSJ(s))
    );

    res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ resolvedDate: iso, items });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
