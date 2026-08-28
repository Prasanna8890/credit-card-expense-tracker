const $ = (s) => document.querySelector(s);
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const defaultCards = [
  { id: "card-1", name: "Card 1", last4: "", billingDay: 1, limit: 0, color: "#0f766e" },
  { id: "card-2", name: "Card 2", last4: "", billingDay: 1, limit: 0, color: "#2563eb" },
  { id: "card-3", name: "Card 3", last4: "", billingDay: 1, limit: 0, color: "#b45309" }
];
const state = { cards: [], transactions: [], editingId: null, deletingId: null, isSaving: false, showAll: false };

const apiUrl = window.TRACKER_CONFIG?.apiUrl?.trim();
function localKey(key) { return `cc-tracker-${key}`; }
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function escapeHtml(text = "") { return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function cardFor(id) { return state.cards.find(c => c.id === id); }
function formatCard(card) { return card ? `${card.name}${card.last4 ? ` • ${card.last4}` : ""}` : "Unknown card"; }
function showToast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.remove("show"), 2600); }
function setLoading(isLoading) { $("#refreshButton").disabled = isLoading; $("#refreshButton").textContent = isLoading ? "Refreshing…" : "Refresh"; }

async function request(action, payload = {}) {
  if (!apiUrl) throw new Error("Shared backend is not configured. Add your Apps Script URL in config.js.");
  const response = await fetch(apiUrl, { method: "POST", body: JSON.stringify({ action, ...payload }), headers: { "Content-Type": "text/plain;charset=utf-8" } });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "The shared ledger could not be updated.");
  return data;
}
async function loadData() {
  setLoading(true);
  try {
    if (apiUrl) {
      const data = await request("load"); state.cards = data.cards || defaultCards; state.transactions = data.transactions || [];
    } else {
      state.cards = JSON.parse(localStorage.getItem(localKey("cards"))) || defaultCards;
      state.transactions = JSON.parse(localStorage.getItem(localKey("transactions"))) || [];
    }
    render();
    if (!apiUrl) showToast("Demo mode: configure the shared backend before inviting others.");
  } catch (error) { showToast(error.message); }
  finally { setLoading(false); }
}
function persistDemo() { localStorage.setItem(localKey("cards"), JSON.stringify(state.cards)); localStorage.setItem(localKey("transactions"), JSON.stringify(state.transactions)); }
function sum(items) { return items.reduce((total, item) => total + Number(item.amount || 0), 0); }
function monthTransactions(date = new Date()) { const prefix = date.toISOString().slice(0, 7); return state.transactions.filter(t => t.date?.startsWith(prefix)); }
function cycleRange(card) {
  const now = new Date(); const day = Math.min(Math.max(Number(card.billingDay) || 1, 1), 28);
  let start = new Date(now.getFullYear(), now.getMonth(), day);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, day);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate() - 1);
  const previousStart = new Date(start.getFullYear(), start.getMonth() - 1, start.getDate());
  return { start, end, previousStart };
}
function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function cycleTransactions(card, previous = false) { const r = cycleRange(card); const start = previous ? r.previousStart : r.start; const end = previous ? new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate() - 1) : r.end; return state.transactions.filter(t => t.cardId === card.id && t.date >= iso(start) && t.date <= iso(end)); }
function render() { renderFilters(); renderDashboard(); renderTransactions(); }
function renderDashboard() {
  const current = monthTransactions(); const total = sum(state.transactions); const now = new Date();
  $("#monthTotal").textContent = money.format(sum(current)); $("#monthLabel").textContent = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
  $("#totalSpending").textContent = money.format(total); $("#currentMonthSpending").textContent = money.format(sum(current)); $("#transactionCount").textContent = state.transactions.length;
  $("#cardSummary").innerHTML = state.cards.map(card => { const spent = sum(current.filter(t => t.cardId === card.id)); const percent = card.limit ? Math.min(100, spent / card.limit * 100) : 0; return `<article class="card" style="--accent:${card.color}"><h3>${escapeHtml(card.name)}</h3><span class="card-meta">This calendar month${card.last4 ? ` · • ${escapeHtml(card.last4)}` : ""}</span><div class="amount">${money.format(spent)}</div><span class="card-meta">${card.limit ? `${money.format(card.limit)} limit` : "No spending limit set"}</span><div class="limit-bar"><i style="width:${percent}%"></i></div></article>`; }).join("");
  const categories = {}; current.forEach(t => { const name = t.category || "Uncategorised"; categories[name] = (categories[name] || 0) + Number(t.amount); });
  const entries = Object.entries(categories).sort((a,b) => b[1] - a[1]); $("#categorySummary").innerHTML = entries.length ? entries.slice(0, 6).map(([name, amount]) => `<div class="summary-row"><span>${escapeHtml(name)}</span><b>${money.format(amount)}</b></div>`).join("") : `<p class="empty">Categories will appear as you add expenses.</p>`;
  $("#billingSummary").innerHTML = state.cards.map(card => { const range = cycleRange(card); const spend = sum(cycleTransactions(card)); const previous = sum(cycleTransactions(card, true)); const remaining = card.limit ? card.limit - spend : null; return `<div class="billing-row"><div><b>${escapeHtml(card.name)}</b><br><span>${range.start.toLocaleDateString("en-IN",{day:"numeric",month:"short"})} – ${range.end.toLocaleDateString("en-IN",{day:"numeric",month:"short"})}</span></div><div class="transaction-side"><b>${money.format(spend)}</b><span>${card.limit ? `${money.format(Math.max(0,remaining))} left · ` : ""}Prev. ${money.format(previous)}</span></div></div>`; }).join("");
}
function renderFilters() {
  const card = $("#cardFilter"), currentCard = card.value; card.innerHTML = `<option value="">All cards</option>${state.cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}`; card.value = currentCard;
  const categories = [...new Set(state.transactions.map(t => t.category).filter(Boolean))].sort(); const category = $("#categoryFilter"), currentCategory = category.value; category.innerHTML = `<option value="">All categories</option>${categories.map(c => `<option>${escapeHtml(c)}</option>`).join("")}`; category.value = currentCategory;
}
function filteredTransactions() {
  const search = $("#searchInput").value.toLowerCase().trim(), card = $("#cardFilter").value, month = $("#monthFilter").value, category = $("#categoryFilter").value, sort = $("#sortFilter").value;
  const values = state.transactions.filter(t => (!card || t.cardId === card) && (!month || t.date?.startsWith(month)) && (!category || t.category === category) && (!search || [t.description,t.merchant,t.notes,t.category].join(" ").toLowerCase().includes(search)));
  return values.sort((a,b) => sort === "newest" ? `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`) : `${a.date}${a.createdAt}`.localeCompare(`${b.date}${b.createdAt}`));
}
function renderTransactions() { let rows = filteredTransactions(); if (!state.showAll && !$("#searchInput").value && !$("#cardFilter").value && !$("#monthFilter").value && !$("#categoryFilter").value) rows = rows.slice(0, 6); $("#showAllButton").textContent = state.showAll ? "Show recent" : "View all"; $("#transactionList").innerHTML = rows.length ? rows.map(t => { const c = cardFor(t.cardId); return `<article class="transaction"><div class="transaction-main"><strong>${escapeHtml(t.description)}</strong><span>${t.date ? new Date(`${t.date}T12:00:00`).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}) : "No date"} · ${escapeHtml(formatCard(c))}${t.merchant ? ` · ${escapeHtml(t.merchant)}` : ""}${t.isEmi ? " · EMI" : ""}</span></div><div class="transaction-side"><b>${money.format(t.amount)}</b><span>${escapeHtml(t.category || "Uncategorised")}</span></div><div class="transaction-actions"><button class="text-button" data-edit="${t.id}">Edit</button><button class="text-button" data-delete="${t.id}">Delete</button></div></article>`; }).join("") : `<p class="empty">No expenses match these filters.</p>`; }
function openExpense(id = null) { state.editingId = id; const t = state.transactions.find(x => x.id === id); $("#expenseDialogTitle").textContent = t ? "Edit expense" : "Add expense"; $("#expenseDialogEyebrow").textContent = t ? "UPDATE EXPENSE" : "NEW EXPENSE"; $("#saveExpenseButton").textContent = t ? "Save changes" : "Save expense"; $("#formError").textContent = ""; $("#expenseId").value = t?.id || ""; $("#amount").value = t?.amount || ""; $("#description").value = t?.description || ""; $("#expenseDate").value = t?.date || today(); $("#category").value = t?.category || ""; $("#merchant").value = t?.merchant || ""; $("#notes").value = t?.notes || ""; $("#isEmi").checked = !!t?.isEmi; const lastCard = localStorage.getItem(localKey("last-card")); $("#cardId").innerHTML = state.cards.map(c => `<option value="${c.id}">${escapeHtml(formatCard(c))}</option>`).join(""); $("#cardId").value = t?.cardId || lastCard || state.cards[0]?.id; $("#expenseDialog").showModal(); setTimeout(() => $("#amount").focus(), 50); }
async function saveExpense(event) { event.preventDefault(); if (state.isSaving) return; const raw = { id: $("#expenseId").value || makeId(), amount: Number($("#amount").value), description: $("#description").value.trim(), cardId: $("#cardId").value, date: $("#expenseDate").value, category: $("#category").value.trim(), merchant: $("#merchant").value.trim(), notes: $("#notes").value.trim(), isEmi: $("#isEmi").checked, createdAt: new Date().toISOString() }; if (!(raw.amount > 0) || !raw.description || !raw.cardId || !raw.date) { $("#formError").textContent = "Enter a positive amount, description, card, and date."; return; } state.isSaving = true; $("#saveExpenseButton").disabled = true; try { if (apiUrl) { const result = await request(state.editingId ? "updateTransaction" : "addTransaction", { transaction: raw }); state.transactions = result.transactions; } else { const index = state.transactions.findIndex(t => t.id === raw.id); if (index >= 0) raw.createdAt = state.transactions[index].createdAt, state.transactions[index] = raw; else state.transactions.push(raw); persistDemo(); } localStorage.setItem(localKey("last-card"), raw.cardId); $("#expenseDialog").close(); render(); showToast(state.editingId ? "Expense updated." : "Expense saved."); } catch (error) { $("#formError").textContent = error.message; } finally { state.isSaving = false; $("#saveExpenseButton").disabled = false; } }
function openCards() { $("#cardSettings").innerHTML = state.cards.map((c,i) => `<section class="card-settings"><h3>Card ${i+1}</h3><div class="form-row"><label>Name<input data-card="${c.id}" data-field="name" maxlength="40" value="${escapeHtml(c.name)}" required></label><label>Last 4 digits<input data-card="${c.id}" data-field="last4" inputmode="numeric" maxlength="4" value="${escapeHtml(c.last4 || "")}" placeholder="Optional"></label></div><div class="form-row"><label>Billing-cycle date<input data-card="${c.id}" data-field="billingDay" type="number" min="1" max="28" value="${c.billingDay || 1}"></label><label>Monthly spending limit<input data-card="${c.id}" data-field="limit" type="number" min="0" step="1" value="${c.limit || ""}" placeholder="Optional"></label></div></section>`).join(""); $("#cardsDialog").showModal(); }
async function saveCards(event) { event.preventDefault(); const next = state.cards.map(c => ({...c})); document.querySelectorAll("#cardSettings input").forEach(input => { const c = next.find(x => x.id === input.dataset.card); let value = input.value.trim(); if (input.dataset.field === "billingDay") value = Math.min(28,Math.max(1,Number(value)||1)); if (input.dataset.field === "limit") value = Math.max(0,Number(value)||0); c[input.dataset.field] = value; }); if (next.some(c => !c.name)) { $("#cardFormError").textContent = "Each card needs a name."; return; } try { if (apiUrl) { const data = await request("saveCards", { cards: next }); state.cards = data.cards; } else { state.cards = next; persistDemo(); } $("#cardsDialog").close(); render(); showToast("Card settings saved."); } catch (error) { $("#cardFormError").textContent = error.message; } }
async function deleteExpense() { const id = state.deletingId; if (!id) return; try { if (apiUrl) { const data = await request("deleteTransaction", { id }); state.transactions = data.transactions; } else { state.transactions = state.transactions.filter(t => t.id !== id); persistDemo(); } $("#confirmDialog").close(); render(); showToast("Expense deleted."); } catch (error) { showToast(error.message); } finally { state.deletingId = null; } }
function exportCsv() { const head = ["Date","Time","Card","Amount","Merchant","Description","Category","Notes","Transaction ID"]; const rows = state.transactions.map(t => [t.date, t.createdAt ? new Date(t.createdAt).toLocaleTimeString("en-IN") : "", formatCard(cardFor(t.cardId)), t.amount, t.merchant, t.description, t.category, t.notes, t.id]); const csv = [head,...rows].map(r => r.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n"); const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download=`credit-card-expenses-${today()}.csv`;a.click();URL.revokeObjectURL(a.href); }
$("#openAddButton").onclick = () => openExpense(); $("#expenseForm").addEventListener("submit",saveExpense); $("#openCardsButton").onclick=openCards; $("#cardsForm").addEventListener("submit",saveCards); $("#refreshButton").onclick=loadData; $("#exportButton").onclick=exportCsv; $("#showAllButton").onclick=()=>{state.showAll=!state.showAll;renderTransactions();}; $("#confirmDelete").onclick=deleteExpense; $("#cancelDelete").onclick=()=>$("#confirmDialog").close(); document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$("#"+b.dataset.close).close()); $("#filters").addEventListener("input",renderTransactions); $("#filters").addEventListener("change",renderTransactions); $("#transactionList").onclick=e=>{const id=e.target.dataset.edit||e.target.dataset.delete;if(!id)return;if(e.target.dataset.edit)openExpense(id);else{state.deletingId=id;$("#confirmDialog").showModal();}}; loadData();
