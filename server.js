const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

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

// ── Cupons ────────────────────────────────────────────────────────
const COUPONS = [
  { code: 'AMDC10',  tipo: 'percent', desconto: 10, active: true },
  { code: 'AMDC20',  tipo: 'percent', desconto: 20, active: true },
  { code: 'BITAR10', tipo: 'percent', desconto: 10, active: true },
];

// ── Config ────────────────────────────────────────────────────────
const CONFIG = {
  salesPaused: false,
  pauseMessage: 'Voltamos em breve com novidades!',
  coupons: COUPONS
};

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

app.get('/config', (req, res) => res.json(CONFIG));

// ── Criar pedido ──────────────────────────────────────────────────
app.post('/criar-pedido', async (req, res) => {
  try {
    const { nome, telefone, email, itens, pagamento, parcelas, vendedor, cupom, cep, frete } = req.body;

    const numero = await proximoNumero();
    const preference = new Preference(client);

    const nomeParts = (nome || 'Cliente').trim().split(' ');
    const firstName = nomeParts[0];
    const lastName  = nomeParts.slice(1).join(' ') || nomeParts[0];

    const telLimpo  = (telefone || '11999999999').replace(/\D/g, '');
    const areaCode  = parseInt(telLimpo.slice(0, 2))  || 11;
    const telNumber = parseInt(telLimpo.slice(2))      || 999999999;

    const mpItems = itens.map(item => ({
      id:          item.nome.replace(/\s+/g, '_').toLowerCase(),
      title:       item.nome + (item.size ? ` (Tam: ${item.size})` : ''),
      quantity:    1,
      unit_price:  parseFloat(item.preco),
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
        cupom:         cupom    || null,
        forma_pagamento: pagamento,
        cep:           cep      || null,
        frete:         frete ? frete.nome : null
      }
    };

    const result = await preference.create({ body });

    const totalNum = mpItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    const totalStr = 'R$ ' + totalNum.toFixed(2).replace('.', ',');

    // Salva no Supabase
    const { error } = await supabase.from('pedidos').insert({
      numero,
      nome:      nome || 'Cliente',
      email:     email || '',
      telefone:  telefone || '',
      itens:     itens.map(i => i.nome + (i.size ? ` (Tam: ${i.size})` : '')).join(', '),
      total:     totalStr,
      pagamento: pagamento || '',
      vendedor:  vendedor  || 'Não informado',
      cupom:     cupom     || null,
      cep:       cep       || null,
      frete:     frete ? frete.nome : null,
      status:    'PENDENTE',
      data_hora: nowBR(),
      pedido_id: result.id
    });

    if (error) console.error('Erro ao salvar no Supabase:', error);

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
        if (pag.status === 'approved')                              novoStatus = 'PAGO ✅';
        else if (pag.status === 'rejected' || pag.status === 'cancelled') novoStatus = 'Cancelado';
        if (novoStatus) {
          await supabase.from('pedidos').update({ status: novoStatus }).eq('numero', numero);
          console.log(`Pedido ${numero} → ${novoStatus}`);
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
  res.sendStatus(200);
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

// GET /admin/pedidos
app.get('/admin/pedidos', authAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  // Converte itens de string para array
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
app.patch('/admin/config', authAdmin, (req, res) => {
  const { salesPaused, pauseMessage } = req.body;
  if (salesPaused  !== undefined) CONFIG.salesPaused  = salesPaused;
  if (pauseMessage !== undefined) CONFIG.pauseMessage = pauseMessage;
  res.json(CONFIG);
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor AMDC rodando na porta ${PORT}`));
