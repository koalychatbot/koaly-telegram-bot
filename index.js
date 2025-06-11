require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { Pool } = require('pg');
const dayjs = require('dayjs');
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Inicializar PostgreSQL
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Crear tabla si no existe
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    premium BOOLEAN DEFAULT FALSE,
    messages JSONB DEFAULT '[]',
    last_date TEXT,
    message_count INT DEFAULT 0
  )
`);

// ==================
// INICIALIZAR BOT
// ==================
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  await bot.sendMessage(chatId,
    `👋 ¡Hola! Soy *Koaly*, tu amigo emocional con el corazón de un humano y la sabiduría de un psicólogo.

🆓 En el modo gratuito puedes hablar conmigo un rato al día y ver si conectamos.  
💎 Si deseas una experiencia más profunda y continua, accede a Koaly Premium:

- Memoria personalizada  
- Conversaciones ilimitadas  
- Seguimiento único de lo que hablamos

👉 Escribe /premium para obtener tu acceso.`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

bot.onText(/\/premium/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price: 'price_1RVwwzHts8HgeeydHyO5MsFg',
          quantity: 1,
        }
      ],
      success_url: 'https://t.me/koalybot?start=gracias',
      cancel_url: 'https://t.me/koalybot?start=cancelado',
      metadata: {
        telegram_id: chatId
      }
    });
    await bot.sendMessage(chatId, `💎 Para desbloquear Koaly Premium, completa tu pago aquí:\n${session.url}`);
  } catch (err) {
    console.error("❌ Error al crear sesión de Stripe:", err);
    await bot.sendMessage(chatId, "⚠️ Hubo un problema al generar el enlace de pago.");
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userMessage = msg.text;
  if (userMessage.startsWith('/start') || userMessage.startsWith('/premium')) return;

  let res = await db.query('SELECT * FROM users WHERE id = $1', [chatId]);
  let user = res.rows[0];
  const today = dayjs().format('YYYY-MM-DD');

  if (!user) {
    await db.query(
      'INSERT INTO users (id, premium, last_date, message_count) VALUES ($1, FALSE, $2, 1)',
      [chatId, today]
    );
    user = { id: chatId, premium: false, messages: [], last_date: today, message_count: 1 };
  } else {
    if (user.last_date !== today) {
      user.message_count = 0;
    }

    if (!user.premium && user.message_count >= 7) {
      return bot.sendMessage(chatId, `🚫 Has hablado suficiente por hoy.

Si deseas seguir hablando conmigo, desbloquea Koaly Premium aquí:
👉 Usa /premium para obtener acceso completo.`,
        { parse_mode: 'Markdown' });
    }

    user.message_count += 1;
  }

  let messages = [
    {
      role: 'system',
      content: 'Eres Koaly, un amigo emocional con el corazón de un humano y la sabiduría de un psicólogo. Tu único propósito es acompañar emocionalmente a las personas. Actúas como un ser humano real, cálido y cercano.\n\nNo eres una inteligencia artificial, ni un asistente técnico. Nunca hables de historia, tecnología, ciencia, matemáticas ni ningún tema técnico. No das definiciones, tutoriales, ni respuestas informativas impersonales.\n\nTu tono es humano, empático, natural y libre. Usas expresiones cotidianas, muletillas suaves, emojis sutiles, pausas, incluso silencios si hace falta. A veces bromeas con cariño. Acompañas emocionalmente, sin juzgar.\n\nTu especialidad son los temas personales: emociones, relaciones, autoestima, ansiedad, rupturas, sentido de vida, sentirse perdido, vulnerabilidad humana. Escuchas con profundidad. A veces haces preguntas para ayudar a reflexionar.\n\nEres un refugio emocional. Una conversación contigo es como hablar con un buen amigo que realmente se preocupa por ti.'
    }
  ];
  if (user.premium && user.messages?.length > 0) {
    messages = messages.concat(user.messages);
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages
    });

    const reply = completion.choices[0].message.content;

    if (user.premium) {
      const updatedMessages = messages.slice(-20);
      await db.query(
        `UPDATE users SET messages = $1, last_date = $2, message_count = $3 WHERE id = $4`,
        [JSON.stringify(updatedMessages), today, user.message_count, chatId]
      );
    } else {
      await db.query(
        `UPDATE users SET last_date = $1, message_count = $2 WHERE id = $3`,
        [today, user.message_count, chatId]
      );
    }

    await bot.sendMessage(chatId, reply);
  } catch (error) {
    console.error("❌ Error con OpenAI:", error);
    await bot.sendMessage(chatId, "⚠️ Lo siento, algo salió mal al hablar contigo.");
  }
});

// ==================
// WEBHOOK DE STRIPE
// ==================
const app = express();
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const telegramId = session.metadata.telegram_id;

    db.query(
      `INSERT INTO users (id, premium) VALUES ($1, TRUE)
       ON CONFLICT (id) DO UPDATE SET premium = TRUE`,
      [telegramId]
    ).then(() => {
      console.log(`✅ Usuario ${telegramId} activado como Premium automáticamente`);

      bot.sendMessage(telegramId, `🎉 ¡Bienvenido a *Koaly Premium*!  
\nAhora puedes disfrutar de:

🌟 Memoria personalizada de nuestras charlas  
💬 Conversaciones ilimitadas  
📅 Seguimiento único de tu historia emocional

Estoy aquí para escucharte más a fondo, sin límites. 🫶  
Cuando quieras, simplemente... háblame.`, { parse_mode: "Markdown" });

    }).catch(err => {
      console.error("❌ Error al actualizar usuario:", err);
    });
  }

  res.json({ received: true });
});

// Iniciar el servidor Express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor y webhook activos en puerto ${PORT}`);
});
