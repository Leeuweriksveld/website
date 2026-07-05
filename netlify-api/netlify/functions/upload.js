const pdfParse = require('pdf-parse');
const multipart = require('parse-multipart-data');

function extraheerData(tekst) {
  const regels = tekst.split(/\r?\n/).map(r => r.trim()).filter(r => r.length > 0);

  const groenten = [];
  const recepten = [];
  const nieuws = [];

  // Zoek secties op basis van koppen
  let sectie = null;

  // Patronen voor recepttitels: genummerd (1. 2. 1) 2)) of met streepje
  const receptPatroon = /^(\d+[\.\)]\s+|[-•*]\s+)(.+)$/;

  // Groenten: vaak in een blok na "pakket" of "inhoud" of "groenten"
  const groentenKop = /pakket|inhoud|groenten in|wat zit er|deze week|volgende week/i;
  const receptenKop = /recept|bereid|tip|in de keuken/i;
  const nieuwsKop = /nieuws|agenda|evenement|aankondig|activiteit|bijeenkomst|concert|open dag|oproep/i;
  const stopWoorden = /volgende week|^pagina|^leeuweriksveld|^www\.|^info@|^tel|^\d{4}\s?[a-z]{2}/i;

  for (let i = 0; i < regels.length; i++) {
    const regel = regels[i];

    // Sectie detecteren
    if (groentenKop.test(regel) && regel.length < 60) { sectie = 'groenten'; continue; }
    if (receptenKop.test(regel) && regel.length < 60) { sectie = 'recepten'; continue; }
    if (nieuwsKop.test(regel) && regel.length < 60) { sectie = 'nieuws'; continue; }

    if (stopWoorden.test(regel)) continue;

    if (sectie === 'groenten') {
      // Groenten staan vaak als simpele regels of met streepje
      const match = regel.match(/^[-•*]?\s*(.+)$/);
      if (match && match[1].length > 2 && match[1].length < 60) {
        const groente = match[1].replace(/\(.*?\)/g, '').trim();
        if (groente && !groenten.includes(groente)) groenten.push(groente);
      }
    }

    if (sectie === 'recepten') {
      const match = regel.match(receptPatroon);
      if (match && match[2].length > 4) {
        recepten.push(match[2].trim());
      } else if (regel.length > 10 && regel.length < 100 && /[a-z]/.test(regel)) {
        // Recepttitel zonder nummering maar in receptsectie
        if (!/^\d+$/.test(regel)) recepten.push(regel);
      }
    }

    if (sectie === 'nieuws' && regel.length > 15 && regel.length < 200) {
      nieuws.push(regel);
    }
  }

  // Fallback: als groenten leeg zijn, zoek lijstitems bovenaan
  if (groenten.length === 0) {
    for (const regel of regels.slice(0, 30)) {
      if (/^[-•]\s+\w/.test(regel)) {
        groenten.push(regel.replace(/^[-•]\s+/, '').replace(/\(.*?\)/g, '').trim());
      }
    }
  }

  // Fallback: recepten op basis van nummering in hele tekst
  if (recepten.length === 0) {
    for (const regel of regels) {
      const match = regel.match(/^\d+[\.\)]\s+(.{5,80})$/);
      if (match) recepten.push(match[1].trim());
    }
  }

  return {
    groenten: groenten.slice(0, 20),
    recepten: recepten.slice(0, 20),
    nieuws: nieuws.slice(0, 10),
  };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ bericht: 'Alleen POST toegestaan' }) };

  try {
    const boundary = multipart.getBoundary(event.headers['content-type']);
    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const parts = multipart.parse(body, boundary);

    const get = (naam) => parts.find(p => p.name === naam);
    const wachtwoord = get('wachtwoord')?.data?.toString();
    const week = parseInt(get('week')?.data?.toString());
    const jaar = parseInt(get('jaar')?.data?.toString());
    const bestandPart = get('bestand');

    if (wachtwoord !== process.env.UPLOAD_WACHTWOORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ bericht: 'Ongeldig wachtwoord' }) };
    }

    if (!bestandPart || !week || !jaar) {
      return { statusCode: 400, headers, body: JSON.stringify({ bericht: 'Bestand, week en jaar zijn verplicht' }) };
    }

    // Tekst extraheren
    let tekst = '';
    const bestandsnaam = bestandPart.filename || '';
    if (bestandsnaam.endsWith('.pdf')) {
      const result = await pdfParse(bestandPart.data);
      tekst = result.text;
    } else {
      tekst = bestandPart.data.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, '\n');
    }

    const extracted = extraheerData(tekst);

    const weekStr = String(week).padStart(2, '0');
    const ext = bestandsnaam.endsWith('.html') ? '.html' : '.pdf';
    const nieuwBestand = `pakketbrief-week-${weekStr}-${jaar}${ext}`;

    const nieuwRecord = {
      week, jaar,
      bestand: nieuwBestand,
      groenten: extracted.groenten,
      recepten: extracted.recepten,
      nieuws: extracted.nieuws,
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

    const index = huidigeInhoud.findIndex(r => r.week === week && r.jaar === jaar);
    if (index >= 0) {
      huidigeInhoud[index] = nieuwRecord;
    } else {
      const pos = huidigeInhoud.findIndex(r => r.jaar < jaar || (r.jaar === jaar && r.week < week));
      huidigeInhoud.splice(pos >= 0 ? pos : 0, 0, nieuwRecord);
    }

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
        week, jaar,
        aantalGroenten: nieuwRecord.groenten.length,
        aantalRecepten: nieuwRecord.recepten.length,
      })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ bericht: err.message }) };
  }
};
