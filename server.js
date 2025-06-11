require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const { Pool } = require('pg');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Conexión a la base de datos
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Configurar para leer el cuerpo crudo del request
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Solo reaccionamos a pagos completados
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const telegramId = session.metadata.telegram_id;

    // Actualizar al usuario como premium
    db.query(
      `INSERT INTO users (id, premium) VALUES ($1, TRUE)
       ON CONFLICT (id) DO UPDATE SET premium = TRUE`,
      [telegramId]
    ).then(() => {
      console.log(`✅ Usuario ${telegramId} ahora es premium`);
    }).catch(err => {
      console.error("❌ Error actualizando usuario:", err);
    });
  }

  res.json({ received: true });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook escuchando en puerto ${PORT}`));
