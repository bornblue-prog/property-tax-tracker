import { useState, useEffect, useRef } from "react";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ipwfunhbgtfzwawdrtsa.supabase.co";
const SUPABASE_KEY = "sb_publishable_Y2MATnkLk0ufURomwf08qg_T3lOkpu6";
const USER_ID = "angie-tax-2025";

// ── SA105 CATEGORIES ──────────────────────────────────────────────────────────
const SA105 = [
  { id: "rent",       label: "Rent received",                    box: "Income",   type: "income"  },
  { id: "mgmt",       label: "Management fees",                  box: "5.1",      type: "expense" },
  { id: "repairs",    label: "Repairs, maintenance & renewals",  box: "5.3",      type: "expense" },
  { id: "insurance",  label: "Insurance",                        box: "5.4",      type: "expense" },
  { id: "legal",      label: "Legal & professional fees",        box: "5.5",      type: "expense" },
  { id: "services",   label: "Services (incl. rates)",           box: "5.6",      type: "expense" },
  { id: "other",      label: "Other allowable expenses",         box: "5.7",      type: "expense" },
];

const EXPENSE_CATS = SA105.filter(s => s.type === "expense");

// ── PROPERTIES ────────────────────────────────────────────────────────────────
const PROPERTIES = [
  { id: "southside", label: "57/5 Viewcraig Gardens, Edinburgh", agent: "SouthSide Property Management", type: "cumulative" },
  { id: "plc",       label: "32/4 Rannoch Road, Edinburgh",      agent: "Property Letting Centre",       type: "monthly"     },
  { id: "manual",    label: "Manual entry",                      agent: "",                               type: "manual"      },
];

// ── QUARTERS ──────────────────────────────────────────────────────────────────
const QUARTERS = [
  { id: "q1", label: "Q1 Apr–Jun",  months: [3,4,5]   },
  { id: "q2", label: "Q2 Jul–Sep",  months: [6,7,8]   },
  { id: "q3", label: "Q3 Oct–Dec",  months: [9,10,11] },
  { id: "q4", label: "Q4 Jan–Mar",  months: [0,1,2]   },
];

function getQuarter(dateStr, taxYear) {
  const d = new Date(dateStr);
  const m = d.getMonth();
  for (const q of QUARTERS) {
    if (q.months.includes(m)) {
      // Q4 (Jan-Mar) belongs to next calendar year within the same tax year
      if (q.id === "q4" && d.getFullYear() === taxYear + 1) return q.id;
      if (q.id !== "q4" && d.getFullYear() === taxYear) return q.id;
    }
  }
  return null;
}

// ── TAX YEAR HELPERS ──────────────────────────────────────────────────────────
function getTaxYear(date) {
  const d = date || new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}
function taxYearLabel(y) { return `${y}–${String(y+1).slice(2)}`; }
function inTaxYear(dateStr, year) {
  const d = new Date(dateStr);
  return d >= new Date(year,3,6) && d <= new Date(year+1,3,5,23,59,59);
}
function today() { return new Date().toISOString().slice(0,10); }
const fmt = n => `£${Number(n||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

// ── SUPABASE ──────────────────────────────────────────────────────────────────
const db = {
  async get(table) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?user_id=eq.${USER_ID}&order=date.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return r.json();
  },
  async insert(table, rows) {
    const body = Array.isArray(rows) ? rows.map(r=>({...r,user_id:USER_ID})) : {...rows,user_id:USER_ID};
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type":"application/json", Prefer:"return=representation" },
      body: JSON.stringify(body)
    });
    return r.json();
  },
  async delete(table, id) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&user_id=eq.${USER_ID}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  },
  async uploadFile(file) {
    const ext = file.name.split(".").pop();
    const path = `${USER_ID}/${Date.now()}.${ext}`;
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/tax-documents/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": file.type },
      body: file
    });
    if (r.ok) return `${SUPABASE_URL}/storage/v1/object/public/tax-documents/${path}`;
    return null;
  }
};

// ── CLAUDE PDF PARSER ─────────────────────────────────────────────────────────
async function parsePDFWithClaude(base64Data, mediaType, existingDates) {
  const existingInfo = existingDates.length > 0
    ? `\nAlready imported these month/year combinations for this property: ${existingDates.join(", ")}. Do NOT include these rows again.`
    : "";

  const prompt = `You are a UK property tax assistant parsing a landlord statement PDF for SA105 Self Assessment.

Extract financial transactions. Return ONLY a JSON array, no markdown, no backticks.

Rules:
- For CUMULATIVE statements (SouthSide/multiple rows): extract ONLY rows not already imported.${existingInfo}
- For single-month statements (Property Letting Centre): extract that month's data.
- Each transaction must have: date (YYYY-MM-DD, use the process/payment date or statement date), amount (positive number), category (one of: rent, mgmt, repairs, insurance, legal, services, other), type (income or expense), description, property.
- Management fee VAT should be included in the mgmt amount (use gross amount).
- Repairs & Maintenance → repairs category.
- Commission + VAT → mgmt category.
- Insurance → insurance category.
- Legal & Prof Fees → legal category.
- Services → services category.
- Money Sent / Net Rent / Rent received → rent category (income).
- Only include rows where amount > 0.

Return format:
[{"date":"YYYY-MM-DD","amount":123.45,"category":"rent","type":"income","description":"Rent received Apr 2026","property":"32/4 Rannoch Road"},...]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text||"").join("") || "";
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

// ── CLAUDE INVOICE PDF PARSER ─────────────────────────────────────────────────
async function parseInvoicePDF(base64Data) {
  const prompt = `You are a UK property tax assistant reading a supplier invoice PDF for SA105 Self Assessment.
The landlord is NOT VAT registered, so always use the GROSS amount (including any VAT) as the expense figure.

Extract the invoice details. Return ONLY a JSON object, no markdown, no backticks:
{
  "date": "YYYY-MM-DD (use invoice date or service date)",
  "supplier": "supplier/company name",
  "invoice_number": "invoice or reference number if shown",
  "description": "what the invoice is for — be specific",
  "net_amount": number or null,
  "vat_amount": number or null,
  "gross_amount": number (total amount to pay including VAT — THIS is the SA105 expense figure),
  "category": one of: "repairs" | "insurance" | "mgmt" | "legal" | "services" | "other",
  "property_hint": "any address or property reference mentioned on the invoice",
  "confidence": "high" | "medium" | "low",
  "notes": "anything unclear, missing or that needs checking"
}

Category guide:
- repairs: plumber, electrician, builder, decorator, cleaner, handyman, materials, maintenance contractor
- insurance: any insurance premium or renewal
- mgmt: letting agent fees, management fees, commission
- legal: solicitor, accountant, surveyor, professional fees
- services: utilities, gas, electricity, water, council rates, gardening, waste
- other: anything else allowable but not fitting above`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text||"").join("") || "";
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

// ── CLAUDE IMAGE RECEIPT PARSER ───────────────────────────────────────────────
async function parseReceiptImage(base64Data, mediaType) {
  const prompt = `You are a UK property tax assistant reading a receipt or invoice image for SA105 Self Assessment.

Extract the expense details. Respond ONLY with a JSON object, no markdown, no backticks:
{
  "date": "YYYY-MM-DD or null if unclear",
  "amount": number (total amount paid, GBP),
  "supplier": "name of supplier/shop/company",
  "description": "what was purchased or what the expense is for",
  "category": one of: "repairs" | "insurance" | "mgmt" | "legal" | "services" | "other",
  "confidence": "high" | "medium" | "low",
  "notes": "anything unusual or unclear about this receipt"
}

Category guide:
- repairs: repairs, maintenance, plumbing, electrical, cleaning, decorating, materials
- insurance: any insurance premium
- mgmt: management fees, agent fees, commission
- legal: legal fees, accountancy, professional fees
- services: utilities, rates, gardening, waste collection
- other: anything else allowable but not fitting above`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text||"").join("") || "";
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

// ── ICONS ─────────────────────────────────────────────────────────────────────
const I = {
  dash:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  tx:      ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  pdf:     ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  docs:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  sa105:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>,
  plus:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  trash:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  upload:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  cloud:   ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>,
  spin:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" className="spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
  report:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>,
  invoice: ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  camera:  ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  home:    ()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
};

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [transactions, setTransactions] = useState([]);
  const [documents,    setDocuments]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [syncing,      setSyncing]      = useState(false);
  const [tab,          setTab]          = useState("dashboard");
  const [taxYear,      setTaxYear]      = useState(getTaxYear(new Date()));
  const [error,        setError]        = useState(null);

  // Load report libraries from CDN
  useEffect(()=>{
    const load = (src) => new Promise((res)=>{
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = res; document.head.appendChild(s);
    });
    load("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    load("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
  },[]);

  useEffect(()=>{
    (async()=>{
      setLoading(true);
      try {
        const [txs, docs] = await Promise.all([db.get("transactions"), db.get("documents")]);
        setTransactions(Array.isArray(txs) ? txs : []);
        setDocuments(Array.isArray(docs) ? docs : []);
      } catch { setError("Could not connect to database."); }
      setLoading(false);
    })();
  },[]);

  const addTransactions = async (rows) => {
    setSyncing(true);
    try {
      const saved = await db.insert("transactions", rows);
      if (Array.isArray(saved)) setTransactions(t => [...saved, ...t]);
      else if (saved) setTransactions(t => [saved, ...t]);
    } catch { setError("Failed to save transactions."); }
    setSyncing(false);
  };

  const deleteTx = async (id) => {
    setTransactions(t => t.filter(x => x.id !== id));
    await db.delete("transactions", id);
  };

  const addDocument = async (file) => {
    setSyncing(true);
    try {
      const fileUrl = await db.uploadFile(file);
      const isImage = file.type.startsWith("image/");
      const [saved] = await db.insert("documents", {
        name: file.name,
        doc_type: isImage ? "receipt" : "statement",
        file_url: fileUrl || "",
        file_size: file.size,
        date: today(),
      });
      if (saved) setDocuments(d => [saved, ...d]);
    } catch { setError("Failed to upload document."); }
    setSyncing(false);
  };

  const deleteDoc = async (id) => {
    setDocuments(d => d.filter(x => x.id !== id));
    await db.delete("documents", id);
  };

  const yearTx   = transactions.filter(t => inTaxYear(t.date, taxYear));
  const income   = yearTx.filter(t => t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const expenses = yearTx.filter(t => t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  const profit   = income - expenses;

  const currentYear = getTaxYear(new Date());
  const allYears = [...new Set([
    currentYear, currentYear-1, currentYear-2,
    ...transactions.map(t=>getTaxYear(new Date(t.date)))
  ])].sort((a,b)=>b-a);

  if (loading) return (
    <div style={{...S.root, justifyContent:"center", alignItems:"center", flexDirection:"column", gap:12}}>
      <I.spin/><div style={{color:C.muted, fontSize:"0.875rem"}}>Loading your records…</div>
    </div>
  );

  const navItems = [
    { id:"dashboard", label:"Dashboard",        Icon:I.dash    },
    { id:"import",    label:"Import Statement",  Icon:I.pdf     },
    { id:"invoice",   label:"Import Invoice",    Icon:I.invoice },
    { id:"receipts",  label:"Upload Receipt",    Icon:I.camera  },
    { id:"manual",    label:"Manual Entry",      Icon:I.tx      },
    { id:"sa105",     label:"SA105 Summary",     Icon:I.sa105   },
    { id:"documents", label:"Documents",         Icon:I.docs    },
    { id:"reports",   label:"Year End Reports",   Icon:I.report  },
  ];

  return (
    <div style={S.root}>
      <style>{css}</style>
      <aside style={S.sidebar}>
        <div style={S.logo}>
          <div style={S.logoMark}><I.home/></div>
          <div>
            <div style={S.logoTitle}>Property Tax</div>
            <div style={S.logoSub}>SA105 Tracker</div>
          </div>
        </div>

        <div style={S.cloudBadge}><I.cloud/>{syncing ? "Saving…" : "Cloud sync active"}</div>

        <div style={S.yearBlock}>
          <div style={S.yearLabel}>Tax Year</div>
          <select style={S.yearSelect} value={taxYear} onChange={e=>setTaxYear(Number(e.target.value))}>
            {allYears.map(y=><option key={y} value={y}>{taxYearLabel(y)}</option>)}
          </select>
        </div>

        <nav style={S.nav}>
          {navItems.map(({id,label,Icon})=>(
            <button key={id} onClick={()=>setTab(id)} style={{...S.navBtn,...(tab===id?S.navOn:{})}}>
              <Icon/>{label}
            </button>
          ))}
        </nav>

        <div style={S.sideFoot}>
          <div style={S.footRow}><span style={S.footLabel}>Net Profit</span>
            <span style={{...S.footVal, color: profit>=0?"#4ade80":"#f87171"}}>{fmt(profit)}</span>
          </div>
          <div style={S.footRow}><span style={S.footLabel}>Income</span>
            <span style={{color:"#4ade80", fontSize:"0.8rem", fontWeight:600}}>{fmt(income)}</span>
          </div>
          <div style={S.footRow}><span style={S.footLabel}>Expenses</span>
            <span style={{color:"#f87171", fontSize:"0.8rem", fontWeight:600}}>{fmt(expenses)}</span>
          </div>
        </div>
      </aside>

      <main style={S.main}>
        {error && <div style={S.errBanner}>⚠ {error}<button style={S.errX} onClick={()=>setError(null)}>✕</button></div>}
        {tab==="dashboard" && <Dashboard yearTx={yearTx} taxYear={taxYear} income={income} expenses={expenses} profit={profit}/>}
        {tab==="import"    && <ImportTab transactions={transactions} taxYear={taxYear} onAdd={addTransactions} onAddDoc={addDocument}/>}
        {tab==="invoice"   && <InvoiceTab onAdd={addTransactions} onAddDoc={addDocument}/>}
        {tab==="receipts"  && <ReceiptsTab onAdd={addTransactions} onAddDoc={addDocument}/>}
        {tab==="manual"    && <ManualTab onAdd={addTransactions} onAddDoc={addDocument}/>}
        {tab==="sa105"     && <SA105Tab yearTx={yearTx} taxYear={taxYear}/>}
        {tab==="documents" && <DocumentsTab documents={documents} onDelete={deleteDoc}/>}
        {tab==="reports"   && <ReportsTab allTransactions={transactions} taxYear={taxYear} allYears={allYears}/>}
      </main>
    </div>
  );
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function Dashboard({ yearTx, taxYear, income, expenses, profit }) {
  const [selQ, setSelQ] = useState("all");

  const filtered = selQ==="all" ? yearTx : yearTx.filter(t => getQuarter(t.date, taxYear)===selQ);
  const qIncome   = filtered.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const qExpenses = filtered.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  const qProfit   = qIncome - qExpenses;

  // Per-property income
  const propIncome = PROPERTIES.filter(p=>p.id!=="manual").map(p=>({
    ...p,
    total: filtered.filter(t=>t.type==="income" && t.property===p.id).reduce((s,t)=>s+Number(t.amount),0)
  }));

  // Per-category expenses
  const catExp = EXPENSE_CATS.map(c=>({
    ...c,
    total: filtered.filter(t=>t.type==="expense" && t.category===c.id).reduce((s,t)=>s+Number(t.amount),0)
  })).filter(c=>c.total>0).sort((a,b)=>b.total-a.total);

  const recent = [...filtered].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10);

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.pageTitle}>Dashboard</h1>
        <div style={S.pageSub}>Tax Year {taxYearLabel(taxYear)} · 6 Apr {taxYear} – 5 Apr {taxYear+1}</div>
      </div>

      {/* Quarter filter */}
      <div style={S.qRow}>
        {[{id:"all",label:"Full Year"},...QUARTERS].map(q=>(
          <button key={q.id} onClick={()=>setSelQ(q.id)}
            style={{...S.qBtn,...(selQ===q.id?S.qBtnOn:{})}}>
            {q.label}
          </button>
        ))}
      </div>

      <div style={S.statsGrid}>
        <StatCard label="Total Income"   value={fmt(qIncome)}   accent="#4ade80" sub="Gross rent received"/>
        <StatCard label="Total Expenses" value={fmt(qExpenses)} accent="#f87171" sub="Allowable deductions"/>
        <StatCard label="Net Profit"     value={fmt(qProfit)}   accent={qProfit>=0?"#fbbf24":"#f87171"} sub="Before personal allowances" large/>
        <StatCard label="Tax Estimate*"  value={fmt(Math.max(0,(qProfit-12570)*0.2))} accent="#a78bfa" sub="Basic rate illustration only"/>
      </div>

      <div style={S.threeCol}>
        {/* Property income */}
        <div style={S.card}>
          <div style={S.cardTitle}>Income by Property</div>
          {propIncome.every(p=>p.total===0) && <div style={S.empty}>No income yet</div>}
          {propIncome.map(p=>(
            <div key={p.id} style={S.propRow}>
              <div style={S.propAddr}>{p.label}</div>
              <div style={{color:"#4ade80", fontWeight:700, fontSize:"0.9rem"}}>{fmt(p.total)}</div>
            </div>
          ))}
        </div>

        {/* Expense categories */}
        <div style={S.card}>
          <div style={S.cardTitle}>Expenses by SA105 Category</div>
          {catExp.length===0 && <div style={S.empty}>No expenses yet</div>}
          {catExp.map(c=>(
            <div key={c.id} style={S.catRow}>
              <div>
                <div style={{fontSize:"0.78rem"}}>{c.label}</div>
                <div style={{fontSize:"0.65rem", color:C.muted}}>Box {c.box}</div>
              </div>
              <div style={{color:"#f87171", fontWeight:700, fontSize:"0.85rem", flexShrink:0}}>{fmt(c.total)}</div>
            </div>
          ))}
        </div>

        {/* Recent transactions */}
        <div style={S.card}>
          <div style={S.cardTitle}>Recent Transactions</div>
          {recent.length===0 && <div style={S.empty}>No transactions yet</div>}
          {recent.map(t=>(
            <div key={t.id} style={S.txRow}>
              <div style={{...S.txDot, background: t.type==="income"?"#4ade80":"#f87171"}}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:"0.8rem", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.description}</div>
                <div style={{fontSize:"0.68rem", color:C.muted}}>{t.date}</div>
              </div>
              <div style={{color:t.type==="income"?"#4ade80":"#f87171", fontWeight:700, fontSize:"0.8rem", flexShrink:0}}>
                {t.type==="income"?"+":"-"}{fmt(t.amount)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={S.disc}>* Basic rate tax illustration only. Does not include personal allowance, NI, mortgage interest relief or other factors. Always consult a tax adviser.</div>
    </div>
  );
}

function StatCard({label,value,accent,sub,large}) {
  return (
    <div style={{...S.statCard, borderTop:`3px solid ${accent}`}}>
      <div style={S.statLabel}>{label}</div>
      <div style={{...S.statVal, color:accent, fontSize:large?"1.9rem":"1.5rem"}}>{value}</div>
      <div style={S.statSub}>{sub}</div>
    </div>
  );
}

// ── IMPORT STATEMENT TAB ──────────────────────────────────────────────────────
function ImportTab({ transactions, taxYear, onAdd, onAddDoc }) {
  const fileRef               = useRef(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error,   setError]   = useState(null);
  const [saved,   setSaved]   = useState(false);
  const [file,    setFile]    = useState(null);
  const [editRows, setEditRows] = useState([]);

  const handleFile = async (f) => {
    if (!f || f.type !== "application/pdf") { setError("Please upload a PDF file."); return; }
    setFile(f); setLoading(true); setError(null); setResults(null); setSaved(false);

    try {
      // Convert to base64
      const base64 = await new Promise((res,rej)=>{
        const r = new FileReader();
        r.onload = ()=>res(r.result.split(",")[1]);
        r.onerror = ()=>rej(new Error("Read failed"));
        r.readAsDataURL(f);
      });

      // Get existing dates within this tax year only — avoids false duplicates across years
      const yearTxOnly = transactions.filter(t => inTaxYear(t.date, taxYear));
      const existingDates = yearTxOnly.map(t=>{
        const d = new Date(t.date);
        return `${d.toLocaleString("en-GB",{month:"short"})} ${d.getFullYear()}`;
      });

      const rows = await parsePDFWithClaude(base64, "application/pdf", existingDates);
      setResults(rows);
      setEditRows(rows.map((r,i)=>({...r, _id:i})));
    } catch(e) {
      setError("Could not read this PDF. Try again or use Manual Entry.");
    }
    setLoading(false);
  };

  const updateRow = (i, field, val) => {
    setEditRows(rows => rows.map((r,idx) => idx===i ? {...r,[field]:field==="amount"?parseFloat(val)||0:val} : r));
  };
  const removeRow = (i) => setEditRows(rows => rows.filter((_,idx)=>idx!==i));

  const save = async () => {
    if (!editRows.length) return;
    // Map property address string to property id
    const mapped = editRows.map(r => ({
      type: r.type,
      amount: Number(r.amount),
      date: r.date,
      description: r.description,
      category: r.category,
      property: guessPropertyId(r.property || r.description || ""),
      source: r.property || "Statement import",
    }));
    await onAdd(mapped);
    // Also save the PDF as a document
    if (file) await onAddDoc(file);
    setSaved(true);
    setResults(null);
    setEditRows([]);
    setFile(null);
  };

  function guessPropertyId(str) {
    const s = str.toLowerCase();
    if (s.includes("viewcraig") || s.includes("southside") || s.includes("0518")) return "southside";
    if (s.includes("rannoch") || s.includes("letting centre") || s.includes("plc")) return "plc";
    return "manual";
  }

  return (
    <div style={S.page}>
      <div style={S.pageHead}><h1 style={S.pageTitle}>Import Statement</h1></div>

      <div style={S.card}>
        <div style={S.cardTitle}>Upload PDF Statement</div>
        <p style={S.hint}>Upload your monthly landlord statement PDF. Claude will read it and extract all income and expense figures automatically. For cumulative statements it will only import new months not already in your records.</p>

        <div style={S.dropZone}
          onDragOver={e=>e.preventDefault()}
          onDrop={e=>{e.preventDefault(); handleFile(e.dataTransfer.files[0]);}}
          onClick={()=>fileRef.current?.click()}>
          <I.upload/>
          <div style={{fontSize:"0.95rem", fontWeight:700, color:C.text, marginTop:"0.5rem"}}>
            {loading ? "Reading PDF…" : "Drop PDF here or click to browse"}
          </div>
          <div style={{fontSize:"0.75rem", color:C.muted}}>Monthly statements &amp; invoices</div>
          {file && <div style={{fontSize:"0.75rem", color:"#60a5fa", marginTop:"0.25rem"}}>{file.name}</div>}
        </div>
        <input ref={fileRef} type="file" accept=".pdf" style={{display:"none"}}
          onChange={e=>handleFile(e.target.files[0])}/>

        {loading && <div style={S.loadBox}><I.spin/> Claude is reading your PDF and extracting figures…</div>}
        {error   && <div style={S.errBox}>{error}</div>}
        {saved   && <div style={S.okBox}>✓ {editRows.length} transactions saved to your records</div>}
      </div>

      {editRows.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Extracted Transactions — Review &amp; Edit</div>
          <p style={S.hint}>Check each row. Edit amounts or categories if needed, remove any incorrect rows, then click Save All.</p>

          <div style={{overflowX:"auto"}}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  {["Date","Description","Type","Category (SA105)","Amount (£)",""].map(h=>(
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {editRows.map((r,i)=>(
                  <tr key={r._id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={S.td}>
                      <input style={{...S.input, width:120}} type="date" value={r.date}
                        onChange={e=>updateRow(i,"date",e.target.value)}/>
                    </td>
                    <td style={S.td}>
                      <input style={{...S.input, width:200}} type="text" value={r.description}
                        onChange={e=>updateRow(i,"description",e.target.value)}/>
                    </td>
                    <td style={S.td}>
                      <select style={{...S.input, width:100}} value={r.type} onChange={e=>updateRow(i,"type",e.target.value)}>
                        <option value="income">Income</option>
                        <option value="expense">Expense</option>
                      </select>
                    </td>
                    <td style={S.td}>
                      <select style={{...S.input, width:220}} value={r.category} onChange={e=>updateRow(i,"category",e.target.value)}>
                        {SA105.map(c=><option key={c.id} value={c.id}>{c.label} {c.type==="expense"?`(Box ${c.box})`:""}</option>)}
                      </select>
                    </td>
                    <td style={S.td}>
                      <input style={{...S.input, width:100, textAlign:"right"}} type="number" step="0.01" value={r.amount}
                        onChange={e=>updateRow(i,"amount",e.target.value)}/>
                    </td>
                    <td style={S.td}>
                      <button style={S.delBtn} onClick={()=>removeRow(i)}><I.trash/></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{...S.formActions, marginTop:"1.25rem"}}>
            <div style={{fontSize:"0.8rem", color:C.muted, marginRight:"auto"}}>
              {editRows.filter(r=>r.type==="income").length} income · {editRows.filter(r=>r.type==="expense").length} expenses
              · Total income: {fmt(editRows.filter(r=>r.type==="income").reduce((s,r)=>s+Number(r.amount),0))}
              · Total expenses: {fmt(editRows.filter(r=>r.type==="expense").reduce((s,r)=>s+Number(r.amount),0))}
            </div>
            <button style={S.btnSec} onClick={()=>setEditRows([])}>Discard</button>
            <button style={S.btnPri} onClick={save}>Save All to Records</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MANUAL ENTRY ──────────────────────────────────────────────────────────────
function ManualTab({ onAdd, onAddDoc }) {
  const blank = { date:today(), type:"expense", category:"repairs", property:"southside", description:"", amount:"", source:"" };
  const [form,    setForm]    = useState(blank);
  const [saving,  setSaving]  = useState(false);
  const [done,    setDone]    = useState(false);
  const [file,    setFile]    = useState(null);
  const [preview, setPreview] = useState(null);
  const fileRef               = useRef(null);
  const set = k => e => setForm(f=>({...f,[k]:e.target.value}));

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    if (f.type.startsWith("image/")) setPreview(URL.createObjectURL(f));
    else setPreview(null);
  };

  const submit = async () => {
    if (!form.amount || !form.description) return;
    setSaving(true);
    await onAdd([{ ...form, amount: parseFloat(form.amount) }]);
    if (file) await onAddDoc(file);
    setForm(blank); setFile(null); setPreview(null);
    setDone(true); setSaving(false);
    setTimeout(()=>setDone(false), 3000);
  };

  return (
    <div style={S.page}>
      <div style={S.pageHead}><h1 style={S.pageTitle}>Manual Entry</h1></div>
      <div style={S.card}>
        <div style={S.cardTitle}>Add Transaction</div>
        <div style={S.formGrid}>
          <Fld label="Date"><input style={S.input} type="date" value={form.date} onChange={set("date")}/></Fld>
          <Fld label="Type">
            <select style={S.input} value={form.type} onChange={set("type")}>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </Fld>
          <Fld label="SA105 Category">
            <select style={S.input} value={form.category} onChange={set("category")}>
              {SA105.map(c=><option key={c.id} value={c.id}>{c.label}{c.type==="expense"?` (Box ${c.box})`:""}</option>)}
            </select>
          </Fld>
          <Fld label="Property">
            <select style={S.input} value={form.property} onChange={set("property")}>
              {PROPERTIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Fld>
          <Fld label="Amount (£)"><input style={S.input} type="number" step="0.01" placeholder="0.00" value={form.amount} onChange={set("amount")}/></Fld>
          <Fld label="Source / Supplier"><input style={S.input} type="text" placeholder="Company name" value={form.source} onChange={set("source")}/></Fld>
          <Fld label="Description" wide><input style={S.input} type="text" placeholder="What is this for?" value={form.description} onChange={set("description")}/></Fld>
        </div>

        {/* File attachment */}
        <div style={{marginTop:"1rem"}}>
          <div style={{fontSize:"0.75rem", color:"#7a90a8", marginBottom:"0.4rem"}}>
            Supporting Document <span style={{color:C.muted}}>(receipt, invoice or PDF — recommended for HMRC records)</span>
          </div>
          <div style={S.attachRow}>
            <div style={S.attachBox} onClick={()=>fileRef.current?.click()}>
              {preview
                ? <img src={preview} alt="preview" style={{width:"100%", height:"100%", objectFit:"cover", borderRadius:6}}/>
                : file
                  ? <div style={{textAlign:"center"}}>
                      <I.pdf/>
                      <div style={{fontSize:"0.7rem", color:"#60a5fa", marginTop:"0.3rem"}}>{file.name}</div>
                    </div>
                  : <div style={{textAlign:"center", color:C.muted}}>
                      <I.upload/>
                      <div style={{fontSize:"0.72rem", marginTop:"0.3rem"}}>Tap to attach</div>
                      <div style={{fontSize:"0.65rem", marginTop:"0.15rem"}}>PDF, JPG, PNG</div>
                    </div>
              }
            </div>
            {file && (
              <div style={{flex:1}}>
                <div style={{fontSize:"0.78rem", fontWeight:600, color:C.text, marginBottom:"0.25rem"}}>{file.name}</div>
                <div style={{fontSize:"0.7rem", color:C.muted, marginBottom:"0.5rem"}}>{(file.size/1024).toFixed(0)} KB</div>
                <button style={{...S.btnSec, fontSize:"0.75rem", padding:"0.3rem 0.65rem"}}
                  onClick={()=>{setFile(null); setPreview(null);}}>
                  Remove
                </button>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*,.pdf"
            style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        </div>

        <div style={S.formActions}>
          {done && <span style={{color:"#4ade80", fontSize:"0.85rem", marginRight:"auto"}}>✓ Saved{file?" with attachment":""}</span>}
          {!done && !file && (
            <span style={{color:C.muted, fontSize:"0.72rem", marginRight:"auto"}}>⚠ No attachment — add one for HMRC compliance</span>
          )}
          <button style={S.btnPri} onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save Transaction"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SA105 SUMMARY ─────────────────────────────────────────────────────────────
function SA105Tab({ yearTx, taxYear }) {
  const [selQ, setSelQ] = useState("all");
  const filtered = selQ==="all" ? yearTx : yearTx.filter(t=>getQuarter(t.date,taxYear)===selQ);

  const totalIncome   = filtered.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const totalExpenses = filtered.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  const netProfit     = totalIncome - totalExpenses;

  // Per property
  const propRows = PROPERTIES.filter(p=>p.id!=="manual").map(p=>({
    ...p,
    income:   filtered.filter(t=>t.type==="income"   && t.property===p.id).reduce((s,t)=>s+Number(t.amount),0),
    expenses: filtered.filter(t=>t.type==="expense"  && t.property===p.id).reduce((s,t)=>s+Number(t.amount),0),
  }));

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.pageTitle}>SA105 Summary</h1>
        <div style={S.pageSub}>UK Property Income — figures ready to enter on your Self Assessment return</div>
      </div>

      <div style={S.qRow}>
        {[{id:"all",label:"Full Year"},...QUARTERS].map(q=>(
          <button key={q.id} onClick={()=>setSelQ(q.id)}
            style={{...S.qBtn,...(selQ===q.id?S.qBtnOn:{})}}>
            {q.label}
          </button>
        ))}
      </div>

      {/* Per property breakdown */}
      {propRows.map(p=>(
        <div key={p.id} style={{...S.card, marginBottom:"1rem"}}>
          <div style={S.cardTitle}><I.home/> &nbsp;{p.label}</div>
          <div style={S.sa105Grid}>
            <SA105Row label="Total rent received" box="Income" value={p.income} isIncome/>
            {EXPENSE_CATS.map(c=>{
              const val = filtered.filter(t=>t.type==="expense" && t.property===p.id && t.category===c.id).reduce((s,t)=>s+Number(t.amount),0);
              return <SA105Row key={c.id} label={c.label} box={`Box ${c.box}`} value={val}/>;
            })}
            <SA105Row label="Net profit / (loss)" box="" value={p.income-p.expenses} isTotal isIncome={p.income-p.expenses>=0}/>
          </div>
        </div>
      ))}

      {/* Combined totals */}
      <div style={{...S.card, borderColor:"#3b82f6"}}>
        <div style={S.cardTitle}>Combined SA105 Totals</div>
        <div style={S.sa105Grid}>
          <SA105Row label="Total UK property income" box="Box 20" value={totalIncome} isIncome/>
          {EXPENSE_CATS.map(c=>{
            const val = filtered.filter(t=>t.type==="expense" && t.category===c.id).reduce((s,t)=>s+Number(t.amount),0);
            return <SA105Row key={c.id} label={c.label} box={`Box ${c.box}`} value={val}/>;
          })}
          <SA105Row label="Total allowable expenses" box="Box 24" value={totalExpenses}/>
          <SA105Row label="Net profit / (loss)" box="Box 25/26" value={netProfit} isTotal isIncome={netProfit>=0}/>
        </div>
      </div>

      <div style={S.disc}>These figures are for reference only. Always review with a qualified tax adviser before submitting your Self Assessment return.</div>
    </div>
  );
}

function SA105Row({label, box, value, isIncome, isTotal}) {
  if (value===0 && !isTotal) return null;
  return (
    <div style={{...S.sa105Row, ...(isTotal?{borderTop:`1px solid ${C.border}`, paddingTop:"0.6rem", marginTop:"0.25rem"}:{})}}>
      <div style={{flex:1}}>
        <div style={{fontSize:"0.82rem", fontWeight: isTotal?700:400}}>{label}</div>
        {box && <div style={{fontSize:"0.65rem", color:"#60a5fa"}}>{box}</div>}
      </div>
      <div style={{fontWeight:isTotal?800:600, fontSize: isTotal?"1rem":"0.875rem",
        color: value===0 ? C.muted : isIncome ? "#4ade80" : "#f87171"}}>
        {fmt(value)}
      </div>
    </div>
  );
}

// ── INVOICE IMPORT TAB ────────────────────────────────────────────────────────
function InvoiceTab({ onAdd, onAddDoc }) {
  const fileRef                   = useRef(null);
  const [loading,  setLoading]    = useState(false);
  const [result,   setResult]     = useState(null);
  const [editRow,  setEditRow]    = useState(null);
  const [error,    setError]      = useState(null);
  const [saved,    setSaved]      = useState(false);
  const [file,     setFile]       = useState(null);

  const handleFile = async (f) => {
    if (!f || f.type !== "application/pdf") { setError("Please upload a PDF invoice."); return; }
    setFile(f); setLoading(true); setError(null); setResult(null); setSaved(false); setEditRow(null);

    try {
      const base64 = await new Promise((res,rej)=>{
        const r = new FileReader();
        r.onload = ()=>res(r.result.split(",")[1]);
        r.onerror = ()=>rej(new Error("Read failed"));
        r.readAsDataURL(f);
      });

      const parsed = await parseInvoicePDF(base64);
      setResult(parsed);
      setEditRow({
        date:        parsed.date        || today(),
        amount:      parsed.gross_amount|| "",
        supplier:    parsed.supplier    || "",
        description: parsed.description || "",
        invoice_ref: parsed.invoice_number || "",
        category:    parsed.category    || "repairs",
        property:    guessProperty(parsed.property_hint || ""),
        net:         parsed.net_amount  || null,
        vat:         parsed.vat_amount  || null,
      });
    } catch(e) {
      setError("Could not read this invoice. Try again or use Manual Entry.");
    }
    setLoading(false);
  };

  function guessProperty(hint) {
    const s = (hint||"").toLowerCase();
    if (s.includes("viewcraig") || s.includes("eh8") || s.includes("0518")) return "southside";
    if (s.includes("rannoch")   || s.includes("eh4"))                        return "plc";
    return "manual";
  }

  const set = k => e => setEditRow(r=>({...r,[k]:e.target.value}));

  const save = async () => {
    if (!editRow?.amount || !editRow?.description) return;
    await onAdd([{
      type:        "expense",
      amount:      parseFloat(editRow.amount),
      date:        editRow.date,
      description: editRow.invoice_ref
                     ? `${editRow.description} (Inv: ${editRow.invoice_ref})`
                     : editRow.description,
      source:      editRow.supplier,
      category:    editRow.category,
      property:    editRow.property,
    }]);
    if (file) await onAddDoc(file);
    setSaved(true);
    setResult(null); setEditRow(null); setFile(null);
  };

  const reset = () => {
    setResult(null); setEditRow(null); setFile(null); setError(null); setSaved(false);
  };

  const confColor = c => c==="high"?"#4ade80":c==="medium"?"#fbbf24":"#f87171";

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.pageTitle}>Import Invoice</h1>
        <div style={S.pageSub}>Upload a supplier or contractor invoice PDF — amounts include VAT as you are not VAT registered</div>
      </div>

      {/* Upload area — only show when no file being reviewed */}
      {!editRow && (
        <div style={S.card}>
          <div style={S.cardTitle}>Upload Invoice PDF</div>
          <p style={S.hint}>
            Upload any supplier invoice — plumber, electrician, letting agent, insurance etc.
            Claude will read the invoice, extract the gross amount and suggest the correct SA105 category.
          </p>
          <div style={S.dropZone}
            onDragOver={e=>e.preventDefault()}
            onDrop={e=>{e.preventDefault(); handleFile(e.dataTransfer.files[0]);}}
            onClick={()=>fileRef.current?.click()}>
            <I.invoice/>
            <div style={{fontSize:"0.95rem", fontWeight:700, color:C.text, marginTop:"0.5rem"}}>
              {loading ? "Reading invoice…" : "Drop invoice PDF here or tap to browse"}
            </div>
            <div style={{fontSize:"0.75rem", color:C.muted}}>PDF invoices only</div>
            {file && <div style={{fontSize:"0.75rem", color:"#60a5fa", marginTop:"0.3rem"}}>{file.name}</div>}
          </div>
          <input ref={fileRef} type="file" accept=".pdf"
            style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          {loading && <div style={S.loadBox}><I.spin/> Claude is reading your invoice…</div>}
          {error   && <div style={S.errBox}>{error}</div>}
          {saved   && <div style={S.okBox}>✓ Invoice saved — transaction recorded and PDF stored in Documents</div>}
        </div>
      )}

      {/* Review & edit extracted data */}
      {editRow && (
        <div style={S.card}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.85rem"}}>
            <div style={S.cardTitle}>Extracted Invoice Details — Check &amp; Edit</div>
            {result?.confidence && (
              <div style={{fontSize:"0.7rem", color:confColor(result.confidence),
                background:`${confColor(result.confidence)}18`, padding:"0.2rem 0.55rem", borderRadius:4}}>
                {result.confidence} confidence
              </div>
            )}
          </div>

          {/* VAT breakdown notice */}
          {(editRow.net || editRow.vat) && (
            <div style={{...S.loadBox, color:"#60a5fa", marginBottom:"0.85rem", fontSize:"0.78rem", background:"rgba(37,99,235,0.06)", padding:"0.6rem 0.75rem", borderRadius:7}}>
              📋 Net: {fmt(editRow.net)} + VAT: {fmt(editRow.vat)} = Gross: {fmt(editRow.amount)} &nbsp;·&nbsp;
              Gross amount used as you are not VAT registered
            </div>
          )}

          {result?.notes && (
            <div style={{...S.loadBox, color:"#fbbf24", marginBottom:"0.75rem", fontSize:"0.78rem",
              background:"rgba(251,191,36,0.06)", padding:"0.6rem 0.75rem", borderRadius:7}}>
              ⚠ {result.notes}
            </div>
          )}

          <div style={S.formGrid}>
            <Fld label="Invoice Date">
              <input style={S.input} type="date" value={editRow.date} onChange={set("date")}/>
            </Fld>
            <Fld label="Gross Amount — SA105 Expense (£)">
              <input style={{...S.input, fontWeight:700,
                ...(!editRow.amount&&{borderColor:"#f87171"})}}
                type="number" step="0.01" placeholder="0.00"
                value={editRow.amount} onChange={set("amount")}/>
            </Fld>
            <Fld label="Supplier Name">
              <input style={S.input} type="text" placeholder="Who sent this invoice?"
                value={editRow.supplier} onChange={set("supplier")}/>
            </Fld>
            <Fld label="Invoice Reference">
              <input style={S.input} type="text" placeholder="Invoice number (optional)"
                value={editRow.invoice_ref} onChange={set("invoice_ref")}/>
            </Fld>
            <Fld label="SA105 Category">
              <select style={S.input} value={editRow.category} onChange={set("category")}>
                {EXPENSE_CATS.map(c=>(
                  <option key={c.id} value={c.id}>{c.label} (Box {c.box})</option>
                ))}
              </select>
            </Fld>
            <Fld label="Property">
              <select style={S.input} value={editRow.property} onChange={set("property")}>
                {PROPERTIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Fld>
            <Fld label="Description of Work / Service" wide>
              <input style={S.input} type="text"
                placeholder="What was this invoice for?"
                value={editRow.description} onChange={set("description")}/>
            </Fld>
          </div>

          <div style={S.formActions}>
            <div style={{fontSize:"0.75rem", color:C.muted, marginRight:"auto"}}>
              {file?.name} · PDF will be stored in Documents
            </div>
            <button style={S.btnSec} onClick={reset}>Discard</button>
            <button style={S.btnPri} onClick={save}
              disabled={!editRow.amount || !editRow.description}>
              Save Invoice &amp; Transaction
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RECEIPT UPLOAD TAB ────────────────────────────────────────────────────────
function ReceiptsTab({ onAdd, onAddDoc }) {
  const fileRef                   = useRef(null);
  const [loading,  setLoading]    = useState(false);
  const [result,   setResult]     = useState(null);
  const [editRow,  setEditRow]    = useState(null);
  const [error,    setError]      = useState(null);
  const [saved,    setSaved]      = useState(false);
  const [preview,  setPreview]    = useState(null);
  const [file,     setFile]       = useState(null);

  const ACCEPTED = ["image/jpeg","image/jpg","image/png","image/webp","image/gif"];

  const handleFile = async (f) => {
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) {
      setError("Please upload an image file (JPG, PNG, WEBP). For PDFs use Import Statement.");
      return;
    }
    setFile(f); setLoading(true); setError(null); setResult(null); setSaved(false);
    setPreview(URL.createObjectURL(f));

    try {
      const base64 = await new Promise((res,rej)=>{
        const r = new FileReader();
        r.onload = ()=>res(r.result.split(",")[1]);
        r.onerror = ()=>rej(new Error("Read failed"));
        r.readAsDataURL(f);
      });

      const parsed = await parseReceiptImage(base64, f.type);
      setResult(parsed);
      setEditRow({
        date:        parsed.date || today(),
        amount:      parsed.amount || "",
        supplier:    parsed.supplier || "",
        description: parsed.description || "",
        category:    parsed.category || "other",
        property:    "manual",
        type:        "expense",
      });
    } catch(e) {
      setError("Could not read this image. The receipt may be unclear or too dark. You can enter the details manually below.");
      // Pre-fill a blank edit row so they can still enter manually
      setEditRow({ date:today(), amount:"", supplier:"", description:"", category:"other", property:"manual", type:"expense" });
    }
    setLoading(false);
  };

  const set = k => e => setEditRow(r=>({...r,[k]:e.target.value}));

  const save = async () => {
    if (!editRow?.amount || !editRow?.description) return;
    await onAdd([{
      type:        editRow.type,
      amount:      parseFloat(editRow.amount),
      date:        editRow.date,
      description: editRow.description,
      source:      editRow.supplier,
      category:    editRow.category,
      property:    editRow.property,
    }]);
    if (file) await onAddDoc(file);
    setSaved(true);
    setResult(null); setEditRow(null); setFile(null); setPreview(null);
  };

  const reset = () => {
    setResult(null); setEditRow(null); setFile(null);
    setPreview(null); setError(null); setSaved(false);
  };

  const confidenceColor = c => c==="high"?"#4ade80":c==="medium"?"#fbbf24":"#f87171";

  return (
    <div style={S.page}>
      <div style={S.pageHead}><h1 style={S.pageTitle}>Upload Receipt</h1></div>

      {!editRow && (
        <div style={S.card}>
          <div style={S.cardTitle}>Upload Receipt Image</div>
          <p style={S.hint}>
            Take a photo of your receipt on your phone or upload an image from your device.
            Claude will read the amount, date and supplier automatically.
          </p>
          <div style={S.dropZone}
            onDragOver={e=>e.preventDefault()}
            onDrop={e=>{e.preventDefault(); handleFile(e.dataTransfer.files[0]);}}
            onClick={()=>fileRef.current?.click()}>
            <I.camera/>
            <div style={{fontSize:"0.95rem", fontWeight:700, color:C.text, marginTop:"0.5rem"}}>
              {loading ? "Reading receipt…" : "Tap to take photo or browse"}
            </div>
            <div style={{fontSize:"0.75rem", color:C.muted}}>JPG, PNG, WEBP</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" capture="environment"
            style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          {loading && <div style={S.loadBox}><I.spin/> Claude is reading your receipt…</div>}
          {error   && (
            <div style={S.errBox}>
              {error}
              <button style={{...S.btnPri, marginTop:"0.75rem"}}
                onClick={()=>setEditRow({ date:today(), amount:"", supplier:"", description:"", category:"other", property:"manual", type:"expense" })}>
                Enter Details Manually
              </button>
            </div>
          )}
          {saved && <div style={S.okBox}>✓ Receipt saved to your records</div>}
        </div>
      )}

      {editRow && (
        <div style={{display:"grid", gridTemplateColumns: preview?"1fr 1fr":"1fr", gap:"1rem"}}>
          {/* Receipt preview */}
          {preview && (
            <div style={S.card}>
              <div style={S.cardTitle}>Receipt Image</div>
              <img src={preview} alt="Receipt" style={{width:"100%", borderRadius:8, objectFit:"contain", maxHeight:500}}/>
            </div>
          )}

          {/* Extracted data form */}
          <div style={S.card}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.85rem"}}>
              <div style={S.cardTitle}>
                {result ? "Extracted Details — Check & Edit" : "Enter Receipt Details"}
              </div>
              {result?.confidence && (
                <div style={{fontSize:"0.7rem", color: confidenceColor(result.confidence), background:`${confidenceColor(result.confidence)}18`, padding:"0.2rem 0.5rem", borderRadius:4}}>
                  {result.confidence} confidence
                </div>
              )}
            </div>

            {result?.notes && (
              <div style={{...S.loadBox, color:"#fbbf24", marginBottom:"0.75rem", fontSize:"0.78rem"}}>
                ⚠ {result.notes}
              </div>
            )}

            <div style={S.formGrid}>
              <Fld label="Date">
                <input style={S.input} type="date" value={editRow.date} onChange={set("date")}/>
              </Fld>
              <Fld label="Amount (£)">
                <input style={{...S.input, ...((!editRow.amount||editRow.amount==="0")&&{borderColor:"#f87171"})}}
                  type="number" step="0.01" placeholder="0.00"
                  value={editRow.amount} onChange={set("amount")}/>
              </Fld>
              <Fld label="Supplier">
                <input style={S.input} type="text" placeholder="Who did you pay?"
                  value={editRow.supplier} onChange={set("supplier")}/>
              </Fld>
              <Fld label="SA105 Category">
                <select style={S.input} value={editRow.category} onChange={set("category")}>
                  {EXPENSE_CATS.map(c=><option key={c.id} value={c.id}>{c.label} (Box {c.box})</option>)}
                </select>
              </Fld>
              <Fld label="Property">
                <select style={S.input} value={editRow.property} onChange={set("property")}>
                  {PROPERTIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Fld>
              <Fld label="Type">
                <select style={S.input} value={editRow.type} onChange={set("type")}>
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                </select>
              </Fld>
              <Fld label="Description" wide>
                <input style={S.input} type="text" placeholder="What was this for?"
                  value={editRow.description} onChange={set("description")}/>
              </Fld>
            </div>

            <div style={S.formActions}>
              <button style={S.btnSec} onClick={reset}>Cancel</button>
              <button style={S.btnPri} onClick={save}
                disabled={!editRow.amount || !editRow.description}>
                Save Receipt & Transaction
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────
function DocumentsTab({ documents, onDelete }) {
  const isImage = d => d.doc_type==="receipt" || /\.(jpg|jpeg|png|webp|gif)$/i.test(d.name||"");

  return (
    <div style={S.page}>
      <div style={S.pageHead}><h1 style={S.pageTitle}>Saved Documents</h1></div>
      <p style={S.hint}>All uploaded statements and receipts are stored here. PDFs come from Import Statement, images from Upload Receipt.</p>
      <div style={S.docsGrid}>
        {documents.length===0 && <div style={{...S.empty, gridColumn:"1/-1"}}>No documents yet</div>}
        {documents.map(doc=>(
          <div key={doc.id} style={S.docCard}>
            <div style={S.docThumb}>
              {isImage(doc) && doc.file_url
                ? <img src={doc.file_url} alt={doc.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                : <I.pdf/>
              }
            </div>
            <div style={{padding:"0.75rem"}}>
              <div style={{fontSize:"0.8rem", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{doc.name}</div>
              <div style={{fontSize:"0.7rem", color:C.muted, marginTop:"0.2rem"}}>{doc.date} · {((doc.file_size||0)/1024).toFixed(0)} KB</div>
            </div>
            <div style={{display:"flex", gap:"0.5rem", padding:"0 0.75rem 0.75rem", justifyContent:"flex-end"}}>
              {doc.file_url && <a href={doc.file_url} target="_blank" rel="noreferrer" style={S.viewBtn}>View ↗</a>}
              <button style={S.delBtn} onClick={()=>onDelete(doc.id)}><I.trash/></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── YEAR END REPORTS TAB ─────────────────────────────────────────────────────
function ReportsTab({ allTransactions, taxYear, allYears }) {
  const [selYear,    setSelYear]    = useState(taxYear);
  const [pdfBusy,   setPdfBusy]    = useState(false);
  const [xlsBusy,   setXlsBusy]    = useState(false);
  const [pdfDone,   setPdfDone]    = useState(false);
  const [xlsDone,   setXlsDone]    = useState(false);

  const yearTx = allTransactions.filter(t => inTaxYear(t.date, selYear));
  const income   = yearTx.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const expenses = yearTx.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  const profit   = income - expenses;

  // ── SA105 totals helper ───────────────────────────────────────────────────
  function catTotal(catId, propId) {
    return yearTx
      .filter(t=>t.type==="expense" && t.category===catId && (!propId || t.property===propId))
      .reduce((s,t)=>s+Number(t.amount),0);
  }
  function propIncome(propId) {
    return yearTx.filter(t=>t.type==="income" && t.property===propId).reduce((s,t)=>s+Number(t.amount),0);
  }
  function qTotal(type, catId, q) {
    return yearTx
      .filter(t=>t.type===type && (!catId||t.category===catId) && getQuarter(t.date,selYear)===q)
      .reduce((s,t)=>s+Number(t.amount),0);
  }

  // ── PDF REPORT ────────────────────────────────────────────────────────────
  const generatePDF = async () => {
    setPdfBusy(true); setPdfDone(false);
    try {
      // Use jsPDF loaded from CDN
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
      const W = 210; const lm = 18; const rm = W - 18; const cw = rm - lm;
      let y = 20;

      const navy  = [15, 30, 60];
      const blue  = [37, 99, 235];
      const green = [22, 163, 74];
      const red   = [220, 38, 38];
      const lgrey = [245, 247, 250];
      const mgrey = [180, 190, 210];

      const fmtN = n => `£${Number(n||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
      const tyLabel = taxYearLabel(selYear);

      // ── Header bar ───────────────────────────────────────────────────────
      doc.setFillColor(...navy);
      doc.rect(0, 0, W, 28, "F");
      doc.setTextColor(255,255,255);
      doc.setFontSize(16); doc.setFont("helvetica","bold");
      doc.text("UK Property Income — SA105 Tax Summary", lm, 12);
      doc.setFontSize(9); doc.setFont("helvetica","normal");
      doc.text(`Tax Year ${tyLabel}  ·  6 April ${selYear} – 5 April ${selYear+1}`, lm, 20);
      doc.text(`Angela Bishop  ·  Generated ${new Date().toLocaleDateString("en-GB")}`, rm, 20, {align:"right"});
      y = 36;

      // ── Summary KPI row ───────────────────────────────────────────────────
      const kpis = [
        { label:"Total Income",   value:fmtN(income),   color:green },
        { label:"Total Expenses", value:fmtN(expenses), color:red   },
        { label:"Net Profit",     value:fmtN(profit),   color: profit>=0?green:red },
        { label:"Est. Basic Tax", value:fmtN(Math.max(0,(profit-12570)*0.2)), color:blue },
      ];
      const kw = cw / 4;
      kpis.forEach((k,i) => {
        const x = lm + i*kw;
        doc.setFillColor(...lgrey); doc.roundedRect(x, y, kw-2, 18, 2, 2, "F");
        doc.setTextColor(...mgrey); doc.setFontSize(7); doc.setFont("helvetica","normal");
        doc.text(k.label.toUpperCase(), x+4, y+6);
        doc.setTextColor(...k.color); doc.setFontSize(11); doc.setFont("helvetica","bold");
        doc.text(k.value, x+4, y+14);
      });
      y += 24;

      // ── Section heading helper ────────────────────────────────────────────
      const sectionHead = (title) => {
        doc.setFillColor(...blue); doc.rect(lm, y, cw, 7, "F");
        doc.setTextColor(255,255,255); doc.setFontSize(8); doc.setFont("helvetica","bold");
        doc.text(title, lm+3, y+5);
        y += 10;
      };

      // ── Row helpers ───────────────────────────────────────────────────────
      let rowAlt = false;
      const dataRow = (label, box, value, bold=false, indent=0) => {
        if (rowAlt) { doc.setFillColor(...lgrey); doc.rect(lm, y, cw, 7, "F"); }
        rowAlt = !rowAlt;
        doc.setTextColor(...navy);
        doc.setFontSize(8); doc.setFont("helvetica", bold?"bold":"normal");
        doc.text(`${label}`, lm+3+indent, y+5);
        if (box) { doc.setTextColor(...mgrey); doc.setFontSize(7); doc.text(box, lm+105, y+5); }
        doc.setTextColor(...navy); doc.setFontSize(8); doc.setFont("helvetica", bold?"bold":"normal");
        doc.text(fmtN(value), rm-2, y+5, {align:"right"});
        y += 7;
      };

      const divider = () => {
        doc.setDrawColor(...mgrey); doc.setLineWidth(0.2);
        doc.line(lm, y, rm, y); y += 4;
      };

      // ── Per-property breakdown ────────────────────────────────────────────
      PROPERTIES.filter(p=>p.id!=="manual").forEach(p => {
        const pInc = propIncome(p.id);
        const pExp = EXPENSE_CATS.reduce((s,c)=>s+catTotal(c.id,p.id),0);
        if (pInc===0 && pExp===0) return;
        sectionHead(p.label.toUpperCase());
        rowAlt=false;
        dataRow("Rent received", "Income", pInc, false);
        EXPENSE_CATS.forEach(c=>{
          const v = catTotal(c.id,p.id);
          if (v>0) dataRow(c.label, `Box ${c.box}`, v);
        });
        divider();
        dataRow("Net Profit / (Loss)", "", pInc-pExp, true);
        y += 4;
      });

      // ── Combined SA105 totals ─────────────────────────────────────────────
      sectionHead("COMBINED SA105 TOTALS — ALL PROPERTIES");
      rowAlt=false;
      dataRow("Total UK property income", "Box 20", income, false);
      EXPENSE_CATS.forEach(c=>{
        const v = catTotal(c.id, null);
        if (v>0) dataRow(c.label, `Box ${c.box}`, v);
      });
      divider();
      dataRow("Total allowable expenses", "Box 24", expenses, true);
      dataRow("Net profit / (loss)", "Box 25/26", profit, true);

      y += 8;

      // ── Quarterly breakdown ───────────────────────────────────────────────
      sectionHead("QUARTERLY INCOME & EXPENSE SUMMARY");
      rowAlt=false;
      // Header row
      doc.setFillColor(...navy); doc.rect(lm, y, cw, 7, "F");
      doc.setTextColor(255,255,255); doc.setFontSize(7.5); doc.setFont("helvetica","bold");
      doc.text("", lm+3, y+5);
      const qCols = [{id:"q1",label:"Q1 Apr–Jun"},{id:"q2",label:"Q2 Jul–Sep"},{id:"q3",label:"Q3 Oct–Dec"},{id:"q4",label:"Q4 Jan–Mar"}];
      qCols.forEach((q,i)=> doc.text(q.label, lm+40+(i*38), y+5, {align:"center"}));
      doc.text("TOTAL", rm-2, y+5, {align:"right"});
      y+=7; rowAlt=false;

      const qRow = (label, type, catId=null) => {
        if(rowAlt){doc.setFillColor(...lgrey);doc.rect(lm,y,cw,7,"F");}
        rowAlt=!rowAlt;
        doc.setTextColor(...navy); doc.setFontSize(7.5); doc.setFont("helvetica","normal");
        doc.text(label, lm+3, y+5);
        let total=0;
        qCols.forEach((q,i)=>{
          const v=qTotal(type,catId,q.id); total+=v;
          doc.text(fmtN(v), lm+40+(i*38), y+5, {align:"center"});
        });
        doc.setFont("helvetica","bold");
        doc.text(fmtN(total), rm-2, y+5, {align:"right"});
        y+=7;
      };
      qRow("Rental Income","income",null);
      qRow("Total Expenses","expense",null);
      divider();
      // Net profit row
      if(rowAlt){doc.setFillColor(...lgrey);doc.rect(lm,y,cw,7,"F");}
      doc.setTextColor(...navy); doc.setFontSize(7.5); doc.setFont("helvetica","bold");
      doc.text("Net Profit/(Loss)", lm+3, y+5);
      let qGrandTotal=0;
      qCols.forEach((q,i)=>{
        const v=qTotal("income",null,q.id)-qTotal("expense",null,q.id); qGrandTotal+=v;
        doc.setTextColor(v>=0?green[0]:red[0], v>=0?green[1]:red[1], v>=0?green[2]:red[2]);
        doc.text(fmtN(v), lm+40+(i*38), y+5, {align:"center"});
      });
      doc.setTextColor(qGrandTotal>=0?green[0]:red[0], qGrandTotal>=0?green[1]:red[1], qGrandTotal>=0?green[2]:red[2]);
      doc.text(fmtN(qGrandTotal), rm-2, y+5, {align:"right"});
      y+=10;

      // ── Footer ────────────────────────────────────────────────────────────
      doc.setFillColor(...lgrey); doc.rect(0, 280, W, 17, "F");
      doc.setTextColor(...mgrey); doc.setFontSize(7); doc.setFont("helvetica","italic");
      doc.text("This summary is for reference only. Estimated tax figures do not include personal allowances, NI, mortgage interest or other reliefs. Always consult a qualified tax adviser before submitting your Self Assessment return.", lm, 287, {maxWidth: cw});

      doc.save(`Property_Tax_SA105_${tyLabel.replace("–","-")}.pdf`);
      setPdfDone(true);
    } catch(e) {
      console.error(e);
      alert("PDF generation failed: " + e.message);
    }
    setPdfBusy(false);
  };

  // ── EXCEL REPORT ──────────────────────────────────────────────────────────
  const generateExcel = async () => {
    setXlsBusy(true); setXlsDone(false);
    try {
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      const tyLabel = taxYearLabel(selYear);
      const fmtN = n => Number(n||0);

      // ── Helper: style a header row ───────────────────────────────────────
      // SheetJS CE doesn't support cell styles in free version,
      // so we use structured data that looks clean when opened

      // ── 1. SA105 SUMMARY SHEET ───────────────────────────────────────────
      const summaryRows = [
        ["UK Property Income – SA105 Summary", "", "", ""],
        [`Tax Year ${tyLabel}  ·  6 Apr ${selYear} – 5 Apr ${selYear+1}`, "", "", ""],
        [`Generated: ${new Date().toLocaleDateString("en-GB")}`, "", "", ""],
        [],
        ["SA105 CATEGORY", "SA105 BOX", ...PROPERTIES.filter(p=>p.id!=="manual").map(p=>p.label.split(",")[0]), "COMBINED TOTAL"],
        ["Rent received", "Income",
          ...PROPERTIES.filter(p=>p.id!=="manual").map(p=>fmtN(propIncome(p.id))),
          fmtN(income)],
        ...EXPENSE_CATS.map(c=>[
          c.label, `Box ${c.box}`,
          ...PROPERTIES.filter(p=>p.id!=="manual").map(p=>fmtN(catTotal(c.id,p.id))),
          fmtN(catTotal(c.id,null))
        ]),
        [],
        ["Total Expenses", "Box 24",
          ...PROPERTIES.filter(p=>p.id!=="manual").map(p=>fmtN(EXPENSE_CATS.reduce((s,c)=>s+catTotal(c.id,p.id),0))),
          fmtN(expenses)],
        ["Net Profit / (Loss)", "Box 25/26",
          ...PROPERTIES.filter(p=>p.id!=="manual").map(p=>fmtN(propIncome(p.id)-EXPENSE_CATS.reduce((s,c)=>s+catTotal(c.id,p.id),0))),
          fmtN(profit)],
        [],
        ["QUARTERLY BREAKDOWN","","Q1 Apr-Jun","Q2 Jul-Sep","Q3 Oct-Dec","Q4 Jan-Mar","Full Year"],
        ["Total Income","",
          ...["q1","q2","q3","q4"].map(q=>fmtN(qTotal("income",null,q))),
          fmtN(income)],
        ["Total Expenses","",
          ...["q1","q2","q3","q4"].map(q=>fmtN(qTotal("expense",null,q))),
          fmtN(expenses)],
        ["Net Profit/(Loss)","",
          ...["q1","q2","q3","q4"].map(q=>fmtN(qTotal("income",null,q)-qTotal("expense",null,q))),
          fmtN(profit)],
        [],
        ["* Estimated basic rate tax (profit - £12,570 personal allowance x 20%)", "", "", fmtN(Math.max(0,(profit-12570)*0.2))],
        ["This is an illustration only. Consult a qualified tax adviser.", "", "", ""],
      ];
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
      wsSummary["!cols"] = [{wch:40},{wch:12},{wch:20},{wch:20},{wch:18}];
      XLSX.utils.book_append_sheet(wb, wsSummary, "SA105 Summary");

      // ── 2. ALL TRANSACTIONS SHEET ────────────────────────────────────────
      const txHeaders = ["Date","Type","Property","SA105 Category","SA105 Box","Description","Source / Supplier","Amount (£)"];
      const txRows = [...yearTx]
        .sort((a,b)=>new Date(a.date)-new Date(b.date))
        .map(t=>[
          t.date,
          t.type==="income"?"Income":"Expense",
          PROPERTIES.find(p=>p.id===t.property)?.label || t.property || "",
          SA105.find(c=>c.id===t.category)?.label || t.category || "",
          SA105.find(c=>c.id===t.category)?.box || "",
          t.description || "",
          t.source || "",
          fmtN(t.amount),
        ]);
      const wsAll = XLSX.utils.aoa_to_sheet([txHeaders, ...txRows]);
      wsAll["!cols"] = [{wch:12},{wch:10},{wch:28},{wch:36},{wch:10},{wch:40},{wch:28},{wch:12}];
      XLSX.utils.book_append_sheet(wb, wsAll, "All Transactions");

      // ── 3. PER-PROPERTY SHEETS ────────────────────────────────────────────
      PROPERTIES.filter(p=>p.id!=="manual").forEach(p=>{
        const propTx = yearTx.filter(t=>t.property===p.id).sort((a,b)=>new Date(a.date)-new Date(b.date));
        if (!propTx.length) return;
        const rows = [
          [p.label],
          [`Tax Year ${tyLabel}`],
          [],
          ["Date","Type","SA105 Category","Box","Description","Supplier","Amount (£)"],
          ...propTx.map(t=>[
            t.date,
            t.type==="income"?"Income":"Expense",
            SA105.find(c=>c.id===t.category)?.label||t.category||"",
            SA105.find(c=>c.id===t.category)?.box||"",
            t.description||"",
            t.source||"",
            fmtN(t.amount),
          ]),
          [],
          ["TOTALS","","","","",""],
          ["Total Income","","","","","",fmtN(propTx.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0))],
          ["Total Expenses","","","","","",fmtN(propTx.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0))],
          ["Net Profit/(Loss)","","","","","",fmtN(propIncome(p.id)-EXPENSE_CATS.reduce((s,c)=>s+catTotal(c.id,p.id),0))],
        ];
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws["!cols"] = [{wch:12},{wch:10},{wch:36},{wch:8},{wch:40},{wch:28},{wch:12}];
        const sheetName = p.label.split(",")[0].replace(/[^a-zA-Z0-9 ]/g,"").slice(0,28);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });

      // ── Download ──────────────────────────────────────────────────────────
      XLSX.writeFile(wb, `Property_Tax_Detail_${tyLabel.replace("–","-")}.xlsx`);
      setXlsDone(true);
    } catch(e) {
      console.error(e);
      alert("Excel generation failed: " + e.message);
    }
    setXlsBusy(false);
  };

  const txCount = yearTx.length;
  const propCount = PROPERTIES.filter(p=>p.id!=="manual" && yearTx.some(t=>t.property===p.id)).length;

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.pageTitle}>Year End Reports</h1>
        <div style={S.pageSub}>Generate PDF summary and Excel detail reports for your accountant or personal records</div>
      </div>

      {/* Year selector */}
      <div style={{...S.card, marginBottom:"1.5rem"}}>
        <div style={S.cardTitle}>Select Tax Year</div>
        <div style={{display:"flex", gap:"0.5rem", flexWrap:"wrap"}}>
          {allYears.map(y=>(
            <button key={y} onClick={()=>{setSelYear(y);setPdfDone(false);setXlsDone(false);}}
              style={{...S.qBtn,...(selYear===y?S.qBtnOn:{})}}>
              {taxYearLabel(y)}
            </button>
          ))}
        </div>
        <div style={{marginTop:"1rem", display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"0.75rem"}}>
          {[
            {label:"Transactions", value:txCount, color:C.text},
            {label:"Properties",   value:propCount, color:C.text},
            {label:"Total Income", value:fmt(income), color:"#4ade80"},
            {label:"Net Profit",   value:fmt(profit), color:profit>=0?"#4ade80":"#f87171"},
          ].map(k=>(
            <div key={k.label} style={{background:C.surface, borderRadius:8, padding:"0.75rem"}}>
              <div style={{fontSize:"0.68rem", color:C.muted, textTransform:"uppercase", letterSpacing:"0.07em"}}>{k.label}</div>
              <div style={{fontSize:"1rem", fontWeight:700, color:k.color, marginTop:"0.2rem"}}>{k.value}</div>
            </div>
          ))}
        </div>
      </div>

      {txCount === 0 && (
        <div style={S.errBox}>No transactions found for tax year {taxYearLabel(selYear)}. Add some records first.</div>
      )}

      {txCount > 0 && (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem"}}>

          {/* PDF Report */}
          <div style={S.card}>
            <div style={{fontSize:"2rem", marginBottom:"0.5rem"}}>📄</div>
            <div style={{fontWeight:800, fontSize:"1rem", marginBottom:"0.4rem"}}>PDF Summary Report</div>
            <div style={{fontSize:"0.82rem", color:C.muted, marginBottom:"1.25rem", lineHeight:1.5}}>
              A clean one-page A4 summary showing your SA105 figures per property and combined totals,
              with a quarterly breakdown. Ready to print or email to your accountant.
            </div>
            <div style={{fontSize:"0.75rem", color:"#60a5fa", marginBottom:"1rem"}}>
              Includes: SA105 income &amp; expense totals · Per-property breakdown · Quarterly summary · Tax estimate
            </div>
            <button style={{...S.btnPri, width:"100%", justifyContent:"center"}}
              onClick={generatePDF} disabled={pdfBusy}>
              {pdfBusy ? <><I.spin/> Generating PDF…</> : "⬇ Download PDF Summary"}
            </button>
            {pdfDone && <div style={{...S.okBox, marginTop:"0.75rem"}}>✓ PDF downloaded — check your Downloads folder</div>}
          </div>

          {/* Excel Report */}
          <div style={S.card}>
            <div style={{fontSize:"2rem", marginBottom:"0.5rem"}}>📊</div>
            <div style={{fontWeight:800, fontSize:"1rem", marginBottom:"0.4rem"}}>Excel Detail Report</div>
            <div style={{fontSize:"0.82rem", color:C.muted, marginBottom:"1.25rem", lineHeight:1.5}}>
              A full transaction-level spreadsheet with multiple sheets: SA105 summary totals,
              all transactions, and a separate sheet per property. Ideal for your accountant.
            </div>
            <div style={{fontSize:"0.75rem", color:"#60a5fa", marginBottom:"1rem"}}>
              Sheets: SA105 Summary · All Transactions · {PROPERTIES.filter(p=>p.id!=="manual").map(p=>p.label.split(",")[0]).join(" · ")}
            </div>
            <button style={{...S.btnPri, width:"100%", justifyContent:"center", background:"#16a34a"}}
              onClick={generateExcel} disabled={xlsBusy}>
              {xlsBusy ? <><I.spin/> Generating Excel…</> : "⬇ Download Excel Detail"}
            </button>
            {xlsDone && <div style={{...S.okBox, marginTop:"0.75rem"}}>✓ Excel downloaded — check your Downloads folder</div>}
          </div>

        </div>
      )}

      <div style={{...S.disc, marginTop:"1.5rem"}}>
        Reports are generated from your records in this app. Always review figures with a qualified tax adviser before submitting your Self Assessment return. Estimated tax figures are illustrative only.
      </div>
    </div>
  );
}

// ── SMALL COMPONENTS ──────────────────────────────────────────────────────────
function Fld({label, children, wide}) {
  return <label style={{...S.fld,...(wide?{gridColumn:"1/-1"}:{})}}>{label}{children}</label>;
}

// ── COLOURS ───────────────────────────────────────────────────────────────────
const C = { bg:"#080b10", surface:"#0e1117", card:"#131820", border:"#1a2235", text:"#dde4f0", muted:"#5a6a80", accent:"#2563eb" };

const S = {
  root:      {display:"flex", minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Outfit','Segoe UI',sans-serif"},
  sidebar:   {width:232, background:C.surface, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", padding:"1.25rem 0", position:"sticky", top:0, height:"100vh", flexShrink:0},
  logo:      {display:"flex", alignItems:"center", gap:"0.65rem", padding:"0 1.1rem 0.9rem"},
  logoMark:  {width:34, height:34, background:"linear-gradient(135deg,#1d4ed8,#7c3aed)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff"},
  logoTitle: {fontWeight:800, fontSize:"0.95rem", letterSpacing:"-0.02em"},
  logoSub:   {fontSize:"0.65rem", color:C.muted},
  cloudBadge:{display:"flex", alignItems:"center", gap:"0.4rem", margin:"0 1.1rem 0.7rem", background:"rgba(74,222,128,0.07)", border:"1px solid rgba(74,222,128,0.2)", color:"#4ade80", fontSize:"0.68rem", padding:"0.3rem 0.55rem", borderRadius:5},
  yearBlock: {padding:"0 1.1rem 0.8rem", borderBottom:`1px solid ${C.border}`, marginBottom:"0.6rem"},
  yearLabel: {fontSize:"0.65rem", color:C.muted, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:"0.35rem"},
  yearSelect:{width:"100%", background:C.card, border:`1px solid ${C.border}`, color:C.text, padding:"0.38rem 0.55rem", borderRadius:6, fontSize:"0.82rem"},
  nav:       {flex:1, padding:"0 0.6rem"},
  navBtn:    {display:"flex", alignItems:"center", gap:"0.55rem", width:"100%", padding:"0.55rem 0.7rem", borderRadius:7, border:"none", background:"transparent", color:C.muted, cursor:"pointer", fontSize:"0.82rem", textAlign:"left", marginBottom:2},
  navOn:     {background:"rgba(37,99,235,0.13)", color:"#60a5fa"},
  sideFoot:  {padding:"0.9rem 1.1rem 0", borderTop:`1px solid ${C.border}`},
  footRow:   {display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.3rem"},
  footLabel: {fontSize:"0.7rem", color:C.muted},
  footVal:   {fontWeight:800, fontSize:"1.05rem"},
  main:      {flex:1, overflow:"auto"},
  errBanner: {display:"flex", justifyContent:"space-between", alignItems:"center", background:"rgba(248,113,113,0.08)", borderBottom:`1px solid rgba(248,113,113,0.25)`, color:"#f87171", padding:"0.65rem 2rem", fontSize:"0.82rem"},
  errX:      {background:"none", border:"none", color:"#f87171", cursor:"pointer"},
  page:      {padding:"1.75rem 2rem", maxWidth:1080},
  pageHead:  {display:"flex", alignItems:"center", gap:"1rem", marginBottom:"1.5rem", flexWrap:"wrap"},
  pageTitle: {margin:0, fontSize:"1.6rem", fontWeight:800, letterSpacing:"-0.03em", flex:1},
  pageSub:   {color:C.muted, fontSize:"0.82rem", flex:"0 0 100%", marginTop:"-1.2rem"},
  qRow:      {display:"flex", gap:"0.4rem", marginBottom:"1.25rem", flexWrap:"wrap"},
  qBtn:      {background:C.card, border:`1px solid ${C.border}`, color:C.muted, padding:"0.35rem 0.85rem", borderRadius:20, fontSize:"0.78rem", cursor:"pointer"},
  qBtnOn:    {borderColor:"#2563eb", color:"#60a5fa", background:"rgba(37,99,235,0.1)"},
  statsGrid: {display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))", gap:"0.85rem", marginBottom:"1.25rem"},
  statCard:  {background:C.card, border:`1px solid ${C.border}`, borderRadius:11, padding:"1.1rem"},
  statLabel: {fontSize:"0.7rem", color:C.muted, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:"0.4rem"},
  statVal:   {fontWeight:800, letterSpacing:"-0.02em", lineHeight:1.1},
  statSub:   {fontSize:"0.65rem", color:C.muted, marginTop:"0.3rem"},
  threeCol:  {display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.85rem"},
  card:      {background:C.card, border:`1px solid ${C.border}`, borderRadius:11, padding:"1.1rem", marginBottom:"0.85rem"},
  cardTitle: {display:"flex", alignItems:"center", gap:"0.4rem", fontWeight:700, marginBottom:"0.85rem", fontSize:"0.78rem", textTransform:"uppercase", letterSpacing:"0.06em", color:"#7a90a8"},
  empty:     {color:C.muted, fontSize:"0.82rem", textAlign:"center", padding:"1.5rem 0"},
  propRow:   {display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.45rem 0", borderBottom:`1px solid ${C.border}`, gap:"0.5rem"},
  propAddr:  {fontSize:"0.78rem", color:C.text, flex:1},
  catRow:    {display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"0.4rem 0", borderBottom:`1px solid ${C.border}`, gap:"0.75rem"},
  txRow:     {display:"flex", alignItems:"center", gap:"0.6rem", padding:"0.4rem 0", borderBottom:`1px solid ${C.border}`},
  txDot:     {width:7, height:7, borderRadius:"50%", flexShrink:0},
  disc:      {fontSize:"0.67rem", color:C.muted, marginTop:"1.25rem", fontStyle:"italic"},
  hint:      {fontSize:"0.82rem", color:C.muted, marginBottom:"0.85rem"},
  dropZone:  {border:`2px dashed ${C.border}`, borderRadius:10, padding:"2rem", textAlign:"center", cursor:"pointer", marginBottom:"1rem", display:"flex", flexDirection:"column", alignItems:"center", gap:"0.4rem", color:C.muted, transition:"border-color 0.2s"},
  loadBox:   {display:"flex", alignItems:"center", gap:"0.5rem", color:"#60a5fa", fontSize:"0.85rem", marginTop:"0.75rem"},
  errBox:    {background:"rgba(248,113,113,0.08)", border:`1px solid rgba(248,113,113,0.25)`, color:"#f87171", padding:"0.65rem 0.9rem", borderRadius:7, marginTop:"0.75rem", fontSize:"0.82rem"},
  okBox:     {background:"rgba(74,222,128,0.08)", border:`1px solid rgba(74,222,128,0.25)`, color:"#4ade80", padding:"0.65rem 0.9rem", borderRadius:7, marginTop:"0.75rem", fontSize:"0.82rem"},
  tbl:       {width:"100%", borderCollapse:"collapse", fontSize:"0.82rem"},
  th:        {textAlign:"left", padding:"0.5rem 0.6rem", fontSize:"0.68rem", color:C.muted, textTransform:"uppercase", letterSpacing:"0.07em", borderBottom:`1px solid ${C.border}`},
  td:        {padding:"0.4rem 0.4rem"},
  formGrid:  {display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.85rem"},
  fld:       {display:"flex", flexDirection:"column", gap:"0.3rem", fontSize:"0.75rem", color:"#7a90a8"},
  input:     {background:C.surface, border:`1px solid ${C.border}`, color:C.text, padding:"0.45rem 0.65rem", borderRadius:6, fontSize:"0.82rem", outline:"none"},
  formActions:{display:"flex", gap:"0.65rem", justifyContent:"flex-end", marginTop:"0.9rem", alignItems:"center"},
  btnPri:    {display:"flex", alignItems:"center", gap:"0.35rem", background:C.accent, color:"#fff", border:"none", padding:"0.48rem 1rem", borderRadius:7, fontWeight:700, fontSize:"0.82rem", cursor:"pointer"},
  btnSec:    {background:"transparent", color:C.text, border:`1px solid ${C.border}`, padding:"0.48rem 0.9rem", borderRadius:7, fontWeight:600, fontSize:"0.82rem", cursor:"pointer"},
  delBtn:    {background:"transparent", border:"none", color:C.muted, cursor:"pointer", padding:"0.2rem", display:"flex", alignItems:"center"},
  sa105Grid: {display:"flex", flexDirection:"column", gap:"0"},
  sa105Row:  {display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.45rem 0", borderBottom:`1px solid ${C.border}`, gap:"1rem"},
  docsGrid:  {display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:"0.75rem"},
  docCard:   {background:C.card, border:`1px solid ${C.border}`, borderRadius:9, overflow:"hidden"},
  docThumb:  {height:80, background:C.surface, display:"flex", alignItems:"center", justifyContent:"center", color:C.muted},
  attachRow: {display:"flex", gap:"1rem", alignItems:"center"},
  attachBox: {width:100, height:100, background:C.surface, border:`2px dashed ${C.border}`, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, overflow:"hidden"},
  viewBtn:   {background:"rgba(37,99,235,0.1)", color:"#60a5fa", padding:"0.2rem 0.5rem", borderRadius:4, fontSize:"0.75rem", textDecoration:"none"},
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 0.8s linear infinite; }
  select option { background: #131820; }
  input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-thumb { background: #1a2235; border-radius: 3px; }
  @media (max-width: 768px) {
    aside { display: none; }
    .threeCol { grid-template-columns: 1fr !important; }
  }
`;
