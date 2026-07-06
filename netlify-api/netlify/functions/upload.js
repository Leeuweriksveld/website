const pdfParse = require('pdf-parse');
const Busboy = require('busboy');

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const velden = {};
    const bestanden = {};

    const busboy = Busboy({
      headers: { 'content-type': event.headers['content-type'] },
    });

    busboy.on('field', (naam, waarde) => { velden[naam] = waarde; });

    busboy.on('file', (naam, stroom, info) => {
      const stukken = [];
      stroom.on('data', (chunk) => stukken.push(chunk));
      stroom.on('end', () => {
        bestanden[naam] = { data: Buffer.concat(stukken), filename: info.filename };
      });
    });

    busboy.on('finish', () => resolve({ velden, bestanden }));
    busboy.on('error', reject);

    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    busboy.write(body);
    busboy.end();
  });
}

function extraheerData(tekst) {
  const regels = tekst.split(/\r?\n/).map(r => r.trim()).filter(r => r.length > 0);
  const groenten = [];
  const recepten = [];
  const nieuws = [];

  let sectie = null;
  const groentenKop = /pakket|inhoud|groenten in|wat zit er|deze week/i;
  const receptenKop = /recept|bereid|tip|in de keuken/i;
  const nieuwsKop = /nieuws|agenda|evenement|aankondig|activiteit|bijeenkomst|concert|open dag|oproep/i;
  const stopWoorden = /volgende week|^pagina|^leeuweriksveld|^www\.|^info@|^tel:/i;

  for (const regel of regels) {
    if (groentenKop.test(regel) && regel.length < 60) { sectie = 'groenten'; continue; }
    if (receptenKop.test(regel) && regel.length < 60) { sectie = 'recepten'; continue; }
    if (nieuwsKop.test(regel) && regel.length < 60) { sectie = 'nieuws'; continue; }
    if (stopWoorden.test(regel)) continue;

    if (sectie === 'groenten') {
      const match = regel.match(/^[-•*]?\s*(.+)$/);
      if (match && match[1].length > 2 && match[1].length < 60) {
        const groente = match[1].replace(/\(.*?\)/g, '').trim();
        if (groente && !groenten.includes(groente)) groenten.push(groente);
      }
    }
    if (sectie === 'recepten') {
      const match = regel.match(/^(\d+[\.\)]\s+|[-•*]\s+)(.+)$/);
      if (match && match[2].length > 4) recepten.push(match[2].trim());
    }
    if (sectie === 'nieuws' && regel.length > 15 && regel.length < 200) {
      nieuws.push(regel);
    }
  }

  // Fallback: genummerde regels in hele tekst
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
    const { velden, bestanden } = await parseMultipart(event);

    const wachtwoord = velden['wachtwoord'];
    const week = parseInt(velden['week']);
    const jaar = parseInt(velden['jaar']);
    const bestandPart = bestanden['bestand'];

    if (wachtwoord !== process.env.UPLOAD_WACHTWOORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ bericht: 'Ongeldig wachtwoord' }) };
    }
    if (!bestandPart || !week || !jaar) {
      return { statusCode: 400, headers, body: JSON.stringify({ bericht: 'Bestand, week en jaar zijn verplicht' }) };
    }

    let tekst = '';
    const bestandsnaam = bestandPart.filename || '';
    if (bestandsnaam.endsWith('.pdf')) {
      const result = await pdfParse(bestandPart.data);
      tekst = result.text;
    } else {
      tekst = bestandPart.data.toString('utf8')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, '\n');
    }

    const extracted = extraheerData(tekst);
    const weekStr = String(week).padStart(2, '0');
    const ext = bestandsnaam.endsWith('.html') ? '.html' : '.pdf';

    const nieuwRecord = {
      week, jaar,
      bestand: `pakketbrief-week-${weekStr}-${jaar}${ext}`,
      groenten: extracted.groenten,
      recepten: extracted.recepten,
      nieuws: extracted.nieuws,
    };

    const githubToken = process.env.GITHUB_TOKEN;
    const apiBase = `https://api.github.com/repos/Leeuweriksveld/website/contents/src/data/pakketbrieven.json`;

    const huidigResp = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    const huidigData = await huidigResp.json();
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
        sha: huidigData.sha,
      })
    });

    if (!commitResp.ok) {
      const fout = await commitResp.json();
      throw new Error(`GitHub commit mislukt: ${fout.message}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ week, jaar, aantalGroenten: nieuwRecord.groenten.length, aantalRecepten: nieuwRecord.recepten.length }),
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ bericht: err.message }) };
  }
};
