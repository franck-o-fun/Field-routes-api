// Field routes go-between: holds the GoHighLevel key so the public app never sees it.
// No dependencies. Node 18 or newer.
"use strict";
const http = require("http");

const ENV = process.env;
const GHL = (ENV.GHL_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const TOKEN = ENV.GHL_TOKEN || "";
const LOCATION = ENV.GHL_LOCATION_ID || "";
const VERSION = ENV.GHL_VERSION || "2021-07-28";
const APP_KEY = ENV.APP_KEY || "";
const PIPELINE_NAME = (ENV.PIPELINE_NAME || "Commandes").trim().toLowerCase();
const ORIGINS = (ENV.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
const PORT = ENV.PORT || 10000;
const MAX_BODY = 20 * 1024 * 1024;

const FIELDS = {
  storeId: { name: "Field routes ID", type: "TEXT" }, storeNo: { name: "Store number", type: "TEXT" }, region: { name: "Region", type: "TEXT" },
  lastOrder: { name: "Dernière commande", type: "DATE" }, lastVisit: { name: "Dernière visite", type: "DATE" }
};
const REORDER_DAYS = ENV.REORDER_DAYS != null ? Number(ENV.REORDER_DAYS) : 35;   // 0 turns the task off
const FOLLOWUP_DAYS = ENV.FOLLOWUP_DAYS != null ? Number(ENV.FOLLOWUP_DAYS) : 21;
const TASK_ORDER = "Relance commande", TASK_VISIT = "Suivi visite";

/* ---------- GoHighLevel calls ---------- */
class GhlError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }
async function ghl(method, path, body, isForm) {
  const headers = { Authorization: "Bearer " + TOKEN, Version: VERSION, Accept: "application/json" };
  if (body && !isForm) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(GHL + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (r.status === 429 && attempt < 3) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
    if (!r.ok) {
      const msg = (data && (Array.isArray(data.message) ? data.message.join("; ") : data.message)) || r.statusText;
      throw new GhlError(r.status, `GoHighLevel ${method} ${path.split("?")[0]} failed (${r.status}): ${msg}`, data);
    }
    return data || {};
  }
}

/* ---------- setup cached in memory ---------- */
let fieldIds = null, pipeline = undefined;
async function ensureFields() {
  if (fieldIds) return fieldIds;
  const got = await ghl("GET", `/locations/${LOCATION}/customFields?model=contact`);
  const list = got.customFields || [];
  const ids = {};
  for (const [k, { name, type }] of Object.entries(FIELDS)) {
    let f = list.find(x => String(x.name).trim().toLowerCase() === name.toLowerCase());
    if (!f) {
      const made = await ghl("POST", `/locations/${LOCATION}/customFields`, { name, dataType: type, model: "contact" });
      f = made.customField || made;
    }
    ids[k] = f.id;
  }
  fieldIds = ids; return ids;
}
// One number field per product on opportunities ("Qté Açaï"...), created the first time that product is ordered.
let oppFields = null;
async function oppFieldId(product) {
  const name = "Qté " + product;
  if (!oppFields) { const got = await ghl("GET", `/locations/${LOCATION}/customFields?model=opportunity`); oppFields = new Map((got.customFields || []).map(f => [String(f.name).trim().toLowerCase(), f.id])); }
  const k = name.toLowerCase(); if (oppFields.has(k)) return oppFields.get(k);
  const made = await ghl("POST", `/locations/${LOCATION}/customFields`, { name, dataType: "NUMERICAL", model: "opportunity" });
  const id = (made.customField || made).id; oppFields.set(k, id); return id;
}
async function findPipeline() {
  if (pipeline !== undefined) return pipeline;
  const got = await ghl("GET", `/opportunities/pipelines?locationId=${LOCATION}`);
  const p = (got.pipelines || []).find(x => String(x.name).trim().toLowerCase() === PIPELINE_NAME) || null;
  pipeline = p ? { id: p.id, stageId: p.stages && p.stages.length ? p.stages[0].id : undefined, name: p.name } : null;
  return pipeline;
}

/* ---------- helpers ---------- */
const e164 = p => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return undefined; };
const money = n => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") + " $";
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!m) throw new GhlError(400, "A photo or file could not be read.");
  const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
  return new Blob([buf], { type: m[1] || "application/octet-stream" });
}
async function upload(dataUrl, name) {
  const fd = new FormData();
  fd.append("file", dataUrlToBlob(dataUrl), name);
  fd.append("name", name);
  fd.append("hosted", "false");
  const r = await ghl("POST", "/medias/upload-file", fd, true);
  return r.url || (r.data && r.data.url) || "";
}
async function searchOne(filters) {
  const r = await ghl("POST", "/contacts/search", { locationId: LOCATION, pageLimit: 1, filters });
  return r.contacts && r.contacts[0] ? r.contacts[0].id : null;
}

/* ---------- actions ---------- */
async function ensureContact(store) {
  if (!store || !store.id || !store.name) throw new GhlError(400, "Store is missing.");
  const f = await ensureFields();
  const found = await searchOne([{ field: `customFields.${f.storeId}`, operator: "eq", value: store.id }]);
  if (found) return { contactId: found, created: false };
  const custom = [{ id: f.storeId, field_value: store.id }];
  if (store.storeNo) custom.push({ id: f.storeNo, field_value: String(store.storeNo) });
  if (store.region) custom.push({ id: f.region, field_value: store.region });
  const body = {
    locationId: LOCATION, firstName: store.name, companyName: store.name,
    address1: store.address || undefined, city: store.city || undefined, state: "QC", postalCode: store.postal || undefined, country: "CA",
    phone: e164(store.phone), email: store.email || undefined,
    tags: ["field-routes", store.list || "store"].filter(Boolean), source: "Field routes", customFields: custom
  };
  if (store.region === "Nouveau-Brunswick") body.state = "NB";
  try {
    const made = await ghl("POST", "/contacts/", body);
    return { contactId: (made.contact || made).id, created: true };
  } catch (e) {
    // Duplicate email or phone: reuse that contact and stamp it with the store id.
    if (e.status !== 400 && e.status !== 422) throw e;
    let id = (e.data && e.data.meta && e.data.meta.contactId) || null;
    if (!id && body.email) id = await searchOne([{ field: "email", operator: "eq", value: body.email }]);
    if (!id && body.phone) id = await searchOne([{ field: "phone", operator: "eq", value: body.phone }]);
    if (!id) { delete body.email; delete body.phone; const made = await ghl("POST", "/contacts/", body); return { contactId: (made.contact || made).id, created: true }; }
    await ghl("PUT", `/contacts/${id}`, { customFields: custom });
    return { contactId: id, created: false };
  }
}

/* ---------- follow-ups: never block the note or order itself ---------- */
async function extra(out, label, fn) {
  try { return await fn(); }
  catch (e) { console.error(label + ": " + e.message); (out.notices = out.notices || []).push(label + ": " + e.message); return null; }
}
async function setDate(contactId, key, date) {
  const f = await ensureFields();
  await ghl("PUT", `/contacts/${contactId}`, { customFields: [{ id: f[key], field_value: date }] });
}
// Closes any open reminder of the given kinds, then creates the new one.
async function replaceTask(contactId, closeKinds, kind, storeName, body, fromDate, days) {
  if (!(days > 0)) return null;
  const r = await ghl("GET", `/contacts/${contactId}/tasks`);
  for (const t of r.tasks || []) {
    if (!t.completed && closeKinds.some(k => String(t.title || "").startsWith(k))) await ghl("PUT", `/contacts/${contactId}/tasks/${t.id}/completed`, { completed: true });
  }
  const due = new Date((fromDate || new Date().toISOString().slice(0, 10)) + "T14:00:00Z"); due.setUTCDate(due.getUTCDate() + days);
  const task = { title: `${kind} · ${storeName || "magasin"}`.slice(0, 120), body, dueDate: due.toISOString(), completed: false };
  if (ENV.GHL_USER_ID) task.assignedTo = ENV.GHL_USER_ID;
  const made = await ghl("POST", `/contacts/${contactId}/tasks`, task);
  return (made.task || made).id;
}

async function saveNote(p) {
  if (!p.contactId) throw new GhlError(400, "Contact is missing.");
  const urls = (p.photoUrls || []).slice();
  let i = urls.length;
  for (const ph of (p.photos || []).slice(0, 4)) { i++; urls.push(await upload(ph, `${p.storeName || "visite"} ${p.date} photo ${i}.jpg`.replace(/[\\/:*?"<>|]+/g, " "))); }
  const body = [`Visite ${p.date} · ${p.rep || ""}`.trim(), "", (p.text || "").trim()];
  if (urls.length) body.push("", "Photos :", ...urls.filter(Boolean));
  const text = body.join("\n").slice(0, 5000);
  if (p.noteId) {
    try {
      await ghl("PUT", `/contacts/${p.contactId}/notes/${p.noteId}`, { body: text });
      return { noteId: p.noteId, photoUrls: urls, updated: true };
    } catch (e) { if (e.status !== 404) throw e; }      // note deleted in GoHighLevel: write a new one
  }
  const made = await ghl("POST", `/contacts/${p.contactId}/notes`, { body: text });
  const out = { noteId: (made.note || made).id, photoUrls: urls, updated: false };
  await extra(out, "Dernière visite", () => setDate(p.contactId, "lastVisit", p.date));
  await extra(out, "Task", () => replaceTask(p.contactId, [TASK_VISIT], TASK_VISIT, p.storeName,
    `Visite du ${p.date}. Repasser ou appeler.\n\n${(p.text || "").trim().slice(0, 500)}`, p.date, FOLLOWUP_DAYS));
  return out;
}

async function saveOrder(p) {
  if (!p.contactId) throw new GhlError(400, "Contact is missing.");
  const out = {};
  if (p.xlsx && !p.fileUrl) out.fileUrl = await upload(p.xlsx, p.fileName || `Bon de commande ${p.date}.xlsx`);
  else out.fileUrl = p.fileUrl || "";
  const min = Number(p.minimum) || 0;
  const lines = [`Commande ${p.date} · ${p.rep || ""}`.trim()];
  if (p.po) lines.push(`PO : ${p.po}`);
  if (p.contact) lines.push(`Contact : ${p.contact}`);
  lines.push("");
  for (const l of p.lines || []) lines.push(`${l.name} ${l.size || ""} × ${l.qty} = ${money(l.qty * l.price)}`.replace(/\s+/g, " "));
  lines.push("", `Total : ${money(p.total)}` + (min ? (p.total < min ? ` (sous le minimum de ${money(min)})` : " (minimum atteint)") : ""));
  if (out.fileUrl) lines.push("", "Bon de commande : " + out.fileUrl);
  if (!p.noteId) out.noteId = (await ghl("POST", `/contacts/${p.contactId}/notes`, { body: lines.join("\n") })).note?.id || null;
  else out.noteId = p.noteId;
  if (!p.opportunityId) {
    const pl = await findPipeline();
    if (pl) {
      const body = {
        pipelineId: pl.id, pipelineStageId: pl.stageId, locationId: LOCATION, contactId: p.contactId,
        name: `Commande ${p.storeName || ""} ${p.date}${p.po ? " PO " + p.po : ""}`.trim(), status: (ENV.OPP_STATUS || "open"), monetaryValue: Math.round(p.total * 100) / 100
      };
      const qty = await extra(out, "Product fields", async () => {
        const cf = []; for (const l of p.lines || []) if (l.qty > 0) cf.push({ id: await oppFieldId(l.name), field_value: l.qty }); return cf;
      });
      let opp;
      if (qty && qty.length) {
        try { opp = await ghl("POST", "/opportunities/", Object.assign({}, body, { customFields: qty })); }
        catch (e) { if (e.status !== 400 && e.status !== 422) throw e; (out.notices = out.notices || []).push("Product quantities refused: " + e.message); }
      }
      if (!opp) opp = await ghl("POST", "/opportunities/", body);
      out.opportunityId = (opp.opportunity || opp).id;
      await extra(out, "Dernière commande", () => setDate(p.contactId, "lastOrder", p.date));
      await extra(out, "Task", () => replaceTask(p.contactId, [TASK_ORDER, TASK_VISIT], TASK_ORDER, p.storeName,
        `Dernière commande le ${p.date} : ${money(p.total)}. Vérifier le réassort.`, p.date, REORDER_DAYS));
    } else out.warning = `No pipeline named "${ENV.PIPELINE_NAME || "Commandes"}" in GoHighLevel, so no opportunity was created.`;
  } else out.opportunityId = p.opportunityId;
  return out;
}

async function listNotes(contactId) {
  const r = await ghl("GET", `/contacts/${contactId}/notes`);
  return (r.notes || []).map(n => ({ id: n.id, body: n.body || "", date: n.dateAdded || n.createdAt || "" }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10);
}

async function check() {
  const out = { location: LOCATION ? "set" : "missing", token: TOKEN ? "set" : "missing", appKey: APP_KEY ? "set" : "missing" };
  if (!TOKEN || !LOCATION) return out;
  try { await ensureFields(); out.customFields = "ok"; }
  catch (e) { out.customFields = e.message; }
  try { await ghl("GET", `/locations/${LOCATION}/customFields?model=opportunity`); out.opportunityFields = "ok"; } catch (e) { out.opportunityFields = e.message; }
  try { const p = await findPipeline(); out.pipeline = p ? `ok (${p.name})` : `not found: create a pipeline named "${ENV.PIPELINE_NAME || "Commandes"}"`; } catch (e) { out.pipeline = e.message; }
  return out;
}

/* ---------- web server ---------- */
function cors(req, res) {
  const o = req.headers.origin;
  const allow = ORIGINS.includes("*") ? "*" : (o && ORIGINS.includes(o) ? o : ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-App-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(new GhlError(413, "Too large. Send fewer or smaller photos.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new GhlError(400, "Bad request.")); } });
    req.on("error", reject);
  });
}
http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/health") return send(res, 200, { ok: true, service: "field-routes-api", ready: !!(TOKEN && LOCATION && APP_KEY) });
    if (!APP_KEY || req.headers["x-app-key"] !== APP_KEY) return send(res, 401, { error: "Wrong app password. Check it in Reports > GoHighLevel." });
    if (!TOKEN || !LOCATION) return send(res, 500, { error: "The service is missing GHL_TOKEN or GHL_LOCATION_ID in Render." });
    if (req.method === "GET" && url.pathname === "/api/check") return send(res, 200, await check());
    if (req.method === "GET" && url.pathname === "/api/notes") return send(res, 200, { notes: await listNotes(url.searchParams.get("contactId")) });
    if (req.method === "POST" && url.pathname === "/api/contact") { const b = await readJson(req); return send(res, 200, await ensureContact(b.store)); }
    if (req.method === "POST" && url.pathname === "/api/note") { const b = await readJson(req); return send(res, 200, await saveNote(b)); }
    if (req.method === "POST" && url.pathname === "/api/order") { const b = await readJson(req); return send(res, 200, await saveOrder(b)); }
    return send(res, 404, { error: "Not found." });
  } catch (e) {
    const code = e.status && e.status < 500 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 502;
    console.error(e.message, e.data ? JSON.stringify(e.data).slice(0, 500) : "");
    return send(res, code, { error: e.status === 401 || e.status === 403 ? "GoHighLevel refused the key. Check GHL_TOKEN and its access in Render." : e.message });
  }
}).listen(PORT, () => console.log("field-routes-api on " + PORT));
