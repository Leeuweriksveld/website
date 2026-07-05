const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const multipart = require('parse-multipart-data');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://leeuweriksveld.github.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ bericht: 'Alleen POST toegestaan' }) };

  try {
    // Multipart verwerken
    const boundary = multipart.getBoundary(event.headers['content-type']);
    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const parts = multipart.parse(body, boundary);

    const get = (naam) => parts.find(p => p.name === naam);
    const wachtwoord = get('wachtwoord')?.data?.toString();
    const week = parseInt(get('week')?.data?.toString());
    const jaar = parseInt(get('jaar')?.data?.toString());
    const bestandPart = get('bestand');

    // Wachtwoord controleren
    if (wachtwoord !== process.env.UPLOAD_WACHTWOORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ bericht: 'Ongeldig wachtwoord' }) };
    }

    if (!bestandPart || !week || !jaar) {
      return { statusCode: 400, headers, body: JSON.stringify({ bericht: 'Bestand, week en jaar zijn verplicht' }) };
    }

    // Tekst extraheren uit PDF of HTML
    let tekst = '';
    const bestandsnaam = bestandPart.filename || '';
    if (bestandsnaam.endsWith('.pdf')) {
      const result = await pdfParse(bestandPart.data);
      tekst = result.text;
    } else {
      // HTML: tags verwijderen
      tekst = bestandPart.data.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }

    // Claude API: gestructureerde data extraheren
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Dit is de tekst van een wekelijkse pakketbrief van biologische boerderij 't Leeuweriksveld.
Extraheer de volgende informatie en geef ALLEEN een JSON-object terug, zonder uitleg:

{
  "groenten": ["lijst van groenten in het pakket deze week"],
  "recepten": ["lijst van recepttitels"],
  "nieuws": ["lijst van korte nieuwsberichten of aankondigingen, maximaal 1 zin per item"]
}

Tekst van de pakketbrief:
${tekst.slice(0, 6000)}`
      }]
    });

    let extracted;
    try {
      const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(jsonMatch[0]);
    } catch {
      return { statusCode: 500, headers, body: JSON.stringify({ bericht: 'AI kon de brief niet verwerken. Probeer opnieuw.' }) };
    }

    // Bestandsnaam bepalen
    const weekStr = String(week).padStart(2, '0');
    const ext = bestandsnaam.endsWith('.html') ? '.html' : '.pdf';
    const nieuwBestand = `pakketbrief-week-${weekStr}-${jaar}${ext}`;

    // Nieuw record
    const nieuwRecord = {
      week,
      jaar,
      bestand: nieuwBestand,
      groenten: extracted.groenten || [],
      recepten: extracted.recepten || [],
      nieuws: extracted.nieuws || [],
    };

    // Haal huidige pakketbrieven.json op via GitHub API
    const githubToken = process.env.GITHUB_TOKEN;
    const repo = 'Leeuweriksveld/website';
    const pad = 'src/data/pakketbrieven.json';
    const apiBase = `https://api.github.com/repos/${repo}/contents/${pad}`;

    const huidigResp = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    const huidigData = await huidigResp.json();
    const huidigeSha = huidigData.sha;
    const huidigeInhoud = JSON.parse(Buffer.from(huidigData.content, 'base64').toString());

    // Bestaand record vervangen of nieuw toevoegen
    const index = huidigeInhoud.findIndex(r => r.week === week && r.jaar === jaar);
    if (index >= 0) {
      huidigeInhoud[index] = nieuwRecord;
    } else {
      // Invoegen op juiste positie (nieuwste eerst)
      const pos = huidigeInhoud.findIndex(r => r.jaar < jaar || (r.jaar === jaar && r.week < week));
      huidigeInhoud.splice(pos >= 0 ? pos : 0, 0, nieuwRecord);
    }

    // Commit naar GitHub
    const nieuweInhoud = Buffer.from(JSON.stringify(huidigeInhoud, null, 2)).toString('base64');
    const commitResp = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `📬 Pakketbrief week ${week}, ${jaar} toegevoegd`,
        content: nieuweInhoud,
        sha: huidigeSha,
      })
    });

    if (!commitResp.ok) {
      const fout = await commitResp.json();
      throw new Error(`GitHub commit mislukt: ${fout.message}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        week,
        jaar,
        aantalGroenten: nieuwRecord.groenten.length,
        aantalRecepten: nieuwRecord.recepten.length,
      })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ bericht: err.message }) };
  }
};
