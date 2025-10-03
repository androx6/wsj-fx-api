// WSJ FX API – one-shot batch fetch on Vercel
// GET  /api/fx?date=YYYY-MM-DD&coverage=full|majors|extended
//      /api/fx?date=YYYY-MM-DD&symbols=EURUSD,GBPUSD,...
// POST /api/fx  { "date":"YYYY-MM-DD", "coverage":"full|majors|extended", "symbols":["EURUSD","GBPUSD", ...] }
//
// IMPORTANT:
// 1) In Vercel → Project → Settings → Environment Variables, create:
//    Key = WSJ_COOKIE, Value = <your full WSJ cookie string>, Scope = Production (and Preview if desired)
// 2) This function only uses direct XXXUSD pairs (no reciprocals).

const DEFAULT_SEED = [
  "EURUSD","GBPUSD","AUDUSD","NZDUSD","JPYUSD","CADUSD","CHFUSD","SEKUSD","NOKUSD","DKKUSD",
  "MXNUSD","BRLUSD","CNYUSD","KRWUSD","INRUSD","ZARUSD","TRYUSD","PLNUSD","HUFUSD","CZKUSD",
  "ILSUSD","AEDUSD","SARUSD","CLPUSD","COPUSD","PENUSD","ARSUSD","THBUSD","PHPUSD","MYRUSD",
  "IDRUSD","TWDUSD","SGDUSD","HKDUSD","RONUSD","BGNUSD","QARUSD","MADUSD","AOAUSD","VNDUSD",
  "GHSUSD","NGNUSD"
];

const COVERAGE = {
  majors: ["EURUSD","GBPUSD","JPYUSD","AUDUSD","NZDUSD","CADUSD","CHFUSD","CNYUSD","SEKUSD","NOKUSD"],
  extended: DEFAULT_SEED.slice(0, 30),
  full: DEFAULT_SEED
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

module.exports = async (req, res) => {
  try {
    // ---- Parse input ----
    let date, symbols, coverage;
    if (req.method === "GET") {
      date = req.query.date;
      coverage = (req.query.coverage || "full").toLowerCase();
      symbols = parseSymbolList(req.query.symbols);
      if (!symbols || symbols.length === 0) symbols = COVERAGE[coverage] || COVERAGE.full;
    } else if (req.method === "POST") {
      date = req.body?.date;
      coverage = (req.body?.coverage || "full").toLowerCase();
      symbols = Array.isArray(req.body?.symbols) ? clean(req.body.symbols) : null;
      if (!symbols || symbols.length === 0) symbols = COVERAGE[coverage] || COVERAGE.full;
    } else {
      return res.status(405).json({ error: "Use GET or POST" });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    // ---- Resolve trading day (NY): if Sat/Sun → prior Friday) ----
    const resolvedISO = priorBizIfWeekend(date);
    const mdy = toMMDDYYYY(resolvedISO);

    // ---- Concurrency control ----
    const CONCURRENCY = 6;
    const queue = (symbols || []).map(s => String(s).toUpperCase().trim());
    const results = [];
    const running = new Set();

    async function runOne(sym) {
      const out = await fetchWSJ(sym, mdy, resolvedISO);
      results.push(out);
    }

    while (queue.length || running.size) {
      while (queue.length && running.size < CONCURRENCY) {
        const sym = queue.shift();
        const p = runOne(sym).finally(() => running.delete(p));
        running.add(p);
      }
      if (running.size) await Promise.race(running);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      resolvedDate: resolvedISO,
      total: symbols.length,
      ok: results.filter(r => r.status === "ok").length,
      fail: results.filter(r => r.status !== "ok").length,
      items: results.sort((a, b) => a.symbol.localeCompare(b.symbol))
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};

// ----------------- helpers -----------------

function parseSymbolList(s) {
  if (!s) return null;
  return s.split(",").map(v => String(v).trim()).filter(Boolean);
}
function clean(arr) { return arr.map(v => String(v).trim()).filter(Boolean); }

function priorBizIfWeekend(iso) {
  const d = new Date(iso + "T00:00:00-04:00"); // NY offset safe enough for daily roll
  const wd = d.getDay(); // 0 Sun .. 6 Sat
  if (wd === 6) d.setDate(d.getDate() - 1); // Sat -> Fri
  if (wd === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
  return d.toISOString().slice(0, 10);
}
function toMMDDYYYY(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear());
  return `${mm}/${dd}/${yy}`;
}

async function fetchWSJ(symbolRaw, mdy, iso) {
  const symbol = String(symbolRaw || "").toUpperCase().trim();

  // STRICT: accept only 6-letter XXXUSD, no reciprocals computed here
  if (!/^[A-Z]{6}$/.test(symbol)) {
    return { symbol, status: "error", error: "invalid symbol" };
  }
  if (!symbol.endsWith("USD")) {
    return { symbol, status: "error", error: "not XXXUSD (reciprocals disabled)" };
  }

  const url =
    `https://www.wsj.com/market-data/quotes/FX/${symbol}/historical-prices/download` +
    `?startDate=${encodeURIComponent(mdy)}&endDate=${encodeURIComponent(mdy)}&num_rows=50`;

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,                 // browser-like UA
        "Accept": "text/csv, */*;q=0.1",
        "Referer": `https://www.wsj.com/market-data/quotes/FX/${symbol}/historical-prices`,
        "Cookie": process.env.WSJ_COOKIE || ""   // <-- your WSJ cookie from Vercel env
      }
    });

    if (!resp.ok) {
      return { symbol, status: "error", error: `HTTP ${resp.status}`, source_url: url };
    }

    const csv = await resp.text();
    const parsed = parseWSJCSV(csv, iso);
    if (!parsed) {
      return { symbol, status: "error", error: "row not found", source_url: url };
    }

    return {
      symbol,
      status: "ok",
      close: parsed.close,   // keep WSJ precision as string
      date: parsed.date,     // YYYY-MM-DD (normalized)
      source_url: url
    };
  } catch (e) {
    return { symbol, status: "error", error: String(e?.message || e), source_url: url };
  }
}

function parseWSJCSV(csv, isoWanted) {
  if (!csv || !csv.includes("\n")) return null;
  const lines = csv.trim().split(/\r?\n/);
  // Typical header: Date,Open,High,Low,Close[,Volume]
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const iDate = header.indexOf("date");
  const iClose = header.indexOf("close");
  if (iDate < 0 || iClose < 0) return null;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(s => s.trim());
    if (cols.length < Math.max(iDate, iClose) + 1) continue;

    const raw = cols[iDate]; // mm/dd/yy or mm/dd/yyyy
    const parts = raw.split("/");
    if (parts.length !== 3) continue;
    let [mm, dd, yy] = parts;
    if (yy.length === 2) yy = (yy > "50" ? "19" : "20") + yy; // 2-digit year guard
    const iso = `${yy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;

    if (iso === isoWanted) {
      const close = cols[iClose];
      if (close == null || close === "" || isNaN(Number(close))) return null;
      return { date: iso, close };
    }
  }
  return null;
}
