// Importing SimplePractice records (lib/sp-import.js), with invented people and generated documents.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

// A small real PDF with one line of text per row, like SimplePractice's invoice
function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => "\\" + m);
  const body = "BT /F1 10 Tf 50 760 Td 14 TL " + lines.map((l) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let out = "%PDF-1.4\n"; const at = [];
  objs.forEach((o, i) => { at.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const invoicePdf = (issued, desc, amount, paid) => pdf(["Invoice", `Issued: ${issued}`, "Date Description Amount", `${issued} ${desc} $${amount}`, `Subtotal ${amount}`, `Total ${amount}`, `Amount Paid ${paid}`, "Balance"]);

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-sp-"));
  const app = createApp({ adminEmail: "owner@example.com", adminPasswordHash: hashPassword("owner-pass-123"), sessionSecret: "s".repeat(40), dataKey: "k".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://www.mymdfit.com", trashTimer: false });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + url, { method, headers: { connection: "close", ...(raw ? {} : { "content-type": "application/json" }), ...headers, ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const owner = (await call("POST", "/api/admin/login", { email: "owner@example.com", password: "owner-pass-123" })).body.token;
  const file = (q, buf, type, name, token = owner) => call("POST", `/api/admin/import/sp/file?${new URLSearchParams(q)}`, buf, token, { "content-type": type, "x-file-name": encodeURIComponent(name) });
  return { call, owner, file, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("SimplePractice import: match, create, file the records, enter the invoices in revenue, and undo", async () => {
  const s = await start();
  try {
    // Already in MD Fit: one by email, one by name only (no email on the card)
    const a = (await s.call("POST", "/api/clients/signup", { name: "Alma Example", email: "alma@example.com", phone: "941-555-0101", password: "pat-pass-123" })).body.client;
    const b = (await s.call("POST", "/api/admin/clients", { name: "Bram Sample", email: "bram@example.com" }, s.owner)).body.client;
    const contacts = [
      { key: "c1", name: "Alma Example", email: "ALMA@example.com", phone: "941-555-0199", dob: "1980-01-02", address: "1 Example St" },
      { key: "c2", name: "Bram Sample", phone: "941-555-0102", dob: "1975-05-06" },
      { key: "c3", name: "Cleo Invented", email: "cleo@example.com", phone: "941-555-0103", dob: "1990-03-04" },
      { key: "c4", name: "Dov Madeup", phone: "941-555-0104" },                      // no email
      { key: "c5", name: "Eda Notreal", email: "eda@example.com" }
    ];
    assert.equal((await s.call("POST", "/api/import/sp/plan", { contacts })).status, 404, "not a route outside the admin area");
    assert.equal((await s.call("POST", "/api/admin/import/sp/plan", { contacts })).status, 401);
    let r = await s.call("POST", "/api/admin/import/sp/plan", { contacts }, s.owner);
    assert.equal(r.status, 200);
    const plan = Object.fromEntries(r.body.rows.map((x) => [x.key, x]));
    assert.deepEqual([plan.c1.action, plan.c1.how, plan.c1.clientId], ["link", "email", a.id]);
    assert.deepEqual([plan.c2.action, plan.c2.how, plan.c2.clientId], ["link", "name", b.id]);
    for (const k of ["c3", "c4", "c5"]) assert.equal(plan[k].action, "new", k);

    // staff, even an Administrator, cannot import
    await s.call("POST", "/api/admin/staff", { name: "Admin Person", email: "adm@example.com", role: "admin", password: "staff-pass-1234" }, s.owner);
    const adm = (await s.call("POST", "/api/admin/login", { email: "adm@example.com", password: "staff-pass-1234" })).body.token;
    assert.equal((await s.call("POST", "/api/admin/import/sp/plan", { contacts }, adm)).status, 403);

    const rows = contacts.map((x) => ({ ...x, action: plan[x.key].action, clientId: plan[x.key].clientId, patientSince: { c1: "2025-10-31", c3: "2025-12-16", c4: "2026-02-05" }[x.key] || "" }));
    r = await s.call("POST", "/api/admin/import/sp/clients", { rows }, s.owner);
    assert.equal(r.status, 201); assert.equal(r.body.created, 3); assert.equal(r.body.linked, 2); assert.equal(r.body.patients, 3);
    const { batch, map } = r.body;
    let list = (await s.call("GET", "/api/admin/clients", undefined, s.owner)).body;
    const by = (id) => list.find((c) => c.id === id);
    assert.equal(list.length, 5, "three new accounts on the client list");
    assert.equal(by(map.c4).email, "", "a contact with no email comes in without one");
    assert.equal(by(a.id).phone, "941-555-0101", "an existing account's details are not overwritten");
    // nobody can sign in to an imported account until they set a password, and nobody was emailed (no service here)
    assert.notEqual((await s.call("POST", "/api/clients/login", { email: "cleo@example.com", password: "anything-at-all" })).status, 200);

    // documents onto charts
    r = await s.file({ batch, client: map.c3, kind: "record", date: "2025-12-16" }, pdf(["Chart Note", "Example text"]), "application/pdf", "Chart Note 2025-12-16 101500 123456789.pdf");
    assert.equal(r.status, 201); assert.equal(r.body.file.at, "2025-12-16T12:00:00.000Z"); assert.equal(r.body.duplicate, false);
    r = await s.file({ batch, client: map.c3, kind: "record", date: "2025-12-16" }, pdf(["Chart Note", "Example text"]), "application/pdf", "Chart Note 2025-12-16 101500 123456789.pdf");
    assert.equal(r.body.duplicate, true, "running the same import twice does not file a document twice");
    r = await s.file({ batch, client: map.c3, kind: "invoice" }, invoicePdf("12/16/2025", "Professional Services", "150.00", "150.00"), "application/pdf", "Cleo Invented 10.pdf");
    assert.equal(r.status, 201); assert.deepEqual([r.body.invoice.amount, r.body.invoice.status, r.body.invoice.date], [15000, "paid", "2025-12-16"]);
    r = await s.file({ batch, client: map.c3, kind: "invoice" }, invoicePdf("12/16/2025", "Professional Services", "150.00", "150.00"), "application/pdf", "Cleo Invented 10.pdf");
    assert.equal(r.body.invoice.duplicate, true, "an invoice is entered once");
    r = await s.file({ batch, client: map.c1, kind: "invoice" }, invoicePdf("10/31/2025", "Online Eval/ Treat", "125.00", "125.00"), "application/pdf", "Alma Example 7.pdf");
    assert.equal(r.body.invoice.amount, 12500);
    r = await s.file({ batch, client: map.c4, kind: "invoice" }, invoicePdf("04/13/2026", "Two appointments", "0.00", "0.00"), "application/pdf", "Dov Madeup 14.pdf");
    assert.equal(r.body.invoice, null); assert.match(r.body.note, /\$0 invoice/);
    r = await s.file({ batch, client: map.c4, kind: "invoice" }, invoicePdf("02/05/2026", "Professional Services", "150.00", "50.00"), "application/pdf", "Dov Madeup 13.pdf");
    assert.equal(r.body.invoice.status, "unpaid", "a part-paid invoice comes in as still owed");
    r = await s.file({ batch, client: map.c4, kind: "message" }, Buffer.from("----- Example 1, 2026 -----\nhello"), "text/plain", "Dov-Madeup-Jared-Caban-CONV.txt");
    assert.equal(r.status, 201);
    assert.equal((await s.file({ batch, client: map.c5, kind: "record" }, Buffer.from("x"), "application/zip", "bad.zip")).status, 400, "only chart file types");
    assert.equal((await s.file({ batch: "nope", client: map.c5, kind: "record" }, pdf(["x"]), "application/pdf", "x.pdf")).status, 400);

    // the chart has them, with their dates and source, and a patient flag
    const ch = (await s.call("GET", `/api/admin/emr/${map.c3}`, undefined, s.owner)).body;
    assert.equal(ch.patient, true);
    const bill = (await s.call("GET", `/api/admin/emr/${map.c3}/billing`, undefined, s.owner)).body;
    assert.equal(bill.invoices.filter((x) => x.amount === 15000 && x.status === "paid").length, 1);
    // revenue counts the paid ones in the month they were issued, as settled outside Stripe
    const dec = (await s.call("GET", "/api/admin/economics/month?m=2025-12", undefined, s.owner)).body;
    assert.ok(JSON.stringify(dec).includes("15000"), "December 2025 shows the $150 invoice");
    const oct = (await s.call("GET", "/api/admin/economics/month?m=2025-10", undefined, s.owner)).body;
    assert.ok(JSON.stringify(oct).includes("12500"), "October 2025 shows the $125 invoice");
    // clinic revenue never enters the revenue share
    const share = (await s.call("GET", "/api/admin/partner-share", undefined, s.owner)).body;
    assert.equal(JSON.stringify(share).includes("15000"), false);

    // nothing readable on disk
    for (const f of fs.readdirSync(s.dataDir)) { const p = path.join(s.dataDir, f); if (fs.statSync(p).isFile()) for (const t of ["Cleo Invented", "cleo@example.com", "1990-03-04"]) assert.equal(fs.readFileSync(p, "latin1").includes(t), false, `${f} holds ${t}`); }
    // the ledger has the import, by the owner
    const led = (await s.call("GET", "/api/admin/audit?limit=200", undefined, s.owner)).body.entries.map((e) => e.action);
    assert.ok(led.includes("import.sp.clients")); assert.ok(led.includes("import.sp.file"));

    // undo: new accounts go, linked ones lose only what was imported
    r = await s.call("GET", "/api/admin/import/sp/batches", undefined, s.owner);
    assert.equal(r.body[0].files, 6); assert.equal(r.body[0].invoices, 3);
    r = await s.call("POST", `/api/admin/import/sp/batches/${batch}/undo`, {}, s.owner);
    assert.equal(r.status, 200); assert.equal(r.body.removedAccounts, 3);
    list = (await s.call("GET", "/api/admin/clients", undefined, s.owner)).body;
    assert.deepEqual(list.map((c) => c.id).sort(), [a.id, b.id].sort());
    const abill = (await s.call("GET", `/api/admin/emr/${a.id}/billing`, undefined, s.owner)).body;
    assert.equal(abill.invoices.length, 0, "the imported invoice is gone from the linked account: " + JSON.stringify(abill.invoices));
    assert.equal((await s.call("GET", `/api/admin/emr/${a.id}`, undefined, s.owner)).body.patient, false, "and the patient flag the import set");
    assert.equal((await s.call("POST", `/api/admin/import/sp/batches/${batch}/undo`, {}, s.owner)).status, 400, "an import is undone once");
  } finally { s.close(); }
});

test("names shared by two accounts are never guessed", async () => {
  const s = await start();
  try {
    await s.call("POST", "/api/admin/clients", { name: "Sam Twin", email: "sam1@example.com" }, s.owner);
    await s.call("POST", "/api/admin/clients", { name: "Sam Twin", email: "sam2@example.com" }, s.owner);
    const r = await s.call("POST", "/api/admin/import/sp/plan", { contacts: [{ key: "x", name: "Sam Twin" }, { key: "y", name: "Sam Twin", email: "sam3@example.com" }] }, s.owner);
    const x = r.body.rows.find((q) => q.key === "x"), y = r.body.rows.find((q) => q.key === "y");
    assert.equal(x.how, "ambiguous"); assert.equal(x.candidates.length, 2); assert.equal(x.action, "new");
    assert.equal(y.action, "new", "a different email is a different person");
  } finally { s.close(); }
});
