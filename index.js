require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Configuration, OpenAIApi } = require('openai');
const fs = require('fs');
const dayjs = require('dayjs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const memoryFile = './memory.json';
let memory = {};
if (fs.existsSync(memoryFile)) {
  memory = JSON.parse(fs.readFileSync(memoryFile));
}

function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2));
}

// Webhook de Stripe para activar Premium
app.post('/webhook', (req, res) => {
  const event = req.body;

  if (event.type === 'checkout.session.completed') {
    const chatId = event.data.object.metadata.chatId;

    if (!memory[chatId]) memory[chatId] = {};
    memory[chatId].premium = true;
    saveMemory();
  }

  res.status(200).send('ok');
});

// Iniciar Express (necesario en Railway)
app.listen(port, () => {
  console.log(`Servidor Express escuchando en puerto ${port}`);
});

// Comando manual para activar Premium (sigue funcionando)
bot.onText(/\/soyPremium/, (msg) => {
  const chatId = msg.chat.id.toString();
  if (!memory[chatId]) memory[chatId] = { premium: false, messages: [], count: 0, lastDate: dayjs().format('YYYY-MM-DD') };
  memory[chatId].premium = true;
  saveMemory();
  bot.sendMessage(chatId, "🎉 ¡Ahora eres usuario Premium! Disfruta de mensajes ilimitados y memoria persistente.");
});

// Manejo de mensajes
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userMessage = msg.text;

  if (userMessage && userMessage.startsWith('/soyPremium')) return;

  if (!memory[chatId]) {
    memory[chatId] = {
      premium: false,
      messages: [],
      count: 0,
      lastDate: dayjs().format('YYYY-MM-DD')
    };
  }

  const userData = memory[chatId];
  const today = dayjs().format('YYYY-MM-DD');

  if (userData.lastDate !== today) {
    userData.count = 0;
    userData.lastDate = today;
  }

  if (!userData.premium && userData.count >= 7) {
    bot.sendMessage(chatId, "🚫 Has alcanzado tu límite de 7 mensajes hoy.\n\nActualiza a Koaly Premium con /soyPremium para continuar ❤️");
    return;
  }

  userData.messages.push({ role: 'user', content: userMessage });
  userData.messages = userData.messages.slice(-20);
  userData.count++;

  const messages = [
    { role: 'system', content: 'Eres Koaly, un amigo empático con memoria para usuarios premium. Responde con calidez y comprensión.' },
    ...userData.messages
  ];

  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4o",
      messages
    });

    const botReply = completion.data.choices[0].message.content;
    userData.messages.push({ role: 'assistant', content: botReply });
    saveMemory();
    bot.sendMessage(chatId, botReply);
  } catch (e) {
    console.error("OpenAI error:", e);
    bot.sendMessage(chatId, "⚠️ Lo siento, algo salió mal hablando conmigo.");
  }
});
