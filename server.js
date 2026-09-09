import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import Parser from 'rss-parser';
import cron from 'node-cron';

const app = express();
app.use(cors());
app.use(express.json());

// 1. Inicjalizacja Klientów z Zmiennych Środowiskowych
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const rssParser = new Parser();

// Lista źródeł RSS (możesz dopisać kolejne)
const RSS_FEEDS = [
  'https://tvn24.pl/tvnwarszawa.xml'
];

const processedArticles = new Set();

// Lista poprawnych dzielnic Warszawy
const WARSZAWA_DISTRICTS = [
  'Białołęka', 'Bielany', 'Bremowo', 'Krowodrza', 'Mokotów', 'Ochota',
  'Praga-Południe', 'Praga-Północ', 'Rembertów', 'Śródmieście',
  'Targówek', 'Ursus', 'Ursynów', 'Wawer', 'Wesoła', 'Wilanów',
  'Włochy', 'Wola', 'Żoliborz'
];

// 2. Funkcja Analizująca Tekst przez AI i Zapisująca do Supabase
async function processAndStoreAlert(rawText, sourceUrl) {
  const prompt = `
Przeanalizuj poniższy tekst wiadomości i wyciągnij z niego informacje o zdarzeniu kryminalnym lub zagrożeniu bezpieczeństwa w Warszawie.

Wymagane pola w formacie JSON:
- "is_relevant": true (jeśli tekst dotyczy przestępstwa, wypadku, pożaru lub zagrożenia w Warszawie) lub false
- "title": krótki, zwięzły tytuł zdarzenia (po polsku)
- "summary": streszczenie w 1-2 zdaniach
- "category": jedna z kategorii: ["pobicie", "kradzież", "morderstwo", "wypadek", "pożar", "inne"]
- "district": dokladna nazwa dzielnicy Warszawy z listy: ${WARSZAWA_DISTRICTS.join(', ')} lub "Nieokreślona"
- "address_text": ulica lub charakterystyczny punkt (jeśli występuje w tekście)

Tekst wiadomości:
"${rawText}"
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'compound-beta',
      response_format: { type: 'json_object' }
    });

    const parsedData = JSON.parse(completion.choices[0].message.content);

    if (!parsedData.is_relevant || parsedData.district === 'Nieokreślona') {
      console.log('Pominięto wpis: brak istotnego zdarzenia lub nieokreślona dzielnica.');
      return null;
    }

    // Zapis do Supabase
    const { data, error } = await supabase
      .from('alerts')
      .insert([
        {
          title: parsedData.title,
          summary: parsedData.summary,
          category: parsedData.category,
          district: parsedData.district,
          address_text: parsedData.address_text || null,
          is_verified: true,
          raw_source_url: sourceUrl || null
        }
      ]);

    if (error) throw error;

    console.log(`[SUKCES] Zapisano alert dla dzielnicy: ${parsedData.district} - ${parsedData.title}`);
    return data;
  } catch (err) {
    console.error('Błąd podczas przetwarzania wiadomości przez AI/Supabase:', err.message);
  }
}

// 3. Endpoint API dla Zgłoszeń
app.post('/api/ingest-alert', async (req, res) => {
  const { rawText, sourceUrl } = req.body;
  if (!rawText) {
    return res.status(400).json({ error: 'Brak tekstu w polu rawText' });
  }

  const result = await processAndStoreAlert(rawText, sourceUrl);
  res.json({ status: 'ok', processed: !!result });
});

// 4. Zadanie Cron Bota RSS (Uruchamiane co 15 minut)
async function runRssBot() {
  console.log(`[${new Date().toLocaleTimeString()}] Bot RSS: Sprawdzanie kanałów...`);

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await rssParser.parseURL(feedUrl);

      for (const item of feed.items) {
        const articleId = item.guid || item.link;

        if (processedArticles.has(articleId)) continue;

        const rawContent = `${item.title}. ${item.contentSnippet || item.content || ''}`;
        console.log(`Bot RSS wykrył nowy wpis: ${item.title}`);

        await processAndStoreAlert(rawContent, item.link);
        processedArticles.add(articleId);
      }
    } catch (err) {
      console.error(`Błąd bota RSS dla ${feedUrl}:`, err.message);
    }
  }
}

// Rejestracja cyklicznego wykonywania bota
cron.schedule('*/15 * * * *', () => {
  runRssBot();
});

// 5. Uruchomienie Serwera HTTP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serwer backendu z botem RSS działa na porcie ${PORT}`);
  // Pierwsze wykonanie bota od razu po starcie serwera
  runRssBot();
});