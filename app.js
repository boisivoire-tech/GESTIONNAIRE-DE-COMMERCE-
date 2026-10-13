const PAGE_META = {
  dashboard: ['Tableau de bord', 'Les chiffres clés de votre commerce.'],
  sales: ['Ventes', 'Consultez l’activité et le détail de vos ventes.'],
  products: ['Produits & stock', 'Gérez votre catalogue, vos prix et vos niveaux de stock.'],
  customers: ['Clients', 'Retrouvez les coordonnées et l’historique de vos clients.']
};

const state = {
  view: 'dashboard',
  month: new Date().toISOString().slice(0, 7),
  storeName: 'Ma boutique',
  currency: 'EUR',
  products: [],
  customers: [],
  sales: [],
  productSearch: '',
  productCategory: 'all',
  salesSearch: '',
  salesFilter: 'all',
  customerSearch: ''
};

const pageContent = document.getElementById('page-content');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalContent = document.getElementById('modal-content');
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function money(amount) {
  const number = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency', currency: state.currency,
      maximumFractionDigits: state.currency === 'XOF' ? 0 : 2
    }).format(number);
  } catch {
    return `${number.toFixed(2)} ${state.currency}`;
  }
}

function shortDate(value) {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value || '—';
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
}

function monthLabel(value = state.month) {
  const parsed = new Date(`${value}-01T12:00:00`);
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(parsed);
}

function activeProducts() { return state.products.filter((product) => product.active !== false); }
function activeCustomers() { return state.customers.filter((customer) => customer.active !== false); }
function monthSales() {
  return state.sales.filter((sale) => sale.status !== 'cancelled' && String(sale.date || '').startsWith(state.month));
}
function totalSales(sales) { return sales.reduce((total, sale) => total + Number(sale.total || 0), 0); }
function salesMargin(sales) {
  return sales.reduce((total, sale) => total + (sale.items || []).reduce((subtotal, item) => subtotal + (Number(item.unit_price) - Number(item.unit_cost || 0)) * Number(item.quantity || 0), 0), 0);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': document.querySelector('meta[name="csrf-token"]')?.content || '',
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(result.error || 'Une erreur est survenue.');
  return result;
}

async function refreshData() {
  const data = await api('/api/data');
  state.storeName = data.store_name || 'Ma boutique';
  state.currency = data.currency || 'EUR';
  state.products = Array.isArray(data.products) ? data.products : [];
  state.customers = Array.isArray(data.customers) ? data.customers : [];
  state.sales = Array.isArray(data.sales) ? data.sales : [];
  document.getElementById('brand-title').textContent = state.storeName;
  document.title = `${state.storeName} — Gestion de commerce`;
  document.getElementById('month-picker').value = state.month;
  document.getElementById('record-count').textContent = `${activeProducts().length} produit${activeProducts().length === 1 ? '' : 's'} · ${activeCustomers().length} client${activeCustomers().length === 1 ? '' : 's'} · ${state.sales.length} vente${state.sales.length === 1 ? '' : 's'}`;
  render();
}

function render() {
  const [title, subtitle] = PAGE_META[state.view];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  if (state.view === 'dashboard') pageContent.innerHTML = renderDashboard();
  if (state.view === 'sales') pageContent.innerHTML = renderSales();
  if (state.view === 'products') pageContent.innerHTML = renderProducts();
  if (state.view === 'customers') pageContent.innerHTML = renderCustomers();
}

function statCard(label, amount, caption, icon, tone = '') {
  return `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon ${tone}">${icon}</span></div><div class="stat-value">${amount}</div><div class="stat-caption">${caption}</div></article>`;
}

function icon(name) {
  const icons = {
    revenue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    margin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 17 5-5 3 3 6-8"/><path d="M14 7h5v5"/></svg>',
    stock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9L12 3Z"/><path d="m3.8 7.7 8.2 4.5 8.2-4.5M12 12.2V21"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>'
  };
  return icons[name] || '';
}

function getMonthShift(month, shift) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + shift, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function renderDashboard() {
  const sales = monthSales();
  const revenue = totalSales(sales);
  const margin = salesMargin(sales);
  const stockCost = activeProducts().reduce((total, product) => total + Number(product.stock || 0) * Number(product.cost || 0), 0);
  const alerts = activeProducts().filter((product) => Number(product.stock || 0) <= Number(product.low_stock ?? 3));
  const chartMonths = Array.from({ length: 6 }, (_, index) => getMonthShift(state.month, index - 5));
  const chartRows = chartMonths.map((month) => {
    const monthTotal = totalSales(state.sales.filter((sale) => sale.status !== 'cancelled' && String(sale.date || '').startsWith(month)));
    const label = new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(new Date(`${month}-01T12:00:00`));
    return { month, label: label.replace('.', ''), total: monthTotal };
  });
  const chartMax = Math.max(...chartRows.map((row) => row.total), 1);
  const recent = [...state.sales].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const bars = chartRows.map((row) => `<div class="bar-row"><span class="bar-label">${escapeHtml(row.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(row.total ? 3 : 0, Math.round(row.total / chartMax * 100))}%"></div></div><span class="bar-amount">${money(row.total)}</span></div>`).join('');
  const stockWarnings = alerts.slice(0, 5).map((product) => `<div class="stock-alert"><span class="stock-alert-icon">!</span><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category || 'Sans catégorie')}</span></div><span class="stock-qty">${Number(product.stock || 0)} en stock</span></div>`).join('');
  return `<div class="stats-grid">
      ${statCard('Chiffre d’affaires', money(revenue), `${sales.length} vente${sales.length === 1 ? '' : 's'} · ${escapeHtml(monthLabel())}`, icon('revenue'))}
      ${statCard('Marge brute estimée', money(margin), 'Après coût des produits vendus', icon('margin'))}
      ${statCard('Valeur du stock', money(stockCost), `${activeProducts().length} référence${activeProducts().length === 1 ? '' : 's'} active${activeProducts().length === 1 ? '' : 's'}`, icon('stock'), 'neutral')}
      ${statCard('Stock à surveiller', String(alerts.length), alerts.length ? '<span class="alert">Produits sous le seuil minimum</span>' : 'Tous les produits sont au-dessus du seuil', icon('alert'), 'orange')}
    </div>
    <div class="content-grid">
      <section class="panel"><div class="panel-header"><div><h2>Ventes récentes</h2><p>Évolution sur les six derniers mois, jusqu’à ${escapeHtml(monthLabel())}</p></div></div>
        ${state.sales.length ? `<div class="sales-bars">${bars}</div>` : `<div class="empty-state"><div><strong>Votre activité apparaîtra ici</strong>Enregistrez une vente pour commencer à suivre votre chiffre d’affaires.</div></div>`}
      </section>
      <section class="panel"><div class="panel-header"><div><h2>Alertes de stock</h2><p>${alerts.length} produit${alerts.length === 1 ? '' : 's'} au seuil ou en dessous</p></div><button class="text-link" data-go="products">Gérer le stock</button></div>
        ${stockWarnings ? `<div class="stock-alert-list">${stockWarnings}</div>${alerts.length > 5 ? `<p class="toolbar-summary">Et ${alerts.length - 5} autre${alerts.length - 5 > 1 ? 's' : ''}…</p>` : ''}` : `<div class="empty-state"><div><strong>Tout est en ordre</strong>Aucun produit n’est sous son seuil de stock.</div></div>`}
      </section>
    </div>
    <section class="panel recent-panel"><div class="panel-header"><div><h2>Dernières ventes</h2><p>Les opérations les plus récentes</p></div><button class="text-link" data-go="sales">Voir toutes les ventes</button></div>
      ${recent.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Référence</th><th>Date</th><th>Client</th><th>Articles</th><th class="align-right">Total</th><th>État</th></tr></thead><tbody>${recent.map(saleTableRow).join('')}</tbody></table></div>` : `<div class="empty-state"><div><strong>Aucune vente enregistrée</strong>Créez une vente dès que vous avez ajouté vos produits.</div></div>`}
    </section>`;
}

function saleTableRow(sale) {
  const units = (sale.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0);
  const cancelled = sale.status === 'cancelled';
  return `<tr><td><button class="text-link" data-sale="${escapeHtml(sale.id)}">${escapeHtml(sale.number || 'Vente')}</button></td><td>${escapeHtml(shortDate(sale.date))}</td><td>${escapeHtml(sale.customer_name || 'Client de passage')}</td><td>${units} article${units === 1 ? '' : 's'}</td><td class="align-right sale-total">${money(sale.total)}</td><td><span class="pill ${cancelled ? 'cancelled' : ''}">${cancelled ? 'Annulée' : 'Payée'}</span></td></tr>`;
}

function renderSales() {
  const rows = state.sales.filter((sale) => {
    const matchesMonth = String(sale.date || '').startsWith(state.month);
    const matchesStatus = state.salesFilter === 'all' || (state.salesFilter === 'completed' ? sale.status !== 'cancelled' : sale.status === 'cancelled');
    const text = `${sale.number || ''} ${sale.customer_name || ''} ${(sale.items || []).map((item) => item.name).join(' ')}`.toLocaleLowerCase('fr');
    return matchesMonth && matchesStatus && text.includes(state.salesSearch.toLocaleLowerCase('fr'));
  }).sort((a, b) => b.date.localeCompare(a.date));
  return `<section class="panel"><div class="panel-header"><div><h2>Historique des ventes</h2><p>${rows.length} résultat${rows.length === 1 ? '' : 's'} · ${escapeHtml(monthLabel())}</p></div><button class="button button-primary" id="new-sale-inline">Nouvelle vente</button></div>
    <div class="transaction-toolbar"><label class="search-control"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg><input id="sales-search" type="search" placeholder="Rechercher une vente, un client ou un produit…" value="${escapeHtml(state.salesSearch)}" aria-label="Rechercher une vente"></label>
      <label class="filter-control"><span class="sr-only">Filtrer par état</span><select id="sales-filter"><option value="all" ${state.salesFilter === 'all' ? 'selected' : ''}>Tous les états</option><option value="completed" ${state.salesFilter === 'completed' ? 'selected' : ''}>Payées</option><option value="cancelled" ${state.salesFilter === 'cancelled' ? 'selected' : ''}>Annulées</option></select></label></div>
    <p class="toolbar-summary">Total des ventes payées du mois : <strong>${money(totalSales(monthSales()))}</strong></p>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Référence</th><th>Date</th><th>Client</th><th>Articles</th><th class="align-right">Total</th><th>État</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${rows.length ? rows.map((sale) => {
        const cancelled = sale.status === 'cancelled';
        const units = (sale.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0);
        return `<tr><td><button class="text-link" data-sale="${escapeHtml(sale.id)}">${escapeHtml(sale.number || 'Vente')}</button></td><td>${escapeHtml(shortDate(sale.date))}</td><td>${escapeHtml(sale.customer_name || 'Client de passage')}</td><td>${units}</td><td class="align-right sale-total">${money(sale.total)}</td><td><span class="pill ${cancelled ? 'cancelled' : ''}">${cancelled ? 'Annulée' : 'Payée'}</span></td><td><div class="table-actions"><button class="icon-button" data-sale="${escapeHtml(sale.id)}" title="Voir le reçu" aria-label="Voir le reçu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5v-12Z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8M8 10.5h8"/></svg></button>${cancelled ? '' : `<button class="icon-button delete" data-cancel-sale="${escapeHtml(sale.id)}" title="Annuler et remettre en stock" aria-label="Annuler la vente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.8 13h8.4L17 7M10 10.5v6M14 10.5v6"/></svg></button>`}</div></td></tr>`;
      }).join('') : `<tr><td colspan="7" class="table-empty">Aucune vente pour ce mois ou cette recherche.</td></tr>`}
    </tbody></table></div>
  </section>`;
}

function renderProducts() {
  const products = activeProducts();
  const categories = [...new Set(products.map((product) => product.category || 'Général'))].sort((a, b) => a.localeCompare(b, 'fr'));
  const filtered = products.filter((product) => {
    const text = `${product.name} ${product.sku || ''} ${product.category || ''}`.toLocaleLowerCase('fr');
    return text.includes(state.productSearch.toLocaleLowerCase('fr')) && (state.productCategory === 'all' || product.category === state.productCategory);
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const totalValue = products.reduce((total, product) => total + Number(product.stock || 0) * Number(product.cost || 0), 0);
  return `<section class="panel"><div class="panel-header"><div><h2>Catalogue & niveau de stock</h2><p>${products.length} produit${products.length === 1 ? '' : 's'} actif${products.length === 1 ? '' : 's'} · Valeur d’achat du stock : ${money(totalValue)}</p></div><button class="button button-primary" id="add-product"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Ajouter un produit</button></div>
    <div class="transaction-toolbar"><label class="search-control"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg><input id="product-search" type="search" placeholder="Rechercher un produit ou une référence…" value="${escapeHtml(state.productSearch)}" aria-label="Rechercher un produit"></label>
      <label class="filter-control"><span class="sr-only">Filtrer par catégorie</span><select id="product-category-filter"><option value="all">Toutes les catégories</option>${categories.map((category) => `<option value="${escapeHtml(category)}" ${state.productCategory === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Produit</th><th>Catégorie</th><th>Stock</th><th>Seuil</th><th>Prix de vente</th><th>Coût d’achat</th><th>Marge unitaire</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${filtered.length ? filtered.map((product) => {
        const stock = Number(product.stock || 0), threshold = Number(product.low_stock ?? 3), low = stock <= threshold;
        const margin = Number(product.price || 0) - Number(product.cost || 0);
        const initial = (product.name || '?').trim().charAt(0).toLocaleUpperCase('fr');
        return `<tr><td><div class="product-name-cell"><span class="product-thumb">${escapeHtml(initial)}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku || 'Sans référence')}</small></span></div></td><td>${escapeHtml(product.category || 'Général')}</td><td><span class="pill ${low ? 'warn' : ''}">${stock} en stock</span></td><td>${threshold}</td><td>${money(product.price)}</td><td>${money(product.cost)}</td><td>${money(margin)}</td><td><div class="table-actions"><button class="icon-button" data-edit-product="${escapeHtml(product.id)}" title="Modifier" aria-label="Modifier le produit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z"/></svg></button><button class="icon-button delete" data-archive-product="${escapeHtml(product.id)}" title="Archiver" aria-label="Archiver le produit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/></svg></button></div></td></tr>`;
      }).join('') : `<tr><td colspan="8" class="table-empty">${products.length ? 'Aucun produit ne correspond à cette recherche.' : 'Aucun produit dans votre catalogue. Ajoutez votre première référence.'}</td></tr>`}
    </tbody></table></div>
  </section>`;
}

function renderCustomers() {
  const customers = activeCustomers();
  const filtered = customers.filter((customer) => `${customer.name} ${customer.phone || ''} ${customer.email || ''}`.toLocaleLowerCase('fr').includes(state.customerSearch.toLocaleLowerCase('fr'))).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const rows = filtered.map((customer) => {
    const sales = state.sales.filter((sale) => sale.status !== 'cancelled' && sale.customer_id === customer.id);
    const spent = totalSales(sales);
    const lastDate = sales.sort((a, b) => b.date.localeCompare(a.date))[0]?.date;
    return `<tr><td><div class="product-name-cell"><span class="product-thumb">${escapeHtml((customer.name || '?').trim().charAt(0).toLocaleUpperCase('fr'))}</span><span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.note || 'Client')}</small></span></div></td><td>${escapeHtml(customer.phone || '—')}</td><td>${escapeHtml(customer.email || '—')}</td><td>${sales.length}</td><td>${money(spent)}</td><td>${escapeHtml(lastDate ? shortDate(lastDate) : '—')}</td><td><div class="table-actions"><button class="icon-button" data-edit-customer="${escapeHtml(customer.id)}" title="Modifier" aria-label="Modifier le client"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z"/></svg></button><button class="icon-button delete" data-archive-customer="${escapeHtml(customer.id)}" title="Archiver" aria-label="Archiver le client"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/></svg></button></div></td></tr>`;
  }).join('');
  return `<section class="panel"><div class="panel-header"><div><h2>Fichier clients</h2><p>${customers.length} client${customers.length === 1 ? '' : 's'} enregistré${customers.length === 1 ? '' : 's'}</p></div><button class="button button-primary" id="add-customer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Ajouter un client</button></div>
    <div class="transaction-toolbar"><label class="search-control"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg><input id="customer-search" type="search" placeholder="Rechercher un client…" value="${escapeHtml(state.customerSearch)}" aria-label="Rechercher un client"></label></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Client</th><th>Téléphone</th><th>Courriel</th><th>Ventes</th><th>Achats cumulés</th><th>Dernier achat</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="table-empty">${customers.length ? 'Aucun client ne correspond à la recherche.' : 'Aucun client enregistré. Vous pourrez en ajouter lors d’une vente.'}</td></tr>`}</tbody></table></div>
  </section>`;
}

function showToast(message, error = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3100);
}

function showModal(content, wide = false) {
  modalContent.innerHTML = content;
  document.querySelector('.modal').classList.toggle('wide', wide);
  modalBackdrop.hidden = false;
  modalContent.querySelector('input, select, textarea')?.focus();
}

function closeModal() { modalBackdrop.hidden = true; modalContent.innerHTML = ''; }

function openProductModal(product = null) {
  const editing = Boolean(product);
  showModal(`<div class="modal-head"><div><h2 id="modal-title">${editing ? 'Modifier le produit' : 'Ajouter un produit'}</h2><p>Renseignez les informations de cette référence.</p></div><button class="modal-close" type="button" data-close-modal aria-label="Fermer">×</button></div>
    <form class="modal-form" id="product-form" data-id="${escapeHtml(product?.id || '')}">
      <label class="form-field">Nom du produit<input name="name" maxlength="80" value="${escapeHtml(product?.name || '')}" placeholder="Ex. Bougie artisanale" required></label>
      <div class="form-row"><label class="form-field">Référence / SKU<input name="sku" maxlength="40" value="${escapeHtml(product?.sku || '')}" placeholder="Ex. BOU-001"></label><label class="form-field">Catégorie<input name="category" maxlength="50" value="${escapeHtml(product?.category || '')}" placeholder="Ex. Décoration"></label></div>
      <div class="form-row"><label class="form-field">Quantité en stock<input name="stock" type="number" min="0" step="1" value="${escapeHtml(product?.stock ?? 0)}" required></label><label class="form-field">Alerte de stock à<input name="low_stock" type="number" min="0" step="1" value="${escapeHtml(product?.low_stock ?? 3)}" required></label></div>
      <div class="form-row"><label class="form-field">Prix de vente (${escapeHtml(state.currency)})<input name="price" type="number" min="0" step="0.01" value="${escapeHtml(product?.price ?? '')}" placeholder="0,00" required></label><label class="form-field">Coût d’achat (${escapeHtml(state.currency)})<input name="cost" type="number" min="0" step="0.01" value="${escapeHtml(product?.cost ?? '')}" placeholder="0,00" required></label></div>
      <p class="form-error" id="form-error"></p><div class="form-actions"><button class="button button-quiet" type="button" data-close-modal>Annuler</button><button class="button button-primary" type="submit">${editing ? 'Enregistrer' : 'Ajouter le produit'}</button></div>
    </form>`);
}

function openCustomerModal(customer = null) {
  const editing = Boolean(customer);
  showModal(`<div class="modal-head"><div><h2 id="modal-title">${editing ? 'Modifier le client' : 'Ajouter un client'}</h2><p>Enregistrez les coordonnées utiles à votre commerce.</p></div><button class="modal-close" type="button" data-close-modal aria-label="Fermer">×</button></div>
    <form class="modal-form" id="customer-form" data-id="${escapeHtml(customer?.id || '')}">
      <label class="form-field">Nom du client<input name="name" maxlength="80" value="${escapeHtml(customer?.name || '')}" placeholder="Prénom et nom" required></label>
      <div class="form-row"><label class="form-field">Téléphone<input name="phone" maxlength="40" value="${escapeHtml(customer?.phone || '')}" placeholder="Facultatif"></label><label class="form-field">Courriel<input name="email" type="email" maxlength="120" value="${escapeHtml(customer?.email || '')}" placeholder="Facultatif"></label></div>
      <label class="form-field">Note<input name="note" maxlength="160" value="${escapeHtml(customer?.note || '')}" placeholder="Ex. Préfère être contacté par SMS"></label>
      <p class="form-error" id="form-error"></p><div class="form-actions"><button class="button button-quiet" type="button" data-close-modal>Annuler</button><button class="button button-primary" type="submit">${editing ? 'Enregistrer' : 'Ajouter le client'}</button></div>
    </form>`);
}

function openSettingsModal() {
  showModal(`<div class="modal-head"><div><h2 id="modal-title">Paramètres du commerce</h2><p>Personnalisez le nom et la devise d’affichage.</p></div><button class="modal-close" type="button" data-close-modal aria-label="Fermer">×</button></div>
    <form class="modal-form" id="settings-form">
      <label class="form-field">Nom du commerce<input name="store_name" maxlength="60" value="${escapeHtml(state.storeName)}" required></label>
      <label class="form-field">Devise<select name="currency"><option value="EUR" ${state.currency === 'EUR' ? 'selected' : ''}>Euro — EUR €</option><option value="USD" ${state.currency === 'USD' ? 'selected' : ''}>Dollar américain — USD $</option><option value="CAD" ${state.currency === 'CAD' ? 'selected' : ''}>Dollar canadien — CAD $</option><option value="CHF" ${state.currency === 'CHF' ? 'selected' : ''}>Franc suisse — CHF</option><option value="XOF" ${state.currency === 'XOF' ? 'selected' : ''}>Franc CFA — XOF</option></select></label>
      <p class="form-hint">Changer la devise modifie l’affichage des montants. Cela ne convertit pas les valeurs déjà saisies.</p>
      <p class="form-error" id="form-error"></p><div class="form-actions"><button class="button button-quiet" type="button" data-close-modal>Annuler</button><button class="button button-primary" type="submit">Enregistrer</button></div>
    </form>`);
}

function productOptions(selected = '') {
  const options = activeProducts().filter((product) => Number(product.stock || 0) > 0);
  return `<option value="">Choisir un produit…</option>${options.map((product) => `<option value="${escapeHtml(product.id)}" data-price="${Number(product.price || 0)}" data-stock="${Number(product.stock || 0)}" ${product.id === selected ? 'selected' : ''}>${escapeHtml(product.name)} · ${money(product.price)} · stock ${Number(product.stock || 0)}</option>`).join('')}`;
}

function saleItemRow() {
  return `<div class="sale-item-row"><label class="form-field">Produit<select name="product_id" required>${productOptions()}</select></label><label class="form-field">Quantité<input name="quantity" type="number" min="1" step="1" value="1" required></label><button class="sale-item-remove" type="button" data-remove-sale-row aria-label="Retirer cette ligne">×</button></div>`;
}

function openSaleModal() {
  const products = activeProducts().filter((product) => Number(product.stock || 0) > 0);
  if (!products.length) {
    showModal(`<div class="modal-head"><div><h2 id="modal-title">Nouvelle vente</h2><p>Le catalogue n’est pas encore prêt.</p></div><button class="modal-close" type="button" data-close-modal aria-label="Fermer">×</button></div><div class="modal-form"><div class="empty-state"><div><strong>Aucun produit disponible</strong>Ajoutez un produit et sa quantité en stock pour enregistrer une vente.</div></div><div class="form-actions"><button class="button button-quiet" type="button" data-close-modal>Fermer</button><button class="button button-primary" type="button" data-open-products>Ajouter un produit</button></div></div>`);
    return;
  }
  const customers = activeCustomers();
  const customerOptions = `<option value="">Client de passage</option>${customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`).join('')}`;
  showModal(`<div class="modal-head"><div><h2 id="modal-title">Nouvelle vente</h2><p>Le stock sera mis à jour automatiquement.</p></div><button class="modal-close" type="button" data-close-modal aria-label="Fermer">×</button></div>
    <form class="modal-form" id="sale-form"><label class="form-field">Client<select name="customer_id">${customerOptions}</select></label>
      <div class="panel-header"><div><h2>Articles vendus</h2><p>Le prix vient du catalogue.</p></div><button class="button button-quiet" type="button" id="add-sale-row">Ajouter une ligne</button></div>
      <div class="sale-items" id="sale-items">${saleItemRow()}</div><div class="sale-total-box"><span>Total de la vente</span><strong id="sale-total-preview">${money(0)}</strong></div>
      <p class="form-error" id="form-error"></p><div class="form-actions"><button class="button button-quiet" type="button" data-close-modal>Annuler</button><button class="button button-primary" type="submit">Enregistrer la vente</button></div></form>`, true);
  updateSaleTotal();
}

function updateSaleTotal() {
  const rows = [...modalContent.querySelectorAll('.sale-item-row')];
  let total = 0;
  rows.forEach((row) => {
    const select = row.querySelector('[name="product_id"]');
    const option = select?.selectedOptions[0];
    const price = Number(option?.dataset.price || 0);
    const stock = Number(option?.dataset.stock || 0);
    const quantity = Number(row.querySelector('[name="quantity"]')?.value || 0);
    total += price * Math.min(quantity, stock || quantity);
    const input = row.querySelector('[name="quantity"]');
    if (input && stock) input.max = stock;
  });
  const preview = document.getElementById('sale-total-preview');
  if (preview) preview.textContent = money(total);
}

function openSaleDetail(sale) {
  const itemLines = (sale.items || []).map((item) => `<div class="detail-line"><span>${escapeHtml(item.name)} × ${Number(item.quantity || 0)}</span><strong>${money(Number(item.unit_price || 0) * Number(item.quantity || 0))}</strong></div>`).join('');
  const cancelled = sale.status === 'cancelled';
  showModal(`<div class="modal-head"><div><div class="eyebrow">${escapeHtml(state.storeName)}</div><h2 id="modal-title">Reçu ${escapeHtml(sale.number || '')}</h2><p>${escapeHtml(shortDate(sale.date))} · ${escapeHtml(sale.customer_name || 'Client de passage')}</p></div><button class="modal-close no-print" type="button" data-close-modal aria-label="Fermer">×</button></div>
    <div class="sale-detail-lines">${itemLines}<div class="detail-line total"><span>Total</span><strong>${money(sale.total)}</strong></div>${cancelled ? '<p class="form-hint">Cette vente a été annulée et le stock a été remis à jour.</p>' : ''}</div>
    <div class="detail-actions no-print"><button class="button button-quiet" type="button" data-print-sale>Imprimer le reçu</button></div>`);
}

async function archiveRecord(kind, id) {
  const label = kind === 'products' ? 'ce produit' : 'ce client';
  if (!window.confirm(`Archiver ${label} ? L’historique des ventes sera conservé.`)) return;
  try {
    await api(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshData();
    showToast(kind === 'products' ? 'Produit archivé.' : 'Client archivé.');
  } catch (error) { showToast(error.message, true); }
}

async function cancelSale(id) {
  if (!window.confirm('Annuler cette vente et remettre les articles en stock ?')) return;
  try {
    await api(`/api/sales/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
    await refreshData();
    showToast('Vente annulée, stock remis à jour.');
  } catch (error) { showToast(error.message, true); }
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) { state.view = nav.dataset.view; render(); return; }
  const go = event.target.closest('[data-go]');
  if (go) { state.view = go.dataset.go; render(); return; }
  if (event.target.closest('#new-sale') || event.target.closest('#new-sale-inline')) { openSaleModal(); return; }
  if (event.target.closest('#add-product')) { openProductModal(); return; }
  if (event.target.closest('#add-customer')) { openCustomerModal(); return; }
  if (event.target.closest('#open-settings')) { openSettingsModal(); return; }
  if (event.target.closest('#restore-backup')) { document.getElementById('backup-file').click(); return; }
  if (event.target.closest('#logout')) {
    fetch('/logout', { method: 'POST', headers: { 'X-CSRFToken': document.querySelector('meta[name="csrf-token"]')?.content || '' } })
      .then(() => { window.location.href = '/login'; });
    return;
  }
  if (event.target.closest('#add-sale-row')) { document.getElementById('sale-items')?.insertAdjacentHTML('beforeend', saleItemRow()); updateSaleTotal(); return; }
  if (event.target.closest('[data-remove-sale-row]')) {
    const rows = modalContent.querySelectorAll('.sale-item-row');
    if (rows.length > 1) event.target.closest('.sale-item-row').remove();
    updateSaleTotal(); return;
  }
  if (event.target.closest('[data-open-products]')) { closeModal(); state.view = 'products'; render(); openProductModal(); return; }
  const editProduct = event.target.closest('[data-edit-product]');
  if (editProduct) { openProductModal(state.products.find((product) => product.id === editProduct.dataset.editProduct)); return; }
  const archiveProduct = event.target.closest('[data-archive-product]');
  if (archiveProduct) { archiveRecord('products', archiveProduct.dataset.archiveProduct); return; }
  const editCustomer = event.target.closest('[data-edit-customer]');
  if (editCustomer) { openCustomerModal(state.customers.find((customer) => customer.id === editCustomer.dataset.editCustomer)); return; }
  const archiveCustomer = event.target.closest('[data-archive-customer]');
  if (archiveCustomer) { archiveRecord('customers', archiveCustomer.dataset.archiveCustomer); return; }
  const saleButton = event.target.closest('[data-sale]');
  if (saleButton) { openSaleDetail(state.sales.find((sale) => sale.id === saleButton.dataset.sale)); return; }
  const cancelButton = event.target.closest('[data-cancel-sale]');
  if (cancelButton) { cancelSale(cancelButton.dataset.cancelSale); return; }
  if (event.target.closest('[data-print-sale]')) {
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 800);
    return;
  }
  if (event.target.closest('[data-close-modal]') || event.target === modalBackdrop) closeModal();
});

modalContent.addEventListener('input', (event) => {
  if (event.target.closest('#sale-form')) updateSaleTotal();
});
modalContent.addEventListener('change', (event) => {
  if (event.target.closest('#sale-form')) updateSaleTotal();
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!['product-form', 'customer-form', 'sale-form', 'settings-form'].includes(form.id)) return;
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === 'product-form') {
      if (form.dataset.id) payload.id = form.dataset.id;
      await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
      closeModal(); await refreshData(); showToast(form.dataset.id ? 'Produit mis à jour.' : 'Produit ajouté.');
    }
    if (form.id === 'customer-form') {
      if (form.dataset.id) payload.id = form.dataset.id;
      await api('/api/customers', { method: 'POST', body: JSON.stringify(payload) });
      closeModal(); await refreshData(); showToast(form.dataset.id ? 'Client mis à jour.' : 'Client ajouté.');
    }
    if (form.id === 'sale-form') {
      payload.items = [...form.querySelectorAll('.sale-item-row')].map((row) => ({
        product_id: row.querySelector('[name="product_id"]').value,
        quantity: row.querySelector('[name="quantity"]').value
      })).filter((item) => item.product_id);
      const result = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
      closeModal(); await refreshData(); showToast(`Vente ${result.sale.number} enregistrée.`);
      openSaleDetail(result.sale);
    }
    if (form.id === 'settings-form') {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      closeModal(); await refreshData(); showToast('Paramètres enregistrés.');
    }
  } catch (error) {
    const message = document.getElementById('form-error');
    if (message) message.textContent = error.message;
    else showToast(error.message, true);
  }
});

document.getElementById('month-picker').addEventListener('change', (event) => {
  if (event.target.value) { state.month = event.target.value; render(); }
});

pageContent.addEventListener('input', (event) => {
  const id = event.target.id;
  if (id === 'product-search') {
    state.productSearch = event.target.value; const caret = event.target.selectionStart; pageContent.innerHTML = renderProducts();
    const replacement = document.getElementById('product-search'); replacement.focus(); replacement.setSelectionRange(caret, caret);
  } else if (id === 'sales-search') {
    state.salesSearch = event.target.value; const caret = event.target.selectionStart; pageContent.innerHTML = renderSales();
    const replacement = document.getElementById('sales-search'); replacement.focus(); replacement.setSelectionRange(caret, caret);
  } else if (id === 'customer-search') {
    state.customerSearch = event.target.value; const caret = event.target.selectionStart; pageContent.innerHTML = renderCustomers();
    const replacement = document.getElementById('customer-search'); replacement.focus(); replacement.setSelectionRange(caret, caret);
  }
});

pageContent.addEventListener('change', (event) => {
  if (event.target.id === 'product-category-filter') { state.productCategory = event.target.value; render(); }
  if (event.target.id === 'sales-filter') { state.salesFilter = event.target.value; render(); }
});

document.getElementById('backup-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!window.confirm('Restaurer cette sauvegarde remplacera les données actuelles du commerce. Continuer ?')) return;
    await api('/api/backup', { method: 'POST', body: JSON.stringify(backup) });
    await refreshData(); showToast('Sauvegarde restaurée.');
  } catch (error) { showToast(error.message || 'Fichier de sauvegarde invalide.', true); }
  finally { event.target.value = ''; }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalBackdrop.hidden) closeModal();
});

refreshData().catch((error) => {
  pageContent.innerHTML = `<div class="panel empty-state"><div><strong>Impossible de charger les données</strong>${escapeHtml(error.message)}<br>Fermez puis relancez le programme.</div></div>`;
});
