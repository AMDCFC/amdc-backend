const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const app = express();
app.use(cors());
app.use(express.json());

// Configuração do Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

// Cupons de desconto (edite aqui para adicionar/remover)
const COUPONS = [
  { code: 'AMDC10', tipo: 'percent', desconto: 10, active: true },
  { code: 'AMDC20', tipo: 'percent', desconto: 20, active: true },
  { code: 'BITAR10', tipo: 'percent', desconto: 10, active: true },
];

// Controle de vendas (mude salesPaused para true para pausar)
const CONFIG = {
  salesPaused: false,
  pauseMessage: 'Voltamos em breve com novidades!',
  coupons: COUPONS
};

// Rota de teste
app.get('/', (req, res) => {
  res.json({ status: 'AMDC Backend funcionando!' });
});

// Rota de configuração (cupons, pausar vendas)
app.get('/config', (req, res) => {
  res.json(CONFIG);
});

// Rota para criar pedido — chamada pelo frontend no checkout
app.post('/criar-pedido', async (req, res) => {
  try {
    const { numero, nome, telefone, email, itens, pagamento, parcelas, vendedor, cupom, cep, frete } = req.body;

    const preference = new Preference(client);

    // Monta os itens para o Mercado Pago
    const items = itens.map(item => ({
      id: item.nome.replace(/\s+/g, '_').toLowerCase(),
      title: item.nome + (item.size ? ` (Tam: ${item.size})` : ''),
      quantity: 1,
      unit_price: parseFloat(item.preco),
      currency_id: 'BRL'
    }));

    // Adiciona frete como item se houver
    if (frete && frete.preco > 0) {
      items.push({
        id: 'frete',
        title: `Frete - ${frete.nome}`,
        quantity: 1,
        unit_price: parseFloat(frete.preco),
        currency_id: 'BRL'
      });
    }

    // Monta o corpo da preferência
    const body = {
      items,
      payer: {
        name: nome,
        email: email,
        phone: { number: telefone }
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
        vendedor: vendedor || 'Não informado',
        cupom: cupom || null,
        forma_pagamento: pagamento,
        cep: cep || null,
        frete: frete ? frete.nome : null
      }
    };

    const result = await preference.create({ body });

    res.json({
      checkout_url: result.init_point,
      pedido_id: result.id,
      numero: numero
    });

  } catch (error) {
    console.error('Erro ao criar pedido:', error);
    res.status(500).json({ detail: 'Erro ao criar pedido: ' + error.message });
  }
});

// Webhook para receber notificações do MP
app.post('/webhook', async (req, res) => {
  console.log('Webhook recebido:', JSON.stringify(req.body));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor AMDC rodando na porta ${PORT}`);
});
