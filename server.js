const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

// ── Mercado Pago ──────────────────────────────────────────────────
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

// ── Supabase ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Google Sheets ──────────────────────────────────────────────────
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_HEADERS = [
  'Nº Pedido','Data/Hora','Nome','Telefone','Email',
  'Itens','Subtotal','Desconto','Frete','Total',
  'Pagamento','Parcelas','Cupom','Vendedor','CEP','Status'
];

let _sheetsClient = null;
function getSheets() {
  if (_sheetsClient) return _sheetsClient;
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
    if (!creds.client_email) return null;
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    _sheetsClient = google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error('Google Sheets init error:', e.message);
  }
  return _sheetsClient;
}

async function initSheetHeaders() {
  if (!SHEET_ID) return;
  try {
    const sheets = getSheets();
    if (!sheets) return;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A1' });
    if (!res.data.values || !res.data.values[0] || !res.data.values[0][0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [SHEET_HEADERS] }
      });
      console.log('Google Sheets: cabeçalhos criados');
    }
  } catch (e) {
    console.error('Google Sheets initHeaders error:', e.message);
  }
}

async function appendToSheet(row) {
  if (!SHEET_ID) return;
  try {
    const sheets = getSheets();
    if (!sheets) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A:P',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error('Google Sheets append error:', e.message);
  }
}

async function updateSheetStatus(numero, novoStatus) {
  if (!SHEET_ID) return;
  try {
    const sheets = getSheets();
    if (!sheets) return;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A:A' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === String(numero));
    if (rowIndex < 0) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `P${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[novoStatus]] }
    });
    console.log(`Google Sheets: pedido ${numero} → ${novoStatus}`);
  } catch (e) {
    console.error('Google Sheets updateStatus error:', e.message);
  }
}

// ── Config (in-memory, persisted via Supabase) ────────────────────
let CONFIG = {
  salesPaused: false,
  pauseMessage: 'Voltamos em breve com novidades!',
  coupons: [
    { code: 'AMDC10',  tipo: 'percent', desconto: 10, active: true, uses: 0, maxUses: null, expiry: null, owner: '' },
    { code: 'AMDC20',  tipo: 'percent', desconto: 20, active: true, uses: 0, maxUses: null, expiry: null, owner: '' },
    { code: 'BITAR10', tipo: 'percent', desconto: 10, active: true, uses: 0, maxUses: null, expiry: null, owner: '' },
  ],
  visits: { total: 0, unicas: 0, sessions: [] }
};

async function loadConfig() {
  try {
    const { data } = await supabase.from('amdc_config').select('data').eq('id', 1).single();
    if (data?.data) {
      CONFIG = data.data;
      if (!CONFIG.visits) CONFIG.visits = { total: 0, unicas: 0, sessions: [] };
    }
  } catch (e) { /* usa default */ }
}

async function saveConfig() {
  try {
    await supabase.from('amdc_config').upsert({ id: 1, data: CONFIG });
  } catch (e) { /* continua in-memory */ }
}

loadConfig();
initSheetHeaders();

// ── Helpers ───────────────────────────────────────────────────────
function padNum(n) { return String(n).padStart(4, '0'); }
function nowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function proximoNumero() {
  const { count } = await supabase
    .from('pedidos')
    .select('*', { count: 'exact', head: true });
  return padNum((count || 0) + 1);
}

// ══════════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS
// ══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'AMDC Backend funcionando!' }));

app.get('/config', (req, res) => res.json({
  salesPaused: CONFIG.salesPaused,
  pauseMessage: CONFIG.pauseMessage,
  coupons: CONFIG.coupons
}));

// ── Criar pedido ──────────────────────────────────────────────────
app.post('/criar-pedido', async (req, res) => {
  try {
    const { nome, telefone, email, itens, pagamento, parcelas, vendedor, cupom: cupomCode, cep, frete } = req.body;

    if (CONFIG.salesPaused) return res.status(503).json({ detail: CONFIG.pauseMessage });

    // Valida cupom
    let cupomObj = null;
    let desconto = 0;
    if (cupomCode) {
      cupomObj = CONFIG.coupons.find(c => c.code === cupomCode.toUpperCase() && c.active);
      if (cupomObj) {
        if (cupomObj.maxUses && cupomObj.uses >= cupomObj.maxUses) cupomObj = null;
        if (cupomObj && cupomObj.expiry && new Date(cupomObj.expiry) < new Date()) cupomObj = null;
      }
      if (cupomObj) {
        const subtotal = itens.reduce((s, i) => s + parseFloat(i.preco), 0);
        desconto = cupomObj.tipo === 'percent'
          ? Math.round(subtotal * cupomObj.desconto / 100 * 100) / 100
          : Math.min(parseFloat(cupomObj.desconto), subtotal);
      }
    }

    const numero = await proximoNumero();
    const preference = new Preference(client);

    const nomeParts = (nome || 'Cliente').trim().split(' ');
    const firstName = nomeParts[0];
    const lastName  = nomeParts.slice(1).join(' ') || nomeParts[0];

    const telLimpo  = (telefone || '11999999999').replace(/\D/g, '');
    const areaCode  = parseInt(telLimpo.slice(0, 2))  || 11;
    const telNumber = parseInt(telLimpo.slice(2))      || 999999999;

    const subtotalItens = itens.reduce((s, i) => s + parseFloat(i.preco), 0);
    const fator = desconto > 0 ? (subtotalItens - desconto) / subtotalItens : 1;

    const mpItems = itens.map(item => ({
      id:          item.nome.replace(/\s+/g, '_').toLowerCase(),
      title:       item.nome + (item.size ? ` (Tam: ${item.size})` : ''),
      quantity:    1,
      unit_price:  Math.round(parseFloat(item.preco) * fator * 100) / 100,
      currency_id: 'BRL'
    }));

    if (frete && frete.preco > 0) {
      mpItems.push({
        id: 'frete',
        title: `Frete - ${frete.nome}`,
        quantity: 1,
        unit_price: parseFloat(frete.preco),
        currency_id: 'BRL'
      });
    }

    const body = {
      items: mpItems,
      payer: {
        name: firstName,
        surname: lastName,
        email: email,
        phone: { area_code: areaCode, number: telNumber },
        identification: { type: 'CPF', number: '19119119100' },
        address: {
          zip_code:      (cep || '01310100').replace(/\D/g, ''),
          street_name:   'Nao informado',
          street_number: '0',
          neighborhood:  'Nao informado',
          city:          'Sao Paulo',
          federal_unit:  'SP'
        }
      },
      payment_methods: {
        excluded_payment_types: [],
        installments: pagamento === 'Crédito' ? (parcelas || 3) : 1
      },
      back_urls: {
        success: 'https://amdcfc.netlify.app',
        failure: 'https://amdcfc.netlify.app',
        pending: 'https://amdcfc.netlify.app'
      },
      auto_return: 'approved',
      statement_descriptor: 'AMDC FUTEBOL',
      external_reference: `AMDC-${numero}-${Date.now()}`,
      notification_url: `${process.env.RENDER_URL}/webhook`,
      metadata: {
        numero_pedido: numero,
        vendedor:      vendedor || 'Não informado',
        cupom:         cupomObj ? cupomObj.code : null,
        forma_pagamento: pagamento,
        cep:           cep      || null,
        frete:         frete ? frete.nome : null
      }
    };

    const result = await preference.create({ body });

    const totalNum = mpItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    const totalStr = 'R$ ' + totalNum.toFixed(2).replace('.', ',');

    const { error } = await supabase.from('pedidos').insert({
      numero,
      nome:      nome || 'Cliente',
      email:     email || '',
      telefone:  telefone || '',
      itens:     itens.map(i => i.nome + (i.size ? ` (Tam: ${i.size})` : '')).join(', '),
      subtotal:  'R$ ' + subtotalItens.toFixed(2).replace('.', ','),
      desconto:  desconto > 0 ? 'R$ ' + desconto.toFixed(2).replace('.', ',') : null,
      total:     totalStr,
      pagamento: pagamento || '',
      parcelas:  parcelas || 1,
      vendedor:  vendedor  || 'Não informado',
      cupom:     cupomObj ? cupomObj.code : null,
      cep:       cep       || null,
      frete:     frete ? frete.nome : null,
      status:    'PENDENTE',
      data_hora: nowBR(),
      pedido_id: result.id
    });

    if (error) console.error('Erro ao salvar no Supabase:', error);

    // Salvar no Google Sheets
    const itensStr = itens.map(i => i.nome + (i.size ? ` (Tam: ${i.size})` : '')).join(', ');
    appendToSheet([
      numero,
      nowBR(),
      nome || 'Cliente',
      telefone || '',
      email || '',
      itensStr,
      'R$ ' + subtotalItens.toFixed(2).replace('.', ','),
      desconto > 0 ? 'R$ ' + desconto.toFixed(2).replace('.', ',') : '-',
      frete ? `${frete.nome} R$${parseFloat(frete.preco).toFixed(2).replace('.', ',')}` : '-',
      totalStr,
      pagamento || '',
      parcelas || 1,
      cupomObj ? cupomObj.code : '-',
      vendedor || 'Não informado',
      cep || '-',
      'PENDENTE'
    ]);

    // Incrementa uso do cupom
    if (cupomObj) {
      const idx = CONFIG.coupons.findIndex(c => c.code === cupomObj.code);
      if (idx >= 0) {
        CONFIG.coupons[idx].uses = (CONFIG.coupons[idx].uses || 0) + 1;
        saveConfig();
      }
    }

    res.json({
      checkout_url: result.init_point,
      pedido_id:    result.id,
      numero
    });

  } catch (error) {
    console.error('Erro ao criar pedido:', JSON.stringify(error, null, 2));
    res.status(500).json({ detail: 'Erro ao criar pedido: ' + error.message });
  }
});

// ── Webhook MP ────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const payment = new Payment(client);
      const pag = await payment.get({ id: data.id });
      const extRef = pag.external_reference || '';
      const match = extRef.match(/^AMDC-(\d+)-/);
      if (match) {
        const numero = match[1];
        let novoStatus = null;
        if (pag.status === 'approved')                                        novoStatus = 'PAGO ✅';
        else if (pag.status === 'rejected' || pag.status === 'cancelled')     novoStatus = 'Cancelado';
        if (novoStatus) {
          await supabase.from('pedidos').update({ status: novoStatus }).eq('numero', numero);
          updateSheetStatus(numero, novoStatus);
          console.log(`Pedido ${numero} → ${novoStatus}`);
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
  res.sendStatus(200);
});

// ── Visitas ───────────────────────────────────────────────────────
app.post('/visita', async (req, res) => {
  const sid = (req.body || {}).sessionId || (req.body || {}).session_id;
  if (!CONFIG.visits) CONFIG.visits = { total: 0, unicas: 0, sessions: [] };
  CONFIG.visits.total += 1;
  if (sid && !CONFIG.visits.sessions.includes(sid)) {
    CONFIG.visits.unicas += 1;
    CONFIG.visits.sessions.push(sid);
    if (CONFIG.visits.sessions.length > 5000) CONFIG.visits.sessions = CONFIG.visits.sessions.slice(-5000);
  }
  saveConfig();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ROTAS DO ADMIN
// ══════════════════════════════════════════════════════════════════
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'amdc-admin-2026';

function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// GET /admin/visitas
app.get('/admin/visitas', authAdmin, (req, res) => {
  const v = CONFIG.visits || { total: 0, unicas: 0 };
  res.json({ total: v.total, unicas: v.unicas });
});

// POST /admin/login
app.post('/admin/login', (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, detail: 'Token incorreto' });
  res.json({ ok: true, token: ADMIN_TOKEN });
});

// GET /admin/pedidos
app.get('/admin/pedidos', authAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const pedidos = data.map(p => ({
    ...p,
    itens: p.itens ? p.itens.split(', ') : []
  }));
  res.json(pedidos);
});

// PATCH /admin/pedidos/:numero/status
app.patch('/admin/pedidos/:numero/status', authAdmin, async (req, res) => {
  const { numero } = req.params;
  const { status }  = req.body;
  const { data, error } = await supabase
    .from('pedidos')
    .update({ status })
    .eq('numero', numero)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /admin/config
app.get('/admin/config', authAdmin, (req, res) => res.json(CONFIG));

// PATCH /admin/config
app.patch('/admin/config', authAdmin, async (req, res) => {
  const { salesPaused, pauseMessage } = req.body;
  if (salesPaused  !== undefined) CONFIG.salesPaused  = salesPaused;
  if (pauseMessage !== undefined) CONFIG.pauseMessage = pauseMessage;
  await saveConfig();
  res.json(CONFIG);
});

// GET /admin/cupons
app.get('/admin/cupons', authAdmin, (req, res) => {
  res.json(CONFIG.coupons);
});

// POST /admin/cupom  (cria ou atualiza)
app.post('/admin/cupom', authAdmin, async (req, res) => {
  const code = req.body.code?.trim().toUpperCase();
  if (!code) return res.status(400).json({ detail: 'Código inválido' });
  const obj = { ...req.body, code };
  const idx = CONFIG.coupons.findIndex(c => c.code === code);
  if (idx >= 0) {
    obj.uses = CONFIG.coupons[idx].uses || 0;
    CONFIG.coupons[idx] = obj;
  } else {
    obj.uses = 0;
    CONFIG.coupons.push(obj);
  }
  await saveConfig();
  res.json({ ok: true });
});

// DELETE /admin/cupom/:code
app.delete('/admin/cupom/:code', authAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  CONFIG.coupons = CONFIG.coupons.filter(c => c.code !== code);
  await saveConfig();
  res.json({ ok: true });
});

// PATCH /admin/cupom/:code/toggle
app.patch('/admin/cupom/:code/toggle', authAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const c = CONFIG.coupons.find(c => c.code === code);
  if (!c) return res.status(404).json({ detail: 'Cupom não encontrado' });
  c.active = !c.active;
  await saveConfig();
  res.json({ ok: true, active: c.active });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor AMDC rodando na porta ${PORT}`));
