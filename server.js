import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. Konfiguracja Aplikacji i Zmiennych Środowiskowych
const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
  console.error('BŁĄD: Brak wymaganych zmiennych środowiskowych (SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY)');
  process.exit(1);
}

// Inicjalizacja Klientów
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const rssParser = new Parser();

// Inicjalizacja Google Gemini API (gemini-2.5-flash')
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'application/json' }
});

// Lista Dzielnic Warszawy dla Klasyfikacji
const WARSZAWA_DISTRICTS = [
  'Bemowo', 'Białołęka', 'Bielany', 'Mokotów', 'Ochota', 
  'Praga-Południe', 'Praga-Północ', 'Rembertów', 'Śródmieście', 
  'Targówek', 'Ursus', 'Ursynów', 'Wawer', 'Wesoła', 
  'Wilanów', 'Włochy', 'Wola', 'Żoliborz', 'A2 / S2', 'Nieokreślona'
];

// Kanały RSS do Monitorowania
const RSS_FEEDS = [
  'https://tvn24.pl/tvnwarszawa.xml',
  'https://warszawawpigulce.pl/feed/'
];

// Funkcja Pomocnicza do Wstrzymywania Wykonania (Delay)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 2. Logika Analizy AI i Zapisu do Bazy
async function processAndStoreAlert(rawText, sourceUrl, retries = 3) {
  const prompt = `
Jesteś analitykiem bezpieczeństwa publicznego. Twoim zadaniem jest przeanalizowanie tekstu wiadomości i wyciągnięcie informacji wyłącznie o zdarzeniach kryminalnych oraz ciężkich zagrożeniach dla życia i zdrowia mieszkańców w Warszawie.

ZASADY:
1. Jeśli tekst dotyczy przestępstwa lub zagrożenia kryminalnego w Warszawie (np. napaść z bronią, strzelanina, zamach bombowy, morderstwo, gwałt, pobicie, kradzież lub rozbój) -> ustaw "is_relevant": true.
2. IGNORUJ całkowicie zwykłe wypadki drogowe, kolizje, utrudnienia w ruchu, awarie techniczne oraz pożary (chyba że wynikają z zamachu/podpalenia kryminalnego) -> dla nich ustaw "is_relevant": false.

Wymagany format wyjściowy to czysty JSON o strukturze:
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

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const parsedData = JSON.parse(responseText);

      console.log('Odpowiedź AI:', JSON.stringify(parsedData));

      const isRelevant = parsedData.is_relevant === true || parsedData.is_relevant === 'true';

      if (!isRelevant || parsedData.district === 'Nieokreślona') {
        console.log(`[POMINIĘTO] Relevant: ${isRelevant}, Dzielnica: ${parsedData.district}`);
        return null;
      }

      // Zapis w bazie Supabase
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
      console.error(`Błąd podczas analizy AI (Próba ${attempt}/${retries}):`, err.message);
      if (attempt < retries) {
        console.log('Czekam 15 sekund przed ponowną próbą...');
        await delay(15000);
      } else {
        console.error('Osiągnięto maksymalną liczbę prób dla tego wpisu.');
      }
    }
  }
}

// 3. Zadanie Cron dla Bota RSS
async function runRssBot() {
  console.log(`[${new Date().toLocaleTimeString()}] Bot RSS: Sprawdzanie kanałów...`);

  // Przetwarzaj tylko wpisy z ostatnich 2 godzin, aby uniknąć analizowania starej historii
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await rssParser.parseURL(feedUrl);

      for (const item of feed.items) {
        const sourceUrl = item.link;
        if (!sourceUrl) continue;

        // 1. Pomijaj wpisy starsze niż 2 godziny
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        if (pubDate && pubDate < TWO_HOURS_AGO) {
          continue;
        }

        // 2. Weryfikacja duplikatów w bazie Supabase
        const { data: existingAlert } = await supabase
          .from('alerts')
          .select('id')
          .eq('raw_source_url', sourceUrl)
          .maybeSingle();

        if (existingAlert) {
          continue; // Wpis już istnieje w bazie – pomijamy
        }

        const rawContent = `${item.title}. ${item.contentSnippet || item.content || ''}`;
        console.log(`Bot RSS wykrył nowy wpis: ${item.title}`);

        // Przetwarzanie wiadomości i opóźnienie 12 sekund dla bezpieczeństwa limitów API
        await processAndStoreAlert(rawContent, sourceUrl);
        await delay(12000);
      }
    } catch (err) {
      console.error(`Błąd bota RSS podczas pobierania ${feedUrl}:`, err.message);
    }
  }
}

// Harmonogram bota: uruchamianie co 20 minut
cron.schedule('*/20 * * * *', () => {
  runRssBot();
});

// 4. Endpoints API
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 5. Uruchomienie Serwera
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serwer backendu z botem RSS działa na porcie ${PORT}`);
  // Pierwsze wykonanie bota po uruchomieniu serwera
  runRssBot();
});
