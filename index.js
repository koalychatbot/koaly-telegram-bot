require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { Pool } = require('pg');
const dayjs = require('dayjs');

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

// Inicializar bot de Telegram
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Mensaje de bienvenida personalizado
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();

  await bot.sendMessage(chatId,
    `👋 ¡Hola! Soy *Koaly*, tu amigo emocional con el corazón de un humano y la sabiduría de un psicólogo.

Puedes escribirme libremente sobre lo que sientes o piensas, y estaré aquí para escucharte y ayudarte.

🆓 En el modo gratuito puedes hablar conmigo un rato al día y ver si conectamos.  
💎 Si deseas una experiencia más profunda y continua, accede a Koaly Premium:

- Memoria personalizada
- Conversaciones ilimitadas
- Seguimiento único de lo que hablamos

👉 [Hazte Premium aquí](https://buy.stripe.com/eVq3cvbwu6SB1qq2bEbMQ00)`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// Activar premium manualmente (solo para pruebas)
bot.onText(/\/soyPremium/, async (msg) => {
  const chatId = msg.chat.id.toString();
  await db.query(
    `INSERT INTO users (id, premium) VALUES ($1, TRUE)
     ON CONFLICT (id) DO UPDATE SET premium = TRUE`,
    [chatId]
  );
  await bot.sendMessage(chatId, "🎉 ¡Felicidades! Ahora tienes acceso completo como usuario Premium. Estoy aquí para ti, siempre. 🫶");
});

// Manejo general de mensajes
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userMessage = msg.text;

  // Ignorar comandos
  if (userMessage.startsWith('/start') || userMessage.startsWith('/soyPremium')) return;

  // Obtener datos del usuario
  let res = await db.query('SELECT * FROM users WHERE id = $1', [chatId]);
  let user = res.rows[0];

  const today = dayjs().format('YYYY-MM-DD');

  if (!user) {
    // Crear nuevo usuario
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
👉 [Hazte Premium](https://buy.stripe.com/eVq3cvbwu6SB1qq2bEbMQ00)`,
        { parse_mode: 'Markdown' });
    }

    user.message_count += 1;
  }

  // Preparar historial (solo para premium)
  let messages = [
    { role: 'system', content: 'Eres Koaly, un amigo empático con sabiduría de psicólogo. Escucha con atención y responde con calidez y humanidad.' }
  ];

  if (user.premium && user.messages?.length > 0) {
    messages = messages.concat(user.messages);
  }

  messages.push({ role: 'user', content: userMessage });

  // Obtener respuesta de OpenAI
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages
    });

    const reply = completion.choices[0].message.content;

    // Guardar nuevo estado
    if (user.premium) {
      const updatedMessages = messages.slice(-20); // solo los últimos 20 mensajes
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
