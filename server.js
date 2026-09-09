import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import Parser from 'rss-parser';
import cron from 'node-cron';

const app = express();
app.use(cors());
app.use(express.json());

// 1. Inicjalizacja Klientów ze Zmiennych Środowiskowych
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const rssParser = new Parser();

// Lista źródeł RSS
const RSS_FEEDS = [
  'https://tvn24.pl/tvnwarszawa.xml'
];

const processedArticles = new Set();

// Poprawna lista 18 dzielnic Warszawy
const WARSZAWA_DISTRICTS = [
  'Bemowo', 'Białołęka', 'Bielany', 'Mokotów', 'Ochota',
  'Praga-Południe', 'Praga-Północ', 'Rembertów', 'Śródmieście',
  'Targówek', 'Ursus', 'Ursynów', 'Wawer', 'Wesoła', 'Wilanów',
  'Włochy', 'Wola', 'Żoliborz'
];

// 2. Funkcja Analizująca Tekst przez AI i Zapisująca do Supabase
async function processAndStoreAlert(rawText, sourceUrl) {
  const prompt = `
Jesteś analitykiem bezpieczeństwa publicznego. Twoim zadaniem jest przeanalizowanie tekstu wiadomości i wyciągnięcie informacji wyłącznie o zdarzeniach kryminalnych oraz ciężkich zagrożeniach dla życia i zdrowia mieszkańców w Warszawie.

ZASADY:
1. Jeśli tekst dotyczy przestępstwa lub zagrożenia kryminalnego w Warszawie (np. napaść z bronią, strzelanina, zamach bombowy, morderstwo, gwałt, pobicie, kradzież lub rozbój) -> ustaw "is_relevant": true.
2. IGNORUJ całkowicie zwykłe wypadki drogowe, kolizje, utrudnienia w ruchu, awarie techniczne oraz pożary (chyba że wynikają z zamachu/podpalenia kryminalnego) -> dla nich ustaw "is_relevant": false.

Wymagany format JSON:
{
  "is_relevant": true lub false,
  "title": "krótki tytuł po polsku",
  "summary": "streszczenie w 1-2 zdaniach",
  "category": "jedna z dokładnie wybranych opcji: [napasc_bron, strzelanina, zamach_bombowy, morderstwo, gwalt, pobicie, kradziez_rozboj]",
  "district": "jedna z listy: ${WARSZAWA_DISTRICTS.join(', ')} lub Nieokreślona",
  "address_text": "ulica/punkt lub null"
}

Tekst do analizy:
"${rawText}"
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' }
    });

    const parsedData = JSON.parse(completion.choices[0].message.content);
    
    // Log diagnostyczny w panelu Rendera
    console.log('Odpowiedź AI:', JSON.stringify(parsedData));

    // Weryfikacja wartości is_relevant
    const isRelevant = parsedData.is_relevant === true || parsedData.is_relevant === 'true';

    if (!isRelevant || parsedData.district === 'Nieokreślona') {
      console.log(`[POMINIĘTO] Relevant: ${isRelevant}, Dzielnica: ${parsedData.district}`);
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

// 3. Endpointy API

app.post('/api/ingest-alert', async (req, res) => {
  const { rawText, sourceUrl } = req.body;
  if (!rawText) {
    return res.status(400).json({ error: 'Brak tekstu w polu rawText' });
  }

  const result = await processAndStoreAlert(rawText, sourceUrl);
  res.json({ status: 'ok', processed: !!result });
});

app.get('/health', (req, res) => {
  res.send('OK');
});

// 4. Zadanie Cron Bota RSS (co 15 minut)
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

cron.schedule('*/15 * * * *', () => {
  runRssBot();
});

// 5. Uruchomienie Serwera
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Serwer backendu z botem RSS działa na porcie ${PORT}`);
  runRssBot();
});