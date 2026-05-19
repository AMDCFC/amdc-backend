const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const app = express();
app.use(cors());
app.use(express.json());

// ── Arquivos de persistência ─────────────────────────────────────
const CONFIG_FILE = 'amdc_config.json';
const ORDERS_FILE = 'amdc_orders.json';
const VISITS_FILE = 'amdc_visits.json';

const DEFAULT_CONFIG = {
  salesPaused: false,
  pauseMessage: 'Voltamos em breve com novidades!',
  coupons: [
    { code: 'ATLETA10',  tipo: 'percent', desconto: 10, active: true, maxUses: null, expiry: null, owner: '' },
    { code: 'BITAR10',   tipo: 'percent', desconto: 10, active: true, maxUses: null, expiry: null, owner: '' },
    { code: 'BITAR20',   tipo: 'percent', desconto: 20, active: true, maxUses: null, expiry: null, owner: '' },
    { code: 'BITAR15',   tipo: 'percent', desconto: 15, active: true, maxUses: null, expiry: null, owner: '' },
    { code: 'TORCIDA10', tipo: 'percent', desconto: 10, active: true, maxUses: null, expiry: null, owner: 'Torcida' },
    { code: 'AMDC5',     tipo: 'percent', desconto: 5,  active: true, maxUses: null, expiry: null, owner: '' },
  ]
};

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e){}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch(e){}
}

function loadOrders() {
  try { if (fs.existsSync(ORDERS_FILE)) return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8')); } catch(e){}
  return [];
}
function saveOrders(orders) {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); } catch(e){}
}

function loadVisits() {
  try { if (fs.existsSync(VISITS_FILE)) return JSON.parse(fs.readFileSync(VISITS_FILE, 'utf-8')); } catch(e){}
  return { total: 0, unicas: 0, sessions: [] };
}
function saveVisits(v) {
  try { fs.writeFileSync(VISITS_FILE, JSON.stringify(v)); } catch(e){}
}

// ── Auth admin ───────────────────────────────────────────────────
const ADMIN_TOKEN = 'amdc-admin-2026';
function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  next();
}

// ── Mercado Pago ─────────────────────────────────────────────────
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ═══════════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS
// ═══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'AMDC Backend funcionando!' }));

// Configuração pública (cupons ativos, status de pausa)
app.get('/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    salesPaused: cfg.salesPaused,
    pauseMessage: cfg.pauseMessage,
    coupons: cfg.coupons.filter(c => c.active)
  });
});

// Registra visita
app.post('/visita', (req, res) => {
  const sid = (req.body || {}).sessionId || (req.body || {}).session_id;
  const v = loadVisits();
  v.total = (v.total || 0) + 1;
  if (sid && !v.sessions.includes(sid)) {
    v.unicas = (v.unicas || 0) + 1;
    v.sessions.push(sid);
    if (v.sessions.length > 10000) v.sessions = v.sessions.slice(-10000);
  }
  saveVisits(v);
  res.json({ ok: true });
});

// Criar pedido — chamado pelo checkout
app.post('/criar-pedido', async (req, res) => {
  try {
    const { numero, nome, telefone, email, itens, pagamento, parcelas, vendedor, cupom, cep, frete, total } = req.body;

    const preference = new Preference(client);

    const items = itens.map(item => ({
      id: item.nome.replace(/\s+/g, '_').toLowerCase(),
      title: item.nome + (item.size ? ` (Tam: ${item.size})` : ''),
      quantity: 1,
      unit_price: parseFloat(item.preco),
      currency_id: 'BRL'
    }));

    if (frete && frete.preco > 0) {
      items.push({
        id: 'frete',
        title: `Frete - ${frete.nome}`,
        quantity: 1,
        unit_price: parseFloat(frete.preco),
        currency_id: 'BRL'
      });
    }

    const extRef = `AMDC-${numero}-${Date.now()}`;
    const body = {
      items,
      payer: { name: nome, email: email, phone: { number: telefone } },
      payment_methods: {
        excluded_payment_types: [],
        installments: pagamento === 'Crédito' ? (parcelas || 3) : 1
      },
      back_urls: {
        success: 'https://amdc-loja.netlify.app/sucesso.html',
        failure: 'https://amdc-loja.netlify.app/erro.html',
        pending: 'https://amdc-loja.netlify.app/pendente.html'
      },
      auto_return: 'approved',
      statement_descriptor: 'AMDC FUTEBOL',
      external_reference: extRef,
      notification_url: `${process.env.RENDER_URL}/webhook`,
      metadata: {
        numero_pedido: numero,
        vendedor: vendedor || 'Não informado',
        cupom: cupom || null,
        forma_pagamento: pagamento,
        cep: cep || null,
        frete: frete ? frete.nome : null
      }
    };

    const result = await preference.create({ body });

    // Salva pedido
    const orders = loadOrders();
    orders.push({
      id: extRef,
      numero: numero || '----',
      nome,
      email,
      telefone,
      pagamento,
      cupom: cupom || null,
      vendedor: vendedor || null,
      cep: cep || null,
      frete: frete ? frete.nome : null,
      total: total || null,
      itens: itens.map(i => i.nome + (i.size ? ` (Tam: ${i.size})` : '')),
      status: 'PENDENTE',
      data: new Date().toISOString(),
      preference_id: result.id,
      mp_payment_id: null
    });
    saveOrders(orders);

    res.json({ checkout_url: result.init_point, pedido_id: result.id, numero });
  } catch (error) {
    console.error('Erro ao criar pedido:', error);
    res.status(500).json({ detail: 'Erro ao criar pedido: ' + error.message });
  }
});

// Webhook do Mercado Pago
app.post('/webhook', async (req, res) => {
  console.log('Webhook recebido:', JSON.stringify(req.body));
  try {
    const { type, data } = req.body || {};
    if (type === 'payment' && data && data.id) {
      const orders = loadOrders();
      // Tenta encontrar o pedido pelo external_reference via API do MP
      // Por ora, marca todos PENDENTES como PAGO pelo payment_id
      const idx = orders.findIndex(o => o.mp_payment_id === String(data.id));
      if (idx === -1) {
        // Procura pedido sem payment_id (recém-criado)
        const pending = orders.find(o => o.status === 'PENDENTE' && !o.mp_payment_id);
        if (pending) {
          pending.mp_payment_id = String(data.id);
          pending.status = 'PAGO';
          saveOrders(orders);
        }
      }
    }
  } catch(e) { console.error('Webhook error:', e); }
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════
// ROTAS ADMIN (todas exigem x-admin-token)
// ═══════════════════════════════════════════════════════════════════

// Visitas
app.get('/admin/visitas', adminAuth, (req, res) => {
  const v = loadVisits();
  res.json({ total: v.total || 0, unicas: v.unicas || 0 });
});

// Config
app.get('/admin/config', adminAuth, (req, res) => {
  res.json(loadConfig());
});

app.patch('/admin/config', adminAuth, (req, res) => {
  const cfg = loadConfig();
  const { salesPaused, pauseMessage, adminPassword } = req.body || {};
  if (salesPaused !== undefined) cfg.salesPaused = !!salesPaused;
  if (pauseMessage !== undefined) cfg.pauseMessage = pauseMessage;
  // adminPassword ignored — token is static in the admin HTML
  saveConfig(cfg);
  res.json({ ok: true, salesPaused: cfg.salesPaused });
});

// Pedidos
app.get('/admin/pedidos', adminAuth, (req, res) => {
  res.json(loadOrders());
});

app.patch('/admin/pedidos/:id/status', adminAuth, (req, res) => {
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Pedido não encontrado' });
  orders[idx].status = req.body.status || orders[idx].status;
  saveOrders(orders);
  res.json({ ok: true });
});

// Cupons
app.get('/admin/cupons', adminAuth, (req, res) => {
  res.json(loadConfig().coupons);
});

app.post('/admin/cupom', adminAuth, (req, res) => {
  const cfg = loadConfig();
  const { code, tipo, desconto, active, maxUses, expiry, owner, uses } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Código obrigatório' });
  const upper = code.toUpperCase();
  const existing = cfg.coupons.findIndex(c => c.code === upper);
  const cupom = { code: upper, tipo: tipo || 'percent', desconto: Number(desconto) || 0, active: active !== false, maxUses: maxUses || null, expiry: expiry || null, owner: owner || '', uses: uses || 0 };
  if (existing >= 0) {
    cfg.coupons[existing] = cupom;
  } else {
    cfg.coupons.push(cupom);
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

app.patch('/admin/cupom/:code/toggle', adminAuth, (req, res) => {
  const cfg = loadConfig();
  const upper = req.params.code.toUpperCase();
  const c = cfg.coupons.find(x => x.code === upper);
  if (!c) return res.status(404).json({ error: 'Cupom não encontrado' });
  c.active = !c.active;
  saveConfig(cfg);
  res.json({ ok: true, active: c.active });
});

app.delete('/admin/cupom/:code', adminAuth, (req, res) => {
  const cfg = loadConfig();
  const upper = req.params.code.toUpperCase();
  const before = cfg.coupons.length;
  cfg.coupons = cfg.coupons.filter(c => c.code !== upper);
  if (cfg.coupons.length === before) return res.status(404).json({ error: 'Cupom não encontrado' });
  saveConfig(cfg);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor AMDC rodando na porta ${PORT}`));
