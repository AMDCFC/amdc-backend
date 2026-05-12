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

// Rota de teste
app.get('/', (req, res) => {
  res.json({ status: 'AMDC Backend funcionando!' });
});

// Rota para criar preferência de pagamento
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { itens, comprador, total } = req.body;

    const preference = new Preference(client);

    const items = itens.map(item => ({
      id: item.id || 'produto',
      title: item.nome,
      quantity: item.quantidade,
      unit_price: parseFloat(item.preco),
      currency_id: 'BRL'
    }));

    const body = {
      items,
      payer: {
        name: comprador.nome,
        email: comprador.email,
        phone: {
          number: comprador.telefone
        }
      },
      payment_methods: {
        excluded_payment_types: [],
        installments: 3
      },
      back_urls: {
        success: 'https://amdc-loja.netlify.app/sucesso.html',
        failure: 'https://amdc-loja.netlify.app/erro.html',
        pending: 'https://amdc-loja.netlify.app/pendente.html'
      },
      auto_return: 'approved',
      statement_descriptor: 'AMDC FUTEBOL',
      external_reference: `AMDC-${Date.now()}`,
      notification_url: `${process.env.RENDER_URL}/webhook`
    };

    const result = await preference.create({ body });

    res.json({
      id: result.id,
      init_point: result.init_point
    });

  } catch (error) {
    console.error('Erro ao criar pagamento:', error);
    res.status(500).json({ erro: 'Erro ao criar pagamento', detalhes: error.message });
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
